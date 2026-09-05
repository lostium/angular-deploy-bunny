# Multi-environment and SOPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support independent deployment credentials and optional native SOPS decryption while retaining direct `ng deploy` and existing configurations.

**Architecture:** Keep the synchronous legacy dotenv loader. Add a small async resolver which selects the legacy loader or an exclusive SOPS credential map; the deploy orchestrator awaits that resolver through its existing dependency seam. SOPS performs cryptography in an external process and returns JSON in memory; the builder owns input validation and safe diagnostics.

**Tech Stack:** TypeScript, Node >=22.0.0, Angular Architect >=0.1700.0/core >=17.0.0, existing dotenv, Vitest, external SOPS with age. No new runtime dependencies.

**Spec:** [multi-environment-design.md](../../multi-environment-design.md). Read alongside [adversarial review](../../multi-environment-review.md).

## Global Constraints

- `secretsFile` defaults to `null`; variable names default to `BUNNY_STORAGE_PASSWORD` and `BUNNY_ACCOUNT_API_KEY`.
- Without `secretsFile`, process environment variables take precedence. Load `.env.local` if it exists; load `.env` only if `.env.local` does not exist.
- With `secretsFile`, do not load dotenv files or read deployment credentials from `process.env`.
- Use a 30-second timeout, forced termination of the direct SOPS child on timeout, and a 1 MiB limit for each captured output stream.
- Variable names must match `^[A-Za-z_][A-Za-z0-9_]*$`; paths must contain a non-whitespace character and no NUL. `null` is allowed only for `secretsFile`.
- Keep `loadSecrets()` synchronous, new `DeployOptions` properties optional and existing `Deps.loadSecrets` property name intact.
- No plaintext intermediate files, no decrypted values in `process.env`, no raw SOPS errors or parser excerpts in logs/errors.
- No publication, version bump, deployment, real credentials, or age identity provisioning in this implementation. Update only the Unreleased changelog.
- Preserve existing Node 22/24 and Angular 17–22 CI matrices. Real SOPS tests run in a separate opt-in job.

## File map and sequence

| File | Responsibility |
| --- | --- |
| `src/credential-values.ts` (new) | Options/defaults and pure credential selection |
| `src/env.ts` | Existing dotenv loading, delegating pure selection |
| `src/sops.ts` (new) | Bounded SOPS execution and JSON decoding |
| `src/secrets.ts` (new) | Exclusive source selection |
| `src/redact.ts` (new) | Per-deployment exact-value redaction |
| `src/deploy.ts` | Async resolution and safe logging/errors |
| `src/bunny-client.ts` | Omit raw purge response body |
| `src/types.ts`, `src/schema.json` | Public optional configuration |
| Corresponding `src/*.spec.ts` | Unit/regression tests |
| `integration/sops.spec.ts`, `vitest.sops.config.ts` (new) | Real SOPS tests outside ordinary unit suite |
| `.github/workflows/ci.yml`, `package.json` | Opt-in integration command and separate CI job |
| `README.md`, `.env.local.example`, `CHANGELOG.md` | Configuration and migration documentation |

Execute tasks 1–6 in order. Commit each tested deliverable using only its named
files. Do not restructure sync, retry, file walking or build-output resolution.

### Task 1: Pure selection and legacy compatibility

**Files:** create `src/credential-values.ts`, `src/credential-values.spec.ts`; modify `src/env.ts`, `src/env.spec.ts`.

**Interfaces:**

```ts
// credential-values.ts; move existing interfaces here and re-export from env.ts
export interface Secrets { storagePassword: string; accountApiKey: string | null }
export interface LoadSecretsOptions {
  requireAccountApiKey: boolean;
  workspaceRoot?: string;
  storagePasswordVar?: string;
  accountApiKeyVar?: string;
}
export interface CredentialNames { storagePasswordVar: string; accountApiKeyVar: string }
export function credentialNames(options: LoadSecretsOptions): CredentialNames;
export function selectSecrets(
  values: Record<string, unknown>, options: LoadSecretsOptions,
  source: 'environment' | 'sops',
): Secrets;
// env.ts retains export function loadSecrets(options: LoadSecretsOptions): Secrets
```

