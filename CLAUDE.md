# CLAUDE.md

Standing instructions for agents working in this repository. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the release steps, module layout, and
development commands — this file only covers what those documents do not.

## Verification

**Local green is not "done" here. Push and let CI decide.** The integration
suite shells out to real `sops` and `age`, and their behaviour differs between
macOS and the Linux runners: an earlier version of `integration/sops.spec.ts`
passed locally and failed every test in CI with
`open /dev/stdin: no such device or address`, because a piped descriptor cannot
be reopened by name on Linux. Stage a temporary file instead — see the `encrypt`
helper in that spec for the pattern.

`pnpm test` deliberately excludes `integration/`. If you touch `secrets.ts`,
`sops.ts`, `credential-values.ts`, `env.ts` or `redact.ts`, run
`pnpm run test:sops` as well; it needs `sops` and `age-keygen` on `PATH`.

## Secrets

- Never log a decrypted credential value, and never let one reach an error
  message. SOPS failures are classified into fixed messages that carry no
  child-process stdout/stderr and no parser excerpts. Keep it that way: a
  "more helpful" error here is a leak.
- `redact.ts` is exact-value defence against accidental logging, not
  containment. Do not present it as more than that.
- Integration tests use throwaway age identities and fake values in a `mkdtemp`
  directory. They must never read a developer's real identity or contact Bunny.

## Angular Architect tests

Pass the `WorkspaceDefinition` straight to `WorkspaceNodeModulesArchitectHost`
— it has an overload that builds the `WorkspaceHost` adapter itself. Do not
hand-roll that adapter, and do not use `addTarget` for deploy targets: both
bypass Angular's real production/staging option merge, so the test ends up
verifying its own merge instead. See `src/deploy-config.spec.ts`.

## Git and releases

- **Branch and open a PR.** Do not commit directly to `main`.
- **Squash-merge only.** `main` is linear and every commit ends with `(#N)`.
  Two consequences worth knowing:
  - `git branch --merged` never lists merged branches, because squashing
    rewrites the SHAs. Check a branch against its merged PR instead.
  - After `gh pr merge --delete-branch`, the local `git pull` prints
    `fatal: Not possible to fast-forward`. The merge **succeeded**; local `main`
    is simply behind. Confirm the trees match, then reset to `origin/main`.
- **Bump the version** by editing `package.json`, or with
  `pnpm version <level> --no-git-tag-version`. Bare `pnpm version` refuses a
  dirty tree and creates a local tag that collides with the release tag.
- **`gh release create --target` requires the full 40-character SHA**; an
  abbreviated one is rejected as `Release.target_commitish is invalid`. Build
  the notes from the matching `CHANGELOG.md` section.
- `publish.yml` refuses a release tag that disagrees with `package.json`, so a
  forgotten bump fails fast instead of reaching npm.

## Documentation

Change a document and the thing it describes in the same commit. A README that
names a command the workflow does not run is worse than an inconsistent one.
