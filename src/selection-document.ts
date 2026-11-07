const providers = Object.freeze({
  affected: 'git',
  baseline: 'baseline',
  'last-failed': 'cache',
  related: 'explicit-files',
  'since-last-run': 'filesystem',
});

import type { DependencyRunResult } from './dependency-record.ts';
import type { SelectionOutcome } from './selection-run.ts';

export type SelectionCommand = keyof typeof providers;
type CacheFallback = { kind: 'cache-unavailable'; message: string };
type ExecutionDocument = {
  exitCode: number;
  failures: string[];
  status: 'failed' | 'interrupted' | 'passed';
  tests: string[];
};
type SelectionDocumentOptions = {
  allTests: string[];
  cacheFallback?: CacheFallback;
  command: SelectionCommand;
  execution?: ExecutionDocument;
  mode: 'preview' | 'run';
  projectRoot: string;
  selection?: SelectionOutcome;
};

export function selectionProvider(command: SelectionCommand) {
  return providers[command];
}

export function isSelectionCommand(command: string): command is SelectionCommand {
  return Object.hasOwn(providers, command);
}

function createSelectionDocument({
  allTests,
  cacheFallback,
  command,
  execution,
  mode,
  projectRoot,
  selection,
}: SelectionDocumentOptions) {
  const selected = selection?.kind === 'selected';
  const tests = selected ? selection.tests : allTests;
  return {
    schemaVersion: 1,
    mode,
    command,
    provider: selectionProvider(command),
    projectRoot,
    outcome: selected ? (tests.length ? 'selected' : 'no-tests') : 'full-suite',
    tests,
    totalTests: allTests.length,
    reasons: selected ? selection.reasons : {},
    fallback: selected ? null : (selection?.reason ?? cacheFallback ?? null),
    ...(execution ? { execution } : {}),
  };
}

export function createSelectionPreviewDocument(options: Omit<SelectionDocumentOptions, 'execution' | 'mode'>) {
  return createSelectionDocument({ ...options, mode: 'preview' });
}

export function createSelectionRunDocument({ result, runStatus, ...options }: {
  result: Pick<DependencyRunResult, 'completedTests' | 'failedTests'>;
  runStatus: { exitCode: number; status: ExecutionDocument['status'] };
} & Omit<SelectionDocumentOptions, 'execution' | 'mode'>) {
  return createSelectionDocument({
    ...options,
    mode: 'run',
    execution: {
      status: runStatus.status,
      tests: result.completedTests,
      failures: result.failedTests,
      exitCode: runStatus.exitCode,
    },
  });
}