- [ ] Add failing selection tests. Example (imports from Vitest and the new module):

```ts
it('does not substitute the default key or inherit a missing key', () => {
  const opts = { requireAccountApiKey: false, storagePasswordVar: 'STAGING' };
  expect(() => selectSecrets({ BUNNY_STORAGE_PASSWORD: 'production' }, opts, 'sops'))
    .toThrow(/STAGING/);
  expect(() => selectSecrets(Object.create({ STAGING: 'inherited' }), opts, 'sops'))
    .toThrow(/STAGING/);
});
it.each(['demo#suffix', '"quoted"', ' spaced ', '$VALUE', 'a=b'])('preserves %s', value => {
  expect(selectSecrets({ BUNNY_STORAGE_PASSWORD: value },
    { requireAccountApiKey: false }, 'sops').storagePassword).toBe(value);
});
```

- [ ] Add cases for undefined/default names, null/empty/whitespace/invalid names via runtime casts, selected numbers/objects, absent and empty optional account values, required empty values, and unrelated non-string entries. Assert invalid-value messages never include credential values.
- [ ] Extend existing env test setup to cover process precedence, `.env.local` missing an entry present in `.env`, two custom names in one file and missing custom name with populated default. Preserve the seven original tests.
- [ ] Run `pnpm exec vitest run src/credential-values.spec.ts src/env.spec.ts`; expect failure on the new selection module.
- [ ] Implement pure selection with this lookup and validate names using a type check plus the exact regex. Default only on `undefined`, not null. Preserve original missing-variable messages in environment mode; SOPS messages refer to the encrypted source and key name, never shell fallback.

```ts
const value = Object.hasOwn(values, name) ? values[name] : undefined;
// Required: typeof value === 'string' && value.length > 0.
// Optional account: undefined -> null; strings including '' unchanged;
// a present value of another type throws a fixed invalid-credential message.
```

- [ ] Change only the selection portion of `loadSecrets`: validate names before `ensureDotenv`, keep file loading/cache untouched, then return `selectSecrets(process.env, options, 'environment')`.
- [ ] Run the two targeted test files and `pnpm run typecheck`; expect all passing. Commit `feat: support configurable credential variable names`.

### Task 2: Bounded SOPS loader with safe JSON output

**Files:** create `src/sops.ts`, `src/sops.spec.ts`.

**Interfaces:** consumes `LoadSecretsOptions` only in later resolver; produces:

```ts
export type SopsRunner = (absolutePath: string) => Promise<string>;
export function runSops(absolutePath: string): Promise<string>;
export function loadSopsValues(
  absolutePath: string, run?: SopsRunner,
): Promise<Record<string, unknown>>;
```

- [ ] Write failing parser tests with injected runners returning JSON, malformed JSON containing a fake secret, null, array and primitive output. Test own-property handling through Task 1 selection.

```ts
it('keeps hash characters without dotenv re-parsing', async () => {
  const run = vi.fn(async () => '{"BUNNY_STORAGE_PASSWORD":"demo#suffix"}');
  expect(await loadSopsValues('/workspace/staging.enc.env', run))
    .toEqual({ BUNNY_STORAGE_PASSWORD: 'demo#suffix' });
});
it('hides malformed decrypted output', async () => {
  await expect(loadSopsValues('/workspace/file', async () => 'FAKE-SECRET-invalid'))
    .rejects.toThrow('SOPS returned invalid credential data.');
});
```

- [ ] Mock `node:child_process` and filesystem stat at the module boundary to test `runSops`: file missing, directory, permission failure, executable missing, nonzero exit with stdout/stderr secrets, timeout, maxBuffer and successful execution. Assert error messages and absent `cause`, not raw Node error equality.
- [ ] Run `pnpm exec vitest run src/sops.spec.ts`; expect failure.
- [ ] Implement stat validation separately from child execution so file ENOENT is not mistaken for missing SOPS. Execute with callback `execFile` wrapped in a Promise:

