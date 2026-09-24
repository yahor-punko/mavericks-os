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
  console.error('Usage: mavp-operator --ack-recheck RC-N [--rearm] [--due YYYY-MM-DD]');
  console.error('');
  console.error('  RC-N     Recheck ID to acknowledge (e.g. RC-1)');
  console.error('  --rearm  Instead of removing the entry, reschedule it.');
  console.error('           Without --due: due = today + interval. The entry must have an');
  console.error('           interval set (from --arm-recheck --interval).');
  console.error('           With --due YYYY-MM-DD: due = that explicit date (today or later);');
  console.error('           no interval required — use this to rearm an interval-less entry');
  console.error('           (e.g. a wave recheck armed via --park-wave --until).');
  console.error('  --due    Explicit due date, YYYY-MM-DD. Only valid together with --rearm.');
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
let due = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--rearm') {
    rearm = true;
  } else if (args[i] === '--due') {
    due = args[i + 1];
    i++;
    if (!due || due.startsWith('--')) {
      console.error('Error: --due requires a value (YYYY-MM-DD).');
      console.error('');
      printUsage();
      process.exit(1);
    }
  } else if (args[i].startsWith('--due=')) {
    due = args[i].slice('--due='.length);
  } else {
    console.error(`Error: Unknown argument "${args[i]}".`);
    console.error('');
    printUsage();
    process.exit(1);
  }
}

// T-771: --due only makes sense together with --rearm — acking without
// --rearm removes the entry, so a due date on that path would be
// meaningless. Refuse before any write.
if (due && !rearm) {
  console.error('Error: --due requires --rearm (acking without --rearm removes the entry).');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

let result;
try {
  result = ackRecheck({
    recheckId,
    rearm,
    due: due || undefined,
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
