#!/usr/bin/env node

/**
 * mavp-operator-update-task.js
 *
 * Update task status and/or owner in BACKLOG.md and TASK_STATUS.md atomically.
 * Runs validator after write.
 *
 * Usage:
 *   ./scripts/mavp-operator --update-task T-012 merged
 *   ./scripts/mavp-operator --update-task T-012 in_progress developer
 *   ./scripts/mavp-operator --update-task  (interactive picker)
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
const { writeContextBundle, updateTaskField, printRepoIdentityHeader, guardMutatingRoot } = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const VALIDATOR = path.join(
  process.env.MAVERICKS_SCRIPTS || path.join(require('node:os').homedir(), 'Documents', 'mavericks', 'scripts'),
  'mavp-validator.js'
);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

const VALID_STATUSES = [
  'planned', 'in_progress', 'dev_done',
  'ux_review', 'ux_needs_fix',
  'ready_for_qa', 'qa_in_progress', 'qa_passed',
  'needs_fix', 'merged',
];

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, content) { fs.writeFileSync(p, content, 'utf8'); }

function parseActiveTasks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+Active tasks/.test(l));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start + 1, end).join('\n');
  return [...section.matchAll(/^###\s+(T-\d+)\s+—\s+(.+)$/gm)].map(m => ({
    id: m[1],
    title: m[2].trim(),
  }));
}

function moveToCompleted(markdown, taskId) {
  const lines = markdown.split(/\r?\n/);
  const blockStart = lines.findIndex(l => new RegExp(`^###\\s+${taskId}\\s+`).test(l));
  if (blockStart === -1) return markdown;

  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    if (/^###\s+T-/.test(lines[i]) || /^##\s+/.test(lines[i])) { blockEnd = i; break; }
  }

  const block = lines.slice(blockStart, blockEnd);
  const remaining = [...lines.slice(0, blockStart), ...lines.slice(blockEnd)];

  const completedIdx = remaining.findIndex(l => /^##\s+Recently completed tasks/.test(l));
  if (completedIdx !== -1) {
    remaining.splice(completedIdx + 1, 0, '', ...block);
  } else {
    remaining.push('', '## Recently completed tasks', '', ...block);
  }
  return remaining.join('\n');
}

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(`${question}: `, resolve));
}

async function main() {
  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--update-task');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  let taskId = args[0];
  let newStatus = args[1];
  let newOwner = args[2] || null;

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const taskStatus = readUtf8(TASK_STATUS_MD);
  const activeTasks = parseActiveTasks(taskStatus);

  // Interactive mode if no args
  if (!taskId || !newStatus) {
    if (!activeTasks.length) {
      console.log(`${DIM}No active tasks found.${RESET}\n`);
      return;
    }

    console.log(`\n${BOLD}Active tasks:${RESET}`);
    activeTasks.forEach((t, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${t.id} — ${t.title}`));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (!taskId) {
      const idxRaw = await prompt(rl, `Task ID or number (1-${activeTasks.length})`);
      const idx = parseInt(idxRaw, 10);
      taskId = (idx >= 1 && idx <= activeTasks.length)
        ? activeTasks[idx - 1].id
        : idxRaw.trim().toUpperCase();
    }

    if (!newStatus) {
      console.log(`\n${DIM}Statuses: ${VALID_STATUSES.join(' | ')}${RESET}`);
      newStatus = (await prompt(rl, 'New status')).trim();
    }

    if (!newOwner) {
      const ownerRaw = await prompt(rl, 'New owner (leave blank to keep)');
      newOwner = ownerRaw.trim() || null;
    }

    rl.close();
  }

  if (!VALID_STATUSES.includes(newStatus)) {
    console.error(`${RED}Invalid status: ${newStatus}${RESET}`);
    console.error(`Valid: ${VALID_STATUSES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let backlog = readUtf8(BACKLOG_MD);
  let status = readUtf8(TASK_STATUS_MD);

  // Apply a single field write to BOTH BACKLOG.md and TASK_STATUS.md through
  // the bounded composer (T-606/T-607). Each write is scoped to taskId's own
  // block only — a target block missing the field, or a duplicate heading,
  // is reported via `reason` rather than silently falling through to (or
  // inserting into) some other block later in the file.
  const fieldWrites = [];
  function applyField(fieldName, value) {
    const backlogResult = updateTaskField(backlog, taskId, fieldName, value);
    const statusResult = updateTaskField(status, taskId, fieldName, value);
    if (backlogResult.ok) backlog = backlogResult.updated;
    if (statusResult.ok) status = statusResult.updated;
    fieldWrites.push({
      fieldName,
      value,
      backlogOk: backlogResult.ok,
      backlogReason: backlogResult.reason,
      statusOk: statusResult.ok,
      statusReason: statusResult.reason,
    });
  }

  // Update status in both files
  applyField('Status', newStatus);

  // Update owner if provided. Field name is "Owner role" — the name every
  // entry builder (buildTaskStatusEntry, --new-task, --apply-decomposition)
  // actually emits. A bare "Owner" field does exist on older archived/
  // completed blocks in this repo, but --update-task only ever targets
  // in-flight tasks (its own picker only lists "Active tasks"), and no
  // active block anywhere in this repo carries the legacy bare "Owner" name
  // — so there is nothing for a legacy-field fallback to usefully match here.
  // Adding one would also reintroduce exactly the two-names-for-one-concept
  // drift this task exists to close (see the bug report: the old code wrote
  // "Owner" everywhere, when every writer had already moved to "Owner role").
  // If --update-task is ever pointed at an already-archived task carrying a
  // bare "Owner" line, writing "Owner role" alongside it (rather than
  // rewriting the legacy line) is the correct, conservative behavior: it
  // never silently changes the semantics of an already-completed record.
  if (newOwner) {
    applyField('Owner role', newOwner);
  }

  // Move to completed section if merged
  if (newStatus === 'merged') {
    status = moveToCompleted(status, taskId);
  }

  writeUtf8(BACKLOG_MD, backlog);
  writeUtf8(TASK_STATUS_MD, status);

  // Regenerate context prefetch bundle (.mavp/context/T-NNN.md) — best effort, never fatal
  const bundleResult = writeContextBundle(taskId, { root: ROOT, backlogPath: BACKLOG_MD, taskStatusPath: TASK_STATUS_MD });
  if (bundleResult.ok) {
    console.log(`${GREEN}✓ Context bundle regenerated — .mavp/context/${taskId}.md${RESET}`);
  } else {
    console.log(`${DIM}(context bundle not regenerated: ${bundleResult.reason})${RESET}`);
  }

  // Update last_updated in PROCESS_STATE.json
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const psJson = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
      psJson.last_updated = new Date().toISOString().split('T')[0];
      fs.writeFileSync(PROCESS_STATE_JSON, JSON.stringify(psJson, null, 2) + '\n', 'utf8');
    }
  } catch { /* ignore if PROCESS_STATE.json is absent or malformed */ }

  const failedWrites = fieldWrites.filter(w => !w.backlogOk || !w.statusOk);

  if (failedWrites.length > 0) {
    for (const w of failedWrites) {
      if (!w.backlogOk) {
        console.log(`${YELLOW}⚠ BACKLOG.md: ${taskId} — "${w.fieldName}" not written (${w.backlogReason})${RESET}`);
      }
      if (!w.statusOk) {
        console.log(`${YELLOW}⚠ TASK_STATUS.md: ${taskId} — "${w.fieldName}" not written (${w.statusReason})${RESET}`);
      }
    }
    console.log(`${YELLOW}⚠ ${taskId} — one or more requested field writes changed nothing${RESET}\n`);
    process.exitCode = 1;
  } else {
    const ownerNote = newOwner ? ` (owner → ${newOwner})` : '';
    console.log(`\n${GREEN}✓ ${taskId} → ${newStatus}${ownerNote}${RESET}`);
  }

  // Run validator
  try {
    execSync(`node "${VALIDATOR}" "${ROOT}"`, { stdio: 'pipe' });
    console.log(`${GREEN}✓ Validator passed${RESET}\n`);
  } catch (err) {
    console.log(`${YELLOW}⚠ Validator exit ${err.status} — check artifacts${RESET}\n`);
  }
}

main().catch(err => {
  console.error(`${RED}update-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
