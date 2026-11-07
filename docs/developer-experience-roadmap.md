# Developer experience roadmap

This plan turns the current production-ready selection engine into a tool that is easy to discover, adopt, explain, and automate. Implement each slice independently and keep finite command behavior covered by command-level tests.

## DX-1: installation and first success

Status: complete.

User story: a new user can install the package and complete an affected run in under five minutes.

- Choose and consistently apply the final package identity (`affected-node-test` is the current repository and binary name).
- Replace repository-local `node bin/...` onboarding with package-manager installation and `pnpm exec affected-node-test` examples.
- Add a minimal configuration, baseline bootstrap, affected feedback loop, mandatory full-suite CI example, and a command decision table.
- Correct stale package-manager and feature-parity prose.

Acceptance criteria:

- A fresh fixture can follow only the README and complete its first baseline and affected run.
- Package, repository, binary, and documentation names agree.
- Checked examples or command tests cover every quickstart command.

## DX-2: useful help and version output

Status: complete.

User story: a user can discover commands and options without opening the README.

- Add descriptive top-level help, command-specific help, examples, option defaults, and `--version`.
- Report invalid input with the relevant usage and no stack trace.
- Keep help and version independent of Git, project configuration, and the current directory.

Acceptance criteria:

- Every command has a one-line purpose and example.
- Help shows the effective default concurrency rule.
- Command-level tests cover top-level help, per-command help, version, and invalid input.

## DX-3: doctor and configuration schema

Status: complete.

User story: a user can validate discovery and configuration without executing tests.

- Add a read-only `doctor` command for Node compatibility, project root, discovered tests, workspace projects, cache status, Git availability, and resolved configured files.
- Ship a JSON Schema and support a `$schema` property for editor completion.
- Give missing discovery and unmatched configuration actionable remediation.

Acceptance criteria:

- `doctor` never launches test workers or mutates the cache.
- Single-project and workspace fixtures are covered.
- Valid configuration receives editor completion and invalid configuration produces focused diagnostics.

## DX-4: explain and preview selection

Status: complete.

- [x] Add structured selection and fallback reasons without changing execution output.
- [x] Add read-only preview to finite single-project commands.
- [x] Add workspace preview parity.

User story: a user can see what would run and why without running tests or changing the cache.

- Add `--dry-run` or `--list` to `affected`, `related`, and `since-last-run`.
- Enrich normalized outcomes with structured reasons: changed input, dependency path, sticky failure, unrecorded test, mapping, or conservative fallback.
- Render reasons at the CLI adapter while keeping selection and execution on the same module interface.

Acceptance criteria:

- Preview launches no workers and writes no records.
- Preview and execution select exactly the same files.
- Every full-suite fallback identifies the triggering file or rule.

## DX-5: stable automation output

User story: an editor, hook, or CI job can consume results without parsing prose.

- Add versioned `--output=json` output for previews and finite runs.
- Include outcome, project, provider, selected tests, reasons, fallback, failures, and exit status.
- Produce one coherent workspace document; reserve stderr for diagnostics.

Acceptance criteria:

- JSON stdout is parseable for selected, no-op, fallback, and failed outcomes.
- The schema is documented and versioned.
- Human output remains the default.

## DX-6: familiar workflow shortcuts

User stories: a user can immediately rerun failures, allocate a percentage of CPUs, and focus on one workspace project.

- Add `last-failed` with existing sticky-failure semantics.
- Accept percentage concurrency with deterministic rounding and a minimum of one worker.
- Add workspace `--project <glob>` filtering to finite and watch commands.

Acceptance criteria:

- `last-failed` clearly no-ops when no failures are recorded.
- Percentage concurrency is deterministic across runtime parallelism values.
- A project filter that matches nothing fails with an actionable message.

## DX-7: optional onboarding automation

User story: a user can scaffold safe defaults after understanding the tool.

- Add `init` only after package identity and the configuration schema stabilize.
- Preview changes by default and require explicit `--write` to modify configuration, `.gitignore`, or package scripts.
- Preserve existing user content and report every proposed or applied change.

Acceptance criteria:

- The default command is read-only.
- Repeated initialization is idempotent.
- Conflicting existing configuration is never overwritten silently.

## Recommended order

Implement DX-1 through DX-7 in order. DX-1 and DX-2 are the immediate adoption wins. DX-4 is the strongest product-level improvement because the selector already makes safety decisions but does not yet retain enough provenance to explain them.
