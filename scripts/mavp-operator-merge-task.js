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
const {
  resolveCommitHash,
  printRepoIdentityHeader,
  guardMutatingRoot,
  locateTaskBlock,
  updateTaskField,
} = require('./mavp-operator-lib.js');

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
 * Bounded-per-occurrence Status read: given the index/length of a single
 * `### T-NNN — <title>` heading match, returns that OCCURRENCE's Status
 * value (or null if absent/placeholder), stopping at the next `### T-` or
 * `## ` heading — the same boundary rule locateTaskBlock() uses for a
 * unique match. This is deliberately per-occurrence rather than
 * per-ID, so a task ID that happens to be duplicated in the file still
 * has each heading's own Status read correctly (never running past a
 * section boundary into a different task, T-609) — locateTaskBlock()
 * itself only supports a unique-match lookup and refuses on a duplicate,
 * which is the right behavior for a targeted read/write but not for this
 * listing scan, which must still surface a duplicated ID as a selectable
 * (later refused, see the fail-fast check in main()) candidate.
 */
function statusOfBlockAt(markdown, headingIndex, headingLength) {
  const searchStart = headingIndex + headingLength;
  const rest = markdown.slice(searchStart);
  const boundaryMatch = rest.match(/\n(?=###\s+T-\d+\s+—|##\s+[^#])/);
  const endIndex = boundaryMatch ? searchStart + boundaryMatch.index + 1 : markdown.length;
  const block = markdown.slice(headingIndex, endIndex);
  const m = block.match(/^- \*\*Status:\*\*\s*(.+)$/m);
  if (!m) return null;
  const value = m[1].trim();
  return (!value || value === '—' || value === '-') ? null : value;
}

/**
 * Parse all tasks with a given status from the markdown file.
 * Searches entire file (active wave + any other sections). Each heading
 * occurrence's Status is read via statusOfBlockAt() above — bounded to
 * that occurrence's own block, never spilling into a neighboring block
 * (T-609).
 */
function parseTasksByStatus(markdown, status) {
  const results = [];
  const taskPattern = /^###\s+(T-\d+)\s+—\s+(.+)$/gm;
  let taskMatch;
  while ((taskMatch = taskPattern.exec(markdown)) !== null) {
    const id = taskMatch[1];
    const title = taskMatch[2].trim();
    const value = statusOfBlockAt(markdown, taskMatch.index, taskMatch[0].length);
    if (value === status) {
      results.push({ id, title });
    }
  }
  return results;
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
  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--merge-task');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

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

  // T-609: fail fast on a duplicate/missing heading in either artifact,
  // before any further prompt — refuses to proceed rather than letting a
  // later write export itself onto a neighboring (e.g. archived) block
  // sharing the same ID.
  const backlogLoc = locateTaskBlock(backlog, taskId);
  if (backlogLoc.count > 1) {
    console.error(`${RED}Error: ${taskId} has ${backlogLoc.count} duplicate headings in BACKLOG.md — refusing to merge an ambiguous task.${RESET}`);
    rl.close();
    process.exitCode = 1;
    return;
  }
  const taskStatusLoc = locateTaskBlock(taskStatus, taskId);
  if (taskStatusLoc.count === 0) {
    console.error(`${RED}Error: ${taskId} has no entry in TASK_STATUS.md — cannot merge (run --sync-status first).${RESET}`);
    rl.close();
    process.exitCode = 1;
    return;
  }
  if (taskStatusLoc.count > 1) {
    console.error(`${RED}Error: ${taskId} has ${taskStatusLoc.count} duplicate headings in TASK_STATUS.md — refusing to merge an ambiguous task.${RESET}`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  // Prompt for commit hash
  let commitHash = await prompt(rl, "Commit hash (or 'none')");

  // T-446 — validate/resolve the hash before proceeding. Accepts "none",
  // "HEAD" (resolved to the current repo's short hash), or a hex string
  // matching /^[0-9a-f]{7,40}$/. Anything else is rejected before any git
  // subprocess runs. A format-valid hash not reachable from "main" prints a
  // non-blocking warning — the merge still proceeds.
  let commitWarning = null;
  const hasCommit = commitHash && commitHash.toLowerCase() !== 'none';
  if (hasCommit) {
    const resolved = resolveCommitHash(ROOT, commitHash, 'main');
    if (!resolved.ok) {
      console.error(`${RED}Error: ${resolved.error}${RESET}`);
      rl.close();
      process.exitCode = 1;
      return;
    }
    commitHash = resolved.hash;
    commitWarning = resolved.warning;
  }

  // Prompt for evidence summary
  const evidenceSummary = await prompt(rl, 'Evidence summary (one line)');
  if (!evidenceSummary) {
    console.log(`${DIM}Cancelled — evidence summary is required.${RESET}\n`);
    rl.close();
    return;
  }

  rl.close();

  if (commitWarning) {
    console.warn(`${YELLOW}Warning: ${commitWarning}${RESET}`);
  }

  // Build evidence string
  const evidence = hasCommit
    ? `commit: ${commitHash} — ${evidenceSummary}`
    : evidenceSummary;

  // Update BACKLOG.md: change status from qa_passed to merged. Bounded to
  // the target block only (T-609) — a write that ultimately changes
  // nothing does not print an unqualified success line.
  const backlogResult = updateTaskField(backlog, taskId, 'Status', 'merged');
  const backlogChanged = backlogResult.updated !== backlog;
  if (backlogChanged) {
    writeUtf8(BACKLOG_MD, backlogResult.updated);
    console.log(`\n${GREEN}✓ BACKLOG.md — ${taskId} status → merged${RESET}`);
  } else {
    console.log(`\n${YELLOW}⚠ BACKLOG.md — ${taskId} Status already "merged" — no change, file not written${RESET}`);
  }

  // Update TASK_STATUS.md: change status, update evidence (insert-if-missing
  // — a block lacking an Evidence line GAINS one, T-609), move to completed.
  const statusResult = updateTaskField(taskStatus, taskId, 'Status', 'merged');
  const statusChanged = statusResult.updated !== taskStatus;
  const evidenceResult = updateTaskField(statusResult.updated, taskId, 'Evidence', evidence);
  const evidenceChanged = evidenceResult.updated !== statusResult.updated;
  const updatedStatus = moveToCompleted(evidenceResult.updated, taskId);
  writeUtf8(TASK_STATUS_MD, updatedStatus);
  if (statusChanged || evidenceChanged) {
    console.log(`${GREEN}✓ TASK_STATUS.md — ${taskId} status → merged, evidence recorded${RESET}`);
  } else {
    console.log(`${YELLOW}⚠ TASK_STATUS.md — ${taskId} Status/Evidence unchanged (moved to Recently completed tasks)${RESET}`);
  }

  // Run validator
  try {
    const output = execSync(`node "${VALIDATOR}" "${ROOT}"`, { stdio: 'pipe', encoding: 'utf8' });
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
