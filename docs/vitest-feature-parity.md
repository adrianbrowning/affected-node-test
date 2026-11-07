# Vitest affected-test feature parity

Research date: 2026-11-07. This comparison is intentionally limited to affected-test selection and the supporting cache/watch/project features, not parity with Vitest's assertion, mocking, snapshot, browser, coverage, or reporter APIs.

## Executive summary

Vitest 5.1 has two complementary affected-test models:

1. `--changed [ref]` asks Git for changed files and selects tests whose transitive import graphs reach those files. Without runtime dependency recording, Vitest builds a static module graph before the run. [`vitest related <files>`](https://vitest.dev/guide/cli#vitest-related) applies the same idea to an explicit file list. [Vitest's `changed` reference](https://vitest.dev/config/changed) describes staged/unstaged selection, refs, project-wide dependencies, and full-rerun triggers.
2. `--since-last-run` records the files each test actually loaded and later compares their mtimes with that test's last successful record. It does not require Git. New/unrecorded tests and previously failing tests run automatically. [The affected-tests recipe](https://vitest.dev/guide/recipes/affected-tests) explains the distinction and recommends a final full run before completion.

This prototype supports both providers over one runtime-recorded graph: `affected [REF]` obtains changed paths from Git, while `since-last-run` compares per-test dependency metadata without Git. Its Git provider is therefore closest to Vitest's `--changed` combined with `experimental.recordDependencies`, not Vitest's default static-graph `--changed` behavior.

The prototype already has meaningful strengths: transitive static and runtime ESM/CommonJS dependency selection, merge-base Git selection including staged and untracked changes, conservative unresolved-import fallbacks, single-project dependency tracking, exact-runtime/configuration cache invalidation, atomic cache writes, sticky reruns for previously failing tests, configurable non-module/full-rerun triggers, and bounded deterministic parallel execution. The largest remaining architectural gap is multi-project isolation.

## Parity matrix

| Capability | Vitest behavior | Prototype behavior | Gap | Priority |
| --- | --- | --- | --- | --- |
| Git affected selection | `--changed` handles uncommitted staged/unstaged work or accepts a commit/branch; Git supplies changed files and the transitive module graph supplies tests. [Docs](https://vitest.dev/config/changed) | `affected` selects staged, unstaged, and untracked changes; `affected REF` also includes committed changes since the merge base. | Core parity achieved. | Done |
| Explicit related files | `vitest related file... --run` selects tests related to caller-provided paths; useful with lint-staged. Static mode supports literal static/dynamic imports, not computed dynamic imports. [CLI](https://vitest.dev/guide/cli#vitest-related) | Non-Git `related <files...>` accepts relative or absolute paths and shares static/runtime graphs, mappings, sticky failures, and conservative triggers with Git selection. | Core parity achieved. | Done |
| Since-last-run selection | `--since-last-run` compares every recorded dependency's mtime with that test's last run, works without Git, runs unrecorded and previously failing tests, and updates records incrementally. [CLI](https://vitest.dev/guide/cli#since-last-run) | Non-Git `since-last-run` compares recorded per-test dependency mtime/size state, includes unrecorded and sticky failed tests, and updates successful records incrementally. | Core parity achieved. | Done |
| Static dependency graph | Default `--changed`/`related` transforms test graphs before selection, so literal imports can be found without having executed that branch. Runtime records are optional. [Dependency-recording docs](https://vitest.dev/config/experimental#experimental-recorddependencies) | Acorn parses literal JavaScript ESM imports/re-exports/dynamic imports and CommonJS `require()` calls, then merges runtime edges. User-loaded TS/TSX/JSX syntax is attempted but parser failures are explicitly unresolved and conservatively selected. | Core native-runner parity achieved; transformed syntax intentionally relies on runtime edges plus conservative fallback rather than duplicating loader transforms. | Done |
| Runtime dependency records | With `experimental.recordDependencies`, Vitest records executed dynamic imports, mocks, setup files, environments, runners, serializers, plugin watch files, snapshots, and their relevant imports. [Docs](https://vitest.dev/config/experimental#experimental-recorddependencies) | Records in-repository ESM/CJS resolution edges, setup/global-setup closures, environment files, project-dependency globs, watch mappings, and conservative mock/snapshot conventions. | Mock/snapshot dependencies are project-wide rather than test-specific; externalized/linked modules remain unsupported. | P1 |
| Previously failing tests | Dependency-recording modes rerun a previously failing test until it passes because failure may come from unrecorded external state. [CLI](https://vitest.dev/guide/cli#since-last-run) | Failed file status is stored without replacing the last successful graph, and failed files remain selected until they pass. | Core parity achieved. | Done |
| Partial/incomplete records | A filtered run can only add to an existing record and cannot create a supposedly complete record; unrecorded tests always run. [Docs](https://vitest.dev/config/experimental#experimental-recorddependencies) | Always executes a whole selected file, so intra-file filtering is absent; failed runs do not update any cache. | Current whole-file model is safe. Preserve this invariant if test-name/line filters are added. | P2 |
| New tests | A test without a dependency record always runs. [Docs](https://vitest.dev/config/experimental#experimental-recorddependencies) | Additive inventory changes preserve the existing graph and always select unrecorded tests; removals conservatively rebuild the full suite. | Core parity achieved. | Done |
| Project-wide dependencies | Changes to config and its imports, global setup, `.env`, setup files, environments, runners, serializers, and related files can rerun every test in the affected project. [Changed docs](https://vitest.dev/config/changed) | Fingerprints manifests, configuration, environment files, explicit dependencies, setup closures, mock/snapshot conventions, and explicit runner/serializer files. | Add per-project scope. | P1 |
| Forced full reruns | `forceRerunTriggers` is configurable; package/Vite/Vitest config patterns have defaults. [Docs](https://vitest.dev/config/forcereruntriggers) | Root configuration supports custom `forceRerunTriggers` in addition to conservative built-in configuration triggers. | Core single-project parity achieved; project scoping remains. | Done |
| Non-module dependencies | `watchTriggerPatterns` maps changed paths such as templates or fixtures to tests when the module graph cannot see them. [Docs](https://vitest.dev/config/watchtriggerpatterns) | Root configuration maps changed path globs to test-file globs and runs the full suite when a matched mapping resolves to no tests. | Core single-project parity achieved. | Done |
| Watch mode | Vitest watches files and reruns only related tests from its live Vite module graph; setup files rerun for selected files. [Features](https://vitest.dev/guide/features#watch-mode), [lifecycle](https://vitest.dev/guide/lifecycle#watch-mode-lifecycle) | `watch` performs an initial full run, debounces recursive filesystem events, serializes reruns, and reuses static/runtime graphs, sticky failures, project triggers, and non-module mappings. | Core single-project parity achieved; Vitest's live Vite graph is outside the native Node runner design. | Done |
| Cache lifecycle | Cache is configurable/clearable and stores result status, duration, last-run time, and dependency records; duration helps schedule slower tests first. [Cache docs](https://vitest.dev/config/cache) | Atomic versioned graph cache includes exact runtime/config fingerprints, sticky failures, per-test dependency state and duration, slowest-first scheduling with deterministic reporting, a project-relative configurable directory, and an idempotent `clear-cache` command. | Core parity achieved; last-run timestamps are unnecessary for the current mtime comparison model. | Done |
| Multiple projects | Projects can have separate roots/configurations/environments and be filtered by `--project`; affected global dependencies are scoped to a project. [Projects guide](https://vitest.dev/guide/projects) | Workspace `projects` delegates baseline, Git/related selection, since-last-run, watch, and cache clearing to validated roots with isolated discovery, configuration, graphs, and caches. Workspace-level changes conservatively run every project; watch coordinates readiness, prefixed output, and shutdown. | Core parity achieved. Optional project-name filtering remains a P2 ergonomic enhancement. | Done |
| Test discovery | Configurable `include`, `exclude`, directory/root, TypeScript/JSX patterns, and in-source tests via `includeSource`. [In-source guide](https://vitest.dev/guide/in-source) | Root configuration supports `include`/`exclude`, including TS/TSX/JSX patterns, and ordered `nodeArgs` for user-supplied loaders/import hooks. Source files may be explicitly included; there is no separate in-source mode. | Core configurable discovery achieved for the native Node runner contract. | Done |
| Parallel files | File concurrency is configurable with `maxWorkers` (number or percentage) or disabled with `fileParallelism`; Vitest also supports within-file concurrent tests. [Parallelism guide](https://vitest.dev/guide/parallelism) | Bounded child-process pool via integer `--concurrency`; within-file behavior belongs to `node:test`. | Core file-level parity exists. Percentage values and scheduling refinements are optional. | P2 |
| Affected coverage | Coverage defaults `coverage.changed` from `--changed`, limiting reports to related changed files. [CLI options](https://vitest.dev/guide/cli#coverage-changed) | No coverage integration. | Only needed if the product scope expands beyond selection/orchestration. | Out of scope for now |

## Important shared limitations

Runtime recording is not complete in either system. Vitest documents that an unexecuted dynamic import is not recorded, files read through `fs` are not recorded, and imports of externalized modules are not recorded. It also warns that changing imports and committing before refreshing records can later miss a dependency. [Vitest dependency-recording limitations](https://vitest.dev/config/experimental#experimental-recorddependencies) closely match this prototype's documented runtime-observation limitation.

Vitest's mtime provider also cannot detect timestamps moved into the past by a checkout/archive or files that did not exist during the recorded run. Its official guidance is to use affected selection for fast feedback and still perform a full suite before merge or task completion. [Affected-tests recipe](https://vitest.dev/guide/recipes/affected-tests)

This means “Vitest parity” should not be interpreted as making runtime records perfectly sound. It means matching Vitest's layered safety model: static graph selection for Git-based checks, richer runtime records for since-last-run speed, explicit global/non-module triggers, sticky failures, unrecorded-test fallback, and a required full-suite gate.

## Recommended implementation sequence

### P0: correctness contract

1. **Persist per-test status and last-run metadata.** Failed-test persistence is complete; per-test last-run timestamps remain for `since-last-run`.
2. **Introduce project configuration.** `include`, `exclude`, `forceRerunTriggers`, and `watchTriggerPatterns` are complete for one project.
3. **Track project-wide dependencies.** Complete for the current single-project model; future multi-project work must scope reruns to the owning project.
4. **Separate selection providers.** Complete: Git `affected [ref]` and non-Git `since-last-run` share normalized dependency records.
5. **Close the untaken-import gap.** Complete for JavaScript literal imports; unresolved computed imports and parser failures use conservative Git selection, while runtime records remain the non-Git fast path.

### P1: user-facing parity

6. `related <files...>` and ref-less `affected` for uncommitted changes are complete.
7. `clear-cache` and configurable cache location are complete.
8. Persistent watch mode is complete for the single-project model.
9. Multi-project baseline, cache isolation, Git/related routing, and coordinated watch mode are complete.
10. Configurable include/exclude and the loader contract are complete: users supply transforms through `nodeArgs`; source files can be explicitly included without a separate in-source mode.

### P2: efficiency and ergonomics

11. Run only new/unrecorded tests instead of rebuilding the whole suite when inventory grows.
12. Storing durations and starting historically slow tests first while retaining deterministic reporting is complete.
13. Consider percentage concurrency and result-focused commands such as `last-failed`.

## Suggested parity target

For a production release focused on Node's native test runner, the sensible target is feature parity with Vitest's **affected-selection subsystem**, not the entire Vitest runner:

- Git, explicit-file, and since-last-run providers
- transitive static and recorded-runtime dependency selection
- project-wide and user-mapped dependency triggers
- sticky failed/unrecorded tests
- cache lifecycle and project isolation
- watch-mode reruns
- a documented full-suite CI gate

Coverage integration, browser projects, transforms, mocking APIs, assertions, snapshots as a testing API, UI, and reporters should remain outside scope. Snapshot *files* still matter as dependency inputs when native `node:test` tests use them.
