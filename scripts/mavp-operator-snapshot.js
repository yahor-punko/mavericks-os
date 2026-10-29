#!/usr/bin/env node

const path = require('node:path');
const { ROOT, collectOperatorData, generateProcessStateMd, guardReportingWrite, renderThinSnapshot } = require('./mavp-operator-lib');

const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');

// T-847: --help/-h exits before collecting data or regenerating PROCESS_STATE.md.
if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  process.stdout.write([
    'Usage: ./scripts/mavp-operator --snapshot',
    '',
    'Prints a text snapshot of the current project state. Takes no options;',
    '--help/-h prints this text and exits before reading or writing any project state.',
    '',
  ].join('\n'));
} else {
  // T-847: skip the PROCESS_STATE.md regeneration in a never-a-project root; the
  // snapshot itself is still printed from the existing artifacts.
  const writeGuard = guardReportingWrite(ROOT, '--snapshot');
  if (writeGuard.skip) {
    process.stderr.write(`${writeGuard.note}\n`);
  } else {
    generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);
  }
  console.log(renderThinSnapshot(collectOperatorData()));
}
