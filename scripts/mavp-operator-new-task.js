#!/usr/bin/env node

/**
 * mavp-operator-new-task.js
 *
 * Interactive task creation — appends to BACKLOG.md and TASK_STATUS.md atomically.
 * Auto-increments task ID from highest existing T-NNN.
 * Runs validator after write.
 *
 * Usage: ./scripts/mavp-operator --new-task
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
const {
  readUtf8,
  writeUtf8,
  getNextTaskId,
  insertIntoActiveWave,
  insertIntoActiveTasks,
  updateLastTaskId,
  parseTasksWithRepo,
  getDeployPendingForRepo,
} = require('./mavp-operator-lib.js');

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

function buildBacklogEntry(id, title, owner, repo, dependsOn, requiresUx, criteria, verificationType) {
  return `\n### ${id} — ${title}
- **Status:** planned
- **Owner role:** ${owner}
- **Repo:** ${repo || 'TBD'}
- **Depends on:** ${dependsOn || '—'}
- **Requires ux:** ${requiresUx}
- **Acceptance criteria:** ${criteria || '[fill in]'}
- **Verification type:** ${verificationType}
- **Evidence expected:** —
`;
}

function buildTaskStatusEntry(id, title, owner, verificationType) {
  return `\n### ${id} — ${title}
- **Status:** planned
- **Owner role:** ${owner}
- **Verification type:** ${verificationType}
- **Last verified by:** —
- **Evidence:** —
`;
}

async function prompt(rl, question, fallback) {
  return new Promise(resolve => {
    const q = fallback !== undefined ? `${question} [${fallback}]: ` : `${question}: `;
    rl.question(q, answer => resolve(answer.trim() || fallback || ''));
  });
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP New Task${RESET} ${DIM}${today}${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);
  const id = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);

  console.log(`${CYAN}Next task ID: ${BOLD}${id}${RESET}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const title = await prompt(rl, 'Title');
  if (!title) {
    console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
    rl.close();
    return;
  }

  const ownerRaw = await prompt(rl, 'Owner (developer/qa/ux/orchestrator)', 'developer');
  const owner = ownerRaw || 'developer';

  const repoRaw = await prompt(rl, 'Repo (e.g. mavericks, example-service, or leave blank)', '');
  const repo = repoRaw || 'TBD';
  const dependsOn = await prompt(rl, 'Depends on (T-NNN, or leave blank)', '');
  const requiresUxRaw = await prompt(rl, 'Requires UX review? (y/N)', 'n');
  const requiresUx = /^y/i.test(requiresUxRaw) ? 'true' : 'false';
  const criteria = await prompt(rl, 'Acceptance criteria (or leave blank)', '');
  const verificationTypeRaw = await prompt(rl, 'Verification type (artifact/runtime/visual/manual)', 'artifact');
  const verificationType = verificationTypeRaw || 'artifact';

  rl.close();

  // Warn if the target repo has deploy_pending tasks
  try {
    const psJson = fs.existsSync(PROCESS_STATE_JSON)
      ? JSON.parse(readUtf8(PROCESS_STATE_JSON))
      : {};
    const deployContours = psJson.deploy_contours != null ? psJson.deploy_contours : 2;
    const allTasks = parseTasksWithRepo(taskStatus, backlog);
    const pending = getDeployPendingForRepo(allTasks, repo, deployContours);
    if (pending.length > 0) {
      console.warn(`\n${YELLOW}⚠  Warning: ${pending.length} task(s) in ${repo} have pending deploys. Consider deploying before adding new tasks.${RESET}`);
      pending.forEach(t => console.warn(`   ${DIM}${t.id} — ${t.title}${RESET}`));
    }
  } catch (_) {
    // Non-fatal — continue regardless
  }

  const backlogEntry = buildBacklogEntry(id, title, owner, repo, dependsOn, requiresUx, criteria, verificationType);
  const taskStatusEntry = buildTaskStatusEntry(id, title, owner, verificationType);

  const updatedBacklog = insertIntoActiveWave(backlog, backlogEntry);
  const updatedTaskStatus = insertIntoActiveTasks(taskStatus, taskStatusEntry);

  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`\n${GREEN}✓ BACKLOG.md — ${id} added${RESET}`);

  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${id} added${RESET}`);

  // Update last_task_id in PROCESS_STATE.json
  const updated = updateLastTaskId(PROCESS_STATE_JSON, id);
  if (updated) {
    console.log(`${GREEN}✓ PROCESS_STATE.json — last_task_id updated to ${id.replace('T-', '')}${RESET}`);
  }

  // Run validator
  try {
    execSync(`node "${VALIDATOR}"`, { stdio: 'pipe' });
    console.log(`${GREEN}✓ Validator passed${RESET}`);
  } catch (err) {
    const code = err.status;
    console.log(`${YELLOW}⚠ Validator exit ${code} — check artifacts${RESET}`);
  }

  console.log(`\n${BOLD}${id} — ${title}${RESET} ${DIM}(${owner}${requiresUx === 'true' ? ', requires UX' : ''})${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}new-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
