#!/usr/bin/env node

/**
 * mavp-operator-quick-merge.js
 *
 * Fast-track for XS changes (<=2 files, <=10 lines diff, no new files, no
 * risk). Creates one or more tasks directly with status `merged` in both
 * BACKLOG.md and TASK_STATUS.md.
 *
 * T-450 — the fast lane is now a *sanctioned* exception to the architect
 * gate, not merely an advisory one: every cited commit is inspected via git
 * plumbing BEFORE any file is written, and the whole run is refused (naming
 * the violated threshold and the measured value) if any commit exceeds the
 * ratified XS thresholds. The attested conditions printed below (no attack
 * surface / no config / no state-model change / trivial verification)
 * remain Main-Agent attestation — they are not machine-checked.
 *
 * Batch: accepts N title+commit(+optional note) items in a single run, both
 * interactively (TTY, loop until an empty title) and piped (grouped lines of
 * 3 per item — the original single-item 3-line piped contract still works
 * unchanged for N=1). All items are pre-flighted against the XS guard before
 * any registration happens — if any item fails, the ENTIRE run is refused
 * and nothing is written (zero partial registration). On success, sequential
 * T-NNN ids are assigned, last_task_id is bumped once to the highest, one
 * EXECUTION_LOG line is appended per item, and the validator runs exactly
 * once at the end.
 *
 * Usage: ./scripts/mavp-operator --quick-merge
 *
 * Prompts (repeated per item; empty title ends the batch):
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
  printRepoIdentityHeader,
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

// ---------------------------------------------------------------------------
// XS guard — pure, unit-testable: commit hash + repo cwd -> verdict.
// ---------------------------------------------------------------------------

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const MAX_FILES_CHANGED = 2;
const MAX_TOTAL_LINES = 10;

// Self-reference hardening: the guard itself and the wrapper it runs behind
// are in the sensitive set, so an edit to either can never ride the XS lane.
const SENSITIVE_EXACT_PATHS = [
  'scripts/mavp-validator.js',
  'scripts/mavp-operator-close-session.js',
  'scripts/mavp-operator-lib.js',
  'scripts/mavp-operator-quick-merge.js',
  'scripts/mavp-operator',
];
const SENSITIVE_PATH_PREFIXES = [
  '.claude/hooks/',
  'scripts/mavp-publish-',
];

function isSensitivePath(filePath) {
  if (SENSITIVE_EXACT_PATHS.includes(filePath)) return true;
  return SENSITIVE_PATH_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

function resolveCommit(commitHash, cwd) {
  const res = spawnSync('git', ['rev-parse', '--verify', `${commitHash}^{commit}`], { cwd, encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
  return res.stdout.trim();
}

// Diff base: first parent for a merge commit (or a normal commit's sole
// parent); the empty tree for a root commit with no parent at all.
function getDiffBase(fullHash, cwd) {
  const parentRes = spawnSync('git', ['rev-parse', `${fullHash}^1`], { cwd, encoding: 'utf8' });
  if (parentRes.status === 0 && parentRes.stdout && parentRes.stdout.trim()) {
    return parentRes.stdout.trim();
  }
  return EMPTY_TREE_HASH;
}

/**
 * Pure XS guard. Inspects the given commit's diff via git plumbing and
 * decides whether it qualifies for the quick-merge XS fast lane.
 *
 * @param {string} commitHash - commit-ish to inspect (short or full hash)
 * @param {string} cwd - path to the git repository containing the commit
 * @returns {{ok: true} | {ok: false, violation: string, detail: string}}
 */
