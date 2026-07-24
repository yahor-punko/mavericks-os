#!/usr/bin/env node

/**
 * mavp-operator-rescope-task.js
 *
 * Atomically re-scope (or un-defer) an existing task: moves its block between
 * BACKLOG.md sections (## Deferred Tasks <-> ## Active Wave), updates
 * Status/Owner role/title, ensures a matching TASK_STATUS.md "## Active
 * tasks" entry, then runs the MavP validator exactly once.
 *
 * Usage:
 *   ./scripts/mavp-operator --rescope-task T-NNN [--status <s>] [--owner <role>] [--title "..."]
 *
 * Examples:
 *   ./scripts/mavp-operator --rescope-task T-089 --status in_progress --owner developer
 *   ./scripts/mavp-operator --rescope-task T-124 --status deferred
 *   ./scripts/mavp-operator --rescope-task T-124 --title "New title text"
 *
 * Behavior:
 *   - --status deferred moves the task block INTO "## Deferred Tasks" in
 *     BACKLOG.md (creating the section on demand if the project has none).
 *   - --status <anything else> moves the task block INTO "## Active Wave" in
 *     BACKLOG.md, and ensures a corresponding entry exists in TASK_STATUS.md
 *     "## Active tasks" (creating one if the task had none — e.g. a
 *     previously-deferred task with no mirrored TASK_STATUS entry).
 *   - When --status is omitted, the task's current section is preserved and
 *     only --owner / --title are applied in place.
 *   - The task ID is never reassigned. Duplicate or missing IDs in
 *     BACKLOG.md are a fail-fast error (non-zero exit) before any file is
 *     written.
 *
 * The validator runs exactly once, at the end, after both files are written.
 * Its exit code is forwarded as this script's exit code
 * (0 = healthy, 1 = drifting, 2 = repair required).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const { insertIntoActiveWave, insertIntoActiveTasks, writeContextBundle, printRepoIdentityHeader } = require('./mavp-operator-lib.js');

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

const DEFERRED_SECTION_HEADING = '## Deferred Tasks';
const DEFERRED_SECTION_BLURB =
  'Tasks preserved for future waves. Not in the active validator set. Re-activate by moving to the current Active Wave section.';

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function printUsage() {
  console.error(
    `${BOLD}Usage:${RESET} ./scripts/mavp-operator --rescope-task T-NNN [--status <s>] [--owner <role>] [--title "..."]`
  );
  console.error('');
  console.error('At least one of --status / --owner / --title must be provided.');
  console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
}

/**
 * Locate a single `### T-NNN — <title>` heading block anywhere in a markdown
 * document. Block boundaries run from the heading line up to (but not
 * including) the next `### T-...` or `## ...` heading, or end of file.
 *
 * Returns { count, startIndex, endIndex, rawBlock } — count is the number of
 * heading matches found (0 = missing, 1 = found, >1 = duplicate).
 */
