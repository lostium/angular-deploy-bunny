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
});