function checkXsGuard(commitHash, cwd) {
  const fullHash = resolveCommit(commitHash, cwd);
  if (!fullHash) {
    return { ok: false, violation: 'unresolvable', detail: `commit ${commitHash} not resolvable` };
  }

  const base = getDiffBase(fullHash, cwd);
  const numstatRes = spawnSync('git', ['diff', '--numstat', base, fullHash], { cwd, encoding: 'utf8' });
  if (numstatRes.status !== 0) {
    return { ok: false, violation: 'unresolvable', detail: `commit ${commitHash} diff could not be computed` };
  }

  const lines = (numstatRes.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  const filesChanged = lines.length;

  if (filesChanged > MAX_FILES_CHANGED) {
    return {
      ok: false,
      violation: 'files_changed',
      detail: `commit ${commitHash} changes ${filesChanged} files (max ${MAX_FILES_CHANGED})`,
    };
  }

  const paths = [];
  let totalLines = 0;
  for (const line of lines) {
    const parts = line.split('\t');
    const added = parts[0];
    const deleted = parts[1];
    const filePath = parts.slice(2).join('\t');
    paths.push(filePath);
    if (added === '-' || deleted === '-') {
      return {
        ok: false,
        violation: 'binary_file',
        detail: `commit ${commitHash} touches binary file "${filePath}" (line count not mechanically checkable)`,
      };
    }
    totalLines += parseInt(added, 10) + parseInt(deleted, 10);
  }

  if (totalLines > MAX_TOTAL_LINES) {
    return {
      ok: false,
      violation: 'total_lines',
      detail: `commit ${commitHash} changes ${totalLines} total changed lines (max ${MAX_TOTAL_LINES})`,
    };
  }

  const addedRes = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', base, fullHash], { cwd, encoding: 'utf8' });
  const addedFiles = (addedRes.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (addedFiles.length > 0) {
    return {
      ok: false,
      violation: 'new_files',
      detail: `commit ${commitHash} adds new tracked file(s): ${addedFiles.join(', ')} (zero new files allowed)`,
    };
  }

  for (const filePath of paths) {
    if (isSensitivePath(filePath)) {
      return {
        ok: false,
        violation: 'sensitive_path',
        detail: `commit ${commitHash} touches sensitive path "${filePath}"`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Artifact rendering
// ---------------------------------------------------------------------------

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

function nextIdFrom(idString, offset) {
  const num = parseInt(idString.replace('T-', ''), 10);
  return `T-${String(num + offset).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Batch input collection
// ---------------------------------------------------------------------------

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

/**
 * Interactive TTY collection: loop asking Title/Commit/Note per item.
 * An empty title ends the batch (after at least one item has been
 * collected). A missing commit hash on any item cancels the ENTIRE run
 * (matches the original single-item cancellation semantics).
 *
 * @returns {Promise<Array|null>} items, or null on hard cancel
 */
async function collectInputsTTY() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = question => new Promise(resolve => {
    rl.question(`${question}: `, answer => resolve(answer.trim()));
  });

  const items = [];
  while (true) {
    const titleLabel = items.length === 0
      ? 'Title (required)'
      : `Title for item ${items.length + 1} (Enter to finish)`;
    const title = await ask(titleLabel);
    if (!title) {
      if (items.length === 0) {
        console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
      }
      break;
    }
    const commitHash = await ask('Commit hash (required)');
    if (!commitHash) {
      console.log(`${DIM}Cancelled — commit hash is required.${RESET}\n`);
      rl.close();
      return null;
    }
    const note = await ask('One-line note (optional, Enter to skip)');
    items.push({ title, commitHash, note });
  }
  rl.close();
  return items;
}

/**
 * Piped (non-TTY) collection: lines are grouped in chunks of 3
 * (title, commitHash, note) — the original single-item 3-line contract is
 * just the N=1 case of this. A missing/empty title chunk ends the batch; a
 * present title with a missing commit hash cancels the ENTIRE run.
 *
 * @returns {Promise<Array|null>} items, or null on hard cancel
 */
async function collectInputsPiped() {
  const lines = await readPipedLines();
  const items = [];
  let i = 0;
  while (i < lines.length) {
    const title = lines[i] || '';
    const titleLabel = items.length === 0
      ? 'Title (required)'
      : `Title for item ${items.length + 1} (Enter to finish)`;
    if (!title) break;
    process.stdout.write(`${titleLabel}: ${title}\n`);

    const commitHash = lines[i + 1] || '';
    process.stdout.write(`Commit hash (required): ${commitHash}\n`);
    if (!commitHash) {
      console.log(`${DIM}Cancelled — commit hash is required.${RESET}\n`);
      return null;
    }

    const note = lines[i + 2] || '';
    process.stdout.write(`One-line note (optional, Enter to skip): ${note}\n`);

    items.push({ title, commitHash, note });
    i += 3;
  }

  if (items.length === 0) {
    console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
  }
  return items;
}

async function collectBatch() {
  return process.stdin.isTTY ? collectInputsTTY() : collectInputsPiped();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  printRepoIdentityHeader(ROOT);

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP Quick Merge${RESET} ${DIM}${today}${RESET}`);
  console.log(`${DIM}XS fast-track: creates task(s) as merged immediately (no lifecycle ceremony).${RESET}`);
  console.log(`${DIM}Use only for XS changes: <=2 files, <=10 lines diff, no new files, no risk.${RESET}`);
  console.log(`${DIM}Each cited commit is checked against the XS guard before anything is written.${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const items = await collectBatch();
  if (!items || items.length === 0) {
    return;
  }

  // --- Pre-flight: run the XS guard against every item BEFORE any write. ---
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const verdict = checkXsGuard(item.commitHash, ROOT);
    if (!verdict.ok) {
      console.log(`${RED}✗ XS guard: item ${idx + 1} "${item.title}" (commit ${item.commitHash}) refused${RESET}`);
      console.log(`${RED}  Violated threshold [${verdict.violation}]: ${verdict.detail}${RESET}`);
      console.log(`${DIM}Entire run refused — no BACKLOG.md/TASK_STATUS.md changes were made.${RESET}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`${GREEN}✓ XS guard: item ${idx + 1} "${item.title}" (commit ${item.commitHash}) passed${RESET}`);
  }
  console.log('');

  // --- All items passed — assign sequential ids and register. ---
  const backlog0 = readUtf8(BACKLOG_MD);
  const taskStatus0 = readUtf8(TASK_STATUS_MD);
  const firstId = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);

  let updatedBacklog = backlog0;
  let updatedTaskStatus = taskStatus0;
  let lastId = firstId;
  const registered = [];

  for (let idx = 0; idx < items.length; idx++) {
    const id = nextIdFrom(firstId, idx);
    lastId = id;
    const { title, commitHash, note } = items[idx];
    const effectiveNote = note || title;

    updatedBacklog = insertIntoActiveWave(updatedBacklog, buildBacklogEntry(id, title, effectiveNote));
    updatedTaskStatus = insertIntoActiveTasks(updatedTaskStatus, buildTaskStatusEntry(id, title, commitHash, effectiveNote));

    registered.push({ id, title, commitHash });
  }

  writeUtf8(BACKLOG_MD, updatedBacklog);
  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  for (const { id } of registered) {
    console.log(`${GREEN}✓ BACKLOG.md / TASK_STATUS.md — ${id} added (merged)${RESET}`);
  }

  const updated = updateLastTaskId(PROCESS_STATE_JSON, lastId);
  if (updated) {
    console.log(`${GREEN}✓ PROCESS_STATE.json — last_task_id updated to ${lastId.replace('T-', '')}${RESET}`);
  }

  for (const { id, title, commitHash } of registered) {
    appendExecutionLog(id, title, commitHash, today);
  }
  console.log(`${GREEN}✓ EXECUTION_LOG.md — ${registered.length} entr${registered.length === 1 ? 'y' : 'ies'} appended${RESET}`);

  // Run validator EXACTLY ONCE — print full stdout/stderr, do not swallow output
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

  const titles = registered.map(r => `${r.id} (${r.title})`).join(', ');
  console.log(`\n${BOLD}Created as merged: ${titles}${RESET}\n`);
}

module.exports = {
  checkXsGuard,
  isSensitivePath,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`${RED}quick-merge failed: ${err.message}${RESET}`);
    process.exitCode = 1;
  });
}
