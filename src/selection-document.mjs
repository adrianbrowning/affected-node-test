const providers = Object.freeze({
  affected: 'git',
  baseline: 'baseline',
  related: 'explicit-files',
  'since-last-run': 'filesystem',
});

function createSelectionDocument({
  allTests,
  cacheFallback,
  command,
  execution,
  mode,
  projectRoot,
  selection,
}) {
  const selected = selection?.kind === 'selected';
  const tests = selected ? selection.tests : allTests;
  return {
    schemaVersion: 1,
    mode,
    command,
    provider: providers[command],
    projectRoot,
    outcome: selected ? (tests.length ? 'selected' : 'no-tests') : 'full-suite',
    tests,
    totalTests: allTests.length,
    reasons: selected ? selection.reasons : {},
    fallback: selected ? null : (selection?.reason ?? cacheFallback ?? null),
    ...(execution ? { execution } : {}),
  };
}

export function createSelectionPreviewDocument(options) {
  return createSelectionDocument({ ...options, mode: 'preview' });
}

export function createSelectionRunDocument({ result, runStatus, ...options }) {
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
