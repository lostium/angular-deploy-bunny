import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuilderContext, BuilderOutput, Target } from '@angular-devkit/architect';
import type { DeployOptions } from './types.js';
import { runDeploy, type Deps } from './deploy.js';

function fakeContext(extra: Partial<BuilderContext> = {}): BuilderContext {
  const messages: string[] = [];
  const logger = {
    debug: (m: string) => messages.push(`debug: ${m}`),
    info: (m: string) => messages.push(`info: ${m}`),
    warn: (m: string) => messages.push(`warn: ${m}`),
    error: (m: string) => messages.push(`error: ${m}`),
    fatal: (m: string) => messages.push(`fatal: ${m}`),
  };
  return {
    workspaceRoot: process.cwd(),
    logger,
    target: { project: 'my-app', target: 'deploy' } as Target,
    scheduleTarget: vi.fn(),
    getTargetOptions: vi.fn(),
    validateOptions: vi.fn(),
    reportStatus: vi.fn(),
    reportProgress: vi.fn(),
    reportRunning: vi.fn(),
    addTeardown: vi.fn(),
    ...extra,
  } as unknown as BuilderContext;
}

function baseOptions(overrides: Partial<DeployOptions> = {}): DeployOptions {
  return {
    buildTarget: null,
    outputPath: null,
    storageZoneName: 'my-zone',
    storageRegion: 'Falkenstein',
    targetFolder: '/',
    pullZoneId: 12345,
    purgeAfterUpload: true,
    concurrency: 4,
    retries: 3,
    ignore: [],
    dryRun: false,
    ...overrides,
  };
}

