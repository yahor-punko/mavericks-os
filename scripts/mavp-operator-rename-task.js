#!/usr/bin/env node

/**
 * mavp-operator-rename-task.js
 *
 * Atomically rename a task's `### T-NNN — <title>` heading in both
 * BACKLOG.md and TASK_STATUS.md, then run the MavP validator.
 *
 * Usage:
 *   ./scripts/mavp-operator --rename-task T-NNN "New title"
 *
 * Example:
 *   ./scripts/mavp-operator --rename-task T-167 "Add --rename-task operator command for atomic title sync"
 *
 * Exits non-zero when T-NNN is not found in either artifact or the
 * validator finds failures.  The validator exit code is forwarded as
 * the process exit code (0 = healthy, 1 = drifting, 2 = repair required).
 */

'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const { renameTask } = require('./mavp-operator-lib.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function printUsage() {
  console.error(`${BOLD}Usage:${RESET} ./scripts/mavp-operator --rename-task T-NNN "New title"`);
  console.error('');
  console.error('Updates the ### T-NNN — <title> heading in both BACKLOG.md and TASK_STATUS.md.');
}

function main() {
  const args = process.argv.slice(2);
  const rawTaskId = args[0];
  const newTitle = args[1];

  if (!rawTaskId || !newTitle) {
    console.error(`${RED}Error: both task ID and new title are required.${RESET}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const taskId = rawTaskId.toUpperCase();
  if (!/^T-\d+$/.test(taskId)) {
    console.error(`${RED}Error: invalid task ID format "${rawTaskId}" — expected T-NNN (e.g. T-167).${RESET}`);
    process.exitCode = 1;
    return;
  }

  const result = renameTask(taskId, newTitle, BACKLOG_MD, TASK_STATUS_MD);

  if (!result.ok) {
    console.error(`${RED}Error: ${result.error}${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Report what changed
  const trimmedTitle = newTitle.trim();
  const changedFiles = [];
  if (result.backlogChanged) changedFiles.push('BACKLOG.md');
  if (result.taskStatusChanged) changedFiles.push('TASK_STATUS.md');

  if (changedFiles.length === 0) {
    console.log(`${YELLOW}${taskId} heading already matches "${trimmedTitle}" — no changes made.${RESET}`);
  } else {
    console.log(`${GREEN}${taskId} renamed → ${CYAN}${trimmedTitle}${RESET}`);
    console.log(`${GREEN}Updated: ${changedFiles.join(', ')}${RESET}`);
  }

  // Run validator
  console.log('');
  let validatorExitCode = 0;
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
    validatorExitCode = err.status || 2;
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (combined) {
      console.log(combined);
    }
    if (validatorExitCode === 1) {
      console.log(`${YELLOW}Validator: drifting (exit 1) — review warnings above${RESET}`);
    } else {
      console.error(
        `${RED}Validator: repair required (exit ${validatorExitCode}) — fix artifacts before proceeding${RESET}`
      );
    }
  }

  process.exitCode = validatorExitCode;
}

main();
