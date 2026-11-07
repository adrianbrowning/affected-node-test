# Production roadmap

This roadmap targets parity with Vitest's affected-test selection subsystem, not its assertion, mocking, browser, coverage, or reporting APIs. The supporting comparison is in [vitest-feature-parity.md](./vitest-feature-parity.md).

## Completed foundation

- [x] Runtime ESM and CommonJS dependency recording
- [x] Merge-base Git selection with staged and untracked changes
- [x] Conservative handling for unknown, renamed, and deleted JavaScript files
- [x] Versioned, validated, atomically replaced graph cache
- [x] Exact Node and project-configuration cache fingerprints
- [x] Bounded parallel execution with deterministic output
- [x] Signal forwarding, forced termination, temporary-file cleanup, and cache preservation
- [x] Integration tests using isolated temporary Git repositories
- [x] mdcode-ts synchronized README examples and documentation drift check

## P0: correctness contract

- [x] Persist failed-test status and always reselect failures until they pass
- [x] Introduce a project configuration file and schema
  - [x] Configurable test `include` and `exclude` patterns
  - [x] Configurable `forceRerunTriggers`
  - [x] Configurable non-module `watchTriggerPatterns`
- [x] Track project-wide dependencies
  - [x] Per-test setup files and their observed transitive imports
  - [x] Once-per-run global setup files, teardown, and observed transitive imports
  - [x] Environment files and explicit referenced configuration dependencies
  - [x] Mock/snapshot conventions and explicit runner/serializer dependencies
  - [x] User-declared dependency globs with content fingerprints
- [x] Separate selection providers behind one normalized dependency model
  - [x] Git-based `affected [ref]`
  - [x] Non-Git `since-last-run`
- [x] Close the untaken-import gap
  - [x] Build a static graph for literal ESM and CommonJS imports
  - [x] Define conservative fallback for unresolved imports and parser failures
- [x] Document and test the mandatory full-suite CI gate

## P1: user-facing parity

- [x] Add `related <files...>` selection
- [x] Add ref-less `affected` for staged, unstaged, and untracked changes
- [x] Complete cache lifecycle controls
  - [x] Add `clear-cache`
  - [x] Add configurable cache location
- [x] Add persistent watch mode
- [x] Add multiple project/package roots with isolated caches and triggers
  - [x] Validate workspace project roots and run deterministic baselines
  - [x] Isolate project discovery, configuration, caches, and cache clearing
  - [x] Route explicit related-file selection to owning projects
  - [x] Route Git affected selection to owning projects
  - [x] Coordinate persistent watch mode across projects
- [ ] Support configurable discovery and decide the TypeScript/JSX loader contract

## P2: efficiency and ergonomics

- [ ] Run only new or unrecorded tests when inventory grows
- [ ] Store durations and schedule historically slow tests first
- [ ] Consider percentage concurrency and `last-failed`
- [ ] Consider optional workspace project filtering
- [ ] Spill large buffered child output to temporary files

## Release readiness

- [ ] Initialize the final package directory as the repository root
- [x] Add CI for Node 22.15, current LTS, and latest
- [ ] Test supported POSIX and Windows signal/process behavior
- [ ] Finalize package metadata, license, changelog, and publishing policy
- [ ] Run security, performance, and documentation reviews