describe('runDeploy', () => {
  let outputPath: string;
  let deps: Deps;
  let client: {
    listAll: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    purgePullZone: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    outputPath = mkdtempSync(join(tmpdir(), 'bunny-deploy-'));
    writeFileSync(join(outputPath, 'index.html'), '<!doctype html>');
    mkdirSync(join(outputPath, 'assets'));
    writeFileSync(join(outputPath, 'assets', 'app.js'), 'console.log(1)');

    client = {
      listAll: vi.fn(async () => []),
      upload: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      purgePullZone: vi.fn(async () => undefined),
    };
    deps = {
      loadSecrets: () => ({ storagePassword: 'sp', accountApiKey: 'ak' }),
      makeClient: () => client as never,
    };
  });

  afterEach(() => {
    rmSync(outputPath, { recursive: true, force: true });
  });

  it('uploads every local file when the remote is empty', async () => {
    const ctx = fakeContext();
    const out = await runDeploy(baseOptions({ outputPath }), ctx, deps);
    expect(out.success).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(client.remove).not.toHaveBeenCalled();
    expect(client.purgePullZone).toHaveBeenCalledWith(12345);
  });

  it('awaits credentials before scheduling a build and forwards source options', async () => {
    let release!: (secrets: { storagePassword: string; accountApiKey: string }) => void;
    const credentials = new Promise<{ storagePassword: string; accountApiKey: string }>((resolve) => { release = resolve; });
    const loadSecrets = vi.fn(() => credentials);
    const ctx = fakeContext();
    const makeClient = vi.fn(deps.makeClient);
    const run = runDeploy(baseOptions({ buildTarget: 'my-app:build:staging', storagePasswordVar: 'STAGING_STORAGE', accountApiKeyVar: 'STAGING_ACCOUNT', secretsFile: 'secrets/staging.json' }), ctx, { loadSecrets, makeClient });
    expect(ctx.scheduleTarget).not.toHaveBeenCalled();
    expect(makeClient).not.toHaveBeenCalled();
    expect(loadSecrets).toHaveBeenCalledWith({ workspaceRoot: ctx.workspaceRoot, requireAccountApiKey: true, storagePasswordVar: 'STAGING_STORAGE', accountApiKeyVar: 'STAGING_ACCOUNT', secretsFile: 'secrets/staging.json' });
    release({ storagePassword: 'storage-sentinel', accountApiKey: 'account-sentinel' });
    await run;
    expect(ctx.scheduleTarget).toHaveBeenCalled();
  });

  it('passes resolved asynchronous credentials to the client', async () => {
    deps.loadSecrets = async () => ({ storagePassword: 'async-storage', accountApiKey: 'async-account' });
    const makeClient = vi.fn(deps.makeClient);
    const out = await runDeploy(baseOptions({ outputPath }), fakeContext(), { ...deps, makeClient });
    expect(out.success).toBe(true);
    expect(makeClient).toHaveBeenCalledWith(expect.objectContaining({ storagePassword: 'async-storage', accountApiKey: 'async-account' }));
  });

  it.each(['sync', 'async'])('aborts before build or network on %s credential failure', async (mode) => {
    const failure = new Error('Missing encrypted credentials');
    deps.loadSecrets = mode === 'sync' ? () => { throw failure; } : async () => { throw failure; };
    const ctx = fakeContext();
    const makeClient = vi.fn(deps.makeClient);
    const out = await runDeploy(baseOptions({ buildTarget: 'my-app:build:staging' }), ctx, { ...deps, makeClient });
    expect(out).toEqual({ success: false, error: 'Missing encrypted credentials' });
    expect(ctx.scheduleTarget).not.toHaveBeenCalled();
    expect(makeClient).not.toHaveBeenCalled();
    expect(client.listAll).not.toHaveBeenCalled();
  });

  it.each(['build', 'client', 'list', 'upload', 'walk'])('redacts returned %s errors after resolving credentials', async (stage) => {
    deps.loadSecrets = () => ({ storagePassword: 'storage-sentinel', accountApiKey: 'account-sentinel' });
    const failure = new Error('storage-sentinel account-sentinel storage-sentinel');
    const ctx = fakeContext();
    const options = baseOptions({ outputPath });
    if (stage === 'build') {
      options.outputPath = null;
      options.buildTarget = 'my-app:build';
      ctx.scheduleTarget = vi.fn().mockRejectedValue(failure);
    } else if (stage === 'client') deps.makeClient = () => { throw failure; };
    else if (stage === 'list') client.listAll.mockRejectedValue(failure);
    else if (stage === 'upload') client.upload.mockRejectedValue(failure);
    else options.outputPath = join(outputPath, 'storage-sentinel-account-sentinel');
    const out = await runDeploy(options, ctx, deps);
    expect(out.success).toBe(false);
    expect(out.error).toContain('[REDACTED]');
    expect(out.error).not.toContain('storage-sentinel');
    expect(out.error).not.toContain('account-sentinel');
  });

  it('redacts direct logs, client diagnostics, cleanup and purge warnings without changing the context logger', async () => {
    const messages: string[] = [];
    const logger = { debug: (m: string) => messages.push(m), info: (m: string) => messages.push(m), warn: (m: string) => messages.push(m) };
    const ctx = fakeContext({ logger: logger as BuilderContext['logger'] });
    deps.loadSecrets = () => ({ storagePassword: 'storage-sentinel', accountApiKey: 'account-sentinel' });
    deps.makeClient = (input) => {
      input.logger.debug('storage-sentinel client debug');
      input.logger.info('account-sentinel client info');
      input.logger.warn('storage-sentinel account-sentinel retry');
      return client as never;
    };
    client.listAll.mockResolvedValue([{ relPath: 'storage-sentinel.js', size: 1, sha256: null }]);
    client.remove.mockRejectedValue(new Error('storage-sentinel cleanup'));
    client.purgePullZone.mockRejectedValue('account-sentinel purge');
    const out = await runDeploy(baseOptions({ outputPath, storageZoneName: 'storage-sentinel' }), ctx, deps);
    expect(out.success).toBe(true);
    expect(messages.join('\n')).toContain('[REDACTED] cleanup');
    expect(messages.join('\n')).toContain('[REDACTED] purge');
    expect(messages.join('\n')).not.toMatch(/storage-sentinel|account-sentinel/);
    expect(ctx.logger).toBe(logger);
    logger.info('storage-sentinel');
    expect(messages.at(-1)).toBe('storage-sentinel');
  });

  it('redacts a secret in the empty-folder safety error', async () => {
    const emptyDir = join(outputPath, 'storage-sentinel');
    mkdirSync(emptyDir);
    deps.loadSecrets = () => ({ storagePassword: 'storage-sentinel', accountApiKey: null });
    client.listAll.mockResolvedValue([{ relPath: 'index.html', size: 1, sha256: null }]);
    const out = await runDeploy(baseOptions({ outputPath: emptyDir, purgeAfterUpload: false }), fakeContext(), deps);
    expect(out.success).toBe(false);
    expect(out.error).toContain('[REDACTED]');
    expect(out.error).not.toContain('storage-sentinel');
  });

  it('does nothing in dry-run mode', async () => {
    const ctx = fakeContext();
    const out = await runDeploy(baseOptions({ outputPath, dryRun: true }), ctx, deps);
    expect(out.success).toBe(true);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
    expect(client.purgePullZone).not.toHaveBeenCalled();
  });

  it('skips unchanged files and deletes orphans after uploads', async () => {
    // sha256 of "<!doctype html>" — verify with: node -e 'const c=require("node:crypto"); console.log(c.createHash("sha256").update("<!doctype html>").digest("hex"))'
    const indexSha = 'fe26c59e91ac8de694b2531dc3bdc1b7faf471d3d7e4e00870af60f5f22897cb';
    client.listAll.mockResolvedValue([
      { relPath: 'index.html', size: 15, sha256: indexSha },
      { relPath: 'old.js', size: 1, sha256: 'whatever' },
    ]);
    const callOrder: string[] = [];
    client.upload.mockImplementation(async () => {
      callOrder.push('upload');
    });
    client.remove.mockImplementation(async () => {
      callOrder.push('remove');
    });

    const out = await runDeploy(baseOptions({ outputPath }), fakeContext(), deps);
    expect(out.success).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.remove).toHaveBeenCalledTimes(1);
    // Uploads run in a separate runWithConcurrency call before deletes, so
    // all 'upload' entries must precede any 'remove' entry.
    expect(callOrder).toEqual(['upload', 'remove']);
  });

  it('skips purge when purgeAfterUpload is false', async () => {
    await runDeploy(
      baseOptions({ outputPath, purgeAfterUpload: false, pullZoneId: null }),
      fakeContext(),
      deps,
    );
    expect(client.purgePullZone).not.toHaveBeenCalled();
  });

  it('aborts before touching the network when purge is on but pullZoneId is null', async () => {
    const out = await runDeploy(
      baseOptions({ outputPath, purgeAfterUpload: true, pullZoneId: null }),
      fakeContext(),
      deps,
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/pullZoneId/);
    expect(client.listAll).not.toHaveBeenCalled();
  });

  it('returns failure and skips purge when an upload fails', async () => {
    client.upload.mockRejectedValueOnce(new Error('5xx'));
    const out = await runDeploy(baseOptions({ outputPath }), fakeContext(), deps);
    expect(out.success).toBe(false);
    expect(client.purgePullZone).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('treats a purge failure as success-with-warning', async () => {
    client.purgePullZone.mockRejectedValue(new Error('503'));
    const out = await runDeploy(baseOptions({ outputPath }), fakeContext(), deps);
    expect(out.success).toBe(true);
  });

  it('runs the build target and resolves outputPath via getTargetOptions', async () => {
    const { dirname, basename } = await import('node:path');
    const parentDir = dirname(outputPath);
    const browserName = basename(outputPath);
    const scheduleResult: BuilderOutput = { success: true };
    const scheduleTarget = vi.fn(async () => ({
      result: Promise.resolve(scheduleResult),
      stop: async () => {},
    }));
    const getTargetOptions = vi.fn(async () => ({
      outputPath: { base: '.', browser: browserName },
    }));
    const ctx = fakeContext({
      workspaceRoot: parentDir,
      scheduleTarget: scheduleTarget as never,
      getTargetOptions: getTargetOptions as never,
    });
    const out = await runDeploy(
      baseOptions({ outputPath: null, buildTarget: 'my-app:build:production' }),
      ctx,
      deps,
    );
    expect(out.success).toBe(true);
    expect(scheduleTarget).toHaveBeenCalledWith(
      { project: 'my-app', target: 'build', configuration: 'production' },
      undefined,
    );
    expect(getTargetOptions).toHaveBeenCalled();
    expect(client.upload).toHaveBeenCalledTimes(2);
  });

  it('refuses to delete the whole remote when the local folder is empty', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'bunny-empty-'));
    try {
      client.listAll.mockResolvedValue([
        { relPath: 'index.html', size: 15, sha256: 'abc' },
        { relPath: 'app.js', size: 3, sha256: 'def' },
      ]);
      const out = await runDeploy(baseOptions({ outputPath: emptyDir }), fakeContext(), deps);
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/empty/i);
      expect(client.remove).not.toHaveBeenCalled();
      expect(client.upload).not.toHaveBeenCalled();
      expect(client.purgePullZone).not.toHaveBeenCalled();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('resolves a relative outputPath against the workspace root, not cwd', async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), 'bunny-ws-'));
    const browserDirName = 'relative-out';
    mkdirSync(join(wsRoot, browserDirName));
    writeFileSync(join(wsRoot, browserDirName, 'index.html'), '<!doctype html>');
    try {
      const ctx = fakeContext({ workspaceRoot: wsRoot });
      const out = await runDeploy(baseOptions({ outputPath: browserDirName }), ctx, deps);
      expect(out.success).toBe(true);
      expect(client.upload).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
