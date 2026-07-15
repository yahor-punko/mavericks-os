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
const { writeContextBundle } = require('./mavp-operator-lib.js');

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

function updateFieldInMarkdown(markdown, taskId, field, value) {
  const fieldPattern = new RegExp(`(###\\s+${taskId}\\s+—[\\s\\S]*?- \\*\\*${field}:\\*\\*)\\s+\\S+`, 'm');
  if (fieldPattern.test(markdown)) {
    return markdown.replace(fieldPattern, `$1 ${value}`);
  }
  return markdown;
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

  // Update status in both files
  backlog = updateFieldInMarkdown(backlog, taskId, 'Status', newStatus);
  status = updateFieldInMarkdown(status, taskId, 'Status', newStatus);

  // Update owner if provided
  if (newOwner) {
    backlog = updateFieldInMarkdown(backlog, taskId, 'Owner', newOwner);
    status = updateFieldInMarkdown(status, taskId, 'Owner', newOwner);
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

  const ownerNote = newOwner ? ` (owner → ${newOwner})` : '';
  console.log(`\n${GREEN}✓ ${taskId} → ${newStatus}${ownerNote}${RESET}`);

  // Run validator
  try {
    execSync(`node "${VALIDATOR}"`, { stdio: 'pipe' });
    console.log(`${GREEN}✓ Validator passed${RESET}\n`);
  } catch (err) {
    console.log(`${YELLOW}⚠ Validator exit ${err.status} — check artifacts${RESET}\n`);
  }
}

main().catch(err => {
  console.error(`${RED}update-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
