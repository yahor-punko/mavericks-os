#!/usr/bin/env node

/**
 * mavp-operator-close-session.js
 *
 * End-of-session ritual:
 * 1. Reads active tasks from TASK_STATUS.md
 * 2. Prompts operator to mark tasks as merged / needs_fix / keep
 * 3. Updates TASK_STATUS.md and PROCESS_STATE.md
 * 4. Runs the MavP validator and reports health
 * 5. If all tasks merged (wave complete), prompts git push
 *
 * Usage:
 *   ./scripts/mavp-operator --close-session
 *   ./scripts/mavp-operator --close-session --non-interactive [--summary "text"] [--mark-merged T-001,T-002]
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { execSync, spawnSync } = require('node:child_process');

/**
 * Resolve the mavericks installation's scripts/ directory, so project-copied
 * scripts (this file) can require the shared lib without a local copy.
 * Resolution order:
 *   (a) MAVERICKS_SCRIPTS env var, if set and it contains mavp-operator-lib.js
 *       (normal bootstrapped-project path — the bash wrapper exports this)
 *   (b) __dirname, if it contains mavp-operator-lib.js
 *       (the mavericks repo itself, and legacy projects with a local lib copy)
 *   (c) ~/Documents/mavericks/scripts (matches the existing VALIDATOR fallback)
 */
function resolveMavericksScriptsDir() {
  const candidates = [];
  if (process.env.MAVERICKS_SCRIPTS) candidates.push(process.env.MAVERICKS_SCRIPTS);
  candidates.push(__dirname);
  candidates.push(path.join(os.homedir(), 'Documents', 'mavericks', 'scripts'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'mavp-operator-lib.js'))) return dir;
  }
  throw new Error(
    `Cannot locate mavp-operator-lib.js (checked: ${candidates.join(', ')}). ` +
      `Set MAVERICKS_HOME to your mavericks installation's root directory.`
  );
}

const MAVERICKS_SCRIPTS_DIR = resolveMavericksScriptsDir();
const { generateProcessStateMd, archiveActiveWaveInBacklog, archiveMergedTasksFromActiveWave, classifyNextAction, classifyWorktrees, formatWorktreeHygieneAdvisory, parseActiveWaveMergedTitles, parseMidWaveArchivedTasks, readPermissionMode, readPersistedPermissionMode, printRepoIdentityHeader, getCommitHashesReachable, isTaskHeadingFor, headingLeadingTaskId, moveTaskBlockToSection, TERMINAL_SKIP_STATUSES, ARCHIVABLE_TERMINAL_STATUSES, DEFERRED_TASK_STATUS_HEADING, UnresolvableMainRefError } = require(path.join(MAVERICKS_SCRIPTS_DIR, 'mavp-operator-lib'));

// T-530: checkVersionBump()'s release-awareness reads the public mirror's
// tags EXCLUSIVELY through these check-changelog-frozen.js exports — never
// a re-implemented `git -C <mirror> ...` call. See that file's GIT_DIR
// HARDENING (T-517) comment: git sets GIT_DIR in the environment of
// processes it invokes, and GIT_DIR TAKES PRECEDENCE OVER `-C`, so a naive
// mirror-directed git call here would silently read the PRIVATE repo's tags
// instead whenever an ambient GIT_DIR happens to be set — precisely the
// scenario this feature exists to get right, in the dangerous direction
// (the private repo can and does carry version tags ahead of a mirror
// release). isGitRepo()/getMirrorTags() already strip GIT_DIR (and its
// GIT_REPO_ENV_KEYS siblings) via mirrorGitEnv() before every mirror-
// directed call, so reusing them here inherits that hardening for free —
// this file never calls mirrorGitEnv() itself; it is exercised transitively
// through isGitRepo()/getMirrorTags(), which is the intended reuse shape.
const { resolveMirrorHome, getMirrorTags, isGitRepo } = require(path.join(MAVERICKS_SCRIPTS_DIR, 'check-changelog-frozen.js'));

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const VALIDATOR = path.join(
  process.env.MAVERICKS_SCRIPTS || path.join(os.homedir(), 'Documents', 'mavericks', 'scripts'),
  'mavp-validator.js'
);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

// T-530: the two version-bump advisory lines, hoisted into constants so
// both print call sites and the test suite reference the SAME literal —
// tests assert on these exported constants directly (whole-line assertion,
// not a re-typed substring), which is what makes the assertion catch a
// mutant that prints a different (or missing) line rather than passing for
// the wrong reason.
const VERSION_BUMP_LINE = `${YELLOW}⚠ scripts/ changed since last version bump — consider bumping scripts/mavp-version.js before git push${RESET}`;
const VERSION_UNRELEASED_LINE = `${CYAN}ℹ scripts/ changed but the current version is unreleased (untagged on the mirror) and still accumulating — no bump advised yet${RESET}`;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, content) { fs.writeFileSync(p, content, 'utf8'); }

/**
 * Count tasks with a given status across the entire TASK_STATUS content.
 * Used for deploy_queue warning (deployed_dev tasks awaiting prod promotion).
 */
function countTasksByStatus(markdown, targetStatus) {
  const lines = markdown.split(/\r?\n/);
  let count = 0;
  let currentStatus = null;

  for (const line of lines) {
    if (/^###\s+T-\d+/.test(line)) {
      currentStatus = null;
      continue;
    }
    const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s+(.+)$/);
    if (statusMatch) {
      currentStatus = statusMatch[1].trim();
      if (currentStatus === targetStatus) {
        count += 1;
      }
    }
  }

  return count;
}

/**
 * Collect all merged task IDs from the entire TASK_STATUS content (both
 * ## Active tasks and ## Recently completed tasks sections).
 * Returns array of IDs in document order, e.g. ["T-110", "T-111"].
 */
function collectMergedTaskIds(markdown) {
  const lines = markdown.split(/\r?\n/);
  const ids = [];
  let currentId = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      currentId = headingMatch[1];
    } else if (currentId && /^- \*\*Status:\*\*\s+merged/.test(line)) {
      ids.push(currentId);
      currentId = null;
    } else if (/^###\s+/.test(line)) {
      currentId = null;
    }
  }

  return ids;
}

/**
 * Build the RENAME_SESSION label: W{wave}[S{n}] — T-xxx, T-yyy
 * If no merged tasks, omit the task segment.
 */
function buildRenameLabel(wave, waveSession, mergedIds) {
  const prefix = `W${wave}[S${waveSession}]`;
  if (!mergedIds || mergedIds.length === 0) return prefix;
  return `${prefix} — ${mergedIds.join(', ')}`;
}

/**
 * Build an auto-generated wave_summary from merged task titles.
 *
 * T-584: growth is linear in the wave's completed-task count (buildAutoSummary
 * used to join every title), so a long-running wave produced a wave_summary of
 * thousands of characters instead of the documented "one sentence". This is a
 * count-plus-highlights form with a constant upper bound: the count, up to the
 * first three clipped titles, and a "+K more." tail when there are more than
 * three. Format: "Wave N: M task(s) completed — <t1>; <t2>; <t3>; +K more."
 */
const AUTO_SUMMARY_HIGHLIGHT_COUNT = 3;

function buildAutoSummary(waveNumber, mergedTitles) {
  if (mergedTitles.length === 0) {
    return `Wave ${waveNumber}: no tasks recorded.`;
  }
  // Trim long titles to keep the summary readable
  const clipped = mergedTitles.map(t => t.length > 60 ? t.slice(0, 57) + '...' : t);
  const highlights = clipped.slice(0, AUTO_SUMMARY_HIGHLIGHT_COUNT);
  const remaining = clipped.length - highlights.length;
  const tail = remaining > 0 ? `; +${remaining} more.` : '.';
  return `Wave ${waveNumber}: ${clipped.length} task(s) completed — ${highlights.join('; ')}${tail}`;
}

/**
 * Scan TASK_STATUS.md for tasks in `dev_done` or `qa_passed` that have no
 * `Evidence:` line in their block. Returns an array of { id, status } objects.
 * Checks both ## Active tasks and ## Recently completed tasks sections.
 */
function findTasksWithNoEvidence(markdown) {
  const lines = markdown.split(/\r?\n/);
  const results = [];

  let currentId = null;
  let currentStatus = null;
  let blockStart = -1;

  function finalizeBlock(endIdx) {
    if (currentId === null) return;
    // Deliberately NOT derived from IN_FLIGHT_STATUSES (T-525) — this set names the two
    // statuses eligible for the close-session merge prompt, a narrower and semantically
    // distinct purpose; a needs-fix task must never be prompted for merge.
    const targetStatuses = new Set(['dev_done', 'qa_passed']);
    if (!targetStatuses.has(currentStatus)) return;

    // Check for Evidence: field in the block
    const blockLines = lines.slice(blockStart, endIdx);
    const hasEvidence = blockLines.some(l => /^-\s+\*\*Evidence:\*\*/.test(l));
    if (!hasEvidence) {
      results.push({ id: currentId, status: currentStatus });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      finalizeBlock(i);
      currentId = headingMatch[1];
      currentStatus = null;
      blockStart = i;
      continue;
    }
    // Section heading (##) ends current block
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      finalizeBlock(i);
      currentId = null;
      currentStatus = null;
      blockStart = -1;
      continue;
    }
    if (currentId) {
      const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s+(.+)$/);
      if (statusMatch) {
        currentStatus = statusMatch[1].trim();
      }
    }
  }
  // Finalize last block
  finalizeBlock(lines.length);

  return results;
}

/**
 * Parse evidence blocks from TASK_STATUS.md for the given task IDs.
 * Returns a Map of taskId -> { commit, branch } extracted from the Evidence: field.
 * Searches all sections (active + recently completed).
 */
