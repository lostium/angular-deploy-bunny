import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { LocalFile } from './types.js';

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function matchesGlob(relPath: string, glob: string): boolean {
  // Translate the glob to a regex in a SINGLE pass. Doing it in successive
  // .replace() calls is unsafe: expanding ** into `.*` (or `**/` into
  // `(?:.*/)?`) injects `*` characters that a later single-* pass would
  // reprocess, corrupting `.*` into `.[^/]*` and breaking deep matching.
  // Alternation order matters — `**/` and `**` are matched before a lone `*`.
  // Everything else (including `?`) is a literal and gets escaped.
  const pattern = glob.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]?\\]/g, (token) => {
    switch (token) {
      case '**/':
        return '(?:.*/)?'; // any number of leading directories, including none
      case '**':
        return '.*'; // any characters, including /
      case '*':
        return '[^/]*'; // any run of non-slash characters
      default:
        return `\\${token}`; // escape a regex metacharacter → literal match
    }
  });
  return new RegExp(`^${pattern}$`).test(relPath);
}

function isIgnored(relPath: string, ignore: string[]): boolean {
  return ignore.some((g) => matchesGlob(relPath, g));
}

async function hashFile(absPath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function walkLocal(root: string, ignore: string[]): Promise<LocalFile[]> {
  const result: LocalFile[] = [];

  async function recurse(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnored(rel, ignore)) continue;
      const s = await stat(abs);
      result.push({
        relPath: rel,
        absPath: abs,
        size: s.size,
        sha256: await hashFile(abs),
      });
    }
  }

  await recurse(root);
  return result;
}
