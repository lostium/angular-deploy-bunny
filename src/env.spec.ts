import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSecrets, _resetDotenvLoaded } from './env.js';

describe('loadSecrets', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetDotenvLoaded();
    delete process.env['BUNNY_STORAGE_PASSWORD'];
    delete process.env['BUNNY_ACCOUNT_API_KEY'];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('returns the secrets when both env vars are present', () => {
    process.env['BUNNY_STORAGE_PASSWORD'] = 'sp';
    process.env['BUNNY_ACCOUNT_API_KEY'] = 'ak';
    expect(loadSecrets({ requireAccountApiKey: true })).toEqual({
      storagePassword: 'sp',
      accountApiKey: 'ak',
    });
  });

  it('does not require accountApiKey when requireAccountApiKey is false', () => {
    process.env['BUNNY_STORAGE_PASSWORD'] = 'sp';
    expect(loadSecrets({ requireAccountApiKey: false })).toEqual({
      storagePassword: 'sp',
      accountApiKey: null,
    });
  });

  it('throws a helpful error when storage password is missing', () => {
    expect(() => loadSecrets({ requireAccountApiKey: false })).toThrow(
      /BUNNY_STORAGE_PASSWORD/,
    );
  });

  it('throws when accountApiKey is required and missing', () => {
    process.env['BUNNY_STORAGE_PASSWORD'] = 'sp';
    expect(() => loadSecrets({ requireAccountApiKey: true })).toThrow(
      /BUNNY_ACCOUNT_API_KEY/,
    );
  });

  it('falls back to .env when .env.local does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunny-env-fallback-'));
    writeFileSync(join(dir, '.env'), 'BUNNY_STORAGE_PASSWORD=fromEnv\n');
    try {
      expect(loadSecrets({ requireAccountApiKey: false, workspaceRoot: dir })).toEqual({
        storagePassword: 'fromEnv',
        accountApiKey: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.env.local takes precedence over .env when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunny-env-precedence-'));
    writeFileSync(join(dir, '.env'), 'BUNNY_STORAGE_PASSWORD=fromEnv\n');
    writeFileSync(join(dir, '.env.local'), 'BUNNY_STORAGE_PASSWORD=fromLocal\n');
    try {
      expect(loadSecrets({ requireAccountApiKey: false, workspaceRoot: dir })).toEqual({
        storagePassword: 'fromLocal',
        accountApiKey: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads .env.local for each distinct workspaceRoot, not only the first', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'bunny-env-a-')); // no .env.local
    const dirB = mkdtempSync(join(tmpdir(), 'bunny-env-b-'));
    writeFileSync(join(dirB, '.env.local'), 'BUNNY_STORAGE_PASSWORD=fromB\n');
    try {
      // First call against a root with no .env.local must not latch globally
      // and skip loading later roots.
      expect(() => loadSecrets({ requireAccountApiKey: false, workspaceRoot: dirA })).toThrow(
        /BUNNY_STORAGE_PASSWORD/,
      );
      // A different root that DOES have .env.local must still be loaded.
      expect(loadSecrets({ requireAccountApiKey: false, workspaceRoot: dirB })).toEqual({
        storagePassword: 'fromB',
        accountApiKey: null,
      });
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
