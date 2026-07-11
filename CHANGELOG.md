# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] — 2026-07-11

### Changed

- Bump the `dotenv` runtime dependency from 16 to 17 and load it with
  `quiet: true`, so it no longer prints `injected env ...` into the builder
  output (dotenv 17 flipped that default to logging on load).

### Security

- Override `vite` to `^8.0.16` to close GHSA-fx2h-pf6j-xcff (high) and
  GHSA-v6wh-96g9-6wx3 (moderate). `vite` only reaches this repo transitively
  through vitest's dev server, so runtime installs of the published package
  were never affected.

## [0.1.2] — 2026-06-04

### Changed

- Credentials loader now falls back to `.env` when `.env.local` is absent.
  `.env.local` still takes precedence when both files exist.

## [0.1.1] — 2026-05-25

### Fixed

- Ship `.env.local.example` in the published package. The README's
  `cp node_modules/angular-deploy-bunny/.env.local.example .env.local`
  instruction referenced a file that wasn't included in the tarball.

## [0.1.0] — 2026-05-22

### Added

- Initial public release. Angular Architect builder that syncs a build output
  to a Bunny.net Storage Zone using streaming SHA256 diffing — uploads changed
  files, deletes orphaned ones — then purges the matching Pull Zone.
- Optional build-target execution via `buildTarget` (runs the Angular build
  before syncing and auto-resolves the `/browser` output folder).
- Configurable `storageRegion`, `targetFolder`, `ignore` globs, and
  `concurrency`.
- Automatic `retries` (default 3) with exponential backoff on failed uploads,
  deletes, listings, and Pull Zone purges.
- `dryRun` mode and a `purgeAfterUpload` toggle.
- Credentials read from environment variables or a `.env.local` file.

[Unreleased]: https://github.com/lostium/angular-deploy-bunny/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/lostium/angular-deploy-bunny/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lostium/angular-deploy-bunny/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lostium/angular-deploy-bunny/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lostium/angular-deploy-bunny/releases/tag/v0.1.0
