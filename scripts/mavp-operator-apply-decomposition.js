#!/usr/bin/env node

/**
 * mavp-operator-apply-decomposition.js
 *
 * Reads a structured decomposition block (from FILE or stdin) and inserts
 * all tasks into BACKLOG.md and TASK_STATUS.md atomically.
 *
 * Block format (see docs/ARCHITECT_OUTPUT.md):
 *   <!-- mavp-decomposition-start -->
 *   title: Task title here
 *   owner_role: developer
 *   depends_on: —
 *   verification_type: runtime
 *   problem: One-sentence problem description.
 *   acceptance_criteria: What done looks like.
 *   evidence_expected: commit: <hash> branch: <name>
 *   ---
 *   title: Another task
 *   ...
 *   <!-- mavp-decomposition-end -->
 *
 * Usage:
 *   ./scripts/mavp-operator --apply-decomposition [FILE]
 *   echo "<block>" | ./scripts/mavp-operator --apply-decomposition
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  readUtf8,
  writeUtf8,
  getNextTaskId,
  insertIntoActiveWave,
  insertIntoActiveTasks,
  updateLastTaskId,
  writeContextBundle,
  buildTaskStatusEntry,
  printRepoIdentityHeader,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');

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

/**
 * Read input from a file path or from stdin (piped/redirected).
 */
function readInput(filePath) {
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`${RED}File not found: ${filePath}${RESET}`);
      process.exit(1);
    }
    return readUtf8(filePath);
  }
  // Read from stdin synchronously
  try {
    return fs.readFileSync('/dev/stdin', 'utf8');
  } catch {
    return '';
  }
}

/**
 * Extract the content between <!-- mavp-decomposition-start --> and <!-- mavp-decomposition-end -->.
 * Returns null if the delimiters are not found.
 */
function extractBlock(input) {
  const startMarker = '<!-- mavp-decomposition-start -->';
  const endMarker = '<!-- mavp-decomposition-end -->';
  const startIdx = input.indexOf(startMarker);
  const endIdx = input.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  return input.slice(startIdx + startMarker.length, endIdx);
}

/**
 * Parse a single task block (key: value lines).
 * Returns an object with all recognised fields.
 */
function parseTaskBlock(raw) {
  const task = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();
    // Only capture known fields
    if ([
      'title', 'owner_role', 'depends_on', 'verification_type',
      'problem', 'acceptance_criteria', 'evidence_expected',
      'requires_ux', 'requires_security_review', 'touches', 'type', 'repo',
    ].includes(key)) {
      task[key] = value;
    }
  }
  return task;
}

/**
 * Split block content into individual task raw strings (by --- separator).
 */
function splitTasks(blockContent) {
  return blockContent
    .split(/\n---\n/)
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * Validate a parsed task. Returns array of missing required field names.
 */
function validateTask(task) {
  const required = ['title', 'owner_role', 'verification_type'];
  return required.filter(f => !task[f]);
}

function formatTaskId(n) {
  return `T-${String(n).padStart(3, '0')}`;
}

/**
 * Resolve the effective repo value for a task and render its BACKLOG.md
 * line: a single repo renders as `- **Repo:** <name>`; two or more
 * comma-separated repos render as `- **Repos:** a, b` (matches the
 * cross-repo convention in CLAUDE.md). A per-task `repo:` field overrides
 * the batch `--repo` default; a task with neither gets no line at all.
 *
 * @param {object} task - Parsed task fields (may include `repo`)
 * @param {string} [repoName] - Optional batch-level default repo name
 * @returns {string|null} Rendered `- **Repo:**`/`- **Repos:**` line, or null when neither is set
 */
function resolveRepoLine(task, repoName) {
  const effective = (task.repo && task.repo.trim()) || repoName;
  if (!effective) return null;
  const parts = effective.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    return `- **Repos:** ${parts.join(', ')}`;
  }
  return `- **Repo:** ${parts[0]}`;
}

