import { availableParallelism } from 'node:os';
import type { CommandName } from './cli-help.ts';
import { parseConcurrency } from './concurrency.ts';
import { errorMessage } from './errors.ts';

export type CliOptions = {
  command: CommandName;
  concurrency: number;
  dryRun: boolean;
  output: 'human' | 'json';
  phase?: 'affected' | 'remaining';
  plan?: string;
  positionals: string[];
  projectFilters: string[];
};

const selectionCommands: CommandName[] = ['baseline', 'affected', 'related', 'since-last-run', 'last-failed'];
const projectCommands: CommandName[] = [...selectionCommands, 'affected-first', 'watch', 'clear-cache'];

export function parseCliOptions(command: CommandName, values: string[]): CliOptions {
  const positionals: string[] = [];
  let dryRun = false;
  let output: CliOptions['output'] = 'human';
  const projectFilters: string[] = [];
  let concurrency = Math.max(1, Math.min(4, availableParallelism()));
  let phase: CliOptions['phase'];
  let plan: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--concurrency') {
      try {
        concurrency = parseConcurrency(values[index + 1], availableParallelism());
      } catch (error: unknown) {
        throw new Error(errorMessage(error));
      }
      index += 1;
    } else if (argument === '--dry-run') {
      if (!selectionCommands.includes(command)) throw new Error(`Unknown option: ${argument}`);
      dryRun = true;
    } else if (argument === '--output=json') {
      if (!projectCommands.includes(command) || command === 'watch' || command === 'clear-cache') {
        throw new Error(`Unknown option: ${argument}`);
      }
      output = 'json';
    } else if (argument === '--project') {
      if (!projectCommands.includes(command)) throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--project requires a non-empty glob.');
      projectFilters.push(value);
      index += 1;
    } else if (argument === '--phase') {
      if (command !== 'affected-first') throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (value !== 'affected' && value !== 'remaining') throw new Error('--phase must be affected or remaining.');
      phase = value;
      index += 1;
    } else if (argument === '--plan') {
      if (command !== 'affected-first') throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--plan requires a project-relative path.');
      plan = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (command === 'related' && !positionals.length) throw new Error('related requires at least one FILE.');
  if ((command === 'affected' || command === 'affected-first') && positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  if (command === 'affected-first' && Boolean(phase) !== Boolean(plan)) {
    throw new Error('--phase and --plan must be used together.');
  }
  if (command === 'affected-first' && phase === 'remaining' && positionals.length) {
    throw new Error('The remaining phase reads REF from the plan; do not pass REF again.');
  }
  if (command !== 'affected' && command !== 'affected-first' && command !== 'related' && positionals.length) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  return { command, concurrency, dryRun, output, phase, plan, positionals, projectFilters };
}

export function forwardedCliOptions(options: CliOptions): string[] {
  const forwarded = ['--concurrency', String(options.concurrency)];
  if (options.dryRun) forwarded.push('--dry-run');
  if (options.output === 'json') forwarded.push('--output=json');
  return forwarded;
}
