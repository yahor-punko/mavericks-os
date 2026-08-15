#!/usr/bin/env node

/**
 * mavp-operator-set-status.js
 *
 * Atomically update the Status field for one or more tasks in both BACKLOG.md
 * and TASK_STATUS.md, then run the MavP validator once.
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
 * --commit <hash>   When present, merges "commit: <hash> branch: <branch>" into
 *                   the Evidence field of each updated task in TASK_STATUS.md —
 *                   prior evidence text (e.g. QA notes) is preserved, not
 *                   clobbered. Accepts "HEAD" (resolved to the current repo's
 *                   short hash) or a hex string matching /^[0-9a-f]{7,40}$/;
 *                   anything else is rejected before any git subprocess runs.
 *                   A format-valid hash not reachable from --branch prints a
 *                   non-blocking warning naming the hash and branch — the
 *                   write still proceeds. Degrades silently (no warning, no
 *                   crash) when git is unavailable.
 * --branch <name>   Branch name to record alongside the commit, and to check
 *                   reachability against. Defaults to "main".
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
const {
  resolveCommitHash,
  mergeCommitEvidence,
  printRepoIdentityHeader,
  guardMutatingRoot,
  locateTaskBlock,
  extractBlockField,
  setBlockField,
  readTaskField,
  updateTaskField,
} = require('./mavp-operator-lib.js');

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
 * Read the current Status field value for a SPECIFIC task's own block,
 * bounded by locateTaskBlock() (T-608 — replaces a family of lazy-but-
 * unbounded `[\s\S]*?` matchers that did not stop at the next `### T-` or
 * `## ` heading and so could read a neighboring block's Status when the
 * target block lacked one). Returns null when the task is absent, its
 * heading is duplicated, or the Status field itself is not present in its
 * own block — never a value read from any other block.
 *
 * @param {string} markdown
 * @param {string} taskId
 * @returns {string|null}
 */
function readCurrentStatus(markdown, taskId) {
  const result = readTaskField(markdown, taskId, 'Status');
  return result.ok ? result.value : null;
}

/**
 * Update the Status field for a SPECIFIC task's own block, bounded by
 * locateTaskBlock() via updateTaskField() (T-608). Returns the input
 * markdown unchanged when the task is absent or its heading is duplicated —
 * it never falls through to writing into a later block.
 *
 * @param {string} markdown
 * @param {string} taskId
 * @param {string} newStatus
 * @returns {string}
 */
function updateTaskStatusField(markdown, taskId, newStatus) {
  const result = updateTaskField(markdown, taskId, 'Status', newStatus);
  return result.ok ? result.updated : markdown;
}

/**
 * Read the current Evidence field text for a SPECIFIC task's own block,
 * bounded by locateTaskBlock() (T-608). Returns '' when the task is absent,
 * its heading is duplicated, the field is not present, or the field holds
 * only a placeholder ("—" / "-") — extractBlockField() (via readTaskField())
 * normalizes a placeholder to null on read, which is the deliberate decision
 * for this call site: a placeholder is never real prior evidence text, so
 * treating it as "no prior evidence" for the merge below loses nothing (see
 * mergeCommitEvidence() at the call site, which appends/replaces onto
 * whatever this returns).
 *
 * @param {string} markdown
 * @param {string} taskId
 * @returns {string}
 */
function readCurrentEvidence(markdown, taskId) {
  const result = readTaskField(markdown, taskId, 'Evidence');
  return result.ok && result.value ? result.value : '';
}

/**
 * Update the Evidence field for a SPECIFIC task's own block in
 * TASK_STATUS.md, bounded by locateTaskBlock() via updateTaskField()
 * (T-608). INSERTS the field (right after the heading) when the target
 * block does not yet have an Evidence line, rather than failing or writing
 * into a different block — this is what closes the archived-block
 * falsification defect: a target block with no Evidence line now gets one
 * inserted directly, instead of the write silently landing on the next
 * block downstream that happened to have the field. Returns the input
 * markdown unchanged when the task is absent or its heading is duplicated.
 *
 * @param {string} markdown
 * @param {string} taskId
 * @param {string} evidence
 * @returns {string}
 */
