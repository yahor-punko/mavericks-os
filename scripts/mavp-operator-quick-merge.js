#!/usr/bin/env node

/**
 * mavp-operator-quick-merge.js
 *
 * Fast-track for XS changes (1-2 files, 1-5 lines, no risk).
 * Creates a task directly with status `merged` in both BACKLOG.md and TASK_STATUS.md.
 * Updates last_task_id in PROCESS_STATE.json.
 * Appends a line to EXECUTION_LOG.md.
 * Runs validator once at the end.
 *
 * Usage: ./scripts/mavp-operator --quick-merge
 *
 * Prompts:
 *   1. Title (required)
 *   2. Commit hash (required)
 *   3. One-line note (optional, Enter to skip)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const {
  readUtf8,
  writeUtf8,
  getNextTaskId,
  insertIntoActiveWave,
  insertIntoActiveTasks,
  updateLastTaskId,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const EXECUTION_LOG_MD = path.join(ROOT, 'EXECUTION_LOG.md');

// Resolve validator path: project-mode uses MAVERICKS_SCRIPTS, self-mode uses local scripts/
const MAVERICKS_SCRIPTS = process.env.MAVERICKS_SCRIPTS
  || path.join(require('node:os').homedir(), 'Documents', 'mavericks', 'scripts');
const VALIDATOR = path.join(MAVERICKS_SCRIPTS, 'mavp-validator.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function buildBacklogEntry(id, title, note) {
  return `\n### ${id} — ${title}
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

**Problem:** ${note}
`;
}

function buildTaskStatusEntry(id, title, commitHash, note) {
  return `\n### ${id} — ${title}
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

- **Evidence:** commit: ${commitHash} branch: main — ${note}
`;
}

function appendExecutionLog(id, title, commitHash, date) {
  const line = `[${date}] ${id} quick-merge: ${title} (commit: ${commitHash})\n`;
  if (!fs.existsSync(EXECUTION_LOG_MD)) {
    writeUtf8(EXECUTION_LOG_MD, `# Execution Log\n\n${line}`);
  } else {
    fs.appendFileSync(EXECUTION_LOG_MD, line, 'utf8');
  }
}

/**
 * Read all input lines upfront when stdin is not a TTY (piped mode).
 * Returns a queue of lines that can be dequeued one at a time.
 */
function readPipedLines() {
  return new Promise(resolve => {
    const lines = [];
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => lines.push(line.trim()));
    rl.on('close', () => resolve(lines));
  });
}

async function collectInputs() {
  // Interactive TTY: prompt one at a time using readline
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = question => new Promise(resolve => {
      rl.question(`${question}: `, answer => resolve(answer.trim()));
    });
    const title = await ask('Title (required)');
    const commitHash = title ? await ask('Commit hash (required)') : '';
    const note = commitHash ? await ask('One-line note (optional, Enter to skip)') : '';
    rl.close();
    return { title, commitHash, note };
  }

  // Non-TTY (piped): read all lines upfront
  const lines = await readPipedLines();
  const title = lines[0] || '';
  const commitHash = lines[1] || '';
  const note = lines[2] || '';
  // Echo prompts so output looks like interactive mode
  process.stdout.write(`Title (required): ${title}\n`);
  if (title) process.stdout.write(`Commit hash (required): ${commitHash}\n`);
  if (title && commitHash) process.stdout.write(`One-line note (optional, Enter to skip): ${note}\n`);
  return { title, commitHash, note };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP Quick Merge${RESET} ${DIM}${today}${RESET}`);
  console.log(`${DIM}XS fast-track: creates task as merged immediately (no lifecycle ceremony).${RESET}`);
  console.log(`${DIM}Use only for XS changes: ≤2 files, ≤10 lines diff, no risk.${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);
  const id = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);

  console.log(`${CYAN}Next task ID: ${BOLD}${id}${RESET}\n`);

  const { title, commitHash, note } = await collectInputs();

  if (!title) {
    console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
    return;
  }

  if (!commitHash) {
    console.log(`${DIM}Cancelled — commit hash is required.${RESET}\n`);
    return;
  }

  const effectiveNote = note || title;

  const backlogEntry = buildBacklogEntry(id, title, effectiveNote);
  const taskStatusEntry = buildTaskStatusEntry(id, title, commitHash, effectiveNote);

  const updatedBacklog = insertIntoActiveWave(backlog, backlogEntry);
  const updatedTaskStatus = insertIntoActiveTasks(taskStatus, taskStatusEntry);

  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`\n${GREEN}✓ BACKLOG.md — ${id} added (merged)${RESET}`);

  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${id} added (merged)${RESET}`);

  const updated = updateLastTaskId(PROCESS_STATE_JSON, id);
  if (updated) {
    console.log(`${GREEN}✓ PROCESS_STATE.json — last_task_id updated to ${id.replace('T-', '')}${RESET}`);
  }

  appendExecutionLog(id, title, commitHash, today);
  console.log(`${GREEN}✓ EXECUTION_LOG.md — entry appended${RESET}`);

  // Run validator — print full stdout/stderr, do not swallow output
  console.log(`\n${DIM}Running validator...${RESET}`);
  const validatorResult = spawnSync('node', [VALIDATOR], {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (validatorResult.stdout) {
    process.stdout.write(validatorResult.stdout);
  }
  if (validatorResult.stderr) {
    process.stderr.write(validatorResult.stderr);
  }

  const exitCode = validatorResult.status || 0;
  if (exitCode === 0) {
    console.log(`${GREEN}✓ Validator: healthy${RESET}`);
  } else if (exitCode === 1) {
    console.log(`${YELLOW}⚠ Validator: drifting (exit 1)${RESET}`);
  } else {
    console.log(`${RED}✗ Validator: repair required (exit ${exitCode})${RESET}`);
    process.exitCode = exitCode;
    return;
  }

  console.log(`\n${BOLD}Created ${id} as merged: ${title}${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}quick-merge failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
