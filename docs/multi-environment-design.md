# Multi-environment deploys: design

**Date:** 2026-09-05
**Status:** agreed approach; consolidated specification for review
**Target release:** 0.2.0 (new optional options, no breaking change)

## Problem

A workspace that deploys the same Angular project to more than one Bunny
environment (for example production and staging) needs a target or named Angular
configuration per environment, each pointing at its own Storage Zone and Pull Zone. The
builder already supports that on the `angular.json` side: every target
carries its own `storageZoneName` and `pullZoneId`.

Credentials are the gap. `loadSecrets()` (`src/env.ts`) always reads
`BUNNY_STORAGE_PASSWORD` and `BUNNY_ACCOUNT_API_KEY`, from the process
environment first and then from `.env.local` (or `.env`) at the workspace
root. Bunny assigns a different password to every Storage Zone, so two targets
in one workspace cannot both find their password under the same name: the
second environment can receive credentials for the wrong zone.

## Goal

Let each deploy target name the environment variables its credentials come
from, so several environments coexist in one workspace and in one `.env.local`,
without changing anything for workspaces that deploy a single environment.
Optionally decrypt SOPS-encrypted dotenv files using age without requiring a
wrapper around `ng deploy`, desktop authentication, or plaintext secret files.

## Design

Three new optional builder options:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `storagePasswordVar` | `string` | `"BUNNY_STORAGE_PASSWORD"` | Name of the environment variable that holds the Storage Zone password for this target |
| `accountApiKeyVar` | `string` | `"BUNNY_ACCOUNT_API_KEY"` | Name of the environment variable that holds the account API key used to purge the Pull Zone for this target |
| `secretsFile` | `string \| null` | `null` | SOPS-encrypted dotenv file; when set, the exclusive source of deployment credentials |

Without `secretsFile`, process environment variables take precedence. Load
`.env.local` if it exists; load `.env` only if `.env.local` does not exist.
Do not fill missing `.env.local` entries from `.env`. Preserve the existing
dotenv loading and cache behavior. `purgeAfterUpload`, `dryRun`, `targetFolder`,
retries and concurrency retain their current behavior.

With `secretsFile`, do not load dotenv files or read deployment credentials
from `process.env`. Both variable-name options select keys in the decrypted
file, using their existing names by default. Missing required keys fail even
if the shell or local dotenv files contain them. Never fall back from a custom
key name to a default name. Reject empty or whitespace-only option values.

### Native SOPS support

Resolve `secretsFile` relative to `context.workspaceRoot`, preserving absolute
paths. Require the external `sops` executable on PATH only in this mode; do not
install it automatically or implement cryptography inside the package.

Run `sops decrypt --input-type dotenv --output-type dotenv <absolute-path>`
through an asynchronous child-process API with a separate argument array and
no shell. Capture stdout in memory and parse it with `dotenv.parse`; never
write plaintext to disk, expand variables, or copy decrypted entries into
`process.env`. Keep decrypted results local to one deployment; do not cache
them across targets. Use a 30-second timeout and a 1 MiB output limit.

The subprocess inherits the environment so SOPS can use its normal age key
discovery, including `SOPS_AGE_KEY_FILE`. This does not make inherited Bunny
variables eligible as deployment credentials. The user provisions identities
outside the repository; prefer separate identities for remote machines or CI.
The builder does not require a desktop session; the chosen SOPS identity must
itself support unattended decryption for unattended deployments.

Decrypt and validate credentials before scheduling the Angular build or making
network calls. Missing executable/file, decryption or integrity failure,
timeout, output overflow, or missing required credentials abort deployment.
Report actionable error categories without forwarding subprocess stdout,
stderr, or raw child-process error messages, which may contain plaintext.
Do not log secrets. Redact resolved credential values from subsequent builder
logs and returned errors, including errors originating in the SDK or HTTP
responses. This reduces accidental disclosure; it does not protect against a
compromised deployment process or guarantee erasure from JavaScript memory.

Example preserving direct Angular commands:

```json
"deploy": {
  "builder": "angular-deploy-bunny:deploy",
  "options": {
    "buildTarget": "my-app:build:production",
    "storageZoneName": "my-zone",
    "pullZoneId": 12345,
    "secretsFile": "secrets/production.enc.env"
  },
  "configurations": {
    "staging": {
      "buildTarget": "my-app:build:staging",
      "storageZoneName": "my-zone-staging",
      "pullZoneId": 67890,
      "secretsFile": "secrets/staging.enc.env"
    }
  }
}
```

Run `ng deploy` or `ng deploy --configuration=staging`. Each encrypted file
contains its own `BUNNY_STORAGE_PASSWORD` and, when purge is enabled,
`BUNNY_ACCOUNT_API_KEY`. Custom variable names remain optional. An existing
plaintext setup needs no changes unless its owner opts into SOPS.

