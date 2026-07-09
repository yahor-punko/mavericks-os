#!/usr/bin/env node

/**
 * mavp-operator-update-status.js
 *
 * Atomically update the Status field for a task in both BACKLOG.md and
 * TASK_STATUS.md, then run the parliamentary validator.
 *
 * Usage:
 *   ./scripts/mavp-operator --update-status T-NNN <status>
 *
 * Examples:
 *   ./scripts/mavp-operator --update-status T-113 dev_done
 *   ./scripts/mavp-operator --update-status T-042 ready_for_qa
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

const VALID_STATUSES = [
  'planned',
  'in_progress',
  'dev_done',
  'ux_review',
  'ux_needs_fix',
  'security_review',
  'security_needs_fix',
  'security_passed',
  'ready_for_qa',
  'qa_in_progress',
  'qa_passed',
  'needs_fix',
  'merged',
  'deployed_dev',
  'deployed_prod',
];

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

/**
 * Check whether a task ID exists anywhere in a markdown file.
 */
function taskExistsInFile(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  return new RegExp(`^###\\s+${escaped}\\s+—`, 'm').test(markdown);
}

/**
 * Update the Status field for a task block in markdown.
 * Only modifies the first occurrence of the task heading's Status field.
 */
function updateTaskStatusField(markdown, taskId, newStatus) {
  const escaped = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `(###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Status:\\*\\*)\\s+\\S+`,
    'm'
  );
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, `$1 ${newStatus}`);
  }
  return markdown;
}

function printUsage() {
  console.error(`${BOLD}Usage:${RESET} ./scripts/mavp-operator --update-status T-NNN <status>`);
  console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
}

function main() {
  const args = process.argv.slice(2);
  const taskId = args[0];
  const newStatus = args[1];

  // Validate argument count
  if (!taskId || !newStatus) {
    console.error(`${RED}Error: both task ID and status are required.${RESET}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  // Normalise task ID to uppercase (accept t-113 or T-113)
  const normalisedId = taskId.toUpperCase();

  // Validate task ID format
  if (!/^T-\d+$/.test(normalisedId)) {
    console.error(`${RED}Error: invalid task ID format "${taskId}" — expected T-NNN (e.g. T-113).${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Validate status
  if (!VALID_STATUSES.includes(newStatus)) {
    console.error(`${RED}Error: unknown status "${newStatus}".${RESET}`);
    console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Verify artifact files exist
  if (!fs.existsSync(BACKLOG_MD)) {
    console.error(`${RED}Error: BACKLOG.md not found at ${BACKLOG_MD}${RESET}`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}Error: TASK_STATUS.md not found at ${TASK_STATUS_MD}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);

  // Verify task exists in at least one artifact
  const inBacklog = taskExistsInFile(backlog, normalisedId);
  const inTaskStatus = taskExistsInFile(taskStatus, normalisedId);

  if (!inBacklog && !inTaskStatus) {
    console.error(`${RED}Error: task ${normalisedId} not found in BACKLOG.md or TASK_STATUS.md.${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Apply updates
  let updatedBacklog = backlog;
  let updatedTaskStatus = taskStatus;
  let backlogUpdated = false;
  let taskStatusUpdated = false;

  if (inBacklog) {
    const result = updateTaskStatusField(backlog, normalisedId, newStatus);
    if (result !== backlog) {
      updatedBacklog = result;
      backlogUpdated = true;
    }
  }

  if (inTaskStatus) {
    const result = updateTaskStatusField(taskStatus, normalisedId, newStatus);
    if (result !== taskStatus) {
      updatedTaskStatus = result;
      taskStatusUpdated = true;
    }
  }

  // Write files
  if (backlogUpdated) {
    writeUtf8(BACKLOG_MD, updatedBacklog);
    console.log(`${GREEN}BACKLOG.md — ${normalisedId} Status set to ${CYAN}${newStatus}${RESET}`);
  } else if (inBacklog) {
    console.log(`${YELLOW}BACKLOG.md — ${normalisedId} found but Status field not matched (may already be "${newStatus}")${RESET}`);
  } else {
    console.log(`${DIM}BACKLOG.md — ${normalisedId} not present, skipped${RESET}`);
  }

  if (taskStatusUpdated) {
    writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
    console.log(`${GREEN}TASK_STATUS.md — ${normalisedId} Status set to ${CYAN}${newStatus}${RESET}`);
  } else if (inTaskStatus) {
    console.log(`${YELLOW}TASK_STATUS.md — ${normalisedId} found but Status field not matched (may already be "${newStatus}")${RESET}`);
  } else {
    console.log(`${DIM}TASK_STATUS.md — ${normalisedId} not present, skipped${RESET}`);
  }

  // Run validator
  console.log('');
  try {
    const output = execSync(`node "${VALIDATOR}" "${ROOT}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (output && output.trim()) {
      console.log(output.trim());
    }
    console.log(`${GREEN}Validator: healthy (exit 0)${RESET}`);
  } catch (err) {
    const code = err.status;
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (combined) {
      console.log(combined);
    }
    if (code === 1) {
      console.log(`${YELLOW}Validator: drifting (exit 1) — review warnings above${RESET}`);
    } else {
      console.error(`${RED}Validator: repair required (exit ${code}) — fix artifacts before proceeding${RESET}`);
      process.exitCode = 1;
    }
  }
}

main();
