import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkLocal } from './walk.js';

describe('walkLocal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bunny-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns relative paths with sha256 for every file recursively', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

    const files = await walkLocal(dir, []);
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));

    expect(files.map((f) => f.relPath)).toEqual(['assets/app.js', 'index.html']);
    expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files[1].sha256).toBe(
      // sha256("<!doctype html>")
      'fe26c59e91ac8de694b2531dc3bdc1b7faf471d3d7e4e00870af60f5f22897cb',
    );
    expect(files[1].size).toBe(15);
  });

  it('skips files matched by ignore globs', async () => {
    writeFileSync(join(dir, 'main.js'), 'a');
    writeFileSync(join(dir, 'main.js.map'), 'b');

    const files = await walkLocal(dir, ['**/*.map']);

    expect(files.map((f) => f.relPath)).toEqual(['main.js']);
  });

  it('returns an empty array when the root is empty', async () => {
    expect(await walkLocal(dir, [])).toEqual([]);
  });
});
