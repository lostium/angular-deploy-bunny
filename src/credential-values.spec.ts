import { describe, expect, it } from 'vitest';
import {
  credentialNames,
  selectSecrets,
  type LoadSecretsOptions,
} from './credential-values.js';

const withoutAccount: LoadSecretsOptions = { requireAccountApiKey: false };
const withAccount: LoadSecretsOptions = { requireAccountApiKey: true };

describe('credentialNames', () => {
  it('uses the legacy names only when names are undefined', () => {
    expect(credentialNames(withoutAccount)).toEqual({
      storagePasswordVar: 'BUNNY_STORAGE_PASSWORD',
      accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY',
    });
    expect(
      credentialNames({
        ...withoutAccount,
        storagePasswordVar: 'STAGING_PASSWORD',
        accountApiKeyVar: 'STAGING_ACCOUNT',
      }),
    ).toEqual({
      storagePasswordVar: 'STAGING_PASSWORD',
      accountApiKeyVar: 'STAGING_ACCOUNT',
    });
  });

  it.each([
    null,
    42,
    {},
    '',
    ' ',
    '1PASSWORD',
    'PASSWORD-NAME',
    'PASSWORD.NAME',
    'PASSWORD NAME',
  ])('rejects an invalid storage variable name %#', (storagePasswordVar) => {
    expect(() =>
      credentialNames({ ...withoutAccount, storagePasswordVar } as unknown as LoadSecretsOptions),
    ).toThrow(/storagePasswordVar/);
  });

  it.each([null, 42, {}, '', ' ', '1ACCOUNT', 'ACCOUNT-NAME', 'ACCOUNT.NAME'])(
    'rejects an invalid account variable name %#',
    (accountApiKeyVar) => {
      expect(() =>
        credentialNames({ ...withoutAccount, accountApiKeyVar } as unknown as LoadSecretsOptions),
      ).toThrow(/accountApiKeyVar/);
    },
  );
});

describe('selectSecrets', () => {
  it('selects default and custom own keys without falling back to defaults', () => {
    expect(
      selectSecrets(
        { BUNNY_STORAGE_PASSWORD: 'production', BUNNY_ACCOUNT_API_KEY: 'account' },
        withoutAccount,
        'sops',
      ),
    ).toEqual({ storagePassword: 'production', accountApiKey: 'account' });

    expect(
      selectSecrets(
        { STAGING_PASSWORD: 'staging', STAGING_ACCOUNT: 'stage-account' },
        {
          ...withoutAccount,
          storagePasswordVar: 'STAGING_PASSWORD',
          accountApiKeyVar: 'STAGING_ACCOUNT',
        },
        'sops',
      ),
    ).toEqual({ storagePassword: 'staging', accountApiKey: 'stage-account' });

    expect(() =>
      selectSecrets(
        { BUNNY_STORAGE_PASSWORD: 'production' },
        { ...withoutAccount, storagePasswordVar: 'STAGING_PASSWORD' },
        'sops',
      ),
    ).toThrow(/STAGING_PASSWORD/);
  });

  it('does not use inherited credential keys', () => {
    expect(() =>
      selectSecrets(
        Object.create({ BUNNY_STORAGE_PASSWORD: 'inherited' }) as Record<string, unknown>,
        withoutAccount,
        'sops',
      ),
    ).toThrow(/BUNNY_STORAGE_PASSWORD/);
  });

  it.each(['demo#suffix', '"quoted"', ' spaced ', '$VALUE', 'a=b'])(
    'preserves the storage password %s exactly',
    (storagePassword) => {
      expect(
        selectSecrets({ BUNNY_STORAGE_PASSWORD: storagePassword }, withoutAccount, 'sops'),
      ).toEqual({ storagePassword, accountApiKey: null });
    },
  );

  it('keeps an empty optional account key but rejects it when required', () => {
    expect(
      selectSecrets(
        { BUNNY_STORAGE_PASSWORD: 'storage', BUNNY_ACCOUNT_API_KEY: '' },
        withoutAccount,
        'sops',
      ),
    ).toEqual({ storagePassword: 'storage', accountApiKey: '' });

    expect(() =>
      selectSecrets(
        { BUNNY_STORAGE_PASSWORD: 'storage', BUNNY_ACCOUNT_API_KEY: '' },
        withAccount,
        'sops',
      ),
    ).toThrow(/BUNNY_ACCOUNT_API_KEY/);
  });

  it('allows an absent optional account key', () => {
    expect(selectSecrets({ BUNNY_STORAGE_PASSWORD: 'storage' }, withoutAccount, 'sops')).toEqual({
      storagePassword: 'storage',
      accountApiKey: null,
    });
  });

  it('ignores unrelated non-string entries', () => {
    expect(
      selectSecrets(
        {
          BUNNY_STORAGE_PASSWORD: 'storage',
          BUNNY_ACCOUNT_API_KEY: 'account',
          UNRELATED_NUMBER: 42,
          UNRELATED_OBJECT: {},
        },
        withAccount,
        'sops',
      ),
    ).toEqual({ storagePassword: 'storage', accountApiKey: 'account' });
  });

  it.each([
    ['storage', { BUNNY_STORAGE_PASSWORD: 42 }],
    ['storage', { BUNNY_STORAGE_PASSWORD: {} }],
    ['account', { BUNNY_STORAGE_PASSWORD: 'storage', BUNNY_ACCOUNT_API_KEY: 42 }],
    ['account', { BUNNY_STORAGE_PASSWORD: 'storage', BUNNY_ACCOUNT_API_KEY: {} }],
  ])('rejects a selected non-string %s without exposing credential values', (_selected, values) => {
    const fakeSecret = 'sensitive-value-that-must-not-leak';
    const withSecret =
      _selected === 'storage'
        ? { ...values, BUNNY_ACCOUNT_API_KEY: fakeSecret }
        : { ...values, UNUSED: fakeSecret };
    let error: unknown;
    try {
      selectSecrets(withSecret, withAccount, 'sops');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(fakeSecret);
    expect((error as Error).message).toMatch(/invalid credential value/i);
  });

  it('uses legacy environment wording and safe encrypted-source wording', () => {
    expect(() => selectSecrets({}, withoutAccount, 'environment')).toThrow(
      'Missing BUNNY_STORAGE_PASSWORD. Set it in your shell, in .env.local, or in .env at the repo root.',
    );
    expect(() => selectSecrets({}, withoutAccount, 'sops')).toThrow(
      /BUNNY_STORAGE_PASSWORD.*encrypted credentials source/i,
    );
  });
});
