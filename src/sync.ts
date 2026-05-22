import type { Diff, LocalFile, RemoteFile } from './types.js';

export function diff(local: LocalFile[], remote: RemoteFile[]): Diff {
  const remoteByPath = new Map(remote.map((f) => [f.relPath, f]));
  const localPaths = new Set(local.map((f) => f.relPath));

  const toUpload: LocalFile[] = [];
  const unchanged: LocalFile[] = [];

  for (const lf of local) {
    const rf = remoteByPath.get(lf.relPath);
    if (rf && rf.sha256 === lf.sha256 && rf.sha256 !== null) {
      unchanged.push(lf);
    } else {
      toUpload.push(lf);
    }
  }

  const toDelete = remote.filter((rf) => !localPaths.has(rf.relPath));

  return { toUpload, toDelete, unchanged };
}
