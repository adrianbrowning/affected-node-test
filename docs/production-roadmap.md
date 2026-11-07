# Production roadmap

This roadmap targets parity with Vitest's affected-test selection subsystem, not its assertion, mocking, browser, coverage, or reporting APIs. The supporting comparison is in [vitest-feature-parity.md](./vitest-feature-parity.md).

## Execution order

1. Complete stable JSON automation: [finite runs](https://github.com/adrianbrowning/affected-node-test/issues/8), then [workspace aggregation](https://github.com/adrianbrowning/affected-node-test/issues/9).
2. Add workflow shortcuts: [`last-failed`](https://github.com/adrianbrowning/affected-node-test/issues/11), [percentage concurrency](https://github.com/adrianbrowning/affected-node-test/issues/13), then [workspace filtering](https://github.com/adrianbrowning/affected-node-test/issues/14).
3. Bound [large child output](https://github.com/adrianbrowning/affected-node-test/issues/17).
4. Migrate development to [TypeScript on Node 26](https://github.com/adrianbrowning/affected-node-test/issues/10).
5. Add read-only [`init`](https://github.com/adrianbrowning/affected-node-test/issues/12). *(complete)*
6. Complete release gates in order: [cross-platform process verification](https://github.com/adrianbrowning/affected-node-test/issues/15), [package and publishing readiness](https://github.com/adrianbrowning/affected-node-test/issues/18), then [final reviews](https://github.com/adrianbrowning/affected-node-test/issues/16).

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
- [x] Support configurable discovery and define the TypeScript/JSX loader contract

## Architecture hardening

These tasks come from the 2026-11-07 architecture review. Preserve CLI behavior with integration tests while changing module ownership. Suggested order: workspace lifecycle, dependency records, Git changes, then selection/run consolidation.

- [x] Deepen workspace orchestration (**strong recommendation**)
  - [x] Replace parsing the child text `Watching for changes.` with a structured IPC readiness protocol
  - [x] Move abort, shutdown, sibling-failure, and exit-code policy behind the workspace module interface
  - [x] Keep finite-run and persistent-watch process adapters internal to one workspace module
  - [x] Exercise readiness, failure, and shutdown through the same command-facing interface
- [x] Deepen the dependency-record lifecycle (**strong recommendation**)
  - [x] Move schema version, structural validation, compatibility, and invalidation reasons out of the CLI module
  - [x] Give the record module a small interface for load decisions, successful updates, and failure preservation
  - [x] Keep atomic filesystem replacement as an implementation detail; do not introduce a hypothetical storage-adapter seam
  - [x] Lock corrupt, stale, interrupted, failed, sticky-failure, and incremental-success behavior with focused tests
- [x] Concentrate Git change knowledge (**worth scheduling**)
  - [x] Give project and workspace callers one interface for root validation, merge-base selection, diffs, untracked files, and exclusions
  - [x] Centralize Git subprocess errors and no-merge-base outcomes
  - [x] Replace duplicated project/workspace Git rules without changing affected-selection output
- [x] Collapse the selection-and-run protocol (**exploratory refactor after the preceding tasks**)
  - [x] Feed Git, explicit-file, and mtime providers into one normalized selection outcome
    - [x] Normalize Git, explicit-file, and watch file-selection outcomes
    - [x] Normalize mtime selection with the same outcome interface
  - [x] Centralize cache loading, conservative fallback, targeted execution, messages, and record updates
    - [x] Centralize conservative fallback, targeted execution, messages, and record updates
    - [x] Centralize cache loading and cache-miss fallback
  - [x] Keep provider adapters at the real seam while hiding safety sequencing inside the module
  - [x] Prove `affected`, `related`, `since-last-run`, and watch retain their current behavior through command-level tests

## P2: efficiency and ergonomics

- [x] Run only new or unrecorded tests when inventory grows
- [x] Store durations and schedule historically slow tests first
- [x] Add [`last-failed`](https://github.com/adrianbrowning/affected-node-test/issues/11)
- [x] Add [percentage concurrency](https://github.com/adrianbrowning/affected-node-test/issues/13)
- [x] Add optional [workspace project filtering](https://github.com/adrianbrowning/affected-node-test/issues/14)
- [x] [Spill large buffered child output to temporary files](https://github.com/adrianbrowning/affected-node-test/issues/17)
- [ ] Work through the sliced [developer experience roadmap](developer-experience-roadmap.md)

## Release readiness

- [x] Initialize the final package directory as the repository root
- [x] Build and test the Node 26 TypeScript development sources
- [x] [Test supported POSIX and Windows signal/process behavior](https://github.com/adrianbrowning/affected-node-test/issues/15)
- [ ] [Finalize package metadata, license, changelog, and publishing policy](https://github.com/adrianbrowning/affected-node-test/issues/18)
- [ ] [Run security, performance, and documentation reviews](https://github.com/adrianbrowning/affected-node-test/issues/16)
