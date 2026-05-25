# angular-deploy-bunny

[![CI](https://github.com/lostium/angular-deploy-bunny/actions/workflows/ci.yml/badge.svg)](https://github.com/lostium/angular-deploy-bunny/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/angular-deploy-bunny.svg)](https://www.npmjs.com/package/angular-deploy-bunny)
[![license](https://img.shields.io/npm/l/angular-deploy-bunny.svg)](./LICENSE)

An Angular [Architect](https://angular.dev/tools/cli/cli-builder) builder that
deploys your build output to a [Bunny.net](https://bunny.net) CDN **Storage
Zone** with SHA256-based incremental sync, then purges the matching **Pull
Zone**. Wire it up as your project's `ng deploy` target.

- **Incremental** — hashes every file with streaming SHA256 and only uploads
  what changed; orphaned remote files are deleted.
- **Safe ordering** — uploads first, deletes second. If an upload fails it
  aborts before deleting anything, so the live site stays consistent.
  Re-running converges.
- **Cache purge** — calls the Pull Zone purge API after a successful sync. A
  failed purge is a warning, not an error (the cache expires by TTL).
- **No secrets in config** — credentials come from environment variables or a
  gitignored `.env.local`.

## Install

```sh
pnpm add -D angular-deploy-bunny
# or: npm i -D angular-deploy-bunny
```

Requires **Angular 17+** using the esbuild-based **application builder** — the
default since v17, which emits the browser bundle into a `browser/` folder — and
**Node 22+**. The test suite runs in CI against Angular 17 through 21.

## Quick start

Add a `deploy` target to the project in your `angular.json`:

```json
"deploy": {
  "builder": "angular-deploy-bunny:deploy",
  "options": {
    "buildTarget": "my-app:build:production",
    "storageZoneName": "my-zone",
    "storageRegion": "Falkenstein",
    "pullZoneId": 12345,
    "ignore": ["**/*.map"]
  }
}
```

Then deploy:

```sh
ng deploy                       # build + sync + purge
ng deploy --dry-run             # preview the diff, no network writes
ng deploy --no-purge-after-upload
```

With `buildTarget` set, the builder runs the Angular build first and syncs its
`/browser` output folder automatically. If you'd rather sync a folder you
already built, drop `buildTarget` and set `outputPath` instead.

## Credentials

The builder never stores secrets in `angular.json`. It reads two environment
variables, falling back to a `.env.local` file at your workspace root:

```sh
cp node_modules/angular-deploy-bunny/.env.local.example .env.local
```

```ini
BUNNY_STORAGE_PASSWORD=…   # Storage Zones → <zone> → FTP & API Access → Password
BUNNY_ACCOUNT_API_KEY=…    # Account → API → API Key (only needed for purge)
```

Add `.env.local` to your `.gitignore`. The `BUNNY_ACCOUNT_API_KEY` is only
required when `purgeAfterUpload` is `true` (the default); if either secret is
missing the build aborts before touching the network with a clear message.

## Options

| Option             | Type             | Default        | Notes                                                                                         |
| ------------------ | ---------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `storageZoneName`  | `string`         | **required**   | Name of the Bunny Storage Zone.                                                               |
| `buildTarget`      | `string \| null` | `null`         | Angular build target to run first, e.g. `my-app:build:production`. If null, set `outputPath`. |
| `outputPath`       | `string \| null` | `null`         | Folder to sync. Defaults to the build target's output + `/browser`.                           |
| `storageRegion`    | enum             | `Falkenstein`  | One of: Falkenstein, London, NewYork, LosAngeles, Singapore, Stockholm, SaoPaulo, Johannesburg, Sydney. |
| `targetFolder`     | `string`         | `/`            | Subpath inside the storage zone.                                                              |
| `pullZoneId`       | `number \| null` | `null`         | Required when `purgeAfterUpload` is true.                                                      |
| `purgeAfterUpload` | `boolean`        | `true`         | Purge the Pull Zone cache after a successful sync.                                             |
| `concurrency`      | `number`         | `8`            | Parallel uploads/deletes.                                                                      |
| `retries`          | `number`         | `3`            | Retries per failed upload/delete/list/purge (exponential backoff). `0` disables.              |
| `ignore`           | `string[]`       | `[]`           | Glob patterns to skip. Supports `**`, `*`, and literals.                                       |
| `dryRun`           | `boolean`        | `false`        | Compute and print the diff without writing anything.                                          |

## How it works

1. Walks the output folder computing a streaming SHA256 per file.
2. Lists the Storage Zone recursively. The Bunny SDK returns SHA256 checksums in
   the listing, so no files are downloaded.
3. Diffs local vs remote by hash into `toUpload`, `toDelete`, `unchanged`.
4. Uploads changed files (with the correct `Content-Type` per extension, since
   Bunny Storage does not infer it), then deletes orphaned remote files.
5. Purges the Pull Zone via the public purge API.

If an upload fails, the run aborts before any delete or purge. If the purge
fails, the run still succeeds with a warning — the files are uploaded and the
cache expires by TTL.

## Develop

```sh
pnpm install
pnpm test          # vitest
pnpm run typecheck
pnpm run build     # emits dist/
```

Tests cover env loading, file walking, diffing, the concurrency pool, the Bunny
client, and the deploy orchestrator. The orchestrator uses a small dependency
injection seam so tests bypass the SDK and the real filesystem; there are no
E2E tests against live Bunny — verify those with `ng deploy --dry-run`.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development setup, project layout, and release process.

## License

[MIT](./LICENSE) © Lostium
