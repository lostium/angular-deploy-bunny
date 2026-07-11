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
  ensureDotenv(options.workspaceRoot ?? process.cwd());

  const storagePassword = process.env['BUNNY_STORAGE_PASSWORD'];
  if (!storagePassword) {
    throw new Error(
      'Missing BUNNY_STORAGE_PASSWORD. Set it in your shell, in .env.local, or in .env at the repo root.',
    );
  }

  const accountApiKey = process.env['BUNNY_ACCOUNT_API_KEY'] ?? null;
  if (options.requireAccountApiKey && !accountApiKey) {
    throw new Error(
      'Missing BUNNY_ACCOUNT_API_KEY (required when purgeAfterUpload is true). Set it in your shell, in .env.local, or in .env at the repo root.',
    );
  }

  return { storagePassword, accountApiKey };
}

// Test-only escape hatch.
export function _resetDotenvLoaded(): void {
  loadedWorkspaceRoots.clear();
}
