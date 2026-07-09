#!/usr/bin/env node

/**
 * mavp-operator-set-status.js
 *
 * Atomically update the Status field for one or more tasks in both BACKLOG.md
 * and TASK_STATUS.md, then run the parliamentary validator once.
 *
 * Usage:
 *   ./scripts/mavp-operator --set-status T-NNN <status>
 *   ./scripts/mavp-operator --set-status T-NNN,T-MMM,T-PPP <status>
 *   ./scripts/mavp-operator --set-status T-NNN merged --commit <hash>
 *   ./scripts/mavp-operator --set-status T-NNN merged --commit <hash> --branch <name>
 *
 * Examples:
 *   ./scripts/mavp-operator --set-status T-124 in_progress
 *   ./scripts/mavp-operator --set-status T-098,T-099,T-100 merged
 *   ./scripts/mavp-operator --set-status T-098 merged --commit abc1234
 *   ./scripts/mavp-operator --set-status T-098 merged --commit abc1234 --branch develop
 *
 * Task IDs not found in either artifact produce a warning but do not cause
 * failure.  The validator exit code is returned as the process exit code
 * (0 = healthy, 1 = drifting, 2 = repair required).
 *
 * --commit <hash>   When present, writes "commit: <hash> branch: <branch>" into
 *                   the Evidence field of each updated task in TASK_STATUS.md.
 * --branch <name>   Branch name to record alongside the commit. Defaults to "main".
 * --from <status>   When present, acts as a precondition guard: each task is only
 *                   updated if its current Status equals <status>. Tasks that do
 *                   not match are warned and skipped. Enables atomic transitions
 *                   (e.g. dev_done → ready_for_qa) without running the validator
 *                   on any intermediate state.
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
  'ux_passed',
  'security_review',
  'security_needs_fix',
  'security_passed',
  'ready_for_qa',
  'qa_in_progress',
  'qa_passed',
  'needs_fix',
  'merged',
  'runtime_verified',
  'deployed_dev',
  'deployed_prod',
  'deferred',
  'deprecated',
];

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

/**
 * Check whether a task ID exists as a heading in a markdown file.
 */
function taskExistsInFile(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  return new RegExp(`^###\\s+${escaped}\\s+—`, 'm').test(markdown);
}

/**
 * Read the current Status field value for a task block in markdown.
 * Returns the status string, or null if the task or Status field is not found.
 */
function readCurrentStatus(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Status:\\*\\*\\s+(\\S+)`,
    'm'
  );
  const match = markdown.match(blockPattern);
  return match ? match[1] : null;
}

/**
 * Update the Status field for a task block in markdown.
 * Only modifies the first occurrence of the task heading's Status field.
 * Returns the updated string (unchanged if no match).
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

/**
 * Update the Evidence field for a task block in TASK_STATUS.md.
 * Only modifies the first occurrence of the task heading's Evidence field.
 * Returns the updated string (unchanged if no match).
 */
function updateTaskEvidence(markdown, taskId, evidence) {
  const escaped = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `(###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Evidence:\\*\\*)\\s+[^\\n]+`,
    'm'
  );
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, `$1 ${evidence}`);
  }
  return markdown;
}

/**
 * Append "needs_fix_rounds: 0" to the Evidence field for a task in TASK_STATUS.md,
 * but only if the field does not already contain "needs_fix_rounds:".
 * Returns the updated string (unchanged if already present or no match).
 */
function appendNeedsFixRoundsIfMissing(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  const blockPattern = new RegExp(
    `(###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Evidence:\\*\\*)\\s+([^\\n]+)`,
    'm'
  );
  const match = markdown.match(blockPattern);
  if (!match) return markdown;
  const currentEvidence = match[2];
  if (currentEvidence.includes('needs_fix_rounds:')) return markdown;
  return markdown.replace(blockPattern, `$1 ${currentEvidence} needs_fix_rounds: 0`);
}

function printUsage() {
  console.error(
    `${BOLD}Usage:${RESET} ./scripts/mavp-operator --set-status T-NNN[,T-MMM,...] <status> [--commit <hash>] [--branch <name>] [--from <status>]`
  );
  console.error(`${DIM}  --from <status>  Precondition guard: skip tasks not currently at <status>${RESET}`);
  console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
}

