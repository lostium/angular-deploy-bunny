import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Secrets {
  storagePassword: string;
  accountApiKey: string | null;
}

export interface LoadSecretsOptions {
  requireAccountApiKey: boolean;
  /** Absolute path to the repo root. Defaults to process.cwd(). */
  workspaceRoot?: string;
}

// Keyed by the resolved .env.local path so each distinct workspace root loads
// its own file once. A single boolean would latch on the first root and skip
// every later one (breaks multi-project workspaces deploying in one process).
const loadedDotenvPaths = new Set<string>();

function ensureDotenv(workspaceRoot: string): void {
  const path = resolve(workspaceRoot, '.env.local');
  if (loadedDotenvPaths.has(path)) return;
  if (existsSync(path)) {
    loadDotenv({ path });
  }
  loadedDotenvPaths.add(path);
}

export function loadSecrets(options: LoadSecretsOptions): Secrets {
  ensureDotenv(options.workspaceRoot ?? process.cwd());

  const storagePassword = process.env['BUNNY_STORAGE_PASSWORD'];
  if (!storagePassword) {
    throw new Error(
      'Missing BUNNY_STORAGE_PASSWORD. Set it in your shell or in .env.local at the repo root.',
    );
  }

  const accountApiKey = process.env['BUNNY_ACCOUNT_API_KEY'] ?? null;
  if (options.requireAccountApiKey && !accountApiKey) {
    throw new Error(
      'Missing BUNNY_ACCOUNT_API_KEY (required when purgeAfterUpload is true). Set it in your shell or in .env.local at the repo root.',
    );
  }

  return { storagePassword, accountApiKey };
}

// Test-only escape hatch.
export function _resetDotenvLoaded(): void {
  loadedDotenvPaths.clear();
}
