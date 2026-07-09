#!/usr/bin/env node

/**
 * mavp-operator-close-session.js
 *
 * End-of-session ritual:
 * 1. Reads active tasks from TASK_STATUS.md
 * 2. Prompts operator to mark tasks as merged / needs_fix / keep
 * 3. Updates TASK_STATUS.md and PROCESS_STATE.md
 * 4. Runs parliamentary validator and reports health
 * 5. If all tasks merged (wave complete), prompts git push
 *
 * Usage:
 *   ./scripts/mavp-operator --close-session
 *   ./scripts/mavp-operator --close-session --non-interactive [--summary "text"] [--mark-merged T-001,T-002]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, spawnSync } = require('node:child_process');
const { generateProcessStateMd, archiveActiveWaveInBacklog, readPermissionMode, readPersistedPermissionMode } = require('./mavp-operator-lib');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
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
 * Parse merged task titles from ## Recently completed tasks section.
 * Used for auto-generating wave_summary.
 */
function parseMergedTaskTitles(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+Recently completed tasks/.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);

  const titles = [];
  for (const block of blocks) {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    if (headingMatch && statusMatch && statusMatch[1]?.trim() === 'merged') {
      titles.push(headingMatch[2]?.trim() || headingMatch[1]);
    }
  }
  return titles;
}

/**
 * Build an auto-generated wave_summary from merged task titles.
 * Format: "Wave N: <title1>, <title2>, ..."
 */
function buildAutoSummary(waveNumber, mergedTitles) {
  if (mergedTitles.length === 0) {
    return `Wave ${waveNumber}: no tasks recorded.`;
  }
  // Trim long titles to keep the summary readable
  const clipped = mergedTitles.map(t => t.length > 60 ? t.slice(0, 57) + '...' : t);
  return `Wave ${waveNumber}: ${clipped.join('; ')}.`;
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
 * Print a session-completed table for tasks that reached merged/qa_passed/dev_done
 * during this close-session run.
 *
 * @param {string[]} sessionCompletedIds   task IDs completed this session
 * @param {string}   taskStatusContent     final TASK_STATUS.md content (after updates)
 * @param {string}   backlogContent        BACKLOG.md content
 * @param {number}   deployContours        from PROCESS_STATE.json
 * @param {Map}      taskStatusMap         taskId -> final status (from TASK_STATUS)
 */
function printSessionCompletedTable(sessionCompletedIds, taskStatusContent, backlogContent, deployContours, taskStatusMap) {
  if (!sessionCompletedIds || sessionCompletedIds.length === 0) return;

  const evidenceMap = parseTasksEvidence(taskStatusContent, sessionCompletedIds);
  const repoMap = parseBacklogRepos(backlogContent, sessionCompletedIds);

  const COL_TASK = 28;
  const COL_COMMIT = 12;
  const COL_BRANCH = 10;

  function pad(str, len) {
    const s = String(str || '');
    return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
  }

  function deployLabel(taskId) {
    const status = taskStatusMap ? taskStatusMap.get(taskId) : null;
    if (deployContours === 0) return '✓ задеплоен';
    if (deployContours === 1) return '✓ авто-деплой';
    // deploy_contours >= 2
    if (status === 'merged') return '⏳ не запущен в прод';
    return '⏳ не смёрджен';
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
    const deploy = deployLabel(id);
    console.log(` ${pad(taskLabel, COL_TASK)}${pad(commitStr, COL_COMMIT)}${pad(branchStr, COL_BRANCH)}${deploy}`);
  }
  console.log('');
}

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

function updateTaskStatusField(markdown, taskId, field, value) {
  const lines = markdown.split(/\r?\n/);
  let inTask = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i])) {
      inTask = lines[i].includes(taskId + ' ') || lines[i].includes(taskId + ' —');
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
    if (/^###\s+/.test(lines[i]) && (lines[i].includes(taskId + ' ') || lines[i].includes(taskId + ' —'))) {
      taskStart = i;
    } else if (taskStart !== -1 && (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i]))) {
      taskEnd = i;
      break;
    }
  }

  if (taskStart === -1) return markdown;

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
 * Check whether scripts/ changed after the last version bump in mavp-version.js.
 * Returns a non-empty string (commit list) if a bump is needed, null otherwise.
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
    const changes = changesResult.stdout.trim();
    return changes || null;
  } catch {
    return null; // git unavailable or error — skip silently
  }
}

