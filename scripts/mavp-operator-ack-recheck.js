'use strict';
// mavp-operator-ack-recheck.js — acknowledge (or re-arm) a recheck entry in PROCESS_STATE.json
// Usage: node mavp-operator-ack-recheck.js RC-N [--rearm]

const path = require('node:path');
const { ackRecheck, ROOT, printRepoIdentityHeader, guardMutatingRoot } = require('./mavp-operator-lib.js');

const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');

printRepoIdentityHeader(ROOT, { mutating: true });

const rootGuard = guardMutatingRoot(ROOT, '--ack-recheck');
if (rootGuard.blocked) {
  process.exit(1);
}

function printUsage() {
  console.error('Usage: mavp-operator --ack-recheck RC-N [--rearm]');
  console.error('');
  console.error('  RC-N     Recheck ID to acknowledge (e.g. RC-1)');
  console.error('  --rearm  Instead of removing the entry, reschedule due = today + interval.');
  console.error('           The entry must have an interval set (from --arm-recheck --interval).');
}

const args = process.argv.slice(2);

// First positional arg is the recheck ID
const recheckId = args[0];
if (!recheckId || recheckId.startsWith('--')) {
  console.error('Error: Recheck ID (RC-N) is required as the first argument.');
  console.error('');
  printUsage();
  process.exit(1);
}

if (!/^RC-\d+$/.test(recheckId)) {
  console.error(`Error: Invalid recheck ID "${recheckId}". Expected format RC-N (e.g. RC-1).`);
  process.exit(1);
}

// Parse flags
let rearm = false;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--rearm') {
    rearm = true;
  } else {
    console.error(`Error: Unknown argument "${args[i]}".`);
    console.error('');
    printUsage();
    process.exit(1);
  }
}

const today = new Date().toISOString().slice(0, 10);

let result;
try {
  result = ackRecheck({
    recheckId,
    rearm,
    today,
    processStateJsonPath: PROCESS_STATE_JSON,
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

if (result.rearmed) {
  console.log(`Recheck ${recheckId} rearmed.`);
  console.log(`  new due:   ${result.newDue}`);
  console.log(`  armed_at:  ${today}`);
  console.log(`  title:     ${result.entry.title}`);
} else {
  console.log(`Recheck ${recheckId} acknowledged and removed.`);
  console.log(`  was due:   ${result.entry.due}`);
  console.log(`  title:     ${result.entry.title}`);
}
