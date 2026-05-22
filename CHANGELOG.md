# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-22

### Added

- Initial public release. Angular Architect builder that syncs a build output
  to a Bunny.net Storage Zone using streaming SHA256 diffing — uploads changed
  files, deletes orphaned ones — then purges the matching Pull Zone.
- Optional build-target execution via `buildTarget` (runs the Angular build
  before syncing and auto-resolves the `/browser` output folder).
- Configurable `storageRegion`, `targetFolder`, `ignore` globs, and
  `concurrency`.
- `dryRun` mode and a `purgeAfterUpload` toggle.
- Credentials read from environment variables or a `.env.local` file.

[Unreleased]: https://github.com/lostium/angular-deploy-bunny/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lostium/angular-deploy-bunny/releases/tag/v0.1.0
