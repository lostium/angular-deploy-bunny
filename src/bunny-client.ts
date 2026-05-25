import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as BunnyStorageSDK from '@bunny.net/storage-sdk';
import { withRetry } from './retry.js';
import { STORAGE_REGIONS, type StorageRegion } from './types.js';
import type { RemoteFile } from './types.js';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BunnyLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

export interface BunnyClientOptions {
  region: StorageRegion;
  zoneName: string;
  storagePassword: string;
  accountApiKey: string | null;
  logger: BunnyLogger;
  /** Additional attempts on a failed network call (0 = no retry). Default 0. */
  retries?: number;
  /** Base backoff in ms for retries. Default 300; set 0 in tests. */
  retryBaseDelayMs?: number;
}

function resolveRegion(region: StorageRegion): BunnyStorageSDK.regions.StorageRegion {
  if (!STORAGE_REGIONS.includes(region)) {
    throw new Error(`Unknown Bunny region: ${region}. Allowed: ${STORAGE_REGIONS.join(', ')}`);
  }
  const map = BunnyStorageSDK.regions.StorageRegion as unknown as Record<StorageRegion, BunnyStorageSDK.regions.StorageRegion>;
  return map[region];
}

export class BunnyClient {
  private readonly zone: BunnyStorageSDK.zone.StorageZone;
  private readonly accountApiKey: string | null;
  private readonly logger: BunnyLogger;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;

  constructor(opts: BunnyClientOptions) {
    this.zone = BunnyStorageSDK.zone.connect_with_accesskey(
      resolveRegion(opts.region),
      opts.zoneName,
      opts.storagePassword,
    );
    this.accountApiKey = opts.accountApiKey;
    this.logger = opts.logger;
    this.retries = opts.retries ?? 0;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 300;
  }

  private retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retries: this.retries,
      baseDelayMs: this.retryBaseDelayMs,
      onRetry: (err, attempt) =>
        this.logger.warn(`Retry ${attempt}/${this.retries} for ${label}: ${errText(err)}`),
    });
  }

  async listAll(targetFolder: string): Promise<RemoteFile[]> {
    const acc: RemoteFile[] = [];
    const queue: string[] = [normalizeDir(targetFolder)];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      const entries: BunnyStorageSDK.file.StorageFile[] = await this.retry(
        `list ${dir}`,
        () => BunnyStorageSDK.file.list(this.zone, dir),
      );
      for (const e of entries) {
        if (e.isDirectory) {
          queue.push(normalizeDir(`${dir}${e.objectName}/`));
          continue;
        }
        const relPath = relativeFromTarget(targetFolder, dir, e.objectName);
        acc.push({
          relPath,
          size: e.length,
          sha256: e.checksum ? e.checksum.toLowerCase() : null,
        });
      }
    }
    return acc;
  }

  async upload(relPath: string, absPath: string, sha256: string, targetFolder: string): Promise<void> {
    const remotePath = joinRemotePath(targetFolder, relPath);
    // Bunny Storage doesn't infer Content-Type from extension; whatever the
    // client sends is what the Pull Zone serves later. Without this, .mjs/.js/.css
    // are stored as application/octet-stream and browsers reject module scripts.
    const contentType = detectContentType(relPath);
    // Open the read stream inside the retried fn: a stream is single-use, so a
    // retry must start from a fresh one.
    await this.retry(`upload ${relPath}`, () => {
      const node = createReadStream(absPath);
      const web = Readable.toWeb(node) as unknown as import('node:stream/web').ReadableStream<Uint8Array>;
      return BunnyStorageSDK.file.upload(this.zone, remotePath, web, { sha256Checksum: sha256, contentType });
    });
  }

  async remove(relPath: string, targetFolder: string): Promise<void> {
    const remotePath = joinRemotePath(targetFolder, relPath);
    await this.retry(`remove ${relPath}`, () => BunnyStorageSDK.file.remove(this.zone, remotePath));
  }

  // Retries transient failures; if it still fails the orchestrator treats it as
  // success-with-warning (the cache expires by TTL and re-running converges).
  async purgePullZone(pullZoneId: number): Promise<void> {
    if (!this.accountApiKey) {
      throw new Error('purgePullZone called without an accountApiKey');
    }
    const accessKey = this.accountApiKey;
    const url = `https://api.bunny.net/pullzone/${pullZoneId}/purgeCache`;
    await this.retry(`purge pull zone ${pullZoneId}`, async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { AccessKey: accessKey },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Pull zone purge failed: ${res.status} ${res.statusText} ${body}`.trim());
      }
    });
  }
}

function normalizeDir(dir: string): string {
  let out = dir.startsWith('/') ? dir : `/${dir}`;
  if (!out.endsWith('/')) out = `${out}/`;
  return out;
}

function relativeFromTarget(targetFolder: string, currentDir: string, name: string): string {
  const base = normalizeDir(targetFolder);
  const full = `${currentDir}${name}`;
  return full.startsWith(base) ? full.slice(base.length) : full.replace(/^\//, '');
}

function joinRemotePath(targetFolder: string, relPath: string): string {
  const base = normalizeDir(targetFolder);
  return `${base}${relPath}`;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

export function detectContentType(relPath: string): string {
  const lower = relPath.toLowerCase();
  const idx = lower.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  return CONTENT_TYPES[lower.slice(idx)] ?? 'application/octet-stream';
}
