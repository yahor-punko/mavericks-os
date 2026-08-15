'use strict';
// mavp-operator-arm-recheck.js — register a new recheck entry in PROCESS_STATE.json
// Usage: node mavp-operator-arm-recheck.js T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]

const path = require('node:path');
const { armRecheck, ROOT, printRepoIdentityHeader, guardMutatingRoot } = require('./mavp-operator-lib.js');

const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const BACKLOG_PATH = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_PATH = path.join(ROOT, 'TASK_STATUS.md');

printRepoIdentityHeader(ROOT, { mutating: true });

const rootGuard = guardMutatingRoot(ROOT, '--arm-recheck');
if (rootGuard.blocked) {
  process.exit(1);
}

function printUsage() {
  console.error('Usage: mavp-operator --arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]');
  console.error('');
  console.error('  T-NNN        Task ID to create a recheck for');
  console.error('  --due        Due date in YYYY-MM-DD format (required)');
  console.error('  --interval   Repeat interval, e.g. "8w", "2d" (optional; required for --rearm later)');
  console.error('  --note       Optional free-text note for context');
}

const args = process.argv.slice(2);

// First positional arg is the task ID
const taskId = args[0];
if (!taskId || taskId.startsWith('--')) {
  console.error('Error: Task ID (T-NNN) is required as the first argument.');
  console.error('');
  printUsage();
  process.exit(1);
}

if (!/^T-\d+$/.test(taskId)) {
  console.error(`Error: Invalid task ID "${taskId}". Expected format T-NNN (e.g. T-123).`);
  process.exit(1);
}

// Parse named flags
let due = null;
let interval = null;
let note = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--due' && args[i + 1]) {
    due = args[++i];
  } else if (args[i] === '--interval' && args[i + 1]) {
    interval = args[++i];
  } else if (args[i] === '--note' && args[i + 1]) {
    note = args[++i];
  } else if (args[i].startsWith('--due=')) {
    due = args[i].slice('--due='.length);
  } else if (args[i].startsWith('--interval=')) {
    interval = args[i].slice('--interval='.length);
  } else if (args[i].startsWith('--note=')) {
    note = args[i].slice('--note='.length);
  } else {
    console.error(`Error: Unknown argument "${args[i]}".`);
    console.error('');
    printUsage();
    process.exit(1);
  }
}

if (!due) {
  console.error('Error: --due YYYY-MM-DD is required.');
  console.error('');
  printUsage();
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

let result;
try {
  result = armRecheck({
    taskId,
    due,
    interval: interval || undefined,
    note: note || undefined,
    today,
    processStateJsonPath: PROCESS_STATE_JSON,
    backlogPath: BACKLOG_PATH,
    taskStatusPath: TASK_STATUS_PATH,
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

console.log(`Recheck armed: ${result.id}`);
console.log(`  task:      ${result.entry.task}`);
console.log(`  title:     ${result.entry.title}`);
console.log(`  due:       ${result.entry.due}`);
if (result.entry.interval) console.log(`  interval:  ${result.entry.interval}`);
if (result.entry.note) console.log(`  note:      ${result.entry.note}`);
console.log(`  armed_at:  ${result.entry.armed_at}`);