function runValidator() {
  try {
    const result = execSync(`node "${VALIDATOR}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: result };
  } catch (err) {
    return { ok: false, output: err.stdout || err.message, code: err.status };
  }
}

function updateProcessStateJson(nextAction, waveComplete, summaryValue, { summaryKey = 'wave_goal', explicitNextAction = false } = {}) {
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

  let updatedContent = taskStatusContent;

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
    console.log(`  ${GREEN}✓ ${taskId} → merged${RESET}`);
  }

  // Also move any tasks that were already merged before --close-session was called
  const alreadyHandled = new Set(args.markMerged);
  for (const task of activeTasks) {
    if ((task.status === 'merged' || task.status === 'deployed_dev' || task.status === 'deployed_prod') && !alreadyHandled.has(task.id)) {
      updatedContent = moveTaskToCompleted(updatedContent, task.id);
      console.log(`  ${GREEN}✓ ${task.id} → moved to completed (was already merged)${RESET}`);
    }
  }

  // Write TASK_STATUS.md
  writeUtf8(TASK_STATUS_MD, updatedContent);
  console.log(`${GREEN}✓ TASK_STATUS.md updated${RESET}`);

  // Compute remaining tasks and the auto-computed next_action suggestion
  const remainingTasks = parseActiveTasks(updatedContent);
  let nextAction = null;
  if (remainingTasks.length > 0) {
    const first = remainingTasks[0];
    nextAction = `${first.id} → developer → ${first.title}`;
  }

  const allMerged = remainingTasks.length === 0;

  // Read current wave/wave_session and existing next_action before incrementing
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

  // Resolved next_action: preserve existing Main Agent value when wave is still open
  const resolvedNextAction = allMerged
    ? (nextAction || null)
    : (currentNextAction || nextAction || null);

  // Update legacy PROCESS_STATE.md using resolved value (will be overwritten by
  // generateProcessStateMd below; kept for any edge-case where JSON update fails)
  if (fs.existsSync(PROCESS_STATE_MD)) {
    const processContent = readUtf8(PROCESS_STATE_MD);
    writeUtf8(PROCESS_STATE_MD, updateProcessState(processContent, resolvedNextAction));
    console.log(`${GREEN}✓ PROCESS_STATE.md updated${RESET}`);
  }

  // Compute summary: explicit --summary wins, then --auto-summary or auto-fallback in non-interactive mode
  let effectiveSummary = args.summary;

  if (!effectiveSummary && (args.autoSummary || args.nonInteractive)) {
    // Auto-generate from merged tasks in recently completed section
    const mergedTitles = parseMergedTaskTitles(updatedContent);
    effectiveSummary = buildAutoSummary(sessionWave, mergedTitles);
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

  // Run validator
  console.log(`\n${BOLD}Running validator...${RESET}`);
  const validatorResult = runValidator();
  if (validatorResult.ok) {
    console.log(`${GREEN}✓ Validator passed — artifacts in sync${RESET}`);
  } else {
    console.log(`${RED}✗ Validator issues (exit ${validatorResult.code}):${RESET}`);
    console.log(validatorResult.output);
  }

  // Commit all tracked changes after successful validator
  if (validatorResult.ok) {
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
  printSessionCompletedTable(sessionCompletedIds, updatedContent, backlogContent, deployContours, finalStatusMap);

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

  // Version bump warning
  const versionDrift = checkVersionBump();
  if (versionDrift) {
    console.log(`\n${YELLOW}⚠ scripts/ changed since last version bump — consider bumping scripts/mavp-version.js before git push${RESET}`);
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let updatedContent = taskStatusContent;
  let allMerged = activeTasks.length > 0;
  const sessionMergedIds = [];

  for (const task of activeTasks) {
    const answer = await prompt(rl, `${BOLD}${task.id}${RESET} — ${task.title}\n  [m]erged / [n]eeds_fix / [k]eep / [enter] skip: `);
    const choice = answer.trim().toLowerCase();

    if (choice === 'm' || choice === 'merged') {
      const notesAnswer = await prompt(rl, `  Notes (optional, enter to skip): `);
      const notes = notesAnswer.trim() || `Completed ${today}.`;
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Status', 'merged');
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Notes', notes);
      updatedContent = moveTaskToCompleted(updatedContent, task.id);
      sessionMergedIds.push(task.id);
      console.log(`  ${GREEN}✓ ${task.id} → merged${RESET}\n`);
    } else if (choice === 'n' || choice === 'needs_fix') {
      updatedContent = updateTaskStatusField(updatedContent, task.id, 'Status', 'needs_fix');
      console.log(`  ${YELLOW}⚠ ${task.id} → needs_fix${RESET}\n`);
      allMerged = false;
    } else {
      console.log(`  ${DIM}skipped${RESET}\n`);
      allMerged = false;
    }
  }

  // Compute next action from remaining active tasks
  const remainingTasks = parseActiveTasks(updatedContent);
  let nextAction = null;
  if (remainingTasks.length > 0) {
    const first = remainingTasks[0];
    nextAction = `${first.id} → developer → ${first.title}`;
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

  // Read current wave/wave_session before incrementing (for RENAME_SESSION label)
  let sessionWave = 1;
  let sessionNumber = 1;
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      sessionWave = Number(ps.wave) || 1;
      sessionNumber = Number(ps.wave_session) || 1;
    }
  } catch { /* use defaults */ }

  const waveComplete = allMerged && remainingTasks.length === 0;
  const { wave: newWave } = updateProcessStateJson(nextAction, waveComplete, waveGoalToSave, { explicitNextAction: operatorExplicit });
  console.log(`${GREEN}✓ PROCESS_STATE.json updated${waveComplete ? ` — wave → ${newWave}` : ''}${RESET}`);

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

  // Run validator
  console.log(`\n${BOLD}Running validator...${RESET}`);
  const validatorResult = runValidator();
  if (validatorResult.ok) {
    console.log(`${GREEN}✓ Validator passed — artifacts in sync${RESET}`);
  } else {
    console.log(`${RED}✗ Validator issues (exit ${validatorResult.code}):${RESET}`);
    console.log(validatorResult.output);
  }

  // Commit all tracked changes after successful validator
  if (validatorResult.ok) {
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

  // Version bump warning
  const versionDrift = checkVersionBump();
  if (versionDrift) {
    console.log(`\n${YELLOW}⚠ scripts/ changed since last version bump — consider bumping scripts/mavp-version.js before git push${RESET}`);
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
  printSessionCompletedTable(sessionCompletedIds, updatedContent, backlogContent, deployContours, finalStatusMap);

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

module.exports = { moveTaskToCompleted, updateProcessStateJson, resolveMode };
