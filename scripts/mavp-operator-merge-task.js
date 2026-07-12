#!/usr/bin/env node

/**
 * mavp-operator-merge-task.js
 *
 * Interactive qa_passed → merged transition.
 * Collects commit hash + evidence summary, updates both artifacts, runs validator.
 *
 * Usage: ./scripts/mavp-operator --merge-task
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
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

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, content) { fs.writeFileSync(p, content, 'utf8'); }

/**
 * Parse all tasks with a given status from the markdown file.
 * Searches entire file (active wave + any other sections).
 */
function parseTasksByStatus(markdown, status) {
  const results = [];
  const taskPattern = /^###\s+(T-\d+)\s+—\s+(.+)$/gm;
  let taskMatch;
  while ((taskMatch = taskPattern.exec(markdown)) !== null) {
    const id = taskMatch[1];
    const title = taskMatch[2].trim();
    // Find the Status line that follows this heading
    const fromIdx = taskMatch.index;
    const nextHeadingMatch = /^###\s+T-/m.exec(markdown.slice(fromIdx + 1));
    const blockEnd = nextHeadingMatch
      ? fromIdx + 1 + nextHeadingMatch.index
      : markdown.length;
    const block = markdown.slice(fromIdx, blockEnd);
    const statusMatch = block.match(/- \*\*Status:\*\*\s+(\S+)/);
    if (statusMatch && statusMatch[1] === status) {
      results.push({ id, title });
    }
  }
  return results;
}

/**
 * Update the Status field for a task block in markdown.
 * Matches the first occurrence of the task heading and replaces its Status field.
 */
function updateTaskStatus(markdown, taskId, newStatus) {
  // Replace the Status field in the task's block only
  const escapedId = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `(###\\s+${escapedId}\\s+—[\\s\\S]*?- \\*\\*Status:\\*\\*)\\s+\\S+`,
    'm'
  );
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, `$1 ${newStatus}`);
  }
  return markdown;
}

/**
 * Update the Evidence field for a task block in TASK_STATUS.md.
 */
function updateTaskEvidence(markdown, taskId, evidence) {
  const escapedId = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `(###\\s+${escapedId}\\s+—[\\s\\S]*?- \\*\\*Evidence:\\*\\*)\\s+[^\\n]+`,
    'm'
  );
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, `$1 ${evidence}`);
  }
  return markdown;
}

/**
 * Move a task block from Active tasks to Recently completed tasks in TASK_STATUS.md.
 */
function moveToCompleted(markdown, taskId) {
  const lines = markdown.split(/\r?\n/);
  const escapedId = taskId.replace('-', '\\-');
  const blockStart = lines.findIndex(l => new RegExp(`^###\\s+${escapedId}\\s+`).test(l));
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
  return new Promise(resolve => rl.question(`${question}: `, answer => resolve(answer.trim())));
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP Merge Task${RESET} ${DIM}${today}${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);

  // Find all qa_passed tasks
  const qaTasks = parseTasksByStatus(backlog, 'qa_passed');

  if (!qaTasks.length) {
    console.log(`${DIM}No qa_passed tasks found. Nothing to merge.${RESET}\n`);
    return;
  }

  console.log(`${BOLD}Tasks ready to merge (qa_passed):${RESET}`);
  qaTasks.forEach((t, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${CYAN}${t.id}${RESET} — ${t.title}`));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Prompt for task ID
  const idxRaw = await prompt(rl, `Task ID to merge (e.g. T-084, or number 1-${qaTasks.length})`);
  if (!idxRaw) {
    console.log(`${DIM}Cancelled — task ID is required.${RESET}\n`);
    rl.close();
    return;
  }

  let taskId;
  const numIdx = parseInt(idxRaw, 10);
  if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= qaTasks.length) {
    taskId = qaTasks[numIdx - 1].id;
  } else {
    taskId = idxRaw.toUpperCase();
  }

  // Validate
  const taskEntry = qaTasks.find(t => t.id === taskId);
  if (!taskEntry) {
    console.error(`${RED}${taskId} is not a known qa_passed task.${RESET}`);
    console.error(`Known qa_passed tasks: ${qaTasks.map(t => t.id).join(', ')}`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  // Prompt for commit hash
  const commitHash = await prompt(rl, "Commit hash (or 'none')");

  // Prompt for evidence summary
  const evidenceSummary = await prompt(rl, 'Evidence summary (one line)');
  if (!evidenceSummary) {
    console.log(`${DIM}Cancelled — evidence summary is required.${RESET}\n`);
    rl.close();
    return;
  }

  rl.close();

  // Build evidence string
  const evidence = commitHash && commitHash.toLowerCase() !== 'none'
    ? `commit: ${commitHash} — ${evidenceSummary}`
    : evidenceSummary;

  // Update BACKLOG.md: change status from qa_passed to merged
  let updatedBacklog = updateTaskStatus(backlog, taskId, 'merged');
  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`\n${GREEN}✓ BACKLOG.md — ${taskId} status → merged${RESET}`);

  // Update TASK_STATUS.md: change status, update evidence, move to completed
  let updatedStatus = updateTaskStatus(taskStatus, taskId, 'merged');
  updatedStatus = updateTaskEvidence(updatedStatus, taskId, evidence);
  updatedStatus = moveToCompleted(updatedStatus, taskId);
  writeUtf8(TASK_STATUS_MD, updatedStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${taskId} status → merged, evidence recorded${RESET}`);

  // Run validator
  try {
    const output = execSync(`node "${VALIDATOR}"`, { stdio: 'pipe', encoding: 'utf8' });
    if (output && output.trim()) {
      console.log(output.trim());
    }
    console.log(`${GREEN}✓ Validator passed${RESET}`);
  } catch (err) {
    const code = err.status;
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const validatorOutput = (stdout + stderr).trim();
    if (validatorOutput) {
      console.error(validatorOutput);
    }
    console.error(`\n${RED}✗ Validator exited ${code} — merge aborted. Fix artifacts and retry.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${BOLD}${taskId} — ${taskEntry.title}${RESET} ${GREEN}merged${RESET} ${DIM}${today}${RESET}`);
  console.log(`${DIM}Evidence: ${evidence}${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}merge-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
