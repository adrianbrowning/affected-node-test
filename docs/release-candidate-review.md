# Release-candidate review

Reviewed 2026-11-07 for the first public release. The release candidate is acceptable to proceed to packaging and publishing-policy work. No open finding in this review blocks release.

## Security

Review scope covered subprocess arguments, project and artifact paths, temporary files, configuration input, cache and plan parsing, and dependencies.

- Subprocesses use argument arrays with `spawn`/`spawnSync`; test selection does not construct shell commands. Workspace children use the current Node executable. User-supplied `nodeArgs`, setup modules, tests, and environment files are intentionally executable project input, so a checked-out project is the trust boundary.
- Project-relative cache, plan, related-file, and workspace paths are checked before use. Serialized dependency paths now reject absolute paths, traversal segments, Windows drive paths, and backslashes before filesystem metadata is read. Invalid caches fall back to the full suite; invalid partition plans fail closed.
- Worker directories use `mkdtemp`. Spilled output is created exclusively with mode `0600` on POSIX and is removed on pass, failure, interruption, and startup failure. Atomic JSON writes use an exclusive random temporary file followed by rename and cleanup.
- Configuration and persisted JSON enter as `unknown`, reject unknown or incorrectly typed options, and validate nested structures before use. A transferred CI plan is trusted as an artifact, not cryptographically authenticated; its recorded runtime, Git, configuration, project, changed-content, and test identities are revalidated before phase two.
- `acorn@8.19.0` is the sole production dependency and is exactly pinned. Both `pnpm audit --prod --audit-level moderate` and the full `pnpm audit --audit-level high` reported no known vulnerabilities. `pnpm install --fix-lockfile --offline` passed pnpm's supply-chain policy check.

Finding fixed during review: persisted graph edges and dependency-state keys previously accepted traversal strings. Runtime path validation and regression coverage now reject them before any joined filesystem access.

## Performance

Run `pnpm review:performance` to build the package, create disposable Git fixtures, enforce the thresholds, print JSON measurements, and remove the fixtures. Measurements on Node v26.4.0, Android ARM64:

| Scenario | Fixture | Result | Threshold |
| --- | ---: | ---: | ---: |
| Baseline | 20 tests | 2,517 ms | 30,000 ms |
| Affected | 1 of 20 tests | 938 ms | 10,000 ms |
| Workspace baseline | 2 projects, 20 tests | 3,428 ms | 30,000 ms |
| Large output | 2 tests, 1 MiB total | 825 ms | 15,000 ms |
| Module-dense baseline | 256 runtime imports | 1,016 ms, 1 edge-log write | 15,000 ms, at most 4 writes |

The thresholds are broad release regression guards, not cross-machine performance claims. Before batching, the 128-module integration fixture made 129 synchronous edge-log writes; the same fixture now makes one while retaining every edge. The repeatable release benchmark independently records one write for 256 computed runtime imports. Workers flush bounded 64 KiB batches and flush once more on normal exit; interrupted runs preserve the previous graph as documented in [process and signal behavior](process-behavior.md#runtime-edge-batching).

## Documentation

- `pnpm docs:check` verifies every mdcode-backed README example against its checked-in source.
- Every top-level and command-specific help route completed successfully from the built CLI; all example shell files pass `bash -n`.
- `docs/examples/demo.sh` now creates and removes a disposable fixture, supplies its own local Git identity, builds a baseline, changes a transitive dependency, and selects only its affected test. It no longer mutates the checked-in example.
- The integration suite exercises documented baseline, affected, affected-first, related, since-last-run, last-failed, watch, clear-cache, doctor, init, JSON, workspace, concurrency, and failure flows in disposable fixtures.
- The pushed release-candidate commit `3a40b73` passed the Ubuntu and Windows Node 26 CI matrix in [run 42423284251](https://github.com/adrianbrowning/affected-node-test/actions/runs/42423284251).

## Release decision

Proceed to package metadata and publishing-policy review. The path-validation, demo, and runtime edge-write findings were fixed here. The public release remains contingent on completing the package, license, changelog, provenance, clean-install, and release-procedure acceptance criteria in issue #18.
