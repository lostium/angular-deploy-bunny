export interface Secrets {
  storagePassword: string;
  accountApiKey: string | null;
}

export interface LoadSecretsOptions {
  requireAccountApiKey: boolean;
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  workspaceRoot?: string;
  /** Defaults to BUNNY_STORAGE_PASSWORD. */
  storagePasswordVar?: string;
  /** Defaults to BUNNY_ACCOUNT_API_KEY. */
  accountApiKeyVar?: string;
}

export interface CredentialNames {
  storagePasswordVar: string;
  accountApiKeyVar: string;
}

const variableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function credentialName(value: unknown, optionName: string, fallback: string): string {
  const name = value === undefined ? fallback : value;
  if (typeof name !== 'string' || !variableNamePattern.test(name)) {
    throw new Error(
      `Invalid ${optionName}. Expected an environment variable name matching ${variableNamePattern.source}.`,
    );
  }
  return name;
}

export function credentialNames(options: LoadSecretsOptions): CredentialNames {
  return {
    storagePasswordVar: credentialName(
      options.storagePasswordVar,
      'storagePasswordVar',
      'BUNNY_STORAGE_PASSWORD',
    ),
    accountApiKeyVar: credentialName(
      options.accountApiKeyVar,
      'accountApiKeyVar',
      'BUNNY_ACCOUNT_API_KEY',
    ),
  };
}

function missingCredential(name: string, source: 'environment' | 'sops', account = false): Error {
  if (source === 'environment') {
    const suffix = account ? ' (required when purgeAfterUpload is true)' : '';
    return new Error(
      `Missing ${name}${suffix}. Set it in your shell, in .env.local, or in .env at the repo root.`,
    );
  }
  return new Error(`Missing ${name} in the encrypted credentials source.`);
}

function invalidCredential(name: string, source: 'environment' | 'sops'): Error {
  const sourceSuffix = source === 'sops' ? ' in the encrypted credentials source' : '';
  return new Error(`Invalid credential value for ${name}${sourceSuffix}. Expected a string.`);
}

function selectedValue(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function requiredCredential(
  values: Record<string, unknown>,
  name: string,
  source: 'environment' | 'sops',
  account = false,
): string {
  const value = selectedValue(values, name);
  if (value === undefined || value === '') throw missingCredential(name, source, account);
  if (typeof value !== 'string') {
    throw invalidCredential(name, source);
  }
  return value;
}

export function selectSecrets(
  values: Record<string, unknown>,
  options: LoadSecretsOptions,
  source: 'environment' | 'sops',
): Secrets {
  const names = credentialNames(options);
  const storagePassword = requiredCredential(values, names.storagePasswordVar, source);
  const accountValue = selectedValue(values, names.accountApiKeyVar);

  if (accountValue !== undefined && typeof accountValue !== 'string') {
    throw invalidCredential(names.accountApiKeyVar, source);
  }
  if (options.requireAccountApiKey && (accountValue === undefined || accountValue === '')) {
    throw missingCredential(names.accountApiKeyVar, source, true);
  }

  return { storagePassword, accountApiKey: accountValue ?? null };
}
