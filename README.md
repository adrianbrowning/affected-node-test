# affected-node-test

An Acorn-backed affected-test selector for Node's native `node:test`, combining static import analysis with synchronous runtime `node:module` hooks.

## Install

`affected-node-test` requires Node 22.15 or newer. Install it as a development dependency with your package manager:

```sh
pnpm add --save-dev affected-node-test
# or: npm install --save-dev affected-node-test
```

Run commands from the project root. Git is required only for `affected`; `baseline`, `related`, and `since-last-run` also work outside a Git repository.

## Quick start

```sh file=docs/examples/quickstart.sh
pnpm add --save-dev affected-node-test
pnpm exec affected-node-test baseline

# After changing source or tests, run the affected feedback loop.
pnpm exec affected-node-test affected

# Always finish with the project's complete test command.
node --test
```

The initial passing `baseline` records the dependency graph. Later `affected` runs select tests for staged, unstaged, and untracked changes. A full test command remains the required final correctness gate.

No configuration is needed for conventional `.test.js`, `.test.mjs`, `.test.cjs`, `.spec.js`, `.spec.mjs`, and `.spec.cjs` files. To make discovery explicit, add this optional `affected-node-test.config.json`:

```json file=docs/examples/minimal-config.json
{
  "include": ["test/**/*.test.mjs"]
}
```

## Which command should I use?

| Goal | Command |
| --- | --- |
| Create or refresh the complete dependency graph | `pnpm exec affected-node-test baseline` |
| Select staged, unstaged, and untracked Git changes | `pnpm exec affected-node-test affected` |
| Select committed changes since a branch or commit | `pnpm exec affected-node-test affected origin/main` |
| Select tests related to explicit paths without Git | `pnpm exec affected-node-test related src/math.mjs` |
| Select dependencies changed on disk without Git | `pnpm exec affected-node-test since-last-run` |
| Keep selecting tests as files change | `pnpm exec affected-node-test watch` |
| Remove the saved graph | `pnpm exec affected-node-test clear-cache` |
| Discover commands or command-specific options | `pnpm exec affected-node-test --help` or `pnpm exec affected-node-test affected --help` |
| Show the installed version | `pnpm exec affected-node-test --version` |

## Command reference

```sh file=docs/examples/commands.sh
pnpm exec affected-node-test baseline --concurrency 4
pnpm exec affected-node-test affected --concurrency 4
pnpm exec affected-node-test affected origin/main --concurrency 4
pnpm exec affected-node-test related src/math.mjs --concurrency 4
pnpm exec affected-node-test since-last-run --concurrency 4
pnpm exec affected-node-test watch --concurrency 4
pnpm exec affected-node-test clear-cache
```

- `baseline` runs all discovered test files, merges literal static-import edges with observed runtime module-resolution edges, and writes `.affected-tests/graph.json` after a passing suite.
- `affected` selects staged, unstaged, and untracked changes. `affected REF` also includes committed changes since the merge base of `REF` and `HEAD`. Both run unrecorded tests and tests whose captured dependency trees contain changed files.
- `related FILE...` requires no Git repository and runs tests related to explicit repository-relative or absolute paths. It shares the same conservative triggers and mappings as `affected`.
- `since-last-run` requires no Git repository. It compares each test's recorded dependency metadata with the filesystem, reruns changed, unrecorded, and previously failing tests, and updates successful records incrementally.
- `watch` performs an initial full run, then persistently watches the project and serially reruns only tests selected by the same dependency graph, conservative triggers, and non-module mappings.
- `clear-cache` removes the saved dependency graph and is safe to run when no cache exists.
- The graph cache is tied to the exact Node version, `NODE_OPTIONS`, package manifests, lockfiles, npm configuration, Node version files, and TypeScript configuration files.
- Per-test dependency state records include modification time and size. Missing or changed dependencies select that test; project-wide fingerprints remain the conservative outer safety layer.
- Missing/stale cache, missing merge bases, removed tests, unknown non-test JS files, and key configuration changes cause a full run. Newly discovered tests run incrementally and extend the existing record.
- A failed run preserves the previous dependency graph, records the failing test files, and keeps selecting them until they pass.
- Test files run in a bounded worker pool. `--concurrency N` sets its size; the default is the smaller of four and the runtime's available parallelism. Successful durations are cached so historically slower tests start first, while buffered reporting remains deterministic.
- `SIGINT` and `SIGTERM` stop active test processes, clean temporary edge logs, preserve the previous cache, and use conventional exit codes.
- Watch events are debounced, cache/build/dependency directories are ignored, and changes arriving during a run are queued for the next serialized rerun.

## Development

Run the integration suite with `pnpm test`. The tests exercise the CLI in temporary Git repositories and do not modify the working repository.

This repository dogfoods its own selector:

- `pnpm test:baseline` runs the full suite and builds the local dependency graph.
- `pnpm test:affected` selects staged, unstaged, and untracked changes.
- `pnpm test:since-last-run` uses recorded dependency metadata without Git.
- `pnpm test:watch` performs an initial full run and then watches for related changes.

These commands are development feedback loops. They do not replace the final full-suite gate.
The checked-in root configuration limits self-hosted discovery to `test/**/*.test.mjs`, matching `pnpm test` and excluding the standalone example project's tests.