function parseTasksEvidence(markdown, taskIds) {
  const result = new Map();
  const idSet = new Set(taskIds);
  if (idSet.size === 0) return result;

  const lines = markdown.split(/\r?\n/);
  let currentId = null;
  let blockLines = [];

  function finalizeBlock() {
    if (!currentId || !idSet.has(currentId)) return;
    const blockText = blockLines.join('\n');
    const evLine = blockText.match(/[-*]\s+\*\*Evidence:\*\*\s+([\s\S]*?)(?=\n[-*]\s+\*\*|\n###|\s*$)/i);
    const evText = evLine ? evLine[1] : '';
    const commitMatch = evText.match(/commit:\s*([0-9a-f]{5,40})/i);
    const branchMatch = evText.match(/branch:\s*(\S+)/i);
    result.set(currentId, {
      commit: commitMatch ? commitMatch[1] : null,
      branch: branchMatch ? branchMatch[1].replace(/[,;]$/, '') : null,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      finalizeBlock();
      currentId = headingMatch[1];
      blockLines = [line];
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      finalizeBlock();
      currentId = null;
      blockLines = [];
      continue;
    }
    if (currentId) {
      blockLines.push(line);
    }
  }
  finalizeBlock();

  return result;
}

/**
 * Parse Repo: field for given task IDs from BACKLOG.md.
 * Returns a Map of taskId -> repo string (or null).
 */
function parseBacklogRepos(markdown, taskIds) {
  const result = new Map();
  const idSet = new Set(taskIds);
  if (idSet.size === 0) return result;

  const lines = markdown.split(/\r?\n/);
  let currentId = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      currentId = headingMatch[1];
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      currentId = null;
      continue;
    }
    if (currentId && idSet.has(currentId)) {
      const repoMatch = line.match(/^-\s+\*\*Repos?:\*\*\s+(.+)$/i);
      if (repoMatch) {
        result.set(currentId, repoMatch[1].trim());
        currentId = null;
      }
    }
  }

  return result;
}

/**
 * Build a Map of taskId -> status from TASK_STATUS.md for the given IDs.
 * Searches all sections.
 */
function buildTaskStatusMap(markdown, taskIds) {
  const result = new Map();
  const idSet = new Set(taskIds);
  if (idSet.size === 0) return result;

  const lines = markdown.split(/\r?\n/);
  let currentId = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      currentId = headingMatch[1];
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      currentId = null;
      continue;
    }
    if (currentId && idSet.has(currentId)) {
      const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s+(.+)$/);
      if (statusMatch) {
        result.set(currentId, statusMatch[1].trim());
        currentId = null;
      }
    }
  }

  return result;
}

/**
 * Resolve the remote-tracking ref for the current checkout in `root`:
 * prefers `@{upstream}` (the branch's configured tracking ref); falls back
 * to `origin/<current-branch>` when no upstream is configured but an
 * `origin/<branch>` ref exists. Returns null (never throws) when neither
 * resolves — no remote configured, detached HEAD, git unavailable, etc.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string|null} A revspec naming the remote-tracking ref, or null.
 */
function resolveRemoteTrackingRef(root) {
  try {
    const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (upstream) return upstream;
  } catch { /* no upstream configured — try origin/<branch> fallback below */ }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!branch || branch === 'HEAD') return null; // detached HEAD
    const candidate = `origin/${branch}`;
    execSync(`git rev-parse --verify ${candidate}`, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return candidate;
  } catch {
    return null;
  }
}

/**
 * True/false when reachability from the remote-tracking ref could be
 * determined; null when it could not (no remote, no commit hash, git
 * unavailable) — callers must treat null as "degrade to a status-only
 * label", never as "not reachable".
 *
 * @param {string} root - Absolute path to the git working tree.
 * @param {string|null} commitHash - Evidence commit hash (short or full).
 * @returns {boolean|null}
 */
function isCommitReachableFromRemote(root, commitHash) {
  if (!commitHash) return null;
  const ref = resolveRemoteTrackingRef(root);
  if (!ref) return null;
  const reachableHashes = getCommitHashesReachable(root, ref);
  if (reachableHashes === null) return null;
  return reachableHashes.some((full) => full.startsWith(commitHash));
}

/**
 * Compute the deploy-column label for a single task (T-454).
 *
 * deploy_contours >= 2 (dev+prod contours): derives directly from the task's
 * actual status — deployed_prod / deployed_dev / merged each get their own
 * label; anything else falls through to "not merged". This eliminates the
 * former bug where deployed_dev/deployed_prod tasks rendered as "not merged"
 * (the fallthrough only ever checked for `merged`).
 *
 * deploy_contours 0/1 (terminal-on-merge / auto-deploy-on-merge): the
 * terminal/auto-deploy label renders ONLY when the evidence commit is
 * reachable from the remote-tracking ref (origin/<branch> or @{upstream}) —
 * otherwise a "held, not pushed" label renders so an unpushed merge is never
 * mistaken for a live deploy. When reachability can't be determined at all
 * (no remote configured, git unavailable, no evidence commit) this degrades
 * to a status-only label instead of guessing either way.
 *
 * @param {number} deployContours
 * @param {string|null} status - task's current status (from TASK_STATUS.md)
 * @param {string|null} evidenceCommit - evidence commit hash, or null
 * @param {string} root - absolute path to the git working tree
 * @returns {string}
 */
function getDeployLabel(deployContours, status, evidenceCommit, root) {
  if (deployContours >= 2) {
    if (status === 'deployed_prod') return '✓ в проде';
    if (status === 'deployed_dev') return '✓ в dev';
    if (status === 'merged') return '⏳ не задеплоен';
    return '⏳ не смёрджен';
  }

  // deploy_contours 0 or 1
  const terminalLabel = deployContours === 0 ? '✓ задеплоен' : '✓ авто-деплой';
  const reachable = isCommitReachableFromRemote(root, evidenceCommit);
  if (reachable === true) return terminalLabel;
  if (reachable === false) return '⚠ смёрджен — HELD, не запушен';
  // reachable === null: can't verify (no remote / no commit / git unavailable) — degrade
  return status || '—';
}

/**
 * Print a session-completed table for tasks that reached merged/qa_passed/dev_done
 * during this close-session run.
 *
 * @param {string[]} sessionCompletedIds   task IDs completed this session
 * @param {string}   taskStatusContent     final TASK_STATUS.md content (after updates)
 * @param {string}   backlogContent        BACKLOG.md content
 * @param {number}   deployContours        from PROCESS_STATE.json
 * @param {Map}      taskStatusMap         taskId -> final status (from TASK_STATUS)
 * @param {string}   [root]                absolute path to the git working tree (defaults to ROOT)
 */
function printSessionCompletedTable(sessionCompletedIds, taskStatusContent, backlogContent, deployContours, taskStatusMap, root) {
  if (!sessionCompletedIds || sessionCompletedIds.length === 0) return;

  const gitRoot = root || ROOT;
  const evidenceMap = parseTasksEvidence(taskStatusContent, sessionCompletedIds);
  const repoMap = parseBacklogRepos(backlogContent, sessionCompletedIds);

  const COL_TASK = 28;
  const COL_COMMIT = 12;
  const COL_BRANCH = 10;

  function pad(str, len) {
    const s = String(str || '');
    return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
  }

  const separator = '── Сессия завершена ' + '─'.repeat(40);
  console.log(`\n${BOLD}${separator}${RESET}`);
  console.log(
    ` ${DIM}${pad('Задача', COL_TASK)}${pad('Коммит', COL_COMMIT)}${pad('Ветка', COL_BRANCH)}Деплой${RESET}`
  );

  for (const id of sessionCompletedIds) {
    const ev = evidenceMap.get(id) || {};
    const repo = repoMap.get(id) || '';
    const taskLabel = repo ? `${id}  ${repo}` : id;
    const commitStr = ev.commit ? ev.commit.slice(0, 7) : '—';
    const branchStr = ev.branch || '—';
    const status = taskStatusMap ? taskStatusMap.get(id) : null;
    const deploy = getDeployLabel(deployContours, status, ev.commit, gitRoot);
    console.log(` ${pad(taskLabel, COL_TASK)}${pad(commitStr, COL_COMMIT)}${pad(branchStr, COL_BRANCH)}${deploy}`);
  }
  console.log('');
}

/**
 * Parse every `### T-NNN` block in TASK_STATUS.md's `## Active tasks` section.
 *
 * DELIBERATELY UNFILTERED (T-573): this returns EVERY entry regardless of
 * status, because --mark-merged resolves its argument IDs against this list
 * and must still find a `qa_passed`/`dev_done` task. Status-based skipping is
 * the CALLERS' job — see the terminal sweeps in runNonInteractive() and
 * runInteractive(), which relocate terminal entries out of the section and
 * then re-parse, so wave completion is computed from post-sweep content.
 * Do not "fix" wave-completion bugs by adding a filter here.
 */
function parseActiveTasks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+Active tasks/.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);

  return blocks.map(block => {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    return {
      id: headingMatch?.[1] || 'unknown',
      title: headingMatch?.[2]?.trim() || 'unknown',
      status: statusMatch?.[1]?.trim() || 'unknown',
    };
  });
}

// T-573: isTaskHeadingFor() / headingLeadingTaskId() (the T-542 anchored
// heading matcher and its identity companion) now live in
// mavp-operator-lib.js so this file and the lib's own block movers share ONE
// implementation instead of two copies that can drift — the exact defect class
// T-573 itself closes (close-session's local parseActiveTasks had diverged
// from the lib's parseActiveTask). They are imported at the top of this file
// and re-exported unchanged below, so every existing caller and
// scripts/test-task-heading-anchor.js keep working against this module.

function updateTaskStatusField(markdown, taskId, field, value) {
  const lines = markdown.split(/\r?\n/);
  let inTask = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i])) {
      inTask = isTaskHeadingFor(lines[i], taskId);
    }
    if (inTask && new RegExp(`^- \\*\\*${field}:\\*\\*`).test(lines[i])) {
      lines[i] = `- **${field}:** ${value}`;
    }
  }

  return lines.join('\n');
}

function moveTaskToCompleted(markdown, taskId) {
  const lines = markdown.split(/\r?\n/);

  let taskStart = -1;
  let taskEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isTaskHeadingFor(lines[i], taskId)) {
      taskStart = i;
    } else if (taskStart !== -1 && (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i]))) {
      taskEnd = i;
      break;
    }
  }

  if (taskStart === -1) return markdown;

  // Belt-and-braces identity invariant on top of the anchored matcher above:
  // the block we are about to move must genuinely be headed by taskId, not
  // some other block the matcher might (in a future regression) have found.
  if (headingLeadingTaskId(lines[taskStart]) !== taskId) return markdown;

  const taskBlock = lines.slice(taskStart, taskEnd);
  const remaining = [...lines.slice(0, taskStart), ...lines.slice(taskEnd)];

  const completedIdx = remaining.findIndex(l => /^##\s+Recently completed tasks/.test(l));
  if (completedIdx === -1) return markdown;

  return [
    ...remaining.slice(0, completedIdx + 1),
    '',
    ...taskBlock,
    ...remaining.slice(completedIdx + 1)
  ].join('\n');
}

/**
 * T-573: statuses a task can already be sitting at, inside `## Active tasks`,
 * that mean "this work is COMPLETE" — swept into `## Recently completed tasks`
 * without prompting and mirrored into BACKLOG.md via syncBacklogMergedTasks().
 *
 * Deliberately NOT derived from IN_FLIGHT_STATUSES (T-525) — this is the
 * complementary terminal-completed set for wave-archival auto-move, a distinct
 * purpose from "what counts as in-flight work"; a needs-fix task is neither in
 * this set nor eligible here.
 *
 * Shared by both close-session paths, and kept identical to the lib's
 * ARCHIVABLE_TERMINAL_STATUSES (which drives the BACKLOG-side archival those
 * same records trigger) — asserted below rather than merely commented, so the
 * two can never silently diverge. `runtime_verified` is a POST-merge status,
 * so a task carrying it is more finished than `merged`, not less.
 */