/**
 * Build a BACKLOG.md entry for a task.
 * @param {string} id - Task ID (e.g. "T-222")
 * @param {object} task - Parsed task fields
 * @param {string} [repoName] - Optional batch-level default repo name. A per-task `repo:` field overrides this. When neither is set, the Repo field is excluded.
 */
function buildBacklogEntry(id, task, repoName) {
  const lines = [];
  lines.push(`\n### ${id} — ${task.title}`);
  lines.push(`- **Status:** planned`);
  lines.push(`- **Owner role:** ${task.owner_role}`);
  const repoLine = resolveRepoLine(task, repoName);
  if (repoLine) {
    lines.push(repoLine);
  }
  lines.push(`- **Verification type:** ${task.verification_type}`);

  // Optional fields — only include when meaningful
  if (task.depends_on && task.depends_on !== '—' && task.depends_on !== '-') {
    lines.push(`- **Depends on:** ${task.depends_on}`);
  }
  if (task.requires_ux && task.requires_ux.toLowerCase() === 'true') {
    lines.push(`- **Requires ux:** true`);
  }
  if (task.requires_security_review && task.requires_security_review.toLowerCase() === 'true') {
    lines.push(`- **Requires security review:** true`);
  }
  if (task.touches) {
    lines.push(`- **Touches:** ${task.touches}`);
  }
  if (task.type && task.type.trim()) {
    lines.push(`- **Type:** ${task.type}`);
  }

  lines.push('');

  if (task.problem) {
    lines.push(`**Problem:** ${task.problem}`);
    lines.push('');
  }

  if (task.acceptance_criteria) {
    lines.push(`**Acceptance criteria:** ${task.acceptance_criteria}`);
    lines.push('');
  }

  if (task.evidence_expected) {
    lines.push(`**Evidence expected:** ${task.evidence_expected}`);
  }

  // Ensure trailing newline
  return lines.join('\n') + '\n';
}

function runValidator() {
  const result = spawnSync('node', [VALIDATOR], {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status || 0;
}

/**
 * Parse CLI args: an optional positional FILE path plus an optional
 * `--repo <name>` flag supplying the batch-level default repo.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{filePath: string|null, repoName: string|null}}
 */
function parseCliArgs(argv) {
  let filePath = null;
  let repoName = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') {
      repoName = argv[i + 1] || null;
      i++;
    } else if (!filePath) {
      filePath = argv[i];
    }
  }
  return { filePath, repoName };
}

async function main() {
  printRepoIdentityHeader(ROOT);

  const today = new Date().toISOString().slice(0, 10);
  const { filePath, repoName } = parseCliArgs(process.argv.slice(2));

  console.log(`\n${BOLD}MavP Apply Decomposition${RESET} ${DIM}${today}${RESET}\n`);

  // Read input
  const input = readInput(filePath);
  await applyDecompositionFromString(input, repoName);
}

/**
 * Apply a decomposition block string through the full pipeline:
 * parse → validate → insert into BACKLOG.md + TASK_STATUS.md → run validator.
 *
 * @param {string} input - Raw string containing <!-- mavp-decomposition-start --> block.
 * @param {string} [repoName] - Optional repo name written to each task's Repo field. Omit to leave the field blank.
 * @returns {Promise<void>} Resolves on success; sets process.exitCode on failure.
 */
