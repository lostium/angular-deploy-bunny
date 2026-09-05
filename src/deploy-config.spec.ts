import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Architect, createBuilder } from '@angular-devkit/architect';
import { WorkspaceNodeModulesArchitectHost } from '@angular-devkit/architect/node';
import { TestingArchitectHost } from '@angular-devkit/architect/testing';
import { schema, workspaces } from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import { afterEach, describe, expect, it } from 'vitest';
import { runDeploy, type Deps } from './deploy.js';
import builderSchema from './schema.json';
import type { DeployOptions } from './types.js';

function schemaRegistry(): schema.CoreSchemaRegistry {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  return registry;
}

describe('Angular workspace deploy configurations', () => {
  let workspaceRoot: string | undefined;

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  });

  it('merges production and staging deploy configurations before invoking the builder', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'angular-deploy-bunny-config-'));
    for (const environment of ['production', 'staging']) {
      const output = join(workspaceRoot, 'dist', environment, 'browser');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'index.html'), `<!doctype html><title>${environment}</title>`);
    }
    writeFileSync(join(workspaceRoot, 'angular.json'), JSON.stringify({
      version: 1,
      projects: {
        'my-app': {
          projectType: 'application',
          root: '',
          sourceRoot: 'src',
          targets: {
            build: {
              builder: 'test:build',
              options: { outputPath: { base: 'dist/production', browser: 'browser' } },
              configurations: {
                production: { outputPath: { base: 'dist/production', browser: 'browser' } },
                staging: { outputPath: { base: 'dist/staging', browser: 'browser' } },
              },
            },
            deploy: {
              builder: 'angular-deploy-bunny:deploy',
              options: {
                buildTarget: 'my-app:build:production',
                storageZoneName: 'production-zone',
                purgeAfterUpload: false,
                dryRun: true,
              },
              configurations: {
                staging: {
                  buildTarget: 'my-app:build:staging',
                  storageZoneName: 'staging-zone',
                  secretsFile: 'secrets/staging.enc.env',
                },
              },
            },
          },
        },
      },
    }, null, 2));

    const { workspace } = await workspaces.readWorkspace(
      join(workspaceRoot, 'angular.json'),
      workspaces.createWorkspaceHost(new NodeJsSyncHost()),
    );
    const backend = new WorkspaceNodeModulesArchitectHost(workspace, workspaceRoot);
    const host = new TestingArchitectHost(workspaceRoot, workspaceRoot, backend);
    const buildConfigurations: string[] = [];
    const credentialOptions: Array<Parameters<Deps['loadSecrets']>[0]> = [];
    const clientInputs: Array<Parameters<Deps['makeClient']>[0]> = [];
    const deps: Deps = {
      loadSecrets: async (options) => {
        credentialOptions.push(options);
        return { storagePassword: 'test-storage', accountApiKey: null };
      },
      makeClient: (input) => {
        clientInputs.push(input);
        return {
          listAll: async () => [],
          upload: async () => undefined,
          remove: async () => undefined,
          purgePullZone: async () => undefined,
        };
      },
    };
    host.addBuilder(
      'angular-deploy-bunny:deploy',
      createBuilder<DeployOptions>((options, context) => runDeploy(options, context, deps)),
      'Deploy under test',
      builderSchema,
    );
    host.addBuilder(
      'test:build',
      createBuilder((options) => {
        buildConfigurations.push((options['outputPath'] as { base: string }).base);
        return { success: true };
      }),
    );
    const architect = new Architect(host, schemaRegistry());

    const production = await architect.scheduleTarget({ project: 'my-app', target: 'deploy' });
    const staging = await architect.scheduleTarget({ project: 'my-app', target: 'deploy', configuration: 'staging' });
    try {
      expect(await production.result).toMatchObject({ success: true });
      expect(await staging.result).toMatchObject({ success: true });
    } finally {
      await production.stop();
      await staging.stop();
    }

    expect(buildConfigurations).toEqual(['dist/production', 'dist/staging']);
    expect(credentialOptions).toEqual([
      {
        workspaceRoot,
        requireAccountApiKey: false,
        storagePasswordVar: 'BUNNY_STORAGE_PASSWORD',
        accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY',
        secretsFile: null,
      },
      {
        workspaceRoot,
        requireAccountApiKey: false,
        storagePasswordVar: 'BUNNY_STORAGE_PASSWORD',
        accountApiKeyVar: 'BUNNY_ACCOUNT_API_KEY',
        secretsFile: 'secrets/staging.enc.env',
      },
    ]);
    expect(clientInputs.map((input) => input.zoneName)).toEqual(['production-zone', 'staging-zone']);
  });
});