Example: production keeps its current target verbatim; staging adds one option.

```json
"deploy": {
  "builder": "angular-deploy-bunny:deploy",
  "options": {
    "buildTarget": "my-app:build:production",
    "storageZoneName": "my-zone",
    "pullZoneId": 12345,
    "ignore": ["**/*.map"]
  }
},
"deploy-staging": {
  "builder": "angular-deploy-bunny:deploy",
  "options": {
    "buildTarget": "my-app:build:staging",
    "storageZoneName": "my-zone-staging",
    "pullZoneId": 67890,
    "storagePasswordVar": "BUNNY_STORAGE_PASSWORD_STAGING",
    "ignore": ["**/*.map"]
  }
}
```

```sh
# .env.local (gitignored)
BUNNY_STORAGE_PASSWORD=…            # zone my-zone
BUNNY_STORAGE_PASSWORD_STAGING=…    # zone my-zone-staging
BUNNY_ACCOUNT_API_KEY=…             # one account, shared by both targets
```

```sh
ng run my-app:deploy               # production, unchanged
ng run my-app:deploy-staging       # staging
ng run my-app:deploy-staging --dry-run
```

### Alternatives and boundaries

Two alternatives to the traditional variable-name configuration were rejected.
Encrypted per-environment files are supported separately through the exclusive
SOPS source described above; they do not introduce a dotenv precedence chain.

1. **`envFile` option** (a dotenv file per target, for example
   `.env.staging.local`). dotenv does not override variables already present
   in the process environment, so a shell that still exports the production
   `BUNNY_STORAGE_PASSWORD` would silently feed it to the staging deploy.
   Distinct variable names cannot collide. It would also require re-keying the
   once-per-workspace load cache by file path, defining what happens when the
   named file is missing, and a new file convention to gitignore.
2. **`environment` name with a suffix convention** (`staging` implies
   `BUNNY_STORAGE_PASSWORD_STAGING` and `.env.staging.local`). Convention over
   configuration hides the lookup rule from `angular.json` and doubles the test
   surface (name derivation plus file chain). The explicit option says exactly
   which variable is read.

Explicit variable names are also CI-native: GitHub Actions and similar expose
secrets as environment variables, so `BUNNY_STORAGE_PASSWORD_STAGING` works
there with no file-writing step.

## Changes

### `src/schema.json`

Add the three properties, all optional with their defaults; `required` stays
`["storageZoneName"]`.

```json
"storagePasswordVar": {
  "type": "string",
  "default": "BUNNY_STORAGE_PASSWORD",
  "description": "Environment variable holding the Storage Zone password for this target. Lets several targets (production, staging) keep their credentials side by side in one .env.local."
},
"accountApiKeyVar": {
  "type": "string",
  "default": "BUNNY_ACCOUNT_API_KEY",
  "description": "Key holding the account API key used to purge the Pull Zone. Required only when purgeAfterUpload is true."
},
"secretsFile": {
  "type": ["string", "null"],
  "default": null,
  "minLength": 1,
  "description": "SOPS-encrypted dotenv file, relative to the workspace root or absolute. When set, deployment credentials come exclusively from this file. Requires sops on PATH."
}
```

### `src/types.ts`

`DeployOptions` gains optional `storagePasswordVar`, `accountApiKeyVar` and
`secretsFile` fields. Keep them optional for existing typed callers; the schema
and runtime resolver provide defaults. Validate nonblank names at runtime and
add corresponding schema constraints.

### `src/env.ts`

`LoadSecretsOptions` gains two optional fields with the current names as
defaults, so existing direct callers and tests keep compiling and behaving:

```ts
export interface LoadSecretsOptions {
  requireAccountApiKey: boolean;
  workspaceRoot?: string;
  /** Defaults to BUNNY_STORAGE_PASSWORD. */
  storagePasswordVar?: string;
  /** Defaults to BUNNY_ACCOUNT_API_KEY. */
  accountApiKeyVar?: string;
}
```

`loadSecrets()` resolves the names once, reads `process.env[name]`, and its two
error messages name the variable actually looked up (today they hard-code the
default names). The dotenv loading and the `loadedWorkspaceRoots` cache do not
change: the file is loaded once per workspace root, and every target reads its
own variable from the same loaded environment.

Keep this existing synchronous function for traditional loading. Add an async
credential resolver that selects either `loadSecrets()` or a dedicated SOPS
loader, before touching dotenv. Share key selection and required-value
validation between modes. The resolver accepts the three optional fields and
the existing workspace/required-account options. Keep the subprocess boundary
injectable for tests. Do not make existing `loadSecrets()` calls asynchronous.

