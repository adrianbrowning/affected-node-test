import { dependencyPathForTest } from './dependency-graph.ts';
import { matchesPatterns } from './project-config.ts';
import type { DependencyRecord, DependencyState } from './dependency-record.ts';
import type { ProjectConfig } from './project-config.ts';

export type SelectionReason =
  | { file: string; kind: 'dependency'; path: string[] }
  | { kind: 'dependency-state-change' }
  | { kind: 'previous-failure' }
  | { kind: 'unrecorded-test' }
  | { files: string[]; kind: 'unresolved-static' }
  | { file: string; kind: 'watch-trigger'; pattern: string };
export type FallbackReason =
  | { file: string; kind: 'force-rerun-trigger'; pattern: string }
  | { files: string[]; kind: 'project-configuration' }
  | { files: string[]; kind: 'unknown-code' }
  | { file: string; kind: 'watch-trigger-empty'; pattern: string; testPatterns: string[] }
  | { kind: 'no-merge-base'; ref: string };
export type SelectedOutcome = {
  kind: 'selected';
  messages: string[];
  reasons: Record<string, SelectionReason[]>;
  tests: string[];
};
export type BaselineOutcome = {
  kind: 'baseline';
  message: string;
  reason?: FallbackReason;
};
export type SelectionOutcome = BaselineOutcome | SelectedOutcome;
type SelectionDetails = { selectedLabel: string };
export type PreparedSelection = {
  announceSelected?: boolean;
  contextMessages?: string[];
  emptyMessage?: string;
  selectedLabel?: string;
  selection: SelectionOutcome;
};

function reasonCollector() {
  const collected = new Map<string, SelectionReason[]>();
  return {
    add(test: string, reason: SelectionReason) {
      if (!collected.has(test)) collected.set(test, []);
      collected.get(test)?.push(reason);
    },
    forTests(tests: Iterable<string>) {
      return Object.fromEntries([...tests].sort().map((test) => [test, collected.get(test) ?? []]));
    },
  };
}

export async function executeSelectionRun<RecordType>({
  baseline,
  empty,
  execute,
  loadRecord,
  log,
  prepare,
  totalTests,
}: {
  baseline: (record?: RecordType, selection?: BaselineOutcome) => Promise<unknown>;
  empty?: (record: RecordType, selection: SelectedOutcome, details: SelectionDetails) => Promise<unknown> | unknown;
  execute: (tests: string[], record: RecordType, selection: SelectedOutcome, details: SelectionDetails) => Promise<unknown>;
  loadRecord: () => RecordType | undefined;
  log: (message: string) => unknown;
  prepare: (record: RecordType) => PreparedSelection;
  totalTests: number;
}) {
  const record = loadRecord();
  if (!record) {
    await baseline();
    return;
  }
  await executeSelection({
    ...prepare(record),
    baseline: (selection) => baseline(record, selection),
    empty: (selection, details) => empty?.(record, selection, details),
    execute: (selectedTests, selection, details) => execute(selectedTests, record, selection, details),
    log,
    totalTests,
  });
}

async function executeSelection({
  baseline,
  announceSelected = true,
  contextMessages = [],
  empty,
  emptyMessage = 'No tests selected.',
  execute,
  log,
  selection,
  selectedLabel = 'test file(s)',
  totalTests,
}: PreparedSelection & {
  baseline: (selection: BaselineOutcome) => Promise<unknown>;
  empty?: (selection: SelectedOutcome, details: SelectionDetails) => Promise<unknown> | unknown;
  execute: (tests: string[], selection: SelectedOutcome, details: SelectionDetails) => Promise<unknown>;
  log: (message: string) => unknown;
  totalTests: number;
}) {
  if (selection.kind === 'baseline') {
    log(selection.message);
    await baseline(selection);
    return;
  }
  for (const message of selection.messages) log(message);
  for (const message of contextMessages) log(message);
  if (!selection.tests.length) {
    log(emptyMessage);
    await empty?.(selection, { selectedLabel });
    return;
  }
  if (announceSelected) log(`Selected ${selection.tests.length}/${totalTests} ${selectedLabel}`);
  await execute(selection.tests, selection, { selectedLabel });
}

export function selectTestsSinceLastRun({ dependencyStateChanged, record, tests }: {
  dependencyStateChanged: (state: DependencyState) => boolean;
  record: Pick<DependencyRecord, 'dependencyStates' | 'failedTests'>;
  tests: string[];
}): SelectedOutcome {
  const selected = new Set<string>();
  const reasons = reasonCollector();
  for (const test of record.failedTests) {
    selected.add(test);
    reasons.add(test, { kind: 'previous-failure' });
  }
  for (const test of tests) {
    const state = record.dependencyStates[test];
    if (!state) {
      selected.add(test);
      reasons.add(test, { kind: 'unrecorded-test' });
    } else if (dependencyStateChanged(state)) {
      selected.add(test);
      reasons.add(test, { kind: 'dependency-state-change' });
    }
  }
  return {
    kind: 'selected',
    messages: [],
    reasons: reasons.forTests(selected),
    tests: [...selected].sort(),
  };
}

