import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

export type SopsRunner = (absolutePath: string) => Promise<string>;

const maxBuffer = 1024 * 1024;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

function wasTerminated(error: unknown): boolean {
  if (errorCode(error) === 'ETIMEDOUT') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    ('killed' in error || 'signal' in error) &&
    ((error as { killed?: unknown }).killed === true ||
      typeof (error as { signal?: unknown }).signal === 'string')
  );
}

async function validateSecretsFile(absolutePath: string): Promise<void> {
  let file;
  try {
    file = await stat(absolutePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error('Secrets file not found.');
    throw new Error('Cannot read secrets file.');
  }

  if (!file.isFile()) throw new Error('Secrets file must be a regular file.');

  try {
    await access(absolutePath, constants.R_OK);
  } catch {
    throw new Error('Cannot read secrets file.');
  }
}

function sopsError(error: unknown): Error {
  if (errorCode(error) === 'ENOENT') return new Error('SOPS executable not found on PATH.');
  if (errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new Error('SOPS output exceeded 1 MiB.');
  }
  if (wasTerminated(error)) return new Error('SOPS decryption timed out or was terminated.');
  return new Error('SOPS decryption failed. Check the encrypted file and age identity configuration.');
}

export async function runSops(absolutePath: string): Promise<string> {
  await validateSecretsFile(absolutePath);

  return await new Promise<string>((resolve, reject) => {
    const args = ['decrypt', '--input-type', 'dotenv', '--output-type', 'json', absolutePath];
    const options = {
      encoding: 'utf8' as const,
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      killSignal: 'SIGKILL' as const,
      maxBuffer,
    };

    try {
      const child = execFile('sops', args, options, (error, stdout) => {
        if (error) {
          reject(sopsError(error));
          return;
        }
        resolve(stdout);
      });
      child.stdin?.end();
    } catch (error) {
      reject(sopsError(error));
    }
  });
}

export async function loadSopsValues(
  absolutePath: string,
  run: SopsRunner = runSops,
): Promise<Record<string, unknown>> {
  const output = await run(absolutePath);
  try {
    const values: unknown = JSON.parse(output);
    if (values === null || Array.isArray(values) || typeof values !== 'object') {
      throw new TypeError('Expected an object.');
    }
    return values as Record<string, unknown>;
  } catch {
    throw new Error('SOPS returned invalid credential data.');
  }
}
