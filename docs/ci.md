# CI full-suite gate

Affected selection is a feedback optimization, not the final correctness gate. Every pull request and push to the default branch runs `pnpm run check:full` on Node 26, the minimum supported runtime, on Ubuntu and Windows.

The command checks mdcode-synchronized documentation, strictly typechecks the TypeScript development sources and tests, emits the publishable JavaScript artifact, and runs every integration test. It deliberately does not invoke `affected` or `since-last-run`.

## Required branch-protection check

Configure the repository's default branch to require the stable **Full suite gate** status from `.github/workflows/ci.yml`. The gate fails unless both Node 26 platform workers succeed, so branch protection does not need to track matrix-generated status names.

Graceful `SIGINT` and `SIGTERM` assertions are POSIX-only. Windows runs the process-tree, forced-termination, cache-preservation, and sibling-watcher coverage described in [process and signal behavior](process-behavior.md).

## Local equivalent

```sh
pnpm install --frozen-lockfile
pnpm run check:full
```

Selection commands may run earlier for fast feedback, but they must never replace this gate.
