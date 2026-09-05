import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbsolute, resolve } from 'node:path';
import { resolveSecrets, type ResolveSecretsOptions, type SecretSources } from './secrets.js';

const defaults: ResolveSecretsOptions = { requireAccountApiKey: false };

function sources(): SecretSources & {
  environment: ReturnType<typeof vi.fn>;
  sops: ReturnType<typeof vi.fn>;
} {
  return {
    environment: vi.fn(() => ({ storagePassword: 'environment-storage', accountApiKey: null })),
    sops: vi.fn(async () => ({ BUNNY_STORAGE_PASSWORD: 'sops-storage' })),
  };
}

describe('resolveSecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fall back when the encrypted file lacks a key', async () => {
    const selectedSources = {
      environment: vi.fn(() => ({ storagePassword: 'production', accountApiKey: null })),
      sops: vi.fn(async () => ({})),
    };

    await expect(
      resolveSecrets({ ...defaults, secretsFile: 'stage.enc.env' }, selectedSources),
    ).rejects.toThrow(/BUNNY_STORAGE_PASSWORD/);
    expect(selectedSources.environment).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('uses the legacy environment source for secretsFile %s', async (secretsFile) => {
    const selectedSources = sources();

    await expect(resolveSecrets({ ...defaults, secretsFile }, selectedSources)).resolves.toEqual({
      storagePassword: 'environment-storage',
      accountApiKey: null,
    });
    expect(selectedSources.environment).toHaveBeenCalledWith({ ...defaults, secretsFile });
    expect(selectedSources.sops).not.toHaveBeenCalled();
  });

  it('uses an absolute SOPS path unchanged and selects custom encrypted keys', async () => {
    const selectedSources = sources();
    const absolutePath = resolve(process.cwd(), 'secrets', 'stage.enc.env');
    selectedSources.sops.mockResolvedValue({ STAGE_STORAGE: 'stage', STAGE_ACCOUNT: 'account' });

    await expect(
      resolveSecrets(
        {
          ...defaults,
          secretsFile: absolutePath,
          storagePasswordVar: 'STAGE_STORAGE',
          accountApiKeyVar: 'STAGE_ACCOUNT',
          workspaceRoot: '/ignored-workspace-root',
        },
        selectedSources,
      ),
    ).resolves.toEqual({ storagePassword: 'stage', accountApiKey: 'account' });
    expect(isAbsolute(absolutePath)).toBe(true);
    expect(selectedSources.sops).toHaveBeenCalledWith(absolutePath);
    expect(selectedSources.environment).not.toHaveBeenCalled();
  });

  it('passes an absolute SOPS path through without normalizing dot segments', async () => {
    const selectedSources = sources();
    const configuredPath = '/encrypted/secrets/../staging.enc.env';

    await resolveSecrets({ ...defaults, secretsFile: configuredPath }, selectedSources);

    expect(selectedSources.sops).toHaveBeenCalledWith(configuredPath);
  });

  it('resolves a SOPS path from the workspace root', async () => {
    const selectedSources = sources();

    await resolveSecrets(
      { ...defaults, workspaceRoot: '/workspace/project', secretsFile: 'secrets/stage.enc.env' },
      selectedSources,
    );

    expect(selectedSources.sops).toHaveBeenCalledWith('/workspace/project/secrets/stage.enc.env');
  });

  it.each([42, {}, [], '', '  ', 'stage\u0000.enc.env'])(
    'rejects invalid secretsFile values before accessing sources: %#',
    async (secretsFile) => {
      const selectedSources = sources();

      await expect(
        resolveSecrets({ ...defaults, secretsFile } as unknown as ResolveSecretsOptions, selectedSources),
      ).rejects.toThrow(/Invalid secretsFile/);
      expect(selectedSources.environment).not.toHaveBeenCalled();
      expect(selectedSources.sops).not.toHaveBeenCalled();
    },
  );

  it('validates credential names before accessing the selected source', async () => {
    const selectedSources = sources();

    await expect(
      resolveSecrets(
        { ...defaults, secretsFile: 'stage.enc.env', storagePasswordVar: 'invalid-name' },
        selectedSources,
      ),
    ).rejects.toThrow(/storagePasswordVar/);
    expect(selectedSources.environment).not.toHaveBeenCalled();
    expect(selectedSources.sops).not.toHaveBeenCalled();
  });

  it('keeps concurrent encrypted credential maps local to their deployment', async () => {
    const first = sources();
    const second = sources();
    let resolveFirst: ((value: Record<string, unknown>) => void) | undefined;
    const firstValues = new Promise<Record<string, unknown>>((resolveValues) => {
      resolveFirst = resolveValues;
    });
    first.sops.mockReturnValueOnce(firstValues);
    second.sops.mockResolvedValueOnce({ BUNNY_STORAGE_PASSWORD: 'second-storage' });

    const firstDeploy = resolveSecrets({ ...defaults, secretsFile: 'first.enc.env' }, first);
    const secondDeploy = resolveSecrets({ ...defaults, secretsFile: 'second.enc.env' }, second);
    const secondResult = await secondDeploy;
    resolveFirst?.({ BUNNY_STORAGE_PASSWORD: 'first-storage' });

    await expect(firstDeploy).resolves.toEqual({ storagePassword: 'first-storage', accountApiKey: null });
    expect(secondResult).toEqual({ storagePassword: 'second-storage', accountApiKey: null });
    expect(first.environment).not.toHaveBeenCalled();
    expect(second.environment).not.toHaveBeenCalled();
  });

  it('does not mutate process environment while resolving SOPS credentials', async () => {
    const selectedSources = sources();
    const before = { ...process.env };
    selectedSources.sops.mockResolvedValue({
      BUNNY_STORAGE_PASSWORD: 'sops-storage',
      BUNNY_ACCOUNT_API_KEY: 'sops-account',
    });

    await resolveSecrets({ ...defaults, secretsFile: 'stage.enc.env' }, selectedSources);

    expect(process.env).toEqual(before);
  });

  it('propagates source failures without falling back to the environment', async () => {
    const selectedSources = sources();
    const failure = new Error('SOPS decryption failed.');
    selectedSources.sops.mockRejectedValueOnce(failure);

    await expect(
      resolveSecrets({ ...defaults, secretsFile: 'stage.enc.env' }, selectedSources),
    ).rejects.toBe(failure);
    expect(selectedSources.environment).not.toHaveBeenCalled();
  });
});