```ts
const args = ['decrypt', '--input-type', 'dotenv', '--output-type', 'json', absolutePath];
const settings = {
  encoding: 'utf8' as const, shell: false, windowsHide: true,
  timeout: 30_000, killSignal: 'SIGKILL' as const, maxBuffer: 1024 * 1024,
};
// execFile('sops', args, settings, callback); close child.stdin immediately.
// Retain normal env inheritance; never append credentials to argv.
```

- [ ] Translate filesystem errors into `Secrets file not found.`, `Secrets file must be a regular file.`, or `Cannot read secrets file.`. Translate child errors into `SOPS executable not found on PATH.`, `SOPS output exceeded 1 MiB.`, `SOPS decryption timed out or was terminated.`, or `SOPS decryption failed. Check the encrypted file and age identity configuration.`. Check maxBuffer before killed/signal. Never interpolate raw errors or attach causes; catch JSON parsing separately with `SOPS returned invalid credential data.`.
- [ ] `loadSopsValues` uses `JSON.parse` and accepts only non-null, non-array objects. Do not use dotenv, expansion or caching. `runSops` is the error-sanitizing boundary; `loadSopsValues` propagates its safe errors, and catches only its own JSON parsing errors. Injected runners must obey that same safe-error contract; test untrusted child errors at the mocked execFile boundary, not by inventing an unsafe runner contract.
- [ ] Test separate argument passing for spaces and shell metacharacters in paths, no shell execution, stdin closure and both output limits. Run targeted tests and typecheck. Commit `feat: decrypt SOPS credentials with bounded safe execution`.

### Task 3: Exclusive resolver and public configuration

**Files:** create `src/secrets.ts`, `src/secrets.spec.ts`, `src/schema.spec.ts`; modify `src/schema.json`, `src/types.ts`.

**Interfaces:**

```ts
export interface ResolveSecretsOptions extends LoadSecretsOptions { secretsFile?: string | null }
export interface SecretSources {
  environment: (options: LoadSecretsOptions) => Secrets;
  sops: (absolutePath: string) => Promise<Record<string, unknown>>;
}
export function resolveSecrets(options: ResolveSecretsOptions, sources?: SecretSources): Promise<Secrets>;
```

- [ ] Write failing exclusive-source test:

```ts
it('does not fall back when the encrypted file lacks a key', async () => {
  const sources = {
    environment: vi.fn(() => ({ storagePassword: 'production', accountApiKey: null })),
    sops: vi.fn(async () => ({})),
  };
  await expect(resolveSecrets({ requireAccountApiKey: false, secretsFile: 'stage.enc.env' }, sources))
    .rejects.toThrow(/BUNNY_STORAGE_PASSWORD/);
  expect(sources.environment).not.toHaveBeenCalled();
});
```

- [ ] Add default/null routing, invalid runtime path types/empty/NUL, absolute and workspace-relative paths, concurrent maps resolved in reversed order, source rejection, and process-environment snapshots before/after SOPS resolution. Unit test null/array data in Task 2, not through impossible typed source mocks.
- [ ] Run `pnpm exec vitest run src/secrets.spec.ts src/schema.spec.ts`; expect failure.
- [ ] Implement defaults `{ environment: loadSecrets, sops: loadSopsValues }`, validate names/path before any source call, branch only on null/undefined, and use native `path.resolve(workspaceRoot ?? process.cwd(), secretsFile)`. Await SOPS map and call `selectSecrets(values, options, 'sops')`. No module-global secret state.
- [ ] Add the public types and schema properties:

```ts
// DeployOptions additions, all optional:
storagePasswordVar?: string;
accountApiKeyVar?: string;
secretsFile?: string | null;
```

```json
{
  "storagePasswordVar": { "type": "string", "default": "BUNNY_STORAGE_PASSWORD", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$" },
  "accountApiKeyVar": { "type": "string", "default": "BUNNY_ACCOUNT_API_KEY", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$" },
  "secretsFile": { "type": ["string", "null"], "default": null, "pattern": "^(?=[\\s\\S]*\\S)[^\\u0000]+$" }
}
```

Use the descriptions from the spec, referring to keys in the selected source.
Retain `required: ["storageZoneName"]` and every other schema property.
- [ ] Exercise the actual schema with Angular `schema.CoreSchemaRegistry` and `schema.transforms.addUndefinedDefaults`. Angular 22 returns promises; older supported versions can return observables. Use this test-local adapter for both compile and validation results, without adding a direct RxJS dependency:

```ts
type AsyncValue<T> = PromiseLike<T> | {
  subscribe(observer: { next(value: T): void; error(reason: unknown): void }): unknown;
};
function settle<T>(value: AsyncValue<T>): Promise<T> {
  if ('subscribe' in value) {
    return new Promise<T>((resolve, reject) => {
      value.subscribe({ next: resolve, error: reject });
    });
  }
  return Promise.resolve(value);
}
// registry.addPostTransform(schema.transforms.addUndefinedDefaults);
// const validate = await settle(registry.compile(builderSchema));
// const result = await settle(validate({ storageZoneName: 'zone' }));
```

Validate default values in `result.data`, explicit SOPS settings, and rejection
of empty/invalid names and whitespace/NUL paths. This is a behavior test of
Angular validation, not a JSON snapshot.
- [ ] Run targeted resolver/schema tests plus typecheck. Verify an existing object typed as `DeployOptions` compiles without new properties (typecheck a small temporary fixture under `src`, remove after check). Commit `feat: add exclusive optional SOPS credential source`.

### Task 4: Wire deployment and redact observable errors

**Files:** create `src/redact.ts`, `src/redact.spec.ts`; modify `src/deploy.ts`, `src/deploy.spec.ts`, `src/bunny-client.ts`, `src/bunny-client.spec.ts`.

**Interfaces:** consumes `ResolveSecretsOptions`, `resolveSecrets`, `Secrets`; produces:

```ts
export function createRedactor(secrets: Secrets): (message: string) => string;
// Deps retains its existing field name:
loadSecrets: (options: ResolveSecretsOptions) => Secrets | Promise<Secrets>;
// defaultDeps.loadSecrets = resolveSecrets
```

- [ ] Add redactor tests for repeated values, overlapping values (longest first), regex metacharacters, empty/null account values and separate per-deployment instances. Use a single regex alternation of escaped nonempty secrets so replacement text is not reprocessed.

```ts
it('redacts literal overlapping keys', () => {
  const redact = createRedactor({ storagePassword: 'a+b', accountApiKey: 'a+b-long' });
  expect(redact('a+b-long / a+b')).toBe('[REDACTED] / [REDACTED]');
});
```

- [ ] Extend the existing orchestrator suite (reuse `baseOptions`, `fakeContext`, `client` and `deps`). Add an async rejection test:

```ts
it('aborts before the build on credential failure', async () => {
  const ctx = fakeContext();
  deps.loadSecrets = vi.fn(async () => { throw new Error('SOPS decryption failed.'); });
  const out = await runDeploy(baseOptions({ buildTarget: 'my-app:build:staging', secretsFile: 'stage.enc.env' }), ctx, deps);
  expect(out.success).toBe(false);
  expect(ctx.scheduleTarget).not.toHaveBeenCalled();
  expect(client.listAll).not.toHaveBeenCalled();
});
```

- [ ] Add assertions for forwarding all options, synchronous existing injected loaders, async resolution, dry-run still listing/no writes, optional account without purge, SDK retry messages through injected logger, deletion/purge warnings and returned upload errors. Populate fake errors with the exact test credentials and assert absence from all captured strings. Cover early returned empty-output errors as well as catch errors.
- [ ] Run `pnpm exec vitest run src/redact.spec.ts src/deploy.spec.ts src/bunny-client.spec.ts`; expect new cases to fail.
- [ ] Implement redaction with this literal escaping, distinct nonempty values sorted longest first, and a single global replacement:

```ts
const escaped = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const pattern = new RegExp(escaped.join('|'), 'g');
return (message: string) => message.replace(pattern, '[REDACTED]');
```

Here `values` is the sorted nonempty unique credential list. Return the identity
function if the list is empty. Test metacharacters to verify escaping.
- [ ] In `runDeploy`, initialize a local identity redactor before `try`, await `deps.loadSecrets`, then assign the secret redactor before logging source, resolving output or creating a client. Use a new local logger facade with `debug/info/warn` closures which call the original context logger with redacted strings; do not mutate the context logger. Pass that facade to `makeClient`. Redact all returned error strings, including direct returns and the outer catch. Existing structured fixed failures remain failures; upload/delete/purge behavior stays intact.
- [ ] Change purge HTTP failure to a status-only message:

