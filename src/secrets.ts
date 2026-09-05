import { resolve } from 'node:path';
import {
  credentialNames,
  selectSecrets,
  type LoadSecretsOptions,
  type Secrets,
} from './credential-values.js';
import { loadSecrets } from './env.js';
import { loadSopsValues } from './sops.js';

export interface ResolveSecretsOptions extends LoadSecretsOptions {
  secretsFile?: string | null;
}

export interface SecretSources {
  environment: (options: LoadSecretsOptions) => Secrets;
  sops: (absolutePath: string) => Promise<Record<string, unknown>>;
}

const defaultSources: SecretSources = {
  environment: loadSecrets,
  sops: loadSopsValues,
};

function secretsPath(value: unknown): string {
  if (typeof value !== 'string' || !/\S/.test(value) || value.includes('\u0000')) {
    throw new Error('Invalid secretsFile. Expected a non-empty path without NUL characters.');
  }
  return value;
}

export async function resolveSecrets(
  options: ResolveSecretsOptions,
  sources: SecretSources = defaultSources,
): Promise<Secrets> {
  credentialNames(options);

  if (options.secretsFile === undefined || options.secretsFile === null) {
    return sources.environment(options);
  }

  const absolutePath = resolve(options.workspaceRoot ?? process.cwd(), secretsPath(options.secretsFile));
  const values = await sources.sops(absolutePath);
  return selectSecrets(values, options, 'sops');
}
