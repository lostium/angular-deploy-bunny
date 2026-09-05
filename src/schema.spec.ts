import { schema } from '@angular-devkit/core';
import { describe, expect, it } from 'vitest';
import builderSchema from './schema.json';

type AsyncValue<T> = PromiseLike<T> | {
  subscribe(observer: { next(value: T): void; error(reason: unknown): void }): unknown;
};

function settle<T>(value: AsyncValue<T>): Promise<T> {
  if ('subscribe' in value) {
    return new Promise<T>((resolve, reject) => {
      value.subscribe({ next: resolve, error: reject });
    });
  }
  return Promise.resolve(value);
}

async function validate(value: Record<string, unknown>) {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  const validator = await settle(registry.compile(builderSchema));
  return await settle(validator(value));
}

describe('deploy builder schema', () => {
  it('applies the legacy credential defaults and keeps secretsFile null', async () => {
    const result = await validate({ storageZoneName: 'zone' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      storageZoneName: 'zone',
      storagePasswordVar: 'BUNNY_STORAGE_PASSWORD',
      accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY',
      secretsFile: null,
    });
  });

  it('accepts explicit SOPS credentials settings', async () => {
    const result = await validate({
      storageZoneName: 'stage-zone',
      storagePasswordVar: 'BUNNY_STORAGE_PASSWORD_STAGING',
      accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY_STAGING',
      secretsFile: 'secrets/staging.enc.env',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      storagePasswordVar: 'BUNNY_STORAGE_PASSWORD_STAGING',
      accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY_STAGING',
      secretsFile: 'secrets/staging.enc.env',
    });
  });

  it.each([
    { storagePasswordVar: '' },
    { storagePasswordVar: 'invalid-name' },
    { accountApiKeyVar: '1ACCOUNT' },
    { accountApiKeyVar: 'ACCOUNT KEY' },
    { secretsFile: '' },
    { secretsFile: '  ' },
    { secretsFile: 'stage\u0000.enc.env' },
  ])('rejects invalid credential source option %#', async (options) => {
    const result = await validate({ storageZoneName: 'zone', ...options });

    expect(result.success).toBe(false);
  });
});
