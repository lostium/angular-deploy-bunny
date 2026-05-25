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

describe('walkLocal ignore glob semantics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bunny-glob-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('** under a prefix matches files at any depth', async () => {
    writeFileSync(join(dir, 'keep.js'), 'a');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'top.js'), 'a');
    mkdirSync(join(dir, 'assets', 'deep'));
    writeFileSync(join(dir, 'assets', 'deep', 'nested.js'), 'a');

    const files = await walkLocal(dir, ['assets/**']);

    expect(files.map((f) => f.relPath)).toEqual(['keep.js']);
  });

  it('leading **/ matches the trailing pattern at any depth', async () => {
    writeFileSync(join(dir, 'root.map'), 'a');
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'one.map'), 'a');
    mkdirSync(join(dir, 'a', 'b'));
    writeFileSync(join(dir, 'a', 'b', 'two.map'), 'a');
    writeFileSync(join(dir, 'a', 'b', 'keep.js'), 'a');

    const files = await walkLocal(dir, ['**/*.map']);

    expect(files.map((f) => f.relPath)).toEqual(['a/b/keep.js']);
  });

  it('a middle **/ spans zero or more directories', async () => {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'b.js'), 'a');
    mkdirSync(join(dir, 'a', 'x'));
    writeFileSync(join(dir, 'a', 'x', 'b.js'), 'a');
    writeFileSync(join(dir, 'keep.txt'), 'a');

    const files = await walkLocal(dir, ['a/**/b.js']);

    expect(files.map((f) => f.relPath)).toEqual(['keep.txt']);
  });

  it('a single * does not cross directory boundaries', async () => {
    writeFileSync(join(dir, 'app.js'), 'a');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'app.js'), 'a');

    const files = await walkLocal(dir, ['*.js']);

    expect(files.map((f) => f.relPath)).toEqual(['sub/app.js']);
  });

  it('treats ? as a literal, not a single-char wildcard', async () => {
    // The glob feature set is documented as "**, *, and literals"; ? must not
    // behave like a regex quantifier and make the preceding char optional.
    writeFileSync(join(dir, 'chunk.js'), 'a');

    const files = await walkLocal(dir, ['chunk-?.js']);

    expect(files.map((f) => f.relPath)).toEqual(['chunk.js']);
  });
});