export function selectLastFailed({ record }: { record: Pick<DependencyRecord, 'failedTests'> }): SelectedOutcome {
  const tests = [...record.failedTests].sort();
  const reasons = reasonCollector();
  for (const test of tests) reasons.add(test, { kind: 'previous-failure' });
  return {
    kind: 'selected',
    messages: [],
    reasons: reasons.forTests(tests),
    tests,
  };
}

export function selectTestsForFiles({ config, files, record, tests }: {
  config: Pick<ProjectConfig, 'forceRerunTriggers' | 'watchTriggerPatterns'>;
  files: string[];
  record: Pick<DependencyRecord, 'dependencyStates' | 'failedTests' | 'graph' | 'unresolvedStaticTests'>;
  tests: string[];
}): SelectionOutcome {
  for (const file of files) {
    const pattern = config.forceRerunTriggers.find((candidate) => matchesPatterns(file, [candidate]));
    if (!pattern) continue;
    return {
      kind: 'baseline',
      message: `Force-rerun trigger matched: ${file}; running full suite.`,
      reason: { file, kind: 'force-rerun-trigger', pattern },
    };
  }
  const configurationFiles = files.filter((path) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|node_modules\/|tsconfig[^/]*\.json|\.npmrc|\.node-version|\.nvmrc)$/.test(path));
  if (configurationFiles.length) {
    return {
      kind: 'baseline',
      message: 'Project configuration changed; running full suite.',
      reason: { files: configurationFiles, kind: 'project-configuration' },
    };
  }

  const selected = new Set<string>();
  const reasons = reasonCollector();
  for (const test of record.failedTests) {
    selected.add(test);
    reasons.add(test, { kind: 'previous-failure' });
  }
  for (const test of tests) {
    if (!Object.hasOwn(record.dependencyStates, test)) {
      selected.add(test);
      reasons.add(test, { kind: 'unrecorded-test' });
    }
  }
  const known = new Set(tests);
  for (const test of tests) {
    for (const [parent, child] of record.graph[test] ?? []) {
      known.add(parent);
      known.add(child);
    }
  }
  const codeChange = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
  const unknownCode = files.filter((path) => codeChange(path) && !known.has(path));
  if (unknownCode.length) {
    return {
      kind: 'baseline',
      message: `Unknown code file changed (${unknownCode.join(', ')}); running full suite.`,
      reason: { files: unknownCode, kind: 'unknown-code' },
    };
  }
  const changedCodeFiles = files.filter(codeChange);
  if (changedCodeFiles.length) {
    for (const test of record.unresolvedStaticTests) {
      selected.add(test);
      reasons.add(test, { files: changedCodeFiles, kind: 'unresolved-static' });
    }
  }

  const messages = [];
  const watchTriggeredChanges = new Set<string>();
  const watchTriggeredTests = new Set<string>();
  for (const mapping of config.watchTriggerPatterns) {
    for (const file of files) {
      if (!matchesPatterns(file, [mapping.pattern])) continue;
      watchTriggeredChanges.add(file);
      const mappedTests = tests.filter((test) => matchesPatterns(test, mapping.tests));
      if (!mappedTests.length) {
        return {
          kind: 'baseline',
          message: `Watch trigger matched ${file} but selected no tests; running full suite.`,
          reason: {
            file,
            kind: 'watch-trigger-empty',
            pattern: mapping.pattern,
            testPatterns: mapping.tests,
          },
        };
      }
      for (const test of mappedTests) {
        selected.add(test);
        reasons.add(test, { file, kind: 'watch-trigger', pattern: mapping.pattern });
        watchTriggeredTests.add(test);
      }
    }
  }
  if (watchTriggeredChanges.size) {
    messages.push(`Watch trigger matched ${[...watchTriggeredChanges].join(', ')}; selected ${watchTriggeredTests.size} mapped test file(s).`);
  }
  for (const test of tests) {
    for (const file of files) {
      const path = dependencyPathForTest(record.graph[test] ?? [], test, file);
      if (!path) continue;
      selected.add(test);
      reasons.add(test, { file, kind: 'dependency', path });
    }
  }
  return {
    kind: 'selected',
    messages,
    reasons: reasons.forTests(selected),
    tests: [...selected].sort(),
  };
}
