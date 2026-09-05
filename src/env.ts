import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  credentialNames,
  selectSecrets,
  type LoadSecretsOptions,
  type Secrets,
} from './credential-values.js';

export type { LoadSecretsOptions, Secrets } from './credential-values.js';

// Keyed by the resolved workspace root so each distinct root loads its own
// file once. A single boolean would latch on the first root and skip every
// later one (breaks multi-project workspaces deploying in one process).
const loadedWorkspaceRoots = new Set<string>();

function ensureDotenv(workspaceRoot: string): void {
  if (loadedWorkspaceRoots.has(workspaceRoot)) return;
  const envLocal = resolve(workspaceRoot, '.env.local');
  if (existsSync(envLocal)) {
    loadDotenv({ path: envLocal, quiet: true });
  } else {
    const envFile = resolve(workspaceRoot, '.env');
    if (existsSync(envFile)) {
      loadDotenv({ path: envFile, quiet: true });
    }
  }
  loadedWorkspaceRoots.add(workspaceRoot);
}

export function loadSecrets(options: LoadSecretsOptions): Secrets {
  credentialNames(options);
  ensureDotenv(options.workspaceRoot ?? process.cwd());
  return selectSecrets(process.env, options, 'environment');
}

// Test-only escape hatch.
export function _resetDotenvLoaded(): void {
  loadedWorkspaceRoots.clear();
}