function findTaskBlock(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  const headingRe = new RegExp(`^###\\s+${escaped}\\s+—.*$`, 'gm');
  const matches = [...markdown.matchAll(headingRe)];

  if (matches.length !== 1) {
    return { count: matches.length };
  }

  const heading = matches[0];
  const startIndex = heading.index;
  const searchStart = startIndex + heading[0].length;
  const rest = markdown.slice(searchStart);
  const boundaryMatch = rest.match(/\n(?=###\s+T-\d+\s+—|##\s+[^#])/);
  const endIndex = boundaryMatch ? searchStart + boundaryMatch.index + 1 : markdown.length;

  return {
    count: 1,
    startIndex,
    endIndex,
    rawBlock: markdown.slice(startIndex, endIndex),
  };
}

/**
 * Update (or insert) a `- **Field:** value` bullet within a task block.
 * Inserts right after the heading line when the field does not yet exist.
 */
function setBlockField(block, fieldName, value) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRe = new RegExp(`^(- \\*\\*${escaped}:\\*\\*)\\s*.*$`, 'm');
  if (fieldRe.test(block)) {
    return block.replace(fieldRe, `$1 ${value}`);
  }
  const lines = block.split('\n');
  lines.splice(1, 0, `- **${fieldName}:** ${value}`);
  return lines.join('\n');
}

/** Read a `- **Field:** value` bullet from a task block, or null if absent. */
function getBlockField(block, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** Rewrite the title portion of a `### T-NNN — <title>` heading line. */
function setBlockTitle(block, newTitle) {
  const headingRe = /^(###\s+T-\d+\s+—\s+).*$/m;
  return block.replace(headingRe, (_m, prefix) => `${prefix}${newTitle.trim()}`);
}

/**
 * Insert an entry into the "## Deferred Tasks" section of a markdown
 * document, creating the section on demand (appended at end of file) when
 * the project has none. Mirrors insertIntoActiveWave's placement logic.
 */
function insertIntoDeferredSection(markdown, entry) {
  const headingMatch = markdown.match(new RegExp(`\\n${DEFERRED_SECTION_HEADING}[^\\n]*`));
  if (!headingMatch) {
    const header = `\n${DEFERRED_SECTION_HEADING}\n\n${DEFERRED_SECTION_BLURB}\n`;
    return markdown.trimEnd() + '\n' + header + entry;
  }

  const sectionStart = markdown.indexOf(headingMatch[0]);
  const afterHeaderStart = sectionStart + headingMatch[0].length;
  const restOfFile = markdown.slice(afterHeaderStart);

  const nextSectionMatch = restOfFile.match(/\n(?=## )/);
  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    const insertAt = afterHeaderStart + nextSectionMatch.index;
    return markdown.slice(0, insertAt) + '\n' + entry + markdown.slice(insertAt);
  }

  return markdown.trimEnd() + '\n' + entry;
}

function runValidatorOnce() {
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
  return validatorExitCode;
}

function main() {
  printRepoIdentityHeader(ROOT);

  const argv = process.argv.slice(2);

  let taskId = null;
  let newStatus = null;
  let newOwner = null;
  let newTitle = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status' && i + 1 < argv.length) {
      newStatus = argv[++i];
    } else if (arg === '--owner' && i + 1 < argv.length) {
      newOwner = argv[++i];
    } else if (arg === '--title' && i + 1 < argv.length) {
      newTitle = argv[++i];
    } else if (!taskId && !arg.startsWith('--')) {
      taskId = arg;
    }
  }

  if (!taskId) {
    console.error(`${RED}Error: task ID is required.${RESET}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  taskId = taskId.toUpperCase();
  if (!/^T-\d+$/.test(taskId)) {
    console.error(`${RED}Error: invalid task ID format "${taskId}" — expected T-NNN (e.g. T-124).${RESET}`);
    process.exitCode = 1;
    return;
  }

  if (!newStatus && !newOwner && !newTitle) {
    console.error(`${RED}Error: at least one of --status / --owner / --title must be provided.${RESET}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (newStatus && !VALID_STATUSES.includes(newStatus)) {
    console.error(`${RED}Error: unknown status "${newStatus}".${RESET}`);
    console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
    process.exitCode = 1;
    return;
  }

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

  // --- Locate + fail fast on duplicate/missing ID in BACKLOG.md ---
  const backlogLoc = findTaskBlock(backlog, taskId);
  if (backlogLoc.count === 0) {
    console.error(`${RED}Error: ${taskId} not found in BACKLOG.md.${RESET}`);
    process.exitCode = 1;
    return;
  }
  if (backlogLoc.count > 1) {
    console.error(
      `${RED}Error: ${taskId} has ${backlogLoc.count} duplicate headings in BACKLOG.md — refusing to rescope an ambiguous task.${RESET}`
    );
    process.exitCode = 1;
    return;
  }

  // --- Same duplicate check for TASK_STATUS.md (presence is optional) ---
  const taskStatusLoc = findTaskBlock(taskStatus, taskId);
  if (taskStatusLoc.count > 1) {
    console.error(
      `${RED}Error: ${taskId} has ${taskStatusLoc.count} duplicate headings in TASK_STATUS.md — refusing to rescope an ambiguous task.${RESET}`
    );
    process.exitCode = 1;
    return;
  }

  const targetSection = newStatus ? (newStatus === 'deferred' ? 'deferred' : 'active') : null;

  // --- Build the updated BACKLOG.md block ---
  let updatedBlock = backlogLoc.rawBlock;
  if (newStatus) updatedBlock = setBlockField(updatedBlock, 'Status', newStatus);
  if (newOwner) updatedBlock = setBlockField(updatedBlock, 'Owner role', newOwner);
  if (newTitle) updatedBlock = setBlockTitle(updatedBlock, newTitle);

  if (targetSection === null) {
    // No status change requested — edit fields in place, no section move.
    backlog =
      backlog.slice(0, backlogLoc.startIndex) + updatedBlock + backlog.slice(backlogLoc.endIndex);
  } else {
    const trimmedBlock = updatedBlock.trim();
    const withoutBlock =
      backlog.slice(0, backlogLoc.startIndex) + backlog.slice(backlogLoc.endIndex);
    const entry = `\n${trimmedBlock}\n`;
    backlog =
      targetSection === 'deferred'
        ? insertIntoDeferredSection(withoutBlock, entry)
        : insertIntoActiveWave(withoutBlock, entry);
  }

  // --- Mirror the change into TASK_STATUS.md ---
  let taskStatusChanged = false;
  if (taskStatusLoc.count === 1) {
    let updatedStatusBlock = taskStatusLoc.rawBlock;
    if (newStatus) updatedStatusBlock = setBlockField(updatedStatusBlock, 'Status', newStatus);
    if (newOwner) updatedStatusBlock = setBlockField(updatedStatusBlock, 'Owner role', newOwner);
    if (newTitle) updatedStatusBlock = setBlockTitle(updatedStatusBlock, newTitle);

    taskStatus =
      taskStatus.slice(0, taskStatusLoc.startIndex) +
      updatedStatusBlock +
      taskStatus.slice(taskStatusLoc.endIndex);
    taskStatusChanged = true;
  } else if (targetSection === 'active') {
    // Un-deferring (or otherwise activating) a task with no existing
    // TASK_STATUS.md entry — create one from the updated BACKLOG.md fields.
    const status = getBlockField(updatedBlock, 'Status') || newStatus || 'planned';
    const owner = getBlockField(updatedBlock, 'Owner role') || newOwner || 'developer';
    const verificationType = getBlockField(updatedBlock, 'Verification type');
    const titleMatch = updatedBlock.match(/^###\s+T-\d+\s+—\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : taskId;

    const lines = [`\n### ${taskId} — ${title}`, `- **Status:** ${status}`, `- **Owner role:** ${owner}`];
    if (verificationType) lines.push(`- **Verification type:** ${verificationType}`);
    const entry = lines.join('\n') + '\n';

    taskStatus = insertIntoActiveTasks(taskStatus, entry);
    taskStatusChanged = true;
  }
  // targetSection === 'deferred' (or null) with no existing TASK_STATUS entry:
  // leave it absent — matches the project convention of not mirroring
  // deferred tasks into TASK_STATUS.md's Active tasks section.

  writeUtf8(BACKLOG_MD, backlog);
  if (taskStatusChanged) {
    writeUtf8(TASK_STATUS_MD, taskStatus);
  }

  // Regenerate context prefetch bundle (.mavp/context/T-NNN.md) — best effort, never fatal
  const bundleResult = writeContextBundle(taskId, { root: ROOT, backlogPath: BACKLOG_MD, taskStatusPath: TASK_STATUS_MD });
  if (bundleResult.ok) {
    console.log(`${GREEN}Context bundle regenerated: .mavp/context/${taskId}.md${RESET}`);
  } else {
    console.log(`${DIM}(context bundle not regenerated: ${bundleResult.reason})${RESET}`);
  }

  // --- Report ---
  const changes = [];
  if (newStatus) changes.push(`status → ${CYAN}${newStatus}${RESET}`);
  if (newOwner) changes.push(`owner → ${CYAN}${newOwner}${RESET}`);
  if (newTitle) changes.push(`title → ${CYAN}"${newTitle.trim()}"${RESET}`);

  console.log(`${GREEN}${taskId} rescoped: ${changes.join(', ')}${RESET}`);
  if (targetSection) {
    console.log(
      `${GREEN}BACKLOG.md section: → ${targetSection === 'deferred' ? DEFERRED_SECTION_HEADING : '## Active Wave'}${RESET}`
    );
  }
  console.log(
    `${GREEN}Updated: BACKLOG.md${taskStatusChanged ? ', TASK_STATUS.md' : ''}${RESET}`
  );

  const validatorExitCode = runValidatorOnce();
  process.exitCode = validatorExitCode;
}

main();
