import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveSecrets } from '../src/secrets.js';

const originalEnvironment = { ...process.env };

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
}

function requireExecutable(command: string): void {
  try {
    execFileSync(command, ['--help'], { stdio: 'ignore' });
  } catch {
    throw new Error(`SOPS integration prerequisites unavailable: ${command} must be on PATH.`);
  }
}

function directorySnapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [entry.name, readFileSync(join(directory, entry.name)).toString('base64')]),
  );
}

function credentialFilesContaining(directory: string, values: string[]): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .filter((path) => {
      const content = readFileSync(path, 'utf8');
      return values.some((value) => content.includes(value));
    });
}

describe('native SOPS credential resolution', () => {
  let directory: string;
  let identityPath: string;
  let recipient: string;

  beforeAll(() => {
    requireExecutable('sops');
    requireExecutable('age-keygen');
  });

  beforeEach(() => {
    restoreEnvironment();
    directory = mkdtempSync(join(tmpdir(), 'angular-deploy-bunny-sops-'));
    const identity = execFileSync('age-keygen', [], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    recipient = execFileSync('age-keygen', ['-y'], { input: identity, encoding: 'utf8' }).trim();
    identityPath = join(directory, 'test.agekey');
    writeFileSync(identityPath, identity, { mode: 0o600 });
    chmodSync(identityPath, 0o600);

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SOPS_AGE_')) delete process.env[key];
    }
    process.env['SOPS_AGE_KEY_FILE'] = identityPath;
  });

  afterEach(() => {
    restoreEnvironment();
    rmSync(directory, { recursive: true, force: true });
  });

  function encrypt(name: string, dotenv: string): string {
    const emptyConfig = join(directory, 'empty-sops-config.yaml');
    if (!readdirSync(directory).includes('empty-sops-config.yaml')) writeFileSync(emptyConfig, '');
    // SOPS reads its input from a path, not stdin. `/dev/stdin` works on macOS
    // but fails with ENXIO on Linux runners, where the inherited descriptor is
    // a pipe that cannot be reopened by name. Stage the fake plaintext in the
    // temporary directory instead and unlink it before the test observes it.
    const plaintextPath = join(directory, `${name}.plaintext-input`);
    writeFileSync(plaintextPath, dotenv, { mode: 0o600 });
    let encrypted: string;
    try {
      encrypted = execFileSync(
        'sops',
        [
          '--config', emptyConfig,
          'encrypt',
          '--age', recipient,
          '--input-type', 'dotenv',
          '--output-type', 'dotenv',
          plaintextPath,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } finally {
      rmSync(plaintextPath, { force: true });
    }
    const path = join(directory, name);
    writeFileSync(path, encrypted, { mode: 0o600 });
    return path;
  }

  it('preserves SOPS dotenv special values without creating plaintext output', async () => {
    const storagePassword = 'demo#suffix "quoted" with spaces $dollar=equals\\backslash';
    const encryptedPath = encrypt(
      'staging.enc.env',
      'BUNNY_STORAGE_PASSWORD=demo#suffix "quoted" with spaces $dollar=equals\\backslash\n',
    );
    const before = directorySnapshot(directory);

    await expect(resolveSecrets({
      workspaceRoot: directory,
      requireAccountApiKey: false,
      secretsFile: encryptedPath,
    })).resolves.toEqual({ storagePassword, accountApiKey: null });

    expect(directorySnapshot(directory)).toEqual(before);
    expect(credentialFilesContaining(directory, [storagePassword])).toEqual([]);
  });

  it('keeps concurrently decrypted encrypted files local to each deployment', async () => {
    const firstPath = encrypt('first.enc.env', 'BUNNY_STORAGE_PASSWORD=first-file-only\n');
    const secondPath = encrypt('second.enc.env', 'BUNNY_STORAGE_PASSWORD=second-file-only\n');

    const [first, second] = await Promise.all([
      resolveSecrets({ workspaceRoot: directory, requireAccountApiKey: false, secretsFile: firstPath }),
      resolveSecrets({ workspaceRoot: directory, requireAccountApiKey: false, secretsFile: secondPath }),
    ]);

    expect(first).toEqual({ storagePassword: 'first-file-only', accountApiKey: null });
    expect(second).toEqual({ storagePassword: 'second-file-only', accountApiKey: null });
  });

  it('rejects a missing encrypted credential even when the process has a fallback value', async () => {
    const encryptedPath = encrypt('missing.enc.env', 'UNRELATED=value\n');
    process.env['BUNNY_STORAGE_PASSWORD'] = 'ambient-process-value';

    await expect(resolveSecrets({
      workspaceRoot: directory,
      requireAccountApiKey: false,
      secretsFile: encryptedPath,
    })).rejects.toThrow('BUNNY_STORAGE_PASSWORD');
  });

  it('rejects an encrypted file when the configured identity cannot decrypt it', async () => {
    const encryptedPath = encrypt('wrong-identity.enc.env', 'BUNNY_STORAGE_PASSWORD=identity-bound\n');
    const wrongIdentity = execFileSync('age-keygen', [], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const wrongIdentityPath = join(directory, 'wrong.agekey');
    writeFileSync(wrongIdentityPath, wrongIdentity, { mode: 0o600 });
    chmodSync(wrongIdentityPath, 0o600);
    process.env['SOPS_AGE_KEY_FILE'] = wrongIdentityPath;

    await expect(resolveSecrets({
      workspaceRoot: directory,
      requireAccountApiKey: false,
      secretsFile: encryptedPath,
    })).rejects.toThrow('SOPS decryption failed');
  });

  it('rejects tampered ciphertext', async () => {
    const encryptedPath = encrypt('tampered.enc.env', 'BUNNY_STORAGE_PASSWORD=tamper-check\n');
    const encrypted = readFileSync(encryptedPath, 'utf8');
    const tampered = encrypted.replace(/ENC\[AES256_GCM,data:([^,])/, (_match, first: string) =>
      `ENC[AES256_GCM,data:${first === 'A' ? 'B' : 'A'}`,
    );
    expect(tampered).not.toBe(encrypted);
    writeFileSync(encryptedPath, tampered, { mode: 0o600 });

    await expect(resolveSecrets({
      workspaceRoot: directory,
      requireAccountApiKey: false,
      secretsFile: encryptedPath,
    })).rejects.toThrow('SOPS decryption failed');
  });
});
