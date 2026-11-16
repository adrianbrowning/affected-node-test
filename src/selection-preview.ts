import type { FallbackReason, SelectionOutcome, SelectionReason } from './selection-run.ts';

function selectedReason(reason: SelectionReason) {
  switch (reason.kind) {
    case 'dependency': return `changed dependency: ${reason.path.join(' -> ')}`;
    case 'previous-failure': return 'previously failing test';
    case 'unrecorded-test': return 'unrecorded test';
    case 'dependency-state-change': return 'recorded dependency state changed';
    case 'unresolved-static': return `unresolved static import with code changes: ${reason.files.join(', ')}`;
    case 'watch-trigger': return `watch trigger ${reason.pattern} matched ${reason.file}`;
    default: return 'unknown selection reason';
  }
}

function fallbackReason(reason: FallbackReason | undefined) {
  if (!reason) return;
  switch (reason.kind) {
    case 'unknown-code': return `unknown code changed: ${reason.files.join(', ')}`;
    case 'project-configuration': return `project configuration changed: ${reason.files.join(', ')}`;
    case 'force-rerun-trigger': return `force-rerun trigger ${reason.pattern} matched ${reason.file}`;
    case 'watch-trigger-empty':
      return `watch trigger ${reason.pattern} matched ${reason.file} but selected no tests`;
    case 'no-merge-base': return `no merge base with ${reason.ref}`;
    default: return 'unknown fallback reason';
  }
}

export function renderSelectionPreview({ allTests, selectedLabel = 'test file(s)', selection }: {
  allTests: string[];
  selectedLabel?: string;
  selection?: SelectionOutcome;
}) {
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