const ALREADY_TERMINAL_STATUSES = new Set(['merged', 'deployed_dev', 'deployed_prod', 'runtime_verified']);

// Fail loudly at load time if the two sets ever drift apart.
for (const s of ALREADY_TERMINAL_STATUSES) {
  if (!ARCHIVABLE_TERMINAL_STATUSES.has(s)) {
    throw new Error(`close-session: ALREADY_TERMINAL_STATUSES has "${s}" but mavp-operator-lib's ARCHIVABLE_TERMINAL_STATUSES does not — the TASK_STATUS sweep and the BACKLOG archival would disagree.`);
  }
}

/**
 * T-573: sweep the `deferred` / `deprecated` entries (TERMINAL_SKIP_STATUSES)
 * that are still sitting in TASK_STATUS.md's `## Active tasks` section out of
 * it, so wave completion is computed from the work that actually remains.
 *
 * The 2026-08-02 incident: Wave 70's real work was all merged and archived,
 * but 7 terminal entries (1 deprecated + 6 deferred) stayed in `## Active
 * tasks`, so `remainingTasks.length === 0` was never true and the wave latched
 * open across sessions.
 *
 * Destinations:
 *   - `deferred`   → `## Deferred tasks` (created on demand — a project that
 *                    has never deferred a task has no such section yet).
 *   - `deprecated` → `## Recently completed tasks` (permanently retired work
 *                    belongs with the other archived blocks; the validator
 *                    already exempts `deprecated` records from that section's
 *                    non-terminal-status placement check).
 *
 * Blocks are relocated BYTE-FOR-BYTE — Evidence/Notes/Superseded by lines all
 * survive verbatim.
 *
 * CRITICAL: swept records are NOT returned for mergedTaskRecords, and this
 * function deliberately takes no mergedTaskRecords argument so a future edit
 * cannot casually add them. syncBacklogMergedTasks() would rewrite the task's
 * BACKLOG Status and ARCHIVE its BACKLOG block into `## Wave N — Archived
 * (mid-wave)` — but a deferred task's BACKLOG block lives under
 * `## Deferred Tasks` and must stay there, untouched. This sweep is
 * TASK_STATUS-only plus a console line.
 *
 * @param {string} content - current TASK_STATUS.md content
 * @param {Array<{id: string, status: string}>} activeTasks - parseActiveTasks() output
 * @param {Set<string>} [skipIds] - ids already handled by another sweep this run
 * @returns {{ content: string, sweptIds: string[] }}
 */
function sweepTerminalSkipTasks(content, activeTasks, skipIds = new Set()) {
  let updated = content;
  const sweptIds = [];

  for (const task of activeTasks) {
    if (skipIds.has(task.id)) continue;
    if (!TERMINAL_SKIP_STATUSES.has(task.status)) continue;

    if (task.status === 'deferred') {
      const result = moveTaskBlockToSection(updated, task.id, DEFERRED_TASK_STATUS_HEADING);
      if (!result.ok) {
        console.log(`${YELLOW}⚠ ${task.id} (deferred) — could not relocate: ${result.error}${RESET}`);
        continue;
      }
      updated = result.updated;
      console.log(`  ${GREEN}✓ ${task.id} → moved to "${DEFERRED_TASK_STATUS_HEADING}" (deferred — not blocking wave completion)${RESET}`);
    } else {
      const before = updated;
      updated = moveTaskToCompleted(updated, task.id);
      if (updated === before) {
        console.log(`${YELLOW}⚠ ${task.id} (deprecated) — could not relocate into "## Recently completed tasks"${RESET}`);
        continue;
      }
      console.log(`  ${GREEN}✓ ${task.id} → moved to completed (deprecated — not blocking wave completion)${RESET}`);
    }

    sweptIds.push(task.id);
  }

  return { content: updated, sweptIds };
}

/**
 * T-573 (hardening): structural guard on syncBacklogMergedTasks()'s input.
 *
 * The property being protected: a task swept out of `## Active tasks` as
 * `deferred`/`deprecated` must NEVER have its BACKLOG block touched by the
 * merge-mirror. sweepTerminalSkipTasks() enforces that today by construction
 * (it takes no mergedTaskRecords argument and its call sites discard
 * sweptIds), but "by construction" only survives until someone refactors the
 * deferred branch into the merged path — the whole point of this guard is
 * that such a refactor must FAIL LOUDLY instead of silently corrupting
 * BACKLOG.md.
 *
 * Two intrinsic rules, both derived from what syncBacklogMergedTasks()
 * actually does (set a status, then archive the block out of Active Wave):
 *
 *  1. RECORD CONTRACT — every record's status must be in
 *     ARCHIVABLE_TERMINAL_STATUSES. This function only knows how to mirror
 *     COMPLETED work; a record carrying `deferred`/`deprecated` (or anything
 *     else) is a caller bug. Catches a same-status leak, which is otherwise
 *     INVISIBLE: updateTaskStatusField(id, 'Status', 'deferred') rewrites
 *     `deferred` → `deferred` byte-for-byte, and
 *     archiveMergedTasksFromActiveWave() will not move a block that is
 *     neither in `## Active Wave` nor in ARCHIVABLE_TERMINAL_STATUSES, so
 *     the contaminated run produces a byte-identical BACKLOG.md and no
 *     file-level assertion anywhere can see it.
 *
 *  2. NO PROMOTION OF A DEFERRED/DEPRECATED BLOCK — regardless of what
 *     status the record claims, refuse when the task's CURRENT BACKLOG
 *     status is in TERMINAL_SKIP_STATUSES. Catches the realistic refactor
 *     that folds the deferred branch into the merged path and pushes
 *     `{id, status: 'merged'}`: rule 1 cannot see that (the status IS
 *     archivable), but promoting a block that reads `deferred` to `merged`
 *     is exactly the corruption. This rule is intrinsic — it reads BACKLOG
 *     itself and needs no cooperation from the caller, so it holds however
 *     the sweep is later restructured.
 *
 * On a genuine pre-existing drift (BACKLOG stale at `deferred`/`deprecated`
 * while TASK_STATUS says the task was merged) this refuses rather than
 * papering over it.
 *
 * VALIDATOR COVERAGE — corrected by T-575; the paragraph this replaces said
 * the validator did not detect this shape at all, which was true when it was
 * written and is now only PARTLY true. What changed and what did not, each
 * re-measured against a live fixture after T-575 landed:
 *
 *   - The `deferred` half is now COVERED. T-575 added
 *     checkReverseTerminalStatusDisagreement() (mavp-validator.js) — the
 *     mirror image of the forward check named further down — so the fixture
 *     the old paragraph quoted as
 *     "Healthy, 0 failures, 0 warnings, exit 0" (BACKLOG T-810 `deferred`
 *     under `## Deferred Tasks`, TASK_STATUS T-810 `merged` under
 *     `## Active tasks`) now reports "Overall result: Misleading / repair
 *     required", "- Failures: 1", exit 2, and under "## Failures":
 *       - [T-810] reverse_terminal_status_disagreement
 *         - Issue: T-810 is merged in TASK_STATUS.md (section: Active tasks)
 *           but BACKLOG.md (section: Deferred Tasks) still records status
 *           deferred — the artifacts disagree on whether this task shipped.
 *   - The `deprecated` half is STILL INVISIBLE. TERMINAL_SKIP_STATUSES holds
 *     both `deferred` and `deprecated`, but the validator's
 *     isSkippedByExistingRules() exempts `deprecated` records (and any record
 *     carrying a real `Superseded by:`) on BOTH sides by design, so the new
 *     check skips them. Verified by flipping only the BACKLOG status in that
 *     same fixture to `deprecated`: "Overall result: Healthy", 0 failures,
 *     0 warnings, exit 0. Rule 2 above still refuses it.
 *   - The three older checks remain blind in this direction, exactly as the
 *     old paragraph described — the new coverage comes solely from the new
 *     check. compareRecords()'s active-vs-active `status_mismatch` never sees
 *     the BACKLOG block: parseBacklogActiveTasks() keeps only
 *     ACTIVE_BACKLOG_STATUSES, and `deferred` is not in that set. That is a
 *     STATUS filter, not a section filter — moving the same block into
 *     `## Active Wave` leaves it equally invisible to it (re-verified in
 *     test-validator-cross-section-status.js Test G: no `status_mismatch`
 *     finding, and the block is dropped from the active record count).
 *     checkCrossSectionTerminalStatusDisagreement() and
 *     checkMissingTaskStatusRecordAnywhere() both read whole-file records, so
 *     they CAN see a `## Deferred Tasks` block, but both fire only when the
 *     BACKLOG side is terminal — the opposite direction. Section placement
 *     was never what hid this shape; direction was.
 *
 * The guard is still load-bearing even for the now-covered half, for two
 * reasons. First, ORDERING: close-session calls syncBacklogMergedTasks()
 * before runValidator(), so by the time the validator runs the sweep has
 * already rewritten BACKLOG.md to agree with TASK_STATUS.md — the
 * disagreement the new check looks for has been erased by the very write the
 * guard exists to prevent. A validator check reports drift at rest; only this
 * throw stops the corrupting write. Second, this shape cannot come out of a
 * sanctioned ritual: `--rescope-task --status deferred` sets the BACKLOG
 * Status in the same write that relocates the block and mirrors the same
 * value into TASK_STATUS.md, and `--set-status` writes both artifacts. It
 * appears only via a direct hand-edit of TASK_STATUS.md — sync-status mirrors
 * BACKLOG → TASK_STATUS only, never back.
 *
 * Throws before any BACKLOG.md write, so a tripped guard leaves BACKLOG.md
 * untouched — the safe direction.
 *
 * @param {Array<{id: string, status: string}>} mergedTaskRecords
 * @param {string} backlogContent - BACKLOG.md content, read before any mutation
 */