```ts
if (!res.ok) {
  await res.body?.cancel().catch(() => undefined);
  throw new Error(`Pull zone purge failed: ${res.status}`);
}
```

Update client tests to prove a response body containing a fake secret is absent
from thrown errors/retry logs. Do not claim interception of arbitrary SDK console
output or scheduled-build logs.
- [ ] Run targeted tests and typecheck. Commit `feat: resolve deployment secrets asynchronously and redact diagnostics`.

### Task 5: Real SOPS and Angular integration checks

**Files:** create `integration/sops.spec.ts`, `vitest.sops.config.ts`, `src/deploy-config.spec.ts`; modify `package.json`, `.github/workflows/ci.yml`.

**Interfaces:** consumes `resolveSecrets`, default builder export, the published schema. No additional production API.

- [ ] Create opt-in config and command so ordinary tests never require SOPS:

```ts
// vitest.sops.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['integration/**/*.spec.ts'], environment: 'node', testTimeout: 45_000,
} });
```

`package.json` script: `"test:sops": "vitest run --config vitest.sops.config.ts"`.
- [ ] In real integration setup create a temporary directory with `mkdtemp`, generate a fresh identity by capturing `age-keygen` stdout, derive recipient with `age-keygen -y` stdin, and encrypt only fake values using SOPS stdin. Store only encrypted outputs and the test identity (mode 0600) in that temporary directory; never print captured key material. Set `SOPS_AGE_KEY_FILE` only for tests, clear other `SOPS_AGE_*` overrides during the test, and restore the original environment in `finally`. Use a fresh test identity not configured in any user key store, so wrong-key tests cannot succeed via ambient identities. Encrypt with an explicit recipient and no repository creation rules (use a temporary empty SOPS config if needed). Remove only the explicit directory returned by `mkdtemp`.

```ts
const identity = execFileSync('age-keygen', [], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
const recipient = execFileSync('age-keygen', ['-y'], {
  input: identity, encoding: 'utf8',
}).trim();
const encrypted = execFileSync('sops', [
  'encrypt', '--age', recipient, '--input-type', 'dotenv',
  '--output-type', 'dotenv', '/dev/stdin',
], { input: 'BUNNY_STORAGE_PASSWORD=demo#suffix\n', encoding: 'utf8' });
```

This real integration harness targets Linux/macOS; Windows unit tests still use
native paths and mocked subprocesses. Do not infer Windows integration coverage.
- [ ] Assert actual resolver output for `demo#suffix`, literal quotes, spaces, `$`, equals and backslashes (respect SOPS input escape semantics). Also assert independent concurrent files, missing required key despite environment fallback, wrong identity, and tampered ciphertext fail. Snapshot the test directory to confirm the loader writes no plaintext output.
- [ ] Run `pnpm test:sops`. Missing binaries must fail this explicit command with a setup error, not silently skip; ordinary `pnpm test` excludes it.
- [ ] Add an Angular Architect configuration test using `WorkspaceNodeModulesArchitectHost` as the backend of `TestingArchitectHost`, and `Architect`. Create a temporary minimal `angular.json` matching the spec, load it through `workspaces.readWorkspace` with `workspaces.createWorkspaceHost(new NodeJsSyncHost())`, then construct the workspace backend. Register the real deploy schema and a `createBuilder` handler calling `runDeploy(options, context, fakeDeps)` on the testing host. Do not use `addTarget` for deploy targets: it bypasses the real workspace configuration merge. Register a fake build builder that returns success and use a temporary output folder. Schedule production and staging, await results and stop runs in `finally`. Assert zone, build configuration, secret file and default names at the injected dependencies. Neither call contacts Bunny.

