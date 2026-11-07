import { dependenciesForTest } from './dependency-graph.mjs';
import { matchesPatterns } from './project-config.mjs';

export async function executeSelection({
  baseline,
  contextMessages = [],
  emptyMessage,
  execute,
  log,
  selection,
  selectedLabel = 'test file(s)',
  totalTests,
}) {
  if (selection.kind === 'baseline') {
    log(selection.message);
    await baseline();
    return;
  }
  for (const message of selection.messages) log(message);
  for (const message of contextMessages) log(message);
  if (!selection.tests.length) {
    log(emptyMessage);
    return;
  }
  log(`Selected ${selection.tests.length}/${totalTests} ${selectedLabel}`);
  await execute(selection.tests);
}

export function selectTestsSinceLastRun({ dependencyStateChanged, record, tests }) {
  const selected = new Set(record.failedTests);
  for (const test of tests) {
    const state = record.dependencyStates[test];
    if (!state || dependencyStateChanged(state)) selected.add(test);
  }
  return { kind: 'selected', messages: [], tests: [...selected].sort() };
}

export function selectTestsForFiles({ config, files, record, tests }) {
  const forcedChange = files.find((path) => matchesPatterns(path, config.forceRerunTriggers));
  if (forcedChange) {
    return {
      kind: 'baseline',
      message: `Force-rerun trigger matched: ${forcedChange}; running full suite.`,
    };
  }
  if (files.some((path) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|node_modules\/|tsconfig[^/]*\.json|\.npmrc|\.node-version|\.nvmrc)$/.test(path))) {
    return { kind: 'baseline', message: 'Project configuration changed; running full suite.' };
  }

  const selected = new Set(record.failedTests);
  const known = new Set(tests);
  for (const test of tests) {
    for (const [parent, child] of record.graph[test] ?? []) {
      known.add(parent);
      known.add(child);
    }
  }
  const codeChange = (path) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
  const unknownCode = files.filter((path) => codeChange(path) && !known.has(path));
  if (unknownCode.length) {
    return {
      kind: 'baseline',
      message: `Unknown code file changed (${unknownCode.join(', ')}); running full suite.`,
    };
  }
  if (files.some(codeChange)) {
    for (const test of record.unresolvedStaticTests) selected.add(test);
  }

  const messages = [];
  const watchTriggeredChanges = new Set();
  const watchTriggeredTests = new Set();
  for (const mapping of config.watchTriggerPatterns) {
    for (const file of files) {
      if (!matchesPatterns(file, [mapping.pattern])) continue;
      watchTriggeredChanges.add(file);
      const mappedTests = tests.filter((test) => matchesPatterns(test, mapping.tests));
      if (!mappedTests.length) {
        return {
          kind: 'baseline',
          message: `Watch trigger matched ${file} but selected no tests; running full suite.`,
        };
      }
      for (const test of mappedTests) {
        selected.add(test);
        watchTriggeredTests.add(test);
      }
    }
  }
  if (watchTriggeredChanges.size) {
    messages.push(`Watch trigger matched ${[...watchTriggeredChanges].join(', ')}; selected ${watchTriggeredTests.size} mapped test file(s).`);
  }
  for (const test of tests) {
    if (files.some((file) => dependenciesForTest(record.graph[test] ?? [], test).has(file))) selected.add(test);
  }
  return { kind: 'selected', messages, tests: [...selected].sort() };
}