function assertMergedRecordsUncontaminated(mergedTaskRecords, backlogContent) {
  const backlogStatuses = parseBacklogStatuses(backlogContent);

  for (const rec of mergedTaskRecords) {
    if (!ARCHIVABLE_TERMINAL_STATUSES.has(rec.status)) {
      throw new Error(
        `close-session: refusing to mirror ${rec.id} into BACKLOG.md with status "${rec.status}" — ` +
        `syncBacklogMergedTasks() only mirrors completed work (${[...ARCHIVABLE_TERMINAL_STATUSES].join('/')}). ` +
        `A deferred/deprecated task swept out of "## Active tasks" must never reach mergedTaskRecords; ` +
        `its BACKLOG block stays where it is, untouched.`
      );
    }

    const currentBacklogStatus = backlogStatuses.get(rec.id);
    if (currentBacklogStatus && TERMINAL_SKIP_STATUSES.has(currentBacklogStatus)) {
      throw new Error(
        `close-session: refusing to promote ${rec.id} from "${currentBacklogStatus}" to "${rec.status}" in BACKLOG.md — ` +
        `a ${currentBacklogStatus} task must never be mirrored as completed work. ` +
        `If ${rec.id} genuinely was completed, adjudicate the BACKLOG/TASK_STATUS disagreement by hand first.`
      );
    }
  }
}

/**
 * T-438: mirror TASK_STATUS.md's merge state into BACKLOG.md — set each merged
 * task's `- **Status:**` field to match, then archive its block out of
 * BACKLOG's `## Active Wave` section via the same
 * archiveMergedTasksFromActiveWave() machinery `--archive-merged` uses
 * (moving it into that wave's `## Wave <N> — Archived (mid-wave)` section).
 *
 * Without this, a task merged mid-wave stayed listed as active in BACKLOG.md
 * while its TASK_STATUS.md block had already moved to "Recently completed" —
 * an asymmetry that produced `missing_in_task_status` validator findings and
 * duplicate skeleton entries via sync-status's findMissingEntries().
 *
 * No-op when there are no merged tasks this run, or BACKLOG.md is absent.
 *
 * @param {Array<{id: string, status: string}>} mergedTaskRecords - tasks merged this run, with their final status value
 * @param {number|string} waveNumber - the currently open wave number (read BEFORE any wave increment)
 */
function syncBacklogMergedTasks(mergedTaskRecords, waveNumber) {
  if (!mergedTaskRecords.length || !fs.existsSync(BACKLOG_MD)) return;

  let backlogContent = readUtf8(BACKLOG_MD);

  // T-573: fail loudly before touching BACKLOG.md if a swept deferred/
  // deprecated task leaked into mergedTaskRecords — see the guard's doc
  // comment above for why neither rule can be dropped.
  assertMergedRecordsUncontaminated(mergedTaskRecords, backlogContent);

  for (const rec of mergedTaskRecords) {
    backlogContent = updateTaskStatusField(backlogContent, rec.id, 'Status', rec.status);
  }
  writeUtf8(BACKLOG_MD, backlogContent);

  const archiveResult = archiveMergedTasksFromActiveWave(BACKLOG_MD, waveNumber);
  if (!archiveResult.ok) {
    console.log(`${YELLOW}⚠ BACKLOG.md archive warning: ${archiveResult.warning}${RESET}`);
  } else if (archiveResult.archivedIds.length > 0) {
    console.log(`  ${GREEN}✓ BACKLOG.md — archived ${archiveResult.archivedIds.length} task(s) out of Active Wave: ${archiveResult.archivedIds.join(', ')}${RESET}`);
  }
}

function updateProcessState(markdown, nextAction) {
  const today = new Date().toISOString().slice(0, 10);
  let updated = markdown;

  updated = updated.replace(
    /^## Last update\n[\s\S]*?(?=\n##|$)/m,
    `## Last update\n${today}\n`
  );

  if (nextAction) {
    updated = updated.replace(
      /^## Next expected handoff\n[\s\S]*?(?=\n##)/m,
      `## Next expected handoff\n- ${nextAction}\n`
    );
  }

  const movementMatch = updated.match(/^## Last meaningful movement\n([\s\S]*?)(?=\n##)/m);
  if (movementMatch) {
    const existing = movementMatch[1].trimEnd();
    updated = updated.replace(
      movementMatch[0],
      `## Last meaningful movement\n${existing}\n- ${today}: Session closed.\n`
    );
  }

  return updated;
}

/**
 * Parse task statuses from BACKLOG.md.
 * Returns a Map of taskId -> status for all tasks found in any section.
 * Only looks at the `- **Status:**` field immediately following a `### T-NNN` heading.
 */
function parseBacklogStatuses(markdown) {
  const statusMap = new Map();
  const lines = markdown.split(/\r?\n/);
  let currentId = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(T-\d+)/);
    if (headingMatch) {
      currentId = headingMatch[1];
      continue;
    }
    if (currentId) {
      const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s+(.+)$/);
      if (statusMatch) {
        statusMap.set(currentId, statusMatch[1].trim());
        currentId = null; // one status per task block
      } else if (/^###\s+/.test(line) || /^##\s+/.test(line)) {
        // New heading before we found a status — reset
        currentId = null;
      }
    }
  }

  return statusMap;
}

/**
 * Remove task IDs from active_slices that have already reached qa_passed or merged
 * status in BACKLOG.md.  Returns the filtered array.
 */
function filterStaleSlices(activeSlices, backlogStatuses) {
  const staleStatuses = new Set(['qa_passed', 'merged']);
  return activeSlices.filter(id => {
    const status = backlogStatuses.get(id);
    return !staleStatuses.has(status);
  });
}

/**
 * T-438: PROCESS_STATE.json's `active_slices` must reflect BACKLOG.md's
 * current state BEFORE the validator runs — otherwise a task just merged
 * (and archived out of BACKLOG's Active Wave) but still listed in
 * `active_slices` trips checkActiveSlices()'s WARNING-severity
 * `active_slices_mismatch` finding, downgrading a healthy close to
 * "drifting" (exit 1) for no real reason. This is a narrow, idempotent
 * pre-validator sync — it only ever removes stale IDs from `active_slices`
 * and never touches `wave`/`wave_session`/`last_updated`, so it does not
 * reintroduce the "PROCESS_STATE mutated before the validator gate" problem
 * the wave/wave_session bump (see updateProcessStateJson call sites below)
 * is being fixed for.
 */
function syncActiveSlicesPreValidator() {
  if (!fs.existsSync(PROCESS_STATE_JSON) || !fs.existsSync(BACKLOG_MD)) return;
  try {
    const current = JSON.parse(readUtf8(PROCESS_STATE_JSON));
    if (!Array.isArray(current.active_slices) || current.active_slices.length === 0) return;
    const backlogStatuses = parseBacklogStatuses(readUtf8(BACKLOG_MD));
    const filtered = filterStaleSlices(current.active_slices, backlogStatuses);
    if (filtered.length !== current.active_slices.length) {
      current.active_slices = filtered;
      writeUtf8(PROCESS_STATE_JSON, JSON.stringify(current, null, 2) + '\n');
    }
  } catch { /* leave PROCESS_STATE.json untouched on any parse/read error */ }
}

/**
 * T-530: read the current framework version out of <ROOT>/scripts/mavp-version.js's
 * raw text. Deliberately NOT require()'d — require() would cache against
 * the first-loaded path and can't re-read a different ROOT across repeated
 * calls/tests, and ROOT may be a fixture project root carrying its own
 * throwaway mavp-version.js rather than this checkout's real one. Anchored
 * to the `module.exports = { MAVERICKS_VERSION: 'x.y.z' }` declaration
 * shape (same regex mavp-publish-release.js's parseMavericksVersion() uses)
 * so an earlier prose comment mentioning the constant can never shadow the
 * real value. Returns null when the file is absent or unparsable.
 */
function readCurrentMavericksVersion() {
  try {
    const versionFilePath = path.join(ROOT, 'scripts', 'mavp-version.js');
    const content = fs.readFileSync(versionFilePath, 'utf8');
    const m = content.match(/module\.exports\s*=\s*\{[^}]*\bMAVERICKS_VERSION\s*:\s*['"]([^'"]+)['"][^}]*\}/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * T-530: resolve the public mirror's local tags, exclusively through
 * check-changelog-frozen.js's own exports (resolveMirrorHome/isGitRepo/
 * getMirrorTags — all of which route through mirrorGitEnv() internally).
 * See the require() comment near the top of this file for why a
 * re-implemented `git -C <mirror> ...` call here would be actively
 * dangerous (T-517's GIT_DIR-precedence trap). No network fetch beyond
 * whatever getMirrorTags() itself already does (best-effort, ~4s timeout,
 * swallowed on failure) — this function adds none of its own.
 *
 * Returns a Set<string> of tag names, or null when the mirror can't be
 * resolved/read at all (caller degrades to pre-T-530 "always advise"
 * behavior in that case).
 */
function resolveMirrorTagsForVersionBump() {
  try {
    const mirrorHome = resolveMirrorHome();
    if (!mirrorHome || !fs.existsSync(mirrorHome) || !isGitRepo(mirrorHome)) return null;
    return getMirrorTags(mirrorHome);
  } catch {
    return null;
  }
}

/**
 * T-530: pure classification of the scripts/-drifted-since-bump signal
 * against the mirror's tag state — no git/fs, directly unit-testable.
 *
 *   null                             — no drift at all; nothing to advise on.
 *   { kind: 'bump', changes }        — advise a bump (pre-T-530 behavior):
 *                                       either the current version IS
 *                                       already tagged on the mirror, or
 *                                       the mirror/tag state is unknown
 *                                       (degrade unchanged when the mirror
 *                                       is unresolvable — `tags` is null).
 *   { kind: 'unreleased', changes }  — current version is NOT tagged on the
 *                                       mirror — informational only, no
 *                                       bump advice (bumping now would
 *                                       orphan the still-unreleased,
 *                                       still-accumulating version).
 */
function classifyVersionBumpAdvisory({ changes, currentVersion, tags }) {
  if (!changes) return null;
  if (!tags || !currentVersion) return { kind: 'bump', changes };
  const tagName = currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`;
  return tags.has(tagName) ? { kind: 'bump', changes } : { kind: 'unreleased', changes };
}

/**
 * Check whether scripts/ changed after the last version bump in mavp-version.js.
 * Returns null when there's no drift at all, otherwise a release-aware
 * classification object from classifyVersionBumpAdvisory() (T-530) — see
 * that function's doc comment for the three possible shapes.
 */
function checkVersionBump() {
  try {
    const versionFile = 'scripts/mavp-version.js';
    const versionResult = spawnSync(
      'git', ['log', '-1', '--format=%H', '--', versionFile],
      { encoding: 'utf8', cwd: ROOT }
    );
    if (versionResult.status !== 0 || !versionResult.stdout.trim()) return null;
    const versionCommit = versionResult.stdout.trim();

    const scriptsResult = spawnSync(
      'git', ['log', '-1', '--format=%H', '--', 'scripts/'],
      { encoding: 'utf8', cwd: ROOT }
    );
    if (scriptsResult.status !== 0 || !scriptsResult.stdout.trim()) return null;
    const scriptsCommit = scriptsResult.stdout.trim();

    // Same commit — no drift
    if (versionCommit === scriptsCommit) return null;

    // Check if any scripts/ files changed after the last version bump
    const changesResult = spawnSync(
      'git', ['log', '--oneline', `${versionCommit}..HEAD`, '--', 'scripts/'],
      { encoding: 'utf8', cwd: ROOT }
    );
    if (changesResult.status !== 0) return null;
    const changes = changesResult.stdout.trim() || null;
    if (!changes) return null;

    // T-530: release-awareness — classify against the mirror's tag state
    // before deciding whether to advise a bump.
    const currentVersion = readCurrentMavericksVersion();
    const tags = resolveMirrorTagsForVersionBump();
    return classifyVersionBumpAdvisory({ changes, currentVersion, tags });
  } catch {
    return null; // git unavailable or error — skip silently
  }
}

// T-431: runValidator() must distinguish the validator's three exit codes
// (0 healthy, 1 drifting/warnings, 2 repair required) rather than collapsing
// 1 and 2 into a single "not ok" result — execSync throws on ANY non-zero
// exit, so the caught branch previously had no way to tell drifting (1) apart
// from repair-required (2). `code` is always populated: err.status when the
// child process actually ran and exited non-zero; defaults to 1 (drifting-like,
// non-blocking) for the rare case where execSync fails before/without an exit
// code (e.g. spawn failure) — only an explicit exit 2 should ever skip the
// session commit. Existing callers only read `.ok`/`.output`/`.code`, all of
// which keep their prior shape and meaning — this is an additive change.
function runValidator() {
  try {
    const result = execSync(`node "${VALIDATOR}" "${ROOT}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, code: 0, output: result };
  } catch (err) {
    const code = typeof err.status === 'number' ? err.status : 1;
    return { ok: false, code, output: err.stdout || err.message };
  }
}

