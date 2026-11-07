const concurrency = `Options:
  --concurrency N|P%  Run at most N test files, or floor(P% of available parallelism).
                      Percentages must be >0% and <=100%, with a minimum of 1 worker.
                      Default concurrency is min(4, available parallelism), with a minimum of 1.
  -h, --help       Show this command's help.`;

const commandHelpText = {
  baseline: `Build the complete dependency graph by running every discovered test file.

Usage: affected-node-test baseline [--concurrency N] [--dry-run] [--output=json]

${concurrency}
  --dry-run        Show the full suite without running tests or updating the cache.
  --output=json    Emit a versioned JSON preview or execution result.

Example:
  affected-node-test baseline --concurrency 4`,
  affected: `Run tests affected by staged, unstaged, untracked, or committed Git changes.

Usage: affected-node-test affected [REF] [--concurrency N] [--dry-run] [--output=json]

REF defaults to working-tree changes. When provided, changes are compared from its merge base with HEAD.

${concurrency}
  --dry-run        Show what would run and why without running tests or updating the cache.
  --output=json    Emit a versioned JSON preview or execution result.

Example:
  affected-node-test affected origin/main --concurrency 4`,
  related: `Run tests related to one or more explicit files without requiring Git.

Usage: affected-node-test related <FILE...> [--concurrency N] [--dry-run] [--output=json]

FILE may be project-relative or absolute and must remain inside the project root.

${concurrency}
  --dry-run        Show what would run and why without running tests or updating the cache.
  --output=json    Emit a versioned JSON preview or execution result.

Example:
  affected-node-test related src/math.mjs --concurrency 4`,
  'since-last-run': `Run tests whose recorded dependencies changed on disk since their last successful run.

Usage: affected-node-test since-last-run [--concurrency N] [--dry-run] [--output=json]

${concurrency}
  --dry-run        Show what would run and why without running tests or updating the cache.
  --output=json    Emit a versioned JSON preview or execution result.

Example:
  affected-node-test since-last-run --concurrency 4`,
  'last-failed': `Rerun test files recorded as failing by the previous execution.

Usage: affected-node-test last-failed [--concurrency N] [--dry-run] [--output=json]

${concurrency}
  --dry-run        Show recorded failures without running tests or updating the cache.
  --output=json    Emit a versioned JSON preview or execution result.

Example:
  affected-node-test last-failed --dry-run`,
  watch: `Build the graph, watch the project, and serially rerun selected tests.

Usage: affected-node-test watch [--concurrency N]

${concurrency}

Example:
  affected-node-test watch --concurrency 4`,
  'clear-cache': `Remove the saved dependency graph. This is safe when no cache exists.

Usage: affected-node-test clear-cache

Options:
  -h, --help  Show this command's help.

Example:
  affected-node-test clear-cache`,
  doctor: `Validate configuration, test discovery, cache state, Git availability, and workspace projects without running tests.

Usage: affected-node-test doctor

Options:
  -h, --help  Show this command's help.

Example:
  affected-node-test doctor`,
};

export const commandNames = Object.freeze(Object.keys(commandHelpText));

export function commandHelp(command) {
  return commandHelpText[command];
}

export function topLevelHelp() {
  return `Affected test selection for Node's native test runner.

Usage: affected-node-test <COMMAND> [OPTIONS]

Commands:
  baseline              Build the complete dependency graph.
  affected [REF]        Run tests affected by Git changes.
  related <FILE...>     Run tests related to explicit files without Git.
  since-last-run        Run tests whose recorded dependencies changed on disk.
  last-failed           Rerun test files recorded as failing.
  watch                 Watch files and serially rerun selected tests.
  clear-cache           Remove the saved dependency graph.
  doctor                Validate setup without running tests.

Global options:
  -h, --help       Show this help or COMMAND help.
  -v, --version    Show the installed version.

Default concurrency is min(4, available parallelism), with a minimum of 1.

Examples:
  affected-node-test baseline
  affected-node-test affected origin/main
  affected-node-test related src/math.mjs
  affected-node-test doctor

Run affected-node-test help COMMAND for command-specific details.`;
}
