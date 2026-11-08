export type CommandOption = 'concurrency' | 'dry-run' | 'output=json' | 'phase' | 'plan' | 'project' | 'write';

type CommandDefinition = {
  description: string;
  examples: string[];
  extraUsage?: string[];
  notes?: string;
  options: readonly CommandOption[];
  positionals?: string;
  summary: string;
};

const concurrencyDefault = 'Default concurrency is min(4, available parallelism), with a minimum of 1.';
const optionUsage: Record<CommandOption, string> = {
  concurrency: '--concurrency N|P%',
  'dry-run': '--dry-run',
  'output=json': '--output=json',
  phase: '--phase PHASE',
  plan: '--plan FILE',
  project: '--project GLOB',
  write: '--write',
};
const optionHelp: Record<CommandOption, string> = {
  concurrency: `  --concurrency N|P%  Run at most N test files, or floor(P% of available parallelism).
                      Percentages must be >0% and <=100%, with a minimum of 1 worker.
                      ${concurrencyDefault}`,
  'dry-run': '  --dry-run        Show what would run and why without running tests or updating the cache.',
  'output=json': '  --output=json    Emit a versioned JSON preview or execution result.',
  phase: '  --phase PHASE    Run only the affected or remaining phase.',
  plan: '  --plan FILE      Portable handoff plan used with --phase.',
  project: '  --project GLOB   In a workspace, run only matching project paths. Repeatable.',
  write: '  --write          Apply proposed changes. Without this option, init is read-only.',
};

const runOptions = ['concurrency', 'project', 'dry-run', 'output=json'] as const;
const commandCatalog = {
  baseline: {
    summary: 'Build the complete dependency graph.',
    description: 'Build the complete dependency graph by running every discovered test file.',
    options: runOptions,
    examples: ['affected-node-test baseline --concurrency 4'],
  },
  affected: {
    summary: 'Run tests affected by Git changes.',
    description: 'Run tests affected by staged, unstaged, untracked, or committed Git changes.',
    positionals: '[REF]',
    notes: 'REF defaults to working-tree changes. When provided, changes are compared from its merge base with HEAD.',
    options: runOptions,
    examples: ['affected-node-test affected origin/main --concurrency 4'],
  },
  'affected-first': {
    summary: 'Run affected tests, then the remaining suite.',
    description: 'Run affected tests first, then complete the suite without duplicate execution.',
    positionals: '[REF]',
    notes: 'REF defaults to working-tree changes. The remaining partition starts only after the affected partition passes.',
    options: ['concurrency', 'project', 'output=json', 'phase', 'plan'],
    extraUsage: [
      'affected-node-test affected-first [REF] --phase affected --plan FILE',
      'affected-node-test affected-first --phase remaining --plan FILE',
    ],
    examples: [
      'affected-node-test affected-first origin/main --concurrency 4',
      'affected-node-test affected-first origin/main --phase affected --plan .affected-tests/plan.json',
      'affected-node-test affected-first --phase remaining --plan .affected-tests/plan.json',
    ],
  },
  related: {
    summary: 'Run tests related to explicit files without Git.',
    description: 'Run tests related to one or more explicit files without requiring Git.',
    positionals: '<FILE...>',
    notes: 'FILE may be project-relative or absolute and must remain inside the project root.',
    options: runOptions,
    examples: ['affected-node-test related src/math.mjs --concurrency 4'],
  },
  'since-last-run': {
    summary: 'Run tests whose recorded dependencies changed on disk.',
    description: 'Run tests whose recorded dependencies changed on disk since their last successful run.',
    options: runOptions,
    examples: ['affected-node-test since-last-run --concurrency 4'],
  },
  'last-failed': {
    summary: 'Rerun test files recorded as failing.',
    description: 'Rerun test files recorded as failing by the previous execution.',
    options: runOptions,
    examples: ['affected-node-test last-failed --dry-run'],
  },
  watch: {
    summary: 'Watch files and serially rerun selected tests.',
    description: 'Build the graph, watch the project, and serially rerun selected tests.',
    options: ['concurrency', 'project'],
    examples: ['affected-node-test watch --concurrency 4'],
  },
  'clear-cache': {
    summary: 'Remove the saved dependency graph.',
    description: 'Remove the saved dependency graph. This is safe when no cache exists.',
    options: ['project'],
    examples: ['affected-node-test clear-cache'],
  },
  doctor: {
    summary: 'Validate setup without running tests.',
    description: 'Validate configuration, test discovery, cache state, Git availability, and workspace projects without running tests.',
    options: [],
    examples: ['affected-node-test doctor'],
  },
  init: {
    summary: 'Preview safe onboarding changes.',
    description: 'Preview or apply safe onboarding changes for the current package.',
    options: ['write'],
    examples: ['affected-node-test init --write'],
  },
} satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof commandCatalog;
export const commandNames = Object.freeze(Object.keys(commandCatalog) as CommandName[]);

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commandCatalog, value);
}

export function commandAllowsOption(command: CommandName, option: CommandOption) {
  return (commandCatalog[command].options as readonly CommandOption[]).includes(option);
}

export function commandPositionals(command: CommandName) {
  const definition: CommandDefinition = commandCatalog[command];
  return definition.positionals;
}

export function commandHelp(command: CommandName) {
  const definition: CommandDefinition = commandCatalog[command];
  const usage = `Usage: affected-node-test ${command}${definition.positionals ? ` ${definition.positionals}` : ''}` +
    definition.options.map((option) => ` [${optionUsage[option]}]`).join('');
  const extraUsage = definition.extraUsage?.map((line) => `       ${line}`).join('\n') ?? '';
  const notes = definition.notes ? `${definition.notes}\n\n` : '';
  const options = definition.options.map((option) => optionHelp[option]).join('\n');
  return `${definition.description}\n\n${usage}${extraUsage ? `\n${extraUsage}` : ''}\n\n${notes}Options:\n${options ? `${options}\n` : ''}  -h, --help       Show this command's help.\n\nExample:\n  ${definition.examples.join('\n  ')}`;
}

export function topLevelHelp() {
  const commands = commandNames.map((command) => {
    const definition: CommandDefinition = commandCatalog[command];
    const label = `${command}${definition.positionals ? ` ${definition.positionals}` : ''}`;
    return `  ${label.padEnd(22)}${definition.summary}`;
  }).join('\n');
  return `Affected test selection for Node's native test runner.

Usage: affected-node-test <COMMAND> [OPTIONS]

Commands:
${commands}

Global options:
  -h, --help       Show this help or COMMAND help.
  -v, --version    Show the installed version.

${concurrencyDefault}

Examples:
  affected-node-test baseline
  affected-node-test affected origin/main
  affected-node-test related src/math.mjs
  affected-node-test doctor

Run affected-node-test help COMMAND for command-specific details.`;
}