### `src/deploy.ts`

The deployment credential dependency uses the new resolver and accepts either
a synchronous `Secrets` result or a promise, preserving existing injected
test loaders. Await it and pass all three options plus the workspace and purge
requirement. The startup log line gains the source and variable
name so a wrong target is visible at a glance, for example
`Credentials: BUNNY_STORAGE_PASSWORD_STAGING (storage), BUNNY_ACCOUNT_API_KEY (account)`.
Values are never logged.

### Tests (written first, then the code)

`src/env.spec.ts`:

- custom `storagePasswordVar` and `accountApiKeyVar` resolve from the process
  environment;
- custom names resolve from `.env.local` (one file holding both the default and
  the suffixed variables, only the suffixed one requested);
- a missing custom variable throws an error that mentions the custom name and
  not the default one;
- the existing seven cases stay untouched and keep passing with no options
  given;
- process variables override local files, and a present `.env.local` never
  receives missing values from `.env`;
- two targets in one process select their own configured keys, and missing
  custom keys do not fall back to populated default keys.

SOPS loader/resolver tests:

- default and custom keys, relative/absolute paths, and independent files for
  sequential and concurrent deployments;
- populated process variables and local dotenv files cannot satisfy a missing
  required encrypted-file key;
- no dotenv loading or `process.env` mutation in SOPS mode;
- missing executable/file, failed decryption, timeout and excessive output;
- fixed argument array with no shell, including paths containing spaces;
- subprocess failures containing fake secrets cannot leak through diagnostics;
- absent account key succeeds when purge is disabled;
- an integration check with actual SOPS and a temporary test-only age identity
  verifies the encrypted dotenv format and successful decryption. Never use
  production identities or contact Bunny for this check.

`src/deploy.spec.ts`: through the existing `Deps` seam, assert that
the resolver receives the option values and that omission resolves defaults.
Assert credential failures precede build/network work, legacy deploys never
invoke SOPS, and logs/returned errors redact resolved secrets. `dryRun` retains
its current remote listing and credential requirements in both modes.

### Documentation and packaging

- `README.md`: new section «Multiple environments» with the two-target excerpt
  and the `.env.local` above; the Options table gains the three rows. Document
  SOPS setup, encrypted dotenv format, age identity provisioning, native Angular
  configurations, source exclusivity, and safe migration away from plaintext.
  Keep legacy instructions available. Clearly state that encrypted secrets and
  private keys must never be included in the Angular browser output.
- `.env.local.example`: a commented `BUNNY_STORAGE_PASSWORD_<ENV>=` line. The
  file ships in the tarball (fixed in 0.1.1), so the example reaches users.
- `CHANGELOG.md`: an `### Added` entry under `[Unreleased]`, then released as
  `0.2.0` with the same heading format as the existing entries.
- `package.json`: version `0.2.0` at release time; `engines` and peer ranges
  unchanged. Publishing is a separate operation from this design work.

## Compatibility

- Existing `angular.json` targets need no change: variable names default to
  those used today and `secretsFile` defaults to null. No SOPS installation is
  required for existing projects.
- Existing `.env.local` and `.env` files need no change; the
  `.env.local` → `.env` fallback from 0.1.2 is untouched.
- `loadSecrets()` keeps its signature for callers that pass only
  `requireAccountApiKey` and `workspaceRoot`.
- `--dry-run`, `--no-purge-after-upload` and every other flag behave as before.
- Semantic versioning: minor bump, no deprecations.

## Out of scope

- Several zones in one run, or fan-out to many environments from one target:
  one target, one zone, as today.
- Per-environment Pull Zone edge rules or hostnames: they belong to the
  consuming project's tooling, not to the builder.
- Loading a different plaintext dotenv file per target.
- Secret creation, rotation, key provisioning, bundled SOPS binaries, desktop
  integrations, and additional secret-manager providers.

## Acceptance

- `pnpm test` and `pnpm run typecheck` green on Node 22 and 24.
- A workspace with two targets, one without options and one with
  `storagePasswordVar`, deploys each zone with its own password from a single
  `.env.local`, and `--dry-run` on either target prints the right zone.
- A workspace on 0.1.x upgraded to 0.2.0 with no config change deploys exactly
  as before.
- `ng deploy` and `ng deploy --configuration=staging` can select independent
  SOPS files without command wrappers or plaintext intermediate files.
- SOPS failures never fall back to inherited/local credentials, and traditional
  deployments do not require SOPS.

## References

- [SOPS documentation](https://getsops.io/docs/): age identities and supported formats.
- [SOPS advanced usage](https://getsops.io/docs/usage/advanced/): explicit input/output formats.
- [Angular workspace configurations](https://angular.dev/reference/configs/workspace-config): named target configurations.
