import { join } from 'node:path';
import {
  createBuilder,
  targetFromTargetString,
  type BuilderContext,
  type BuilderOutput,
} from '@angular-devkit/architect';
import { BunnyClient, type BunnyLogger } from './bunny-client.js';
import { runWithConcurrency } from './concurrency.js';
import { loadSecrets } from './env.js';
import { diff } from './sync.js';
import type { DeployOptions, RemoteFile } from './types.js';
import { walkLocal } from './walk.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ClientLike {
  listAll(targetFolder: string): Promise<RemoteFile[]>;
  upload(relPath: string, absPath: string, sha256: string, targetFolder: string): Promise<void>;
  remove(relPath: string, targetFolder: string): Promise<void>;
  purgePullZone(pullZoneId: number): Promise<void>;
}

export interface Deps {
  loadSecrets: typeof loadSecrets;
  makeClient: (input: {
    region: DeployOptions['storageRegion'];
    zoneName: string;
    storagePassword: string;
    accountApiKey: string | null;
    logger: BunnyLogger;
  }) => ClientLike;
}

const defaultDeps: Deps = {
  loadSecrets,
  makeClient: (input) => new BunnyClient(input),
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveOutputPath(
  options: DeployOptions,
  context: BuilderContext,
): Promise<string> {
  if (options.outputPath) return options.outputPath;
  if (!options.buildTarget) {
    throw new Error('Either buildTarget or outputPath must be set.');
  }
  const target = targetFromTargetString(options.buildTarget);
  const run = await context.scheduleTarget(target, undefined);
  const result = await run.result;
  await run.stop();
  if (!result.success) {
    throw new Error(`Build failed for target ${options.buildTarget}.`);
  }

  // @angular/build:application yields only {success}. Read the build's
  // outputPath from the workspace via getTargetOptions. The build always
  // emits the browser bundle into `<base>/<browser-subdir>` (default
  // subdir name: "browser") regardless of outputMode.
  const buildOpts = await context.getTargetOptions(target);
  const projectName = target.project;
  if (!projectName) {
    throw new Error('Build target has no project name; cannot derive default outputPath.');
  }
  const buildOutputPath = buildOpts['outputPath'];
  let baseDir: string;
  let browserDir = 'browser';
  if (typeof buildOutputPath === 'string') {
    baseDir = buildOutputPath;
  } else if (buildOutputPath && typeof buildOutputPath === 'object') {
    const ob = buildOutputPath as { base?: string; browser?: string };
    baseDir = ob.base ?? join('dist', projectName);
    browserDir = ob.browser ?? 'browser';
  } else {
    baseDir = join('dist', projectName);
  }
  const isAbs = baseDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(baseDir);
  const abs = isAbs ? baseDir : join(context.workspaceRoot, baseDir);
  return join(abs, browserDir);
}

export async function runDeploy(
  options: DeployOptions,
  context: BuilderContext,
  deps: Deps = defaultDeps,
): Promise<BuilderOutput> {
  const log = context.logger;
  try {
    if (options.purgeAfterUpload && options.pullZoneId == null) {
      return {
        success: false,
        error: 'purgeAfterUpload is true but pullZoneId is null. Set pullZoneId or pass --no-purge-after-upload.',
      };
    }

    const secrets = deps.loadSecrets({
      requireAccountApiKey: options.purgeAfterUpload,
      workspaceRoot: context.workspaceRoot,
    });

    const outputPath = await resolveOutputPath(options, context);
    log.info(`Deploying ${outputPath} → bunny:${options.storageZoneName}${options.targetFolder}`);

    const client = deps.makeClient({
      region: options.storageRegion,
      zoneName: options.storageZoneName,
      storagePassword: secrets.storagePassword,
      accountApiKey: secrets.accountApiKey,
      logger: log,
    });

    log.info(`Hashing local files...`);
    const local = await walkLocal(outputPath, options.ignore);
    log.info(`Hashed ${local.length} local file(s).`);

    log.info(`Listing remote files...`);
    const remote = await client.listAll(options.targetFolder);
    log.info(`Listed ${remote.length} remote file(s).`);

    const plan = diff(local, remote);
    const uploadBytes = plan.toUpload.reduce((s, f) => s + f.size, 0);
    log.info(
      `Diff: ${plan.toUpload.length} upload (${formatBytes(uploadBytes)}), ${plan.toDelete.length} delete, ${plan.unchanged.length} unchanged.`,
    );

    if (options.dryRun) {
      for (const f of plan.toUpload) log.debug(`  + ${f.relPath} (${formatBytes(f.size)})`);
      for (const f of plan.toDelete) log.debug(`  - ${f.relPath}`);
      log.info('Dry run complete. No changes made.');
      return { success: true };
    }

    if (plan.toUpload.length > 0) {
      log.info(`Uploading ${plan.toUpload.length} file(s)...`);
      await runWithConcurrency(plan.toUpload, options.concurrency, async (f) => {
        log.debug(`  upload ${f.relPath}`);
        await client.upload(f.relPath, f.absPath, f.sha256, options.targetFolder);
      });
    }

    if (plan.toDelete.length > 0) {
      log.info(`Deleting ${plan.toDelete.length} orphan file(s)...`);
      let deleteFailures = 0;
      await runWithConcurrency(plan.toDelete, options.concurrency, async (f) => {
        try {
          await client.remove(f.relPath, options.targetFolder);
          log.debug(`  delete ${f.relPath}`);
        } catch (err) {
          deleteFailures++;
          log.warn(`Failed to delete ${f.relPath}: ${errMessage(err)}`);
        }
      });
      if (deleteFailures > 0) {
        log.warn(`${deleteFailures} delete(s) failed (cleanup only — site is still consistent).`);
      }
    }

    if (options.purgeAfterUpload && options.pullZoneId != null) {
      try {
        log.info(`Purging pull zone ${options.pullZoneId}...`);
        await client.purgePullZone(options.pullZoneId);
        log.info('Pull zone cache purged.');
      } catch (err) {
        log.warn(
          `Pull zone purge failed: ${errMessage(err)}. Files are uploaded; cache will expire by TTL.`,
        );
      }
    }

    log.info(
      `Done — ${plan.toUpload.length} uploaded, ${plan.toDelete.length} deleted, ${plan.unchanged.length} unchanged.`,
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: errMessage(err) };
  }
}

export default createBuilder<DeployOptions>(runDeploy);
