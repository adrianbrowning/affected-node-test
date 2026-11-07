function selectedReason(reason) {
  if (reason.kind === 'dependency') return `changed dependency: ${reason.path.join(' -> ')}`;
  if (reason.kind === 'previous-failure') return 'previously failing test';
  if (reason.kind === 'unrecorded-test') return 'unrecorded test';
  if (reason.kind === 'dependency-state-change') return 'recorded dependency state changed';
  if (reason.kind === 'unresolved-static') {
    return `unresolved static import with code changes: ${reason.files.join(', ')}`;
  }
  if (reason.kind === 'watch-trigger') {
    return `watch trigger ${reason.pattern} matched ${reason.file}`;
  }
  return reason.kind;
}

function fallbackReason(reason) {
  if (!reason) return;
  if (reason.kind === 'unknown-code') return `unknown code changed: ${reason.files.join(', ')}`;
  if (reason.kind === 'project-configuration') {
    return `project configuration changed: ${reason.files.join(', ')}`;
  }
  if (reason.kind === 'force-rerun-trigger') {
    return `force-rerun trigger ${reason.pattern} matched ${reason.file}`;
  }
  if (reason.kind === 'watch-trigger-empty') {
    return `watch trigger ${reason.pattern} matched ${reason.file} but selected no tests`;
  }
  if (reason.kind === 'no-merge-base') return `no merge base with ${reason.ref}`;
  return reason.kind;
}

export function renderSelectionPreview({ allTests, selectedLabel = 'test file(s)', selection }) {
  if (!selection || selection.kind === 'baseline') {
    const lines = [`Dry run: full suite (${allTests.length} test file(s)).`];
    const explanation = fallbackReason(selection?.reason);
    if (explanation) lines.push(`  reason: ${explanation}`);
    for (const test of allTests) lines.push(`  ${test}`);
    return lines;
  }

  const lines = [`Dry run: selected ${selection.tests.length}/${allTests.length} ${selectedLabel}.`];
  for (const test of selection.tests) {
    lines.push(`  ${test}`);
    for (const reason of selection.reasons[test] ?? []) {
      lines.push(`    - ${selectedReason(reason)}`);
    }
  }
  return lines;
}