function updateProcessStateJson(nextAction, waveComplete, summaryValue, { summaryKey = 'wave_goal', explicitNextAction = false, waveSummary } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let current = {};
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      current = JSON.parse(readUtf8(PROCESS_STATE_JSON));
    }
  } catch { /* start fresh */ }

  // Clean stale active_slices: remove tasks that are qa_passed or merged in BACKLOG.md
  let activeSlices = Array.isArray(current.active_slices) ? current.active_slices : [];
  try {
    if (fs.existsSync(BACKLOG_MD)) {
      const backlogStatuses = parseBacklogStatuses(readUtf8(BACKLOG_MD));
      activeSlices = filterStaleSlices(activeSlices, backlogStatuses);
    }
  } catch { /* skip on error — leave active_slices unchanged */ }

  const currentWave = Number(current.wave) || 1;
  const newWave = waveComplete ? currentWave + 1 : currentWave;
  const prevWaveSession = Number(current.wave_session) || 1;
  // Reset wave_session to 1 when wave advances; otherwise increment
  const newWaveSession = waveComplete ? 1 : prevWaveSession + 1;

  // Priority logic for next_action:
  //   wave complete     → use computed (clears stale pointer when all done)
  //   explicit override → operator typed a value; always wins
  //   wave in progress  → preserve existing Main Agent value; fall back to computed
  let resolvedNextAction;
  if (waveComplete) {
    resolvedNextAction = nextAction || null;
  } else if (explicitNextAction) {
    resolvedNextAction = nextAction || null;
  } else {
    resolvedNextAction = current.next_action || nextAction || null;
  }

  const updated = {
    ...current,
    active_slices: activeSlices,
    next_action: resolvedNextAction,
    last_updated: today,
    wave: newWave,
    wave_session: newWaveSession,
    stage: waveComplete ? 'planning' : (current.stage || 'execution'),
    wave_strategy_note: null,
  };

  if (summaryValue !== undefined && summaryValue !== null) {
    updated[summaryKey] = summaryValue;
  }

  // T-367: optional secondary write — lets a caller populate `wave_summary`
  // alongside a primary summaryKey write (e.g. runInteractive writes
  // wave_goal via the default summaryKey but, on a wave-complete close,
  // also needs to write wave_summary in the same call — mirroring the
  // non-interactive contract that wave_summary is written automatically
  // at the end of each wave). No-op when omitted, so existing callers
  // (runNonInteractive passes summaryKey:'wave_summary' with no waveSummary
  // option; the pre-T-367 interactive call passed neither) are unaffected.
  if (waveSummary !== undefined && waveSummary !== null) {
    updated.wave_summary = waveSummary;
  }

  writeUtf8(PROCESS_STATE_JSON, JSON.stringify(updated, null, 2) + '\n');
  return { wave: updated.wave, wave_session: newWaveSession };
}

