import type { Stats } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  access: vi.fn(),
  execFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: boundaries.access,
  stat: boundaries.stat,
}));

vi.mock('node:child_process', () => ({
  execFile: boundaries.execFile,
}));

import { loadSopsValues, runSops } from './sops.js';

const file = '/workspace/secrets/staging file;$(never-run).enc.env';
const fakeSecret = 'FAKE-SECRET-should-not-leak';

function regularFile(): Stats {
  return { isFile: () => true } as Stats;
}

function queueReadableFile(): void {
  boundaries.stat.mockResolvedValue(regularFile());
  boundaries.access.mockResolvedValue(undefined);
}

function queueExecSuccess(stdout = '{"BUNNY_STORAGE_PASSWORD":"demo#suffix"}'): {
  stdin: { end: ReturnType<typeof vi.fn> };
} {
  const child = { stdin: { end: vi.fn() } };
  boundaries.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(null, stdout, '');
    return child;
  });
  return child;
}

function queueExecError(error: Error & Record<string, unknown>): void {
  boundaries.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(error, fakeSecret, fakeSecret);
    return { stdin: { end: vi.fn() } };
  });
}

function errorWith(properties: Record<string, unknown>): Error & Record<string, unknown> {
  return Object.assign(new Error(fakeSecret), properties);
}

async function rejectionOf(action: () => Promise<unknown>): Promise<Error & { cause?: unknown }> {
  try {
    await action();
  } catch (error) {
    return error as Error & { cause?: unknown };
  }
  throw new Error('Expected the action to reject.');
}

beforeEach(() => {
  vi.clearAllMocks();
  queueReadableFile();
});

describe('loadSopsValues', () => {
  it('keeps a hash character in JSON values without dotenv parsing', async () => {
    const run = vi.fn(async () => '{"BUNNY_STORAGE_PASSWORD":"demo#suffix"}');

    await expect(loadSopsValues(file, run)).resolves.toEqual({
      BUNNY_STORAGE_PASSWORD: 'demo#suffix',
    });
  });

  it('hides malformed decrypted output', async () => {
    const error = await rejectionOf(() => loadSopsValues(file, async () => fakeSecret));

    expect(error.message).toBe('SOPS returned invalid credential data.');
    expect(error.message).not.toContain(fakeSecret);
    expect(error.cause).toBeUndefined();
  });

  it.each(['null', '[]', '"string"', '12', 'false'])(
    'rejects a non-object JSON result: %s',
    async (output) => {
      await expect(loadSopsValues(file, async () => output)).rejects.toThrow(
        'SOPS returned invalid credential data.',
      );
    },
  );
});

describe('runSops', () => {
  it('decrypts a readable regular file through fixed direct arguments', async () => {
    const child = queueExecSuccess();

    await expect(runSops(file)).resolves.toBe('{"BUNNY_STORAGE_PASSWORD":"demo#suffix"}');
    expect(boundaries.stat).toHaveBeenCalledWith(file);
    expect(boundaries.access).toHaveBeenCalledWith(file, expect.any(Number));
    expect(boundaries.execFile).toHaveBeenCalledWith(
      'sops',
      ['decrypt', '--input-type', 'dotenv', '--output-type', 'json', file],
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      expect.any(Function),
    );
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });

  it('reports a missing secrets file without invoking SOPS', async () => {
    boundaries.stat.mockRejectedValue(errorWith({ code: 'ENOENT' }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe('Secrets file not found.');
    expect(error.message).not.toContain(fakeSecret);
    expect(error.cause).toBeUndefined();
    expect(boundaries.execFile).not.toHaveBeenCalled();
  });

  it('rejects a path that is not a regular file without invoking SOPS', async () => {
    boundaries.stat.mockResolvedValue({ isFile: () => false } as Stats);

    await expect(runSops(file)).rejects.toThrow('Secrets file must be a regular file.');
    expect(boundaries.access).not.toHaveBeenCalled();
    expect(boundaries.execFile).not.toHaveBeenCalled();
  });

  it('reports inaccessible stat results without invoking SOPS', async () => {
    boundaries.stat.mockRejectedValue(errorWith({ code: 'EACCES' }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe('Cannot read secrets file.');
    expect(error.message).not.toContain(fakeSecret);
    expect(boundaries.execFile).not.toHaveBeenCalled();
  });

  it('reports a regular but unreadable file without invoking SOPS', async () => {
    boundaries.access.mockRejectedValue(errorWith({ code: 'EACCES' }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe('Cannot read secrets file.');
    expect(error.message).not.toContain(fakeSecret);
    expect(boundaries.execFile).not.toHaveBeenCalled();
  });

  it('hides an unavailable SOPS executable', async () => {
    queueExecError(errorWith({ code: 'ENOENT' }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe('SOPS executable not found on PATH.');
    expect(error.message).not.toContain(fakeSecret);
    expect(error.cause).toBeUndefined();
  });

  it('hides nonzero SOPS output and error text', async () => {
    queueExecError(errorWith({ code: 1, stdout: fakeSecret, stderr: fakeSecret }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe(
      'SOPS decryption failed. Check the encrypted file and age identity configuration.',
    );
    expect(error.message).not.toContain(fakeSecret);
    expect(error.cause).toBeUndefined();
  });

  it('reports a timed-out SOPS process without error details', async () => {
    queueExecError(errorWith({ code: 'ETIMEDOUT', killed: true, signal: 'SIGKILL' }));

    const error = await rejectionOf(() => runSops(file));

    expect(error.message).toBe('SOPS decryption timed out or was terminated.');
    expect(error.message).not.toContain(fakeSecret);
  });

  it.each(['stdout', 'stderr'])(
    'reports a %s capture limit before a termination signal',
    async (stream) => {
      queueExecError(
        errorWith({
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          killed: true,
          signal: 'SIGKILL',
          [stream]: fakeSecret,
        }),
      );

      const error = await rejectionOf(() => runSops(file));

      expect(error.message).toBe('SOPS output exceeded 1 MiB.');
      expect(error.message).not.toContain(fakeSecret);
    },
  );
});
