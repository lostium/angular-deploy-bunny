import { describe, expect, it } from 'vitest';
import type { LocalFile, RemoteFile } from './types.js';
import { diff } from './sync.js';

const local = (relPath: string, sha256: string): LocalFile => ({
  relPath,
  absPath: `/abs/${relPath}`,
  size: 1,
  sha256,
});

const remote = (relPath: string, sha256: string | null): RemoteFile => ({
  relPath,
  size: 1,
  sha256,
});

describe('diff', () => {
  it('marks new local files as toUpload', () => {
    const result = diff([local('a', 'h1')], []);
    expect(result.toUpload.map((f) => f.relPath)).toEqual(['a']);
    expect(result.toDelete).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it('marks orphan remote files as toDelete', () => {
    const result = diff([], [remote('a', 'h1')]);
    expect(result.toUpload).toEqual([]);
    expect(result.toDelete.map((f) => f.relPath)).toEqual(['a']);
  });

  it('marks files with identical hash as unchanged', () => {
    const result = diff([local('a', 'h1')], [remote('a', 'h1')]);
    expect(result.toUpload).toEqual([]);
    expect(result.toDelete).toEqual([]);
    expect(result.unchanged.map((f) => f.relPath)).toEqual(['a']);
  });

  it('marks files whose hash differs as toUpload', () => {
    const result = diff([local('a', 'h2')], [remote('a', 'h1')]);
    expect(result.toUpload.map((f) => f.relPath)).toEqual(['a']);
    expect(result.toDelete).toEqual([]);
  });

  it('treats missing remote checksum as a diff (re-uploads)', () => {
    const result = diff([local('a', 'h1')], [remote('a', null)]);
    expect(result.toUpload.map((f) => f.relPath)).toEqual(['a']);
  });

  it('handles a realistic mixed scenario', () => {
    const result = diff(
      [local('keep', 'k'), local('changed', 'new'), local('new', 'n')],
      [remote('keep', 'k'), remote('changed', 'old'), remote('orphan', 'o')],
    );
    expect(result.toUpload.map((f) => f.relPath).sort()).toEqual(['changed', 'new']);
    expect(result.toDelete.map((f) => f.relPath)).toEqual(['orphan']);
    expect(result.unchanged.map((f) => f.relPath)).toEqual(['keep']);
  });
});