function tryGitPush() {
  try {
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function parseArgs(argv) {
  const args = {
    interactive: false,
    nonInteractive: false,
    summary: null,
    autoSummary: false,
    markMerged: [],
    push: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interactive') {
      args.interactive = true;
    } else if (argv[i] === '--non-interactive') {
      args.nonInteractive = true;
    } else if (argv[i] === '--summary' && argv[i + 1]) {
      args.summary = argv[++i];
    } else if (argv[i] === '--auto-summary') {
      args.autoSummary = true;
    } else if (argv[i] === '--mark-merged' && argv[i + 1]) {
      args.markMerged = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (argv[i] === '--push') {
      args.push = true;
    }
  }

  return args;
}

function resolveMode({ interactive, nonInteractive, isTTY } = {}) {
  if (interactive === true) return 'interactive';
  if (nonInteractive === true) return 'non-interactive';
  return isTTY === true ? 'interactive' : 'non-interactive';
}

/**
 * T-350: build the (non-blocking) advisory notice text printed when
 * --close-session preserves an existing next_action that carries volatile
 * facts (a copied framework version, unpushed-commit count, etc. with no
 * invalidation trigger). Pure — no I/O, no console output — so it can be
 * unit-tested directly without exercising the rest of runNonInteractive.
 *
 * @param {boolean} allMerged - whether the wave is complete (no preserve happens here)
 * @param {string|null} currentNextAction - the existing next_action being preserved
 * @returns {string|null} the notice text, or null when no notice should print
 */
function buildVolatileNextActionNotice(allMerged, currentNextAction) {
  if (allMerged || !currentNextAction) return null;
  const { volatile_facts } = classifyNextAction(currentNextAction);
  if (volatile_facts.length === 0) return null;
  return `NOTE: preserving freeform next_action with volatile facts (${volatile_facts.join(', ')}) — move narrative to HANDOFF.md; keep next_action a directive`;
}

/**
 * T-445: build the explicit wave-completion announcement line, unified across
 * both interactive and non-interactive close-session runs so the same state
 * (e.g. an empty Active tasks section) always produces the same decision AND
 * the same visible message. On completion, names the wave being archived +
 * incremented. When the wave stays open, names the specific task(s) still
 * blocking completion so "wave stays open" is never a silent, unexplained
 * no-op — pure function, no I/O, unit-testable directly.
 *
 * @param {boolean} waveComplete - whether every task has left the Active tasks section
 * @param {number} sessionWave - the wave number being evaluated (not yet incremented)
 * @param {Array<{id: string, status: string}>} remainingTasks - tasks still in the Active tasks section
 * @returns {string} the announcement line (no color codes — caller wraps in color)
 */
function buildWaveCompletionAnnouncement(waveComplete, sessionWave, remainingTasks) {
  if (waveComplete) {
    return `Wave ${sessionWave} complete — archiving + incrementing`;
  }
  const reasons = remainingTasks.map(t => `${t.id} still ${t.status}`).join(', ');
  return `Wave ${sessionWave} stays open — ${reasons}`;
}

/**
 * T-559: build the one-line worktree-hygiene advisory printed by both
 * --close-session modes — total worktree count and per-class counts, from
 * the SAME classifyWorktrees()/formatWorktreeHygieneAdvisory() implementation
 * the `--worktree-report` and `--prune-worktrees` flags use, so all three
 * surfaces can never disagree. Fires only when `<root>/.claude/worktrees`
 * exists and is non-empty — never prunes anything itself, purely advisory.
 * Degrades to null (no line printed) when the directory is absent/empty or
 * classification fails for any reason (e.g. `root` isn't a git repo) — EXCEPT
 * an unresolvable `mainRef` (T-633), which degrades to a single line naming
 * the unresolved ref instead of silently going quiet: close-session must
 * complete either way (never throw here), but "nothing to report" and "the
 * classifier couldn't check" are different facts and must read differently.
 *
 * @param {string} root - project root (ROOT — may differ from the mavericks
 *   installation for bootstrapped projects).
 * @returns {string|null}
 */
function buildWorktreeHygieneAdvisory(root) {
  try {
    const worktreesDir = path.join(root, '.claude', 'worktrees');
    if (!fs.existsSync(worktreesDir)) return null;
    const contents = fs.readdirSync(worktreesDir);
    if (contents.length === 0) return null;
    const entries = classifyWorktrees(root);
    if (entries.length === 0) return null;
    return formatWorktreeHygieneAdvisory(entries);
  } catch (err) {
    if (err instanceof UnresolvableMainRefError) {
      return `Worktree hygiene: unable to classify — mainRef '${err.mainRef}' does not resolve to a commit (see --worktree-report --main-ref)`;
    }
    return null;
  }
}

async function runNonInteractive(args) {
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n${BOLD}MavP Close Session${RESET} ${DIM}${today}${RESET} ${DIM}[non-interactive]${RESET}\n`);

  const taskStatusContent = readUtf8(TASK_STATUS_MD);
  const activeTasks = parseActiveTasks(taskStatusContent);

  if (activeTasks.length) {
    console.log(`${BOLD}Active tasks:${RESET}`);
    activeTasks.forEach(t => console.log(`  ${t.id} — ${t.title} ${DIM}[${t.status}]${RESET}`));
    console.log('');
  }

  // Warn on tasks in dev_done or qa_passed with no Evidence recorded
  const noEvidenceTasks = findTasksWithNoEvidence(taskStatusContent);
  if (noEvidenceTasks.length > 0) {
    for (const t of noEvidenceTasks) {
      console.log(`${YELLOW}WARN: ${t.id} (${t.status}) — no evidence recorded${RESET}`);
    }
    console.log('');
  }

  // T-559: worktree-hygiene advisory — informational only, never prunes.
  {
    const worktreeAdvisory = buildWorktreeHygieneAdvisory(ROOT);
    if (worktreeAdvisory) {
      console.log(`${DIM}${worktreeAdvisory}${RESET}`);
      console.log('');
    }
  }

  let updatedContent = taskStatusContent;

  // Read current wave/wave_session and existing next_action before any mutation.
  // T-438: read early (before the BACKLOG.md sync below) so the symmetric
  // archival step can use the CURRENT (not-yet-incremented) wave number.
  let sessionWave = 1;
  let sessionNumber = 1;
  let currentNextAction = null;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      sessionWave = Number(ps.wave) || 1;
      sessionNumber = Number(ps.wave_session) || 1;
      currentNextAction = ps.next_action || null;
    }
  } catch { /* use defaults */ }

  // T-438: tasks merged this run, tracked with their final status so BACKLOG.md
  // can be synced symmetrically (see syncBacklogMergedTasks doc comment).
  const mergedTaskRecords = [];

  // Apply --mark-merged
  for (const taskId of args.markMerged) {
    const task = activeTasks.find(t => t.id === taskId);
    if (!task) {
      console.log(`${YELLOW}⚠ ${taskId} not found in active tasks — skipping${RESET}`);
      continue;
    }
    updatedContent = updateTaskStatusField(updatedContent, taskId, 'Status', 'merged');
    updatedContent = updateTaskStatusField(updatedContent, taskId, 'Notes', `Completed ${today}.`);
    updatedContent = moveTaskToCompleted(updatedContent, taskId);
    mergedTaskRecords.push({ id: taskId, status: 'merged' });
    console.log(`  ${GREEN}✓ ${taskId} → merged${RESET}`);
  }

  // Also move any tasks that were already merged before --close-session was called
  const alreadyHandled = new Set(args.markMerged);
  for (const task of activeTasks) {
    if (ALREADY_TERMINAL_STATUSES.has(task.status) && !alreadyHandled.has(task.id)) {
      updatedContent = moveTaskToCompleted(updatedContent, task.id);
      mergedTaskRecords.push({ id: task.id, status: task.status });
      console.log(`  ${GREEN}✓ ${task.id} → moved to completed (was already ${task.status})${RESET}`);
      alreadyHandled.add(task.id);
    }
  }

  // T-573: sweep deferred/deprecated entries out of Active tasks. Runs BEFORE
  // remainingTasks is computed below, so wave completion is derived from
  // post-sweep content. Swept ids are deliberately NOT added to
  // mergedTaskRecords — see sweepTerminalSkipTasks()'s doc comment.
  {
    const swept = sweepTerminalSkipTasks(updatedContent, activeTasks, alreadyHandled);
    updatedContent = swept.content;
  }

  // Write TASK_STATUS.md
  writeUtf8(TASK_STATUS_MD, updatedContent);
  console.log(`${GREEN}✓ TASK_STATUS.md updated${RESET}`);

  // T-438: mirror the merge into BACKLOG.md — set Status + archive the block
  // out of Active Wave, so BACKLOG.md and TASK_STATUS.md never fall out of
  // sync mid-wave (see syncBacklogMergedTasks doc comment above).
  syncBacklogMergedTasks(mergedTaskRecords, sessionWave);

  // Compute remaining tasks and the auto-computed next_action suggestion
  const remainingTasks = parseActiveTasks(updatedContent);
  let nextAction = null;
  if (remainingTasks.length > 0) {
    const first = remainingTasks[0];
    nextAction = `${first.id} → developer → ${first.title}`;
  }

  const allMerged = remainingTasks.length === 0;

  // T-445: explicit wave-completion announcement — unified with the
  // interactive path via buildWaveCompletionAnnouncement() so identical state
  // always produces identical messaging in both modes.
  {
    const announcement = buildWaveCompletionAnnouncement(allMerged, sessionWave, remainingTasks);
    console.log(`${allMerged ? `${CYAN}${BOLD}` : YELLOW}${announcement}${RESET}`);
  }

  // Resolved next_action: preserve existing Main Agent value when wave is still open
  const resolvedNextAction = allMerged
    ? (nextAction || null)
    : (currentNextAction || nextAction || null);

  // T-350: when we preserved an existing next_action (rather than the freshly
  // computed one) and that preserved value carries volatile facts (a copied
  // framework version, unpushed-commit count, etc. with no invalidation
  // trigger), print a one-line advisory. Non-blocking — no behavior/exit-code
  // change; the value is still preserved as before.
  const volatileNextActionNotice = buildVolatileNextActionNotice(allMerged, currentNextAction);
  if (volatileNextActionNotice) {
    console.log(`${YELLOW}${volatileNextActionNotice}${RESET}`);
  }

  // Compute summary: explicit --summary wins, otherwise auto-generate — but only once the wave is
  // actually complete (T-361). Auto-generating on a mid-wave close would clobber the prior wave's
  // summary with a partial one; explicit --summary is exempt from this gate and may still always
  // write, regardless of wave completion.
  //
  // T-366: this function (runNonInteractive) is only ever reached via the non-interactive path
  // resolved by resolveMode() — including the flagless, non-TTY (agent Bash) case where no explicit
  // --non-interactive flag is passed. Gating on args.autoSummary / args.nonInteractive here was wrong:
  // those reflect the CLI flag, not the resolved mode, so a flagless non-TTY close left the gate false
  // and the stale wave_summary was silently preserved. Auto-summary is now the unconditional
  // non-interactive default; args.autoSummary is still parsed for CLI backward compat but is a no-op
  // in this condition.
  let effectiveSummary = args.summary;

  if (!effectiveSummary && allMerged) {
    // Auto-generate from merged/deployed tasks in BACKLOG.md's Active Wave section (the wave being
    // closed right now) — not TASK_STATUS.md's `## Recently completed tasks` section, which
    // accumulates every wave back to Wave 1 and would make the summary grow without bound.
    const backlogContentForSummary = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
    // T-420: pass sessionWave so titles archived mid-wave via --archive-merged
    // (moved out of Active Wave into "## Wave <N> — Archived (mid-wave)")
    // are still included in the wave-complete summary.
    const mergedTitles = parseActiveWaveMergedTitles(backlogContentForSummary, sessionWave);
    effectiveSummary = buildAutoSummary(sessionWave, mergedTitles);
  }

  // T-438: run the validator BEFORE any PROCESS_STATE.json mutation. A blocked
  // (exit 2) close must leave PROCESS_STATE.json byte-for-byte unchanged —
  // otherwise wave/wave_session would already be bumped, and a subsequent
  // repair-and-retry run would bump them a second time (double-bump bug).
  // Narrow exception: sync active_slices first (see syncActiveSlicesPreValidator
  // doc comment) so a task just merged/archived doesn't trip a false
  // active_slices_mismatch warning.
  syncActiveSlicesPreValidator();
  console.log(`\n${BOLD}Running validator...${RESET}`);
  const validatorResult = runValidator();
  if (validatorResult.ok) {
    console.log(`${GREEN}✓ Validator passed — artifacts in sync${RESET}`);
  } else {
    console.log(`${RED}✗ Validator issues (exit ${validatorResult.code}):${RESET}`);
    console.log(validatorResult.output);
  }

  if (validatorResult.code === 2) {
    console.log(`${RED}✗ PROCESS_STATE mutation SKIPPED — validator exit 2 (repair required); state left unchanged, re-run --close-session after repair${RESET}`);
  } else {
    // Update legacy PROCESS_STATE.md using resolved value (will be overwritten by
    // generateProcessStateMd below; kept for any edge-case where JSON update fails)
    if (fs.existsSync(PROCESS_STATE_MD)) {
      const processContent = readUtf8(PROCESS_STATE_MD);
      writeUtf8(PROCESS_STATE_MD, updateProcessState(processContent, resolvedNextAction));
      console.log(`${GREEN}✓ PROCESS_STATE.md updated${RESET}`);
    }

    const { wave: newWave } = updateProcessStateJson(nextAction, allMerged, effectiveSummary, { summaryKey: 'wave_summary' });
    console.log(`${GREEN}✓ PROCESS_STATE.json updated${allMerged ? ` — wave → ${newWave}` : ''}${RESET}`);

    // Archive Active Wave heading in BACKLOG.md when wave is complete
    if (allMerged) {
      const closedWaveNumber = newWave - 1;
      const archiveResult = archiveActiveWaveInBacklog(BACKLOG_MD, closedWaveNumber);
      if (!archiveResult.ok) {
        console.log(`${YELLOW}⚠ BACKLOG.md wave archive warning:${RESET}\n${archiveResult.warning}`);
      } else if (archiveResult.archived) {
        console.log(`${GREEN}✓ BACKLOG.md — Wave ${closedWaveNumber} heading archived${RESET}`);
      } else if (archiveResult.warning) {
        console.log(`${YELLOW}⚠ ${archiveResult.warning}${RESET}`);
      }
    }

    // Regenerate PROCESS_STATE.md from JSON
    generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);
    console.log(`${GREEN}✓ PROCESS_STATE.md regenerated from JSON${RESET}`);

    if (effectiveSummary) {
      console.log(`  ${DIM}wave_summary written: ${effectiveSummary}${RESET}`);
    }
  }

  // Commit all tracked changes unless the validator requires repair (exit 2).
  // T-431: the commit gate is aligned with the pre-commit hook contract
  // (.claude/hooks/pre-commit) where only exit 2 blocks — exit 0 (healthy)
  // and exit 1 (drifting/warnings-only) both still produce a session commit.
  // Only an explicit exit 2 skips the commit, and it prints an unambiguous
  // "session commit SKIPPED" line so a silent skip (the T-431 bug) can never
  // happen again.
  if (validatorResult.code === 2) {
    console.log(`${RED}✗ session commit SKIPPED — validator exit 2 (repair required); commit manually after repair${RESET}`);
  } else {
    try {
      execSync('git -C "' + ROOT + '" add -u', { stdio: 'pipe' });
      const today = new Date().toISOString().slice(0, 10);
      execSync('git -C "' + ROOT + '" commit -m "chore: close session ' + today + '"', { stdio: 'pipe' });
      console.log(`${GREEN}✓ Session changes committed${RESET}`);
    } catch (e) {
      // Nothing to commit is fine — git exits non-zero with "nothing to commit"
      const msg = e.stdout ? e.stdout.toString() : '';
      if (msg.includes('nothing to commit') || msg.includes('nothing added')) {
        console.log(`${DIM}  (no uncommitted changes to commit)${RESET}`);
      } else {
        console.log(`${YELLOW}⚠ git commit skipped: ${msg.trim() || e.message}${RESET}`);
      }
    }
  }

  // Build list of tasks completed this session:
  //   - tasks explicitly marked merged via --mark-merged
  //   - tasks already merged before --close-session ran
  //   - tasks at qa_passed or dev_done (work done this session, not yet merged)
  const alreadyMergedActive = activeTasks.filter(t => t.status === 'merged').map(t => t.id);
  const sessionMergedIds = [...new Set([...args.markMerged, ...alreadyMergedActive])];
  sessionMergedIds.sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));

  const advancedIds = activeTasks
    .filter(t => t.status === 'qa_passed' || t.status === 'dev_done')
    .map(t => t.id);
  const sessionCompletedIds = [...sessionMergedIds];
  for (const id of advancedIds) {
    if (!sessionCompletedIds.includes(id)) sessionCompletedIds.push(id);
  }

  // T-420: union in tasks archived mid-wave via --archive-merged (moved out
  // of TASK_STATUS.md's "## Active tasks" already, so they no longer appear
  // in `activeTasks` above) so their evidence/repo still surface in the
  // results table. Scoped to the currently open wave number — the mid-wave
  // archive heading for a wave only exists while that wave is open.
  const backlogContentForArchiveUnion = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
  const midWaveArchivedTasks = parseMidWaveArchivedTasks(backlogContentForArchiveUnion, sessionWave);
  for (const t of midWaveArchivedTasks) {
    if (t.id && !sessionCompletedIds.includes(t.id)) sessionCompletedIds.push(t.id);
  }

  // Read deploy_contours for deploy status column
  let deployContours = 0;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      deployContours = ps.deploy_contours != null ? Number(ps.deploy_contours) : 0;
    }
  } catch { /* use default */ }

  // Print completed table BEFORE any push prompt/attempt — mandatory pre-push
  // review artifact (omitted when no tasks completed this session).
  const finalStatusMap = buildTaskStatusMap(updatedContent, sessionCompletedIds);
  const backlogContent = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
  printSessionCompletedTable(sessionCompletedIds, updatedContent, backlogContent, deployContours, finalStatusMap, ROOT);

  // Wave complete: push (if --push flag set) or print reminder — runs AFTER
  // commit AND after the results table above. Under bypassPermissions, --push
  // is ignored entirely and an explicit gate message is printed instead —
  // there must be no code path that pushes without a human between the table
  // and the push under bypass mode.
  if (allMerged) {
    if (args.push) {
      // Prefer a live runtime override persisted by the SessionStart hook
      // (see mavp-operator-agent.js — persistRuntimePermissionMode) over the
      // settings-file resolution, so a `--permission-mode bypassPermissions`
      // override is honored by the gate even when settings files say
      // otherwise. Falls back to readPermissionMode(ROOT) when no state
      // file is present — unchanged T-320 behavior.
      const permissionMode = readPersistedPermissionMode(ROOT) || readPermissionMode(ROOT);
      if (permissionMode === 'bypassPermissions') {
        console.log(`\n${YELLOW}${BOLD}push suppressed under bypassPermissions${RESET} — review the results above, then run \`git push\` yourself.`);
      } else {
        console.log('');
        const pushed = tryGitPush();
        if (pushed) {
          console.log(`${GREEN}✓ Pushed${RESET}`);
        } else {
          console.log(`${YELLOW}⚠ Push failed or skipped — push manually if needed${RESET}`);
        }
      }
    } else {
      console.log(`\n${CYAN}${BOLD}Wave complete — run \`git push\` to close the wave${RESET}`);
    }
  }

  // Version bump warning — T-530: release-aware (see classifyVersionBumpAdvisory()).
  const versionDrift = checkVersionBump();
  if (versionDrift && versionDrift.kind === 'bump') {
    console.log(`\n${VERSION_BUMP_LINE}`);
  } else if (versionDrift && versionDrift.kind === 'unreleased') {
    console.log(`\n${VERSION_UNRELEASED_LINE}`);
  }

  // Deploy queue warning — informational only, does not block session close
  const deployedDevCount = countTasksByStatus(updatedContent, 'deployed_dev');
  if (deployedDevCount > 0) {
    console.log(`\n${YELLOW}⚠ ${deployedDevCount} task(s) in deploy_queue awaiting prod promotion${RESET}`);
  }

  console.log(`${BOLD}Session closed.${RESET}`);

  // Emit RENAME_SESSION line for /rename command
  const renameLabel = buildRenameLabel(sessionWave, sessionNumber, sessionMergedIds);
  console.log(`\nRENAME_SESSION: ${renameLabel}\n`);
}