```ts
// Imports: workspaces from @angular-devkit/core; NodeJsSyncHost from
// @angular-devkit/core/node; WorkspaceNodeModulesArchitectHost from
// @angular-devkit/architect/node; TestingArchitectHost from its /testing entry.
const backend = new WorkspaceNodeModulesArchitectHost(workspace, workspaceRoot);
const host = new TestingArchitectHost(workspaceRoot, workspaceRoot, backend);
host.addBuilder('angular-deploy-bunny:deploy',
  createBuilder<DeployOptions>((options, context) => runDeploy(options, context, fakeDeps)),
  'Deploy under test', builderSchema);
const architect = new Architect(host, registry);
const run = await architect.scheduleTarget({ project: 'my-app', target: 'deploy', configuration: 'staging' });
try { expect((await run.result).success).toBe(true); } finally { await run.stop(); }
```
- [ ] Add a separate CI job on Ubuntu/Node 22 and 24 installing SOPS 3.13.3 and age 1.3.2, verified against release checksums. During implementation fetch official release metadata, pin download URLs and checksum literals in the job; never use an unversioned installer or pipe a network script into a shell. Run frozen install and `pnpm test:sops`. Existing test jobs remain SOPS-free. Keep checksum verification and downloads explicit, and do not invent hashes in this plan.
- [ ] Run config integration tests, `pnpm test:sops` and typecheck. Commit `test: verify native SOPS and Angular environment selection`.

### Task 6: Document migration and run release-readiness checks

**Files:** modify `README.md`, `.env.local.example`, `CHANGELOG.md`. Packaging configuration changes only if a verification exposes a concrete missing runtime file.

**Interfaces:** documents the three public fields and unchanged `ng deploy` entry point.

- [ ] Add the spec's native Angular production/staging example and legacy custom-name example to README. Explain process-first legacy loading and the `.env.local` existence rule. Add three Options rows. Include this SOPS operational text:

```text
Install sops on PATH. Provision an age identity outside your repository and
configure SOPS_AGE_KEY_FILE if needed. Encrypt a dotenv file with SOPS, storing
its values without shell-style quotes: quotes are literal in this format.
Set secretsFile in your deploy options. Run ng deploy, or
ng deploy --configuration=staging. The encrypted file is the only credential
source; decryption failures never use your shell or local dotenv credentials.
```

- [ ] Document encrypted input preparation with `sops encrypt --input-type dotenv --output-type dotenv --age <public-recipient> <input-file>` as a user-run example, explaining that input creation is outside the builder and existing plaintext must be retired after successful verification. Do not execute it with user credentials. Include: private identity outside Git, no secrets/private keys in Angular assets or browser environment files, minimum remote access, trusted build code, exact-value redaction limits, and unchanged credential requirements during dry-run.
- [ ] Add a commented `# BUNNY_STORAGE_PASSWORD_STAGING=` to `.env.local.example` and an Unreleased Added entry for configurable names/native SOPS, plus Security entry for redaction/body suppression. Keep package version 0.1.3; 0.2.0 is a later release action.
- [ ] Run required checks once after final edits:

```sh
pnpm test
pnpm test:sops
pnpm run typecheck
pnpm run build
git diff --check
```

- [ ] Smoke-test `import('./dist/deploy.js')` exposes default builder and `runDeploy`, as existing CI does. Inspect `npm pack --dry-run --json`: new emitted runtime modules and `src/schema.json` must be included; `integration/`, private identities and decrypted fixtures must be absent. Do not publish or deploy.
- [ ] Confirm existing Node/Angular CI checks and new SOPS jobs pass before claiming full matrix support. If only local tests ran, report their actual versions and leave CI verification explicitly pending.
- [ ] Commit only documentation/final corrections with `docs: explain multi-environment SOPS deployments`. Report changed behavior, executed checks and any unverified platforms.

## Plan self-review

- Source exclusivity, defaults and legacy synchronous API: Tasks 1 and 3.
- SOPS lifecycle, format preservation, bounds and sanitized failures: Tasks 2 and 5.
- Native deploy, async injection, redaction, unchanged sync/dry-run: Task 4.
- Angular merged configurations and actual cryptography round trip: Task 5.
- User setup, migration, packaging and supported-version checks: Tasks 5 and 6.
- Remaining trust boundaries match the corrected specification; no secret-provider
  framework, global dotenv refactor, wrapper command or release operation added.
