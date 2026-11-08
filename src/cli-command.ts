import { availableParallelism } from 'node:os';
import { commandAllowsOption, commandPositionals } from './command-catalog.ts';
import type { CommandName } from './command-catalog.ts';
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
  write: boolean;
};

export function parseCliOptions(command: CommandName, values: string[]): CliOptions {
  const positionals: string[] = [];
  let dryRun = false;
  let output: CliOptions['output'] = 'human';
  const projectFilters: string[] = [];
  let concurrency = Math.max(1, Math.min(4, availableParallelism()));
  let phase: CliOptions['phase'];
  let plan: string | undefined;
  let write = false;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--concurrency') {
      if (!commandAllowsOption(command, 'concurrency')) throw new Error(`Unknown option: ${argument}`);
      try {
        concurrency = parseConcurrency(values[index + 1], availableParallelism());
      } catch (error: unknown) {
        throw new Error(errorMessage(error));
      }
      index += 1;
    } else if (argument === '--dry-run') {
      if (!commandAllowsOption(command, 'dry-run')) throw new Error(`Unknown option: ${argument}`);
      dryRun = true;
    } else if (argument === '--output=json') {
      if (!commandAllowsOption(command, 'output=json')) throw new Error(`Unknown option: ${argument}`);
      output = 'json';
    } else if (argument === '--project') {
      if (!commandAllowsOption(command, 'project')) throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--project requires a non-empty glob.');
      projectFilters.push(value);
      index += 1;
    } else if (argument === '--phase') {
      if (!commandAllowsOption(command, 'phase')) throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (value !== 'affected' && value !== 'remaining') throw new Error('--phase must be affected or remaining.');
      phase = value;
      index += 1;
    } else if (argument === '--plan') {
      if (!commandAllowsOption(command, 'plan')) throw new Error(`Unknown option: ${argument}`);
      const value = values[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--plan requires a project-relative path.');
      plan = value;
      index += 1;
    } else if (argument === '--write') {
      if (!commandAllowsOption(command, 'write')) throw new Error(`Unknown option: ${argument}`);
      if (write) throw new Error('--write may only be specified once.');
      write = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (commandPositionals(command) === '<FILE...>' && !positionals.length) {
    throw new Error(`${command} requires at least one FILE.`);
  }
  if (commandPositionals(command) === '[REF]' && positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  if (command === 'affected-first' && Boolean(phase) !== Boolean(plan)) {
    throw new Error('--phase and --plan must be used together.');
  }
  if (command === 'affected-first' && phase === 'remaining' && positionals.length) {
    throw new Error('The remaining phase reads REF from the plan; do not pass REF again.');
  }
  if (!commandPositionals(command) && positionals.length) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  return { command, concurrency, dryRun, output, phase, plan, positionals, projectFilters, write };
}

export function forwardedCliOptions(options: CliOptions): string[] {
  const forwarded: string[] = [];
  if (commandAllowsOption(options.command, 'concurrency')) forwarded.push('--concurrency', String(options.concurrency));
  if (options.dryRun) forwarded.push('--dry-run');
  if (options.output === 'json') forwarded.push('--output=json');
  return forwarded;
}