function updateTaskEvidence(markdown, taskId, evidence) {
  const result = updateTaskField(markdown, taskId, 'Evidence', evidence);
  return result.ok ? result.updated : markdown;
}

/**
 * Append "needs_fix_rounds: 0" to the Evidence field for a SPECIFIC task's
 * own block in TASK_STATUS.md, but only if the field does not already
 * contain "needs_fix_rounds:" (T-608 — bounded by locateTaskBlock(), the
 * same fix as the four functions above). Returns the input markdown
 * unchanged when the task is absent, its heading is duplicated, or
 * "needs_fix_rounds:" is already present.
 *
 * @param {string} markdown
 * @param {string} taskId
 * @returns {string}
 */
function appendNeedsFixRoundsIfMissing(markdown, taskId) {
  const loc = locateTaskBlock(markdown, taskId);
  if (loc.count !== 1) return markdown;
  const currentEvidence = extractBlockField(loc.rawBlock, 'Evidence') || '';
  if (currentEvidence.includes('needs_fix_rounds:')) return markdown;
  const mergedEvidence = currentEvidence
    ? `${currentEvidence} needs_fix_rounds: 0`
    : 'needs_fix_rounds: 0';
  const updatedBlock = setBlockField(loc.rawBlock, 'Evidence', mergedEvidence);
  return markdown.slice(0, loc.startIndex) + updatedBlock + markdown.slice(loc.endIndex);
}

function printUsage() {
  console.error(
    `${BOLD}Usage:${RESET} ./scripts/mavp-operator --set-status T-NNN[,T-MMM,...] <status> [--commit <hash>] [--branch <name>] [--from <status>]`
  );
  console.error(`${DIM}  --from <status>  Precondition guard: skip tasks not currently at <status>${RESET}`);
  console.error(`${DIM}Valid statuses: ${VALID_STATUSES.join(', ')}${RESET}`);
}

function main() {
  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--set-status');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

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

  // Resolve/validate --commit before touching any artifact file. Non-hex,
  // non-"HEAD" input is rejected here without invoking any git subprocess.
  // "HEAD" is resolved to the current repo's short hash. A format-valid hash
  // that is not reachable from --branch produces a non-blocking warning
  // (printed later, once, after task IDs are known) — the write still proceeds.
  let commitWarning = null;
  if (commitHash) {
    const resolved = resolveCommitHash(ROOT, commitHash, branchName);
    if (!resolved.ok) {
      console.error(`${RED}Error: ${resolved.error}${RESET}`);
      process.exitCode = 1;
      return;
    }
    commitHash = resolved.hash;
    commitWarning = resolved.warning;
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
    // Both reads are bounded to taskId's OWN block via readCurrentStatus()
    // (readTaskField() under the hood) — when the target block has no
    // Status line (or the task/heading itself can't be resolved), the read
    // returns null rather than silently falling through to whatever a later
    // block in the same file happens to contain (T-608). A null read can
    // never equal a real fromStatus string, so it always falls into the
    // warn+skip branch below, whose message renders as an explicit
    // "currently \"unknown\"" — never a neighbor's status masquerading as a
    // match.
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
      // Write evidence atomically alongside status when --commit is provided.
      // Merges into existing evidence text (e.g. prior QA notes) rather than
      // clobbering it — see mergeCommitEvidence().
      if (commitHash && inTaskStatus) {
        const currentEvidence = readCurrentEvidence(taskStatus, taskId);
        const mergedEvidence = mergeCommitEvidence(currentEvidence, commitHash, branchName);
        taskStatus = updateTaskEvidence(taskStatus, taskId, mergedEvidence);
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
    if (commitWarning) {
      console.warn(`${YELLOW}Warning: ${commitWarning}${RESET}`);
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
