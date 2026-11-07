const providers = Object.freeze({
  affected: 'git',
  baseline: 'baseline',
  related: 'explicit-files',
  'since-last-run': 'filesystem',
});

export function createSelectionPreviewDocument({
  allTests,
  cacheFallback,
  command,
  projectRoot,
  selection,
}) {
  const selected = selection?.kind === 'selected';
  const tests = selected ? selection.tests : allTests;
  return {
    schemaVersion: 1,
    mode: 'preview',
    command,
    provider: providers[command],
    projectRoot,
    outcome: selected ? (tests.length ? 'selected' : 'no-tests') : 'full-suite',
    tests,
    totalTests: allTests.length,
    reasons: selected ? selection.reasons : {},
    fallback: selected ? null : (selection?.reason ?? cacheFallback ?? null),
  };
}
