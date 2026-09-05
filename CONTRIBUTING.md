# Contributing

Thanks for your interest in improving **angular-deploy-bunny**! This is a small,
focused package, so the workflow is lightweight.

## Prerequisites

- **Node.js ≥ 22.13** — required by the pinned pnpm version. (The *published*
  builder requires Node ≥ 22; development just needs the slightly higher pnpm floor.)
- **pnpm** — managed via Corepack, which ships with Node:

  ```sh
  corepack enable
  ```

  The exact version is pinned in `package.json` (`packageManager`), so Corepack
  picks it up automatically.

- **`sops` and `age` (optional)** — only needed to run `pnpm run test:sops`, the
  opt-in suite that exercises real decryption. Everything else works without
  them. CI pins SOPS 3.13.3 and age 1.3.2; nearby versions are expected to work,
  but those are the ones actually verified.

## Getting started

```sh
git clone https://github.com/lostium/angular-deploy-bunny.git
cd angular-deploy-bunny
pnpm install
```

`pnpm install` runs `tsc` via the `prepare` hook, so a successful install also
confirms the project compiles.

## Development commands

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm test`          | Run the vitest suite once.                    |
| `pnpm run test:watch`| Run vitest in watch mode.                     |
| `pnpm run test:sops` | Run the opt-in real-SOPS suite (needs `sops` + `age-keygen`). |
| `pnpm run typecheck` | Type-check without emitting (`tsc --noEmit`). |
| `pnpm run build`     | Compile `src/` to `dist/`.                    |

## Project layout

The package is an Angular Architect builder. Each `src/` module has one job:

| File              | Responsibility                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| `deploy.ts`       | The builder entry point. `runDeploy` orchestrates the pipeline and uses a small `Deps` injection seam so tests bypass the SDK and the filesystem. |
| `bunny-client.ts` | Adapter over `@bunny.net/storage-sdk`: list, upload (with explicit `Content-Type`), remove, and the Pull Zone purge API call. |
| `walk.ts`         | Recursive local file walk with streaming SHA256 and glob-based ignores.   |
| `sync.ts`         | Pure diff: classifies files into `toUpload`, `toDelete`, `unchanged`.     |
| `concurrency.ts`  | Fixed-size, fail-fast async worker pool.                                  |
| `retry.ts`        | `withRetry`: bounded retries with exponential backoff.                    |
| `secrets.ts`      | `resolveSecrets` — picks the credential source. With `secretsFile` set, SOPS is the exclusive source; otherwise the legacy environment path. |
| `sops.ts`         | Runs `sops` as a bounded child process (30 s timeout, SIGKILL, 1 MiB cap) and parses its JSON output. Failures are classified into fixed messages that carry no decrypted material. |
| `credential-values.ts` | `credentialNames` resolves the configured variable names; `selectSecrets` pulls them out of a source map using own-property string checks. |
| `env.ts`          | The synchronous legacy path: `BUNNY_*` from the environment, then `.env.local`, falling back to `.env` only when `.env.local` is absent. |
| `redact.ts`       | `createRedactor` — replaces exact credential values in log and error text.|
| `types.ts`        | Shared types and the `STORAGE_REGIONS` list.                              |
| `schema.json`     | Builder option schema (the source of truth for CLI flags and defaults).   |
| `builders.json`   | Registers the `deploy` builder, pointing at `dist/deploy.js`.             |

Unit specs sit next to the module they cover in `src/`. `integration/` holds the
opt-in suite that runs real SOPS and age; it is excluded from `pnpm test` by
`vitest.config.ts` and selected by `vitest.sops.config.ts`.

## Conventions

- **TypeScript strict mode** is on. Avoid `any`; use `unknown` when a type is
  genuinely uncertain.
- **ESM with `nodenext` resolution** — relative imports must include the `.js`
  extension (e.g. `import { diff } from './sync.js'`).
- **Keep modules single-purpose.** New behavior usually belongs in one of the
  existing files or a new focused module, not bolted onto `deploy.ts`.
- **Every change ships with tests.** Prefer the `Deps` injection seam over
  hitting the network or disk. There are no E2E tests against live Bunny —
  validate real runs with `ng deploy --dry-run`.
- **`integration/` is the one deliberate exception.** It shells out to real
  `sops` and `age-keygen` because mocking them would not prove the format is
  preserved. It uses throwaway keys and fake values in a `mkdtemp` directory,
  and must never touch Bunny or read a developer's real identity.
- If you add or change a builder option, update **`schema.json`**, the
  `DeployOptions` type in **`types.ts`**, and the options table in the README.

## Submitting changes

1. Branch off `main`.
2. Make your change with tests. Run `pnpm run typecheck && pnpm test` locally.
   If you touched credential loading or SOPS, run `pnpm run test:sops` too.
3. Add a line under `## [Unreleased]` in `CHANGELOG.md` describing the change
   from a user's perspective.
4. Open a pull request. CI must pass all three jobs: the unit suite on Node 22
   and 24, the SOPS integration suite on Node 22 and 24, and the Angular 17–22
   compatibility matrix.

## Releasing (maintainers)

1. Move the `## [Unreleased]` entries under a new `## [X.Y.Z] — YYYY-MM-DD`
   heading in `CHANGELOG.md` and update the compare links at the bottom.
2. Bump `version` in `package.json` (SemVer).
3. Commit and push to `main`.
4. Create a GitHub release tagged `vX.Y.Z`. This triggers
   `.github/workflows/publish.yml`, which builds, tests, and runs
   `npm publish --provenance`.

Publishing happens from CI — npm provenance requires it. Authentication uses
npm **Trusted Publishing** (OIDC), so there is no `NPM_TOKEN` secret: the
workflow exchanges a GitHub Actions id-token for a short-lived credential and
attaches provenance automatically. This requires a Trusted Publisher configured
for the package on npmjs.com, matching this repository and the `publish.yml`
workflow file.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