function main() {
  const argv = process.argv.slice(2);

  // Extract named flags (--commit, --branch, --from) before reading positional args.
  // This preserves the existing positional contract: argv[0]=IDs, argv[1]=status.
  let commitHash = null;
  let branchName = 'main';
  let fromStatus = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit' && i + 1 < argv.length) {
      commitHash = argv[++i];
    } else if (argv[i] === '--branch' && i + 1 < argv.length) {
      branchName = argv[++i];
    } else if (argv[i] === '--from' && i + 1 < argv.length) {
      fromStatus = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }

  const args = positional;
  const rawIds = args[0];
  const newStatus = args[1];

  // Validate argument count
  if (!rawIds || !newStatus) {
    console.error(`${RED}Error: both task ID list and status are required.${RESET}`);
    printUsage();
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

  // Parse and normalise task IDs (accept t-113 or T-113, comma-separated)
  const rawList = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  const normalisedIds = [];
  for (const raw of rawList) {
    const upper = raw.toUpperCase();
    if (!/^T-\d+$/.test(upper)) {
      console.error(
        `${RED}Error: invalid task ID format "${raw}" — expected T-NNN (e.g. T-113).${RESET}`
      );
      process.exitCode = 1;
      return;
    }
    normalisedIds.push(upper);
  }

  if (normalisedIds.length === 0) {
    console.error(`${RED}Error: no valid task IDs provided.${RESET}`);
    printUsage();
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

  let backlog = readUtf8(BACKLOG_MD);
  let taskStatus = readUtf8(TASK_STATUS_MD);

  const updated = [];
  const skipped = [];

  for (const taskId of normalisedIds) {
    const inBacklog = taskExistsInFile(backlog, taskId);
    const inTaskStatus = taskExistsInFile(taskStatus, taskId);

    if (!inBacklog && !inTaskStatus) {
      console.warn(
        `${YELLOW}Warning: ${taskId} not found in BACKLOG.md or TASK_STATUS.md — skipped.${RESET}`
      );
      skipped.push(taskId);
      continue;
    }

    // --from precondition guard: check current status before mutating.
    // Read from BACKLOG.md when available, fall back to TASK_STATUS.md.
    if (fromStatus !== null) {
      const currentStatus =
        (inBacklog ? readCurrentStatus(backlog, taskId) : null) ||
        (inTaskStatus ? readCurrentStatus(taskStatus, taskId) : null);
      if (currentStatus !== fromStatus) {
        console.warn(
          `${YELLOW}Warning: ${taskId} is currently "${currentStatus || 'unknown'}", not "${fromStatus}" — skipped (--from guard).${RESET}`
        );
        skipped.push(taskId);
        continue;
      }
    }

    let backlogChanged = false;
    let taskStatusChanged = false;

    if (inBacklog) {
      const result = updateTaskStatusField(backlog, taskId, newStatus);
      if (result !== backlog) {
        backlog = result;
        backlogChanged = true;
      }
    }

    if (inTaskStatus) {
      const result = updateTaskStatusField(taskStatus, taskId, newStatus);
      if (result !== taskStatus) {
        taskStatus = result;
        taskStatusChanged = true;
      }
      // Write evidence atomically alongside status when --commit is provided
      if (commitHash && inTaskStatus) {
        const evidence = `commit: ${commitHash} branch: ${branchName}`;
        taskStatus = updateTaskEvidence(taskStatus, taskId, evidence);
      }
      // Auto-insert needs_fix_rounds: 0 when transitioning to merged (if not already set)
      if (newStatus === 'merged' && inTaskStatus) {
        taskStatus = appendNeedsFixRoundsIfMissing(taskStatus, taskId);
      }
    }

    if (backlogChanged || taskStatusChanged) {
      updated.push(taskId);
    } else {
      // Task exists but Status field was already set to newStatus (or unmatched)
      console.log(
        `${YELLOW}${taskId} — found but Status field not changed (may already be "${newStatus}")${RESET}`
      );
      skipped.push(taskId);
    }
  }

  // Write files (only if something changed)
  if (updated.length > 0) {
    writeUtf8(BACKLOG_MD, backlog);
    writeUtf8(TASK_STATUS_MD, taskStatus);
  }

  // Print summary
  console.log('');
  if (updated.length > 0) {
    console.log(
      `${GREEN}Updated (${updated.length}): ${updated.join(', ')} → ${CYAN}${newStatus}${RESET}`
    );
    if (commitHash) {
      console.log(
        `${GREEN}Evidence written: commit: ${commitHash} branch: ${branchName}${RESET}`
      );
    }
    if (newStatus === 'merged') {
      console.log(
        `${GREEN}Evidence: needs_fix_rounds: 0 added where absent${RESET}`
      );
    }
  }
  if (skipped.length > 0) {
    console.log(`${YELLOW}Skipped (${skipped.length}): ${skipped.join(', ')}${RESET}`);
  }

  // Run validator once
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