async function applyDecompositionFromString(input, repoName) {
  if (!input || !input.trim()) {
    console.error(`${RED}No input provided. Pipe a decomposition block or pass FILE as argument.${RESET}`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Extract decomposition block
  const blockContent = extractBlock(input);
  if (!blockContent) {
    console.error(`${RED}No decomposition block found. Expected <!-- mavp-decomposition-start --> ... <!-- mavp-decomposition-end -->${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Split and parse tasks
  const rawTasks = splitTasks(blockContent);
  if (!rawTasks.length) {
    console.error(`${RED}Decomposition block is empty — no tasks found.${RESET}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${CYAN}Found ${rawTasks.length} task(s) in block.${RESET}\n`);

  // Validate all tasks before touching files (atomicity)
  const parsedTasks = [];
  for (let i = 0; i < rawTasks.length; i++) {
    const task = parseTaskBlock(rawTasks[i]);
    const missing = validateTask(task);
    if (missing.length > 0) {
      console.warn(`${YELLOW}⚠ Task ${i + 1}: missing required field(s): ${missing.join(', ')} — skipping.${RESET}`);
      continue;
    }
    parsedTasks.push(task);
  }

  if (!parsedTasks.length) {
    console.error(`${RED}No valid tasks after validation. Nothing written.${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Determine starting ID
  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);
  const firstIdStr = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);
  const firstIdNum = parseInt(firstIdStr.replace('T-', ''), 10);

  // Build all entries in memory
  const entries = parsedTasks.map((task, idx) => {
    const id = formatTaskId(firstIdNum + idx);
    return {
      id,
      task,
      backlogEntry: buildBacklogEntry(id, task, repoName),
      taskStatusEntry: buildTaskStatusEntry(id, task.title, task.owner_role, task.verification_type, 'planned'),
    };
  });

  // Apply all insertions
  let updatedBacklog = backlog;
  let updatedTaskStatus = taskStatus;

  for (const entry of entries) {
    updatedBacklog = insertIntoActiveWave(updatedBacklog, entry.backlogEntry);
    updatedTaskStatus = insertIntoActiveTasks(updatedTaskStatus, entry.taskStatusEntry);
  }

  // Write both files atomically
  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`${GREEN}✓ BACKLOG.md — ${entries.length} task(s) added${RESET}`);

  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${entries.length} task(s) added${RESET}`);

  // Update last_task_id in PROCESS_STATE.json
  const lastEntry = entries[entries.length - 1];
  const lastNumericId = parseInt(lastEntry.id.replace('T-', ''), 10);
  const updated = updateLastTaskId(PROCESS_STATE_JSON, lastNumericId);
  if (updated) {
    console.log(`${GREEN}✓ PROCESS_STATE.json — last_task_id updated to ${lastNumericId}${RESET}`);
  }

  // Write context prefetch bundles (.mavp/context/T-NNN.md) — best effort, never fatal
  for (const entry of entries) {
    const bundleResult = writeContextBundle(entry.id, { root: ROOT, backlogPath: BACKLOG_MD, taskStatusPath: TASK_STATUS_MD });
    if (bundleResult.ok) {
      console.log(`${GREEN}✓ Context bundle — .mavp/context/${entry.id}.md${RESET}`);
    } else {
      console.log(`${DIM}(context bundle not written for ${entry.id}: ${bundleResult.reason})${RESET}`);
    }
  }

  // Print registered tasks
  console.log(`\n${BOLD}Registered tasks:${RESET}`);
  for (const entry of entries) {
    console.log(`  ${CYAN}${entry.id}${RESET}: ${entry.task.title}`);
  }

  // Run validator once
  console.log(`\n${DIM}Running validator...${RESET}`);
  const exitCode = runValidator();

  if (exitCode === 0) {
    console.log(`${GREEN}✓ Validator: healthy${RESET}`);
  } else if (exitCode === 1) {
    console.log(`${YELLOW}⚠ Validator: drifting (exit 1)${RESET}`);
  } else {
    console.log(`${RED}✗ Validator: repair required (exit ${exitCode})${RESET}`);
    process.exitCode = exitCode;
    return;
  }

  console.log(`\n${BOLD}apply-decomposition complete${RESET} — ${entries.length} task(s) registered.\n`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`${RED}apply-decomposition failed: ${err.message}${RESET}`);
    process.exitCode = 1;
  });
}

module.exports = {
  extractBlock,
  parseTaskBlock,
  splitTasks,
  validateTask,
  buildBacklogEntry,
  buildTaskStatusEntry,
  resolveRepoLine,
  parseCliArgs,
  applyDecompositionFromString,
};