async function runInteractive() {
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n${BOLD}MavP Close Session${RESET} ${DIM}${today}${RESET}\n`);

  // Read wave_goal from PROCESS_STATE.json and show/prompt
  let currentWaveGoal = null;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      currentWaveGoal = ps.wave_goal != null ? ps.wave_goal : null;
    }
  } catch { /* ignore */ }

  if (currentWaveGoal) {
    console.log(`Wave goal: ${currentWaveGoal}\n`);
  }

  const taskStatusContent = readUtf8(TASK_STATUS_MD);
  const activeTasks = parseActiveTasks(taskStatusContent);

  if (!activeTasks.length) {
    console.log(`${GREEN}No active tasks. Nothing to close.${RESET}\n`);
  } else {
    console.log(`${BOLD}Active tasks:${RESET}`);
    activeTasks.forEach(t => console.log(`  ${t.id} — ${t.title} ${DIM}[${t.status}]${RESET}`));
    console.log('');
  }

  // Warn on tasks in dev_done or qa_passed with no Evidence recorded
  const noEvidenceTasks = findTasksWithNoEvidence(taskStatusContent);
  if (noEvidenceTasks.length > 0) {
    for (const t of noEvidenceTasks) {
      console.log(`${YELLOW}WARN: ${t.id} (${t.status}) — no evidence recorded${RESET}`);
    }
    console.log('');
  }

  // T-559: worktree-hygiene advisory — informational only, never prunes.
  {
    const worktreeAdvisory = buildWorktreeHygieneAdvisory(ROOT);
    if (worktreeAdvisory) {
      console.log(`${DIM}${worktreeAdvisory}${RESET}`);
      console.log('');
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Read current wave/wave_session up front — needed for the wave-completion
  // announcement below and for the RENAME_SESSION label later. T-445: moved
  // earlier from its former location (after rl.close()) so both uses share
  // one read.
  let sessionWave = 1;
  let sessionNumber = 1;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      sessionWave = Number(ps.wave) || 1;
      sessionNumber = Number(ps.wave_session) || 1;
    }
  } catch { /* use defaults */ }

  let updatedContent = taskStatusContent;
  const sessionMergedIds = [];
  // T-438: tasks merged this run, tracked with their final status so BACKLOG.md
  // can be synced symmetrically (see syncBacklogMergedTasks doc comment).
  const mergedTaskRecords = [];

  // T-445: tasks already at a terminal completed status (merged/deployed_dev/
  // deployed_prod) when the loop starts are auto-archived without prompting —
  // mirrors runNonInteractive's "already merged before --close-session was
  // called" block below. Previously these were asked the same
  // [m]/[n]/[k]/[enter] question as any other active task, and Enter-skipping
  // one left its already-merged status untouched in the Active tasks section,
  // which then counted as "remaining" and silently blocked wave completion.
  // Deliberately NOT derived from IN_FLIGHT_STATUSES (T-525) — see
  // ALREADY_TERMINAL_STATUSES's doc comment above, which is the shared
  // definition this path and runNonInteractive both use (T-573 unified them).
  const alreadyTerminalTasks = activeTasks.filter(t => ALREADY_TERMINAL_STATUSES.has(t.status));
  for (const task of alreadyTerminalTasks) {
    updatedContent = moveTaskToCompleted(updatedContent, task.id);
    mergedTaskRecords.push({ id: task.id, status: task.status });
    console.log(`  ${GREEN}✓ ${task.id} → moved to completed (was already ${task.status})${RESET}`);
  }

  // T-573: sweep deferred/deprecated entries out of Active tasks — same
  // contract as runNonInteractive's sweep (relocate only; never fed to
  // mergedTaskRecords), so identical state closes identically in both modes.
  {
    const swept = sweepTerminalSkipTasks(updatedContent, activeTasks);
    updatedContent = swept.content;
  }

  for (const task of activeTasks) {
    // T-573: a swept deferred/deprecated entry is terminal — never prompt for
    // it. Prompting would offer [m]erged on a task that was explicitly NOT
    // done, and an Enter-skip would leave it counted as remaining work.
    if (ALREADY_TERMINAL_STATUSES.has(task.status) || TERMINAL_SKIP_STATUSES.has(task.status)) continue;
    const answer = await prompt(rl, `${BOLD}${task.id}${RESET} — ${task.title}\n  [m]erged / [n]eeds_fix / [k]eep / [enter] skip: `);
    const choice = answer.trim().toLowerCase();

    if (choice === 'm' || choice === 'merged') {
      const notesAnswer = await prompt(rl, `  Notes (optional, enter to skip): `);
      const notes = notesAnswer.trim() || `Completed ${today}.`;
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Status', 'merged');
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Notes', notes);
      updatedContent = moveTaskToCompleted(updatedContent, task.id);
      sessionMergedIds.push(task.id);
      mergedTaskRecords.push({ id: task.id, status: 'merged' });
      console.log(`  ${GREEN}✓ ${task.id} → merged${RESET}\n`);
    } else if (choice === 'n' || choice === 'needs_fix') {
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Status', 'needs_fix');
      console.log(`  ${YELLOW}⚠ ${task.id} → needs_fix${RESET}\n`);
    } else {
      console.log(`  ${DIM}skipped${RESET}\n`);
    }
  }

  // Compute next action + wave-completion decision from remaining active
  // tasks. T-445: unified with runNonInteractive — wave completion is purely
  // "no tasks remain in the Active tasks section", not a separately tracked
  // flag that could diverge from that same computation (the former
  // `allMerged` seeded false whenever any task existed and stayed false
  // forever on any skip/needs_fix, so the identical empty-Active-tasks state
  // completed the wave non-interactively but never interactively).
  const remainingTasks = parseActiveTasks(updatedContent);
  const waveComplete = remainingTasks.length === 0;
  let nextAction = null;
  if (remainingTasks.length > 0) {
    const first = remainingTasks[0];
    nextAction = `${first.id} → developer → ${first.title}`;
  }

  // T-445: explicit wave-completion announcement — shares
  // buildWaveCompletionAnnouncement() with runNonInteractive so identical
  // state always produces identical messaging in both modes.
  {
    const announcement = buildWaveCompletionAnnouncement(waveComplete, sessionWave, remainingTasks);
    console.log(`${waveComplete ? `${CYAN}${BOLD}` : YELLOW}${announcement}${RESET}\n`);
  }

  const nextAnswer = await prompt(rl, `Next action [${nextAction || 'wave complete'}]: `);
  const operatorExplicit = nextAnswer.trim().length > 0;
  if (operatorExplicit) nextAction = nextAnswer.trim();

  // Prompt for wave_goal if not already set
  let waveGoalToSave = undefined;
  if (!currentWaveGoal) {
    const goalAnswer = await prompt(rl, `Enter wave goal (or press Enter to skip): `);
    const trimmed = goalAnswer.trim();
    if (trimmed) waveGoalToSave = trimmed;
  }

  rl.close();

  // Write artifacts
  writeUtf8(TASK_STATUS_MD, updatedContent);
  console.log(`${GREEN}✓ TASK_STATUS.md updated${RESET}`);

  // sessionWave/sessionNumber were already read earlier (needed for the
  // wave-completion announcement); reused here for BACKLOG.md sync and later
  // for the RENAME_SESSION label. waveComplete was likewise already computed
  // above alongside remainingTasks — see the T-445 comment there.

  // T-438: mirror the merge into BACKLOG.md — set Status + archive the block
  // out of Active Wave, so BACKLOG.md and TASK_STATUS.md never fall out of
  // sync mid-wave (see syncBacklogMergedTasks doc comment above).
  syncBacklogMergedTasks(mergedTaskRecords, sessionWave);

  // T-367: on a wave-complete interactive close, also compute the scoped
  // wave_summary (mirrors the non-interactive T-361/T-366 contract) so
  // "wave_summary is written automatically... at the end of each wave"
  // holds for interactive closes too. Read BACKLOG.md's Active Wave content
  // now, BEFORE archiveActiveWaveInBacklog() renames the heading below —
  // parseActiveWaveMergedTitles() only matches a live "## Active Wave"
  // heading. A mid-wave (non-complete) close must not touch wave_summary,
  // so this is left undefined otherwise and updateProcessStateJson() skips
  // the write, preserving whatever value is already on disk.
  let autoWaveSummary;
  if (waveComplete) {
    const backlogContentForSummary = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
    // T-420: pass sessionWave so titles archived mid-wave via --archive-merged
    // are still included in the wave-complete summary.
    const mergedTitles = parseActiveWaveMergedTitles(backlogContentForSummary, sessionWave);
    autoWaveSummary = buildAutoSummary(sessionWave, mergedTitles);
  }

  // T-438: run the validator BEFORE any PROCESS_STATE.json mutation. A blocked
  // (exit 2) close must leave PROCESS_STATE.json byte-for-byte unchanged —
  // otherwise wave/wave_session would already be bumped, and a subsequent
  // repair-and-retry run would bump them a second time (double-bump bug).
  // Narrow exception: sync active_slices first (see syncActiveSlicesPreValidator
  // doc comment) so a task just merged/archived doesn't trip a false
  // active_slices_mismatch warning.
  syncActiveSlicesPreValidator();
  console.log(`\n${BOLD}Running validator...${RESET}`);
  const validatorResult = runValidator();
  if (validatorResult.ok) {
    console.log(`${GREEN}✓ Validator passed — artifacts in sync${RESET}`);
  } else {
    console.log(`${RED}✗ Validator issues (exit ${validatorResult.code}):${RESET}`);
    console.log(validatorResult.output);
  }

  if (validatorResult.code === 2) {
    console.log(`${RED}✗ PROCESS_STATE mutation SKIPPED — validator exit 2 (repair required); state left unchanged, re-run --close-session after repair${RESET}`);
  } else {
    const { wave: newWave } = updateProcessStateJson(nextAction, waveComplete, waveGoalToSave, { explicitNextAction: operatorExplicit, waveSummary: autoWaveSummary });
    console.log(`${GREEN}✓ PROCESS_STATE.json updated${waveComplete ? ` — wave → ${newWave}` : ''}${RESET}`);
    if (autoWaveSummary) {
      console.log(`  ${DIM}wave_summary written: ${autoWaveSummary}${RESET}`);
    }

    // Archive Active Wave heading in BACKLOG.md when wave is complete
    if (waveComplete) {
      const closedWaveNumber = newWave - 1;
      const archiveResult = archiveActiveWaveInBacklog(BACKLOG_MD, closedWaveNumber);
      if (!archiveResult.ok) {
        console.log(`${YELLOW}⚠ BACKLOG.md wave archive warning:${RESET}\n${archiveResult.warning}`);
      } else if (archiveResult.archived) {
        console.log(`${GREEN}✓ BACKLOG.md — Wave ${closedWaveNumber} heading archived${RESET}`);
      } else if (archiveResult.warning) {
        console.log(`${YELLOW}⚠ ${archiveResult.warning}${RESET}`);
      }
    }

    // Regenerate PROCESS_STATE.md from JSON
    generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);
    console.log(`${GREEN}✓ PROCESS_STATE.md regenerated from JSON${RESET}`);
  }

  // Commit all tracked changes unless the validator requires repair (exit 2).
  // T-431: the commit gate is aligned with the pre-commit hook contract
  // (.claude/hooks/pre-commit) where only exit 2 blocks — exit 0 (healthy)
  // and exit 1 (drifting/warnings-only) both still produce a session commit.
  // Only an explicit exit 2 skips the commit, and it prints an unambiguous
  // "session commit SKIPPED" line so a silent skip (the T-431 bug) can never
  // happen again.
  if (validatorResult.code === 2) {
    console.log(`${RED}✗ session commit SKIPPED — validator exit 2 (repair required); commit manually after repair${RESET}`);
  } else {
    try {
      execSync('git -C "' + ROOT + '" add -u', { stdio: 'pipe' });
      const today = new Date().toISOString().slice(0, 10);
      execSync('git -C "' + ROOT + '" commit -m "chore: close session ' + today + '"', { stdio: 'pipe' });
      console.log(`${GREEN}✓ Session changes committed${RESET}`);
    } catch (e) {
      // Nothing to commit is fine — git exits non-zero with "nothing to commit"
      const msg = e.stdout ? e.stdout.toString() : '';
      if (msg.includes('nothing to commit') || msg.includes('nothing added')) {
        console.log(`${DIM}  (no uncommitted changes to commit)${RESET}`);
      } else {
        console.log(`${YELLOW}⚠ git commit skipped: ${msg.trim() || e.message}${RESET}`);
      }
    }
  }

  // Version bump warning — T-530: release-aware (see classifyVersionBumpAdvisory()).
  const versionDrift = checkVersionBump();
  if (versionDrift && versionDrift.kind === 'bump') {
    console.log(`\n${VERSION_BUMP_LINE}`);
  } else if (versionDrift && versionDrift.kind === 'unreleased') {
    console.log(`\n${VERSION_UNRELEASED_LINE}`);
  }

  // Deploy queue warning — informational only, does not block session close
  const deployedDevCount = countTasksByStatus(updatedContent, 'deployed_dev');
  if (deployedDevCount > 0) {
    console.log(`\n${YELLOW}⚠ ${deployedDevCount} task(s) in deploy_queue awaiting prod promotion${RESET}`);
  }

  // Build list of tasks completed this session:
  //   - tasks the operator marked merged during the interactive loop
  //   - tasks already at qa_passed or dev_done (work done, not yet promoted)
  sessionMergedIds.sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));

  const advancedIds = activeTasks
    .filter(t => t.status === 'qa_passed' || t.status === 'dev_done')
    .map(t => t.id);
  const sessionCompletedIds = [...sessionMergedIds];
  for (const id of advancedIds) {
    if (!sessionCompletedIds.includes(id)) sessionCompletedIds.push(id);
  }

  // T-420: union in tasks archived mid-wave via --archive-merged (see the
  // matching comment in runNonInteractive above for the full rationale).
  const backlogContentForArchiveUnion = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
  const midWaveArchivedTasks = parseMidWaveArchivedTasks(backlogContentForArchiveUnion, sessionWave);
  for (const t of midWaveArchivedTasks) {
    if (t.id && !sessionCompletedIds.includes(t.id)) sessionCompletedIds.push(t.id);
  }

  // Read deploy_contours for deploy status column
  let deployContours = 0;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      deployContours = ps.deploy_contours != null ? Number(ps.deploy_contours) : 0;
    }
  } catch { /* use default */ }

  // Print completed table BEFORE the "Run git push?" prompt — the table is
  // the mandatory pre-push review artifact the human sees before authorizing
  // push (omitted when no tasks completed this session).
  const finalStatusMap = buildTaskStatusMap(updatedContent, sessionCompletedIds);
  const backlogContent = fs.existsSync(BACKLOG_MD) ? readUtf8(BACKLOG_MD) : '';
  printSessionCompletedTable(sessionCompletedIds, updatedContent, backlogContent, deployContours, finalStatusMap, ROOT);

  // Wave complete → prompt git push. The [Y/n] prompt IS the human
  // authorization — valid because the results table above already printed.
  if (waveComplete) {
    console.log(`\n${CYAN}${BOLD}Wave complete.${RESET} All tasks merged.`);
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const pushAnswer = await new Promise(resolve => rl2.question(`Run git push? [Y/n]: `, resolve));
    rl2.close();

    if (pushAnswer.trim().toLowerCase() !== 'n') {
      console.log('');
      const pushed = tryGitPush();
      if (pushed) {
        console.log(`${GREEN}✓ Pushed${RESET}`);
      } else {
        console.log(`${YELLOW}⚠ Push failed or skipped — push manually if needed${RESET}`);
      }
    } else {
      console.log(`${DIM}Push skipped — remember to push before closing the wave${RESET}`);
    }
  }

  console.log(`${BOLD}Session closed.${RESET}`);

  // Emit RENAME_SESSION line for /rename command
  const renameLabel = buildRenameLabel(sessionWave, sessionNumber, sessionMergedIds);
  console.log(`\nRENAME_SESSION: ${renameLabel}\n`);
}

async function main() {
  printRepoIdentityHeader(ROOT);

  const args = parseArgs(process.argv.slice(2));

  const mode = resolveMode({ interactive: args.interactive, nonInteractive: args.nonInteractive, isTTY: process.stdin.isTTY });
  if (mode === 'non-interactive') {
    await runNonInteractive(args);
  } else {
    await runInteractive();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`${RED}close-session failed: ${err.message}${RESET}`);
    process.exitCode = 1;
  });
}

module.exports = { moveTaskToCompleted, sweepTerminalSkipTasks, assertMergedRecordsUncontaminated, ALREADY_TERMINAL_STATUSES, parseActiveTasks, updateTaskStatusField, isTaskHeadingFor, headingLeadingTaskId, updateProcessStateJson, resolveMode, buildVolatileNextActionNotice, buildWaveCompletionAnnouncement, buildWorktreeHygieneAdvisory, runValidator, getDeployLabel, isCommitReachableFromRemote, resolveRemoteTrackingRef, printSessionCompletedTable, checkVersionBump, classifyVersionBumpAdvisory, readCurrentMavericksVersion, resolveMirrorTagsForVersionBump, VERSION_BUMP_LINE, VERSION_UNRELEASED_LINE, buildAutoSummary };