README code blocks with `file=...` metadata are synchronized from checked-in examples by [mdcode-ts](https://github.com/adrianbrowning/mdcode-ts). Run `pnpm docs:update` to refresh them or `pnpm docs:check` to fail on drift.

`pnpm run check:full` is the mandatory local and CI correctness gate: it checks documentation drift and runs the complete suite without affected-test selection. See [the CI gate documentation](docs/ci.md) for the supported Node matrix and required branch-protection status.

## Configuration

An optional `affected-node-test.config.json` at the repository root controls cache location, discovery, setup, and dependency triggers:

```json file=docs/examples/affected-node-test.config.json
{
  "cacheDir": ".cache/affected-node-test",
  "include": ["test/**/*.test.mjs"],
  "exclude": ["test/fixtures/**"],
  "envFiles": [".env", ".env.test"],
  "forceRerunTriggers": ["config/**"],
  "globalSetupFiles": ["test/global-setup.mjs"],
  "nodeArgs": ["--import", "tsx"],
  "projectDependencies": ["test/setup.mjs", ".env*", "snapshots/**"],
  "setupFiles": ["test/setup.mjs"],
  "watchTriggerPatterns": [
    {
      "pattern": "fixtures/templates/**",
      "tests": ["test/render*.test.mjs"]
    }
  ]
}
```

- A non-empty `include` replaces default `.test`/`.spec` JavaScript discovery.
- `cacheDir` sets a project-relative cache directory; it defaults to `.affected-tests` and cannot escape the project root.
- `exclude` removes matching repository-relative paths from discovery.
- `envFiles` resolves repository-relative globs and loads every match, in deterministic order, before global setup and test workers. Loading follows Node's native `process.loadEnvFile()` semantics.
- `forceRerunTriggers` runs the full suite when any changed path matches.
- `globalSetupFiles` resolves repository-relative globs and loads every match once before test workers start. Each module must export `setup()` or a default setup function; it may return a teardown function or export `teardown()`. Teardowns run in reverse order after workers finish.
- `nodeArgs` passes ordered arguments to every test child before the built-in graph hook and `--test`. Use it for user-supplied loaders or import hooks, for example `["--import", "tsx"]`; no TypeScript or JSX transformer is bundled.
- `projectDependencies` content-fingerprints every matching file with the graph. Added, deleted, modified, or already-committed changes invalidate the cache and run the full suite.
- `setupFiles` resolves repository-relative globs and preloads every match into each test process. Setup modules and their observed transitive imports are recorded as dependencies of every test and content-fingerprinted across commits.
- `watchTriggerPatterns` maps a changed non-module path glob to one or more test-file globs. All matching mappings are combined with graph-affected and previously failing tests.
- A matched watch trigger that resolves to no discovered tests runs the full suite rather than silently skipping coverage.
- Git metadata, dependencies, the graph cache, coverage, and common build-output directories remain excluded from discovery.
- Unknown options and invalid values fail before tests run. Configuration contents are included in the graph-cache fingerprint.
- Every `setupFiles` pattern must resolve to at least one file; an unmatched pattern fails before tests run.
- Global setup runs in the CLI process, so changes to `process.env` are inherited by test children. Setup and teardown failures fail the run without replacing the previous graph.
- Global setup modules and their observed setup/teardown import closure are attached to every test graph and content-fingerprinted across commits.
- Resolved environment files are content-fingerprinted, so additions, deletions, and committed content changes run the full suite.
- Files under `__mocks__` or `__snapshots__`, plus all `*.snap` files, are automatically treated as project-wide convention dependencies. Inventory or content changes run the full suite.
- Custom runner and serializer dependencies have no universal native-runner filename convention; declare them through `projectDependencies`.
- Loader or import-hook files inside the project must also be declared through `projectDependencies`. Package-based loaders are covered by manifest and lockfile fingerprints.
- TypeScript, TSX, and JSX files can be discovered with `include`. Runtime-resolved imports are recorded normally; syntax Acorn cannot parse is marked unresolved and uses conservative affected selection. In-source tests have no separate mode: an `include` pattern may opt source files in, and every matched file is passed to `node --test`.
- The root configuration is non-executable JSON. Add any referenced configuration fragments to `projectDependencies` so their contents are tracked.

### Workspaces

A workspace root can delegate to isolated project roots instead of defining single-project options:

```json file=docs/examples/workspace-config.json
{
  "projects": ["packages/api", "packages/web"]
}
```

Project roots are validated, deduplicated, rejected when overlapping, and run in lexical order. Each project owns its discovery, configuration, dependency graph, and cache. Workspace `baseline`, `affected`, `since-last-run`, `related`, `watch`, and `clear-cache` are supported. Git and explicit related paths are routed project-relative to their owning runners; workspace-level changes conservatively run every project baseline. Unchanged projects still check since-last-run records so sticky failures are not lost. Workspace watch runs project watchers concurrently, prefixes their output with project paths, and coordinates readiness and signal-driven shutdown. The workspace `projects` option cannot be mixed with single-project options in the same configuration file.

## Known limitations

- Literal ESM imports, re-exports, dynamic imports, and CommonJS `require()` calls are parsed statically; executed runtime imports are merged into the same graph.
- Computed imports and parse failures are marked unresolved. For Git selection, any JavaScript change conservatively selects tests with unresolved static imports. Non-Git state selection cannot discover a brand-new computed target that was never recorded.
- Each test file runs in its own Node process rather than using native multi-file test concurrency. Output is buffered and printed in deterministic test-file order.
- The graph only tracks `file:` dependencies **inside the Git repository**. Changes in external linked packages are not handled.
- Non-module data/config files read through `fs` and some worker process patterns require explicit configuration or a full run. User-transformed TypeScript/JSX syntax unsupported by Acorn retains runtime edges and deliberately triggers conservative code-change selection.
- The naive hook appends a line for every import; production code should batch edges and reduce synchronous I/O.
- A changed non-JavaScript file that tests read via `fs` might not trigger a selected run. Full-suite CI remains essential.
