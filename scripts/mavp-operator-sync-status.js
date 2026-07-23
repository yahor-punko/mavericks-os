#!/usr/bin/env node

/**
 * mavp-operator-sync-status.js
 *
 * Reads task statuses from BACKLOG.md (Active Wave section only) and updates
 * the matching `- **Status:**` lines in TASK_STATUS.md.
 *
 * Only touches `- **Status:**` lines and the task heading title — never
 * evidence blocks, Notes, or any other fields — EXCEPT for the auto-create
 * path (T-419): a BACKLOG Active Wave task that has no matching
 * TASK_STATUS.md Active-tasks entry gets a whole new skeleton entry created
 * (via the shared entry builder in mavp-operator-lib.js), completing the
 * mirror for creations the same way status updates were already mirrored.
 *
 * Heading-title mirror (T-432): when a BACKLOG heading title for a task
 * differs from its TASK_STATUS heading title, the TASK_STATUS heading is
 * rewritten to match BACKLOG's title (BACKLOG is the source of truth) —
 * clearing the title_mismatch validator warning that status-only sync could
 * never fix. Only the title portion of the heading is touched; the id and
 * separator are preserved as-is.
 *
 * Called automatically by the PostToolUse hook when BACKLOG.md is edited.
 * Also available as:
 *   ./scripts/mavp-operator --sync-status
 *
 * Exit 0 always — non-fatal.
 *
 * Output policy (hook silent-means-success compliance — T-418): no-op paths
 * (statuses already in sync, titles already in sync, no Active Wave
 * section/tasks to sync, no missing entries to create) emit NOTHING on
 * stdout or stderr — the PostToolUse hook surfaces any stderr output to the
 * agent as feedback, so a noisy no-op looks like an error on every
 * BACKLOG/TASK_STATUS edit. Only four categories write to stderr:
 *   1. Real errors — missing/unreadable files, parse/write exceptions.
 *   2. Actual status-sync mutations — one line per synced task, exactly:
 *      "sync-status: synced T-NNN: <old> -> <new>"
 *   3. Actual entry-creation mutations (T-419) — one line per created task,
 *      exactly: "sync-status: created T-NNN entry"
 *   4. Actual heading-title mutations (T-432) — one line per retitled task,
 *      exactly: "sync-status: retitled T-NNN"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildTaskStatusEntry, insertIntoActiveTasks } = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');

/**
 * Parse the Active Wave section of BACKLOG.md.
 * Returns a Map of { taskId (e.g. "T-123") → task info } where task info is:
 *   { status, title, ownerRole, verificationType, supersededBy }
 * `supersededBy` is a non-empty string when the task carries a
 * `- **Superseded by:**` field with a real value (not "—"/blank), else null.
 */
function parseBacklogTasks(content) {
  const map = new Map();

  // Find the start of the Active Wave section. A missing section is a no-op
  // (nothing to sync), not an error — stay silent (T-418).
  const activeWaveMatch = content.match(/^## Active Wave\b/m);
  if (!activeWaveMatch) {
    return map;
  }

  const startIdx = activeWaveMatch.index;

  // Find the end of the Active Wave section (next ## heading, or end of file)
  const afterStart = content.slice(startIdx + activeWaveMatch[0].length);
  const nextSectionMatch = afterStart.match(/^## /m);
  const section = nextSectionMatch
    ? content.slice(startIdx, startIdx + activeWaveMatch[0].length + nextSectionMatch.index)
    : content.slice(startIdx);

  // Extract task headings and the fields within each task block.
  // Split by ### T-NNN headings
  const parts = section.split(/^(?=###\s+T-\d+\s+)/m);

  for (const part of parts) {
    const headingMatch = part.match(/^###\s+(T-\d+)\s+(?:[—-]\s*)?(.*)$/m);
    if (!headingMatch) continue;
    const taskId = headingMatch[1];
    const title = headingMatch[2].trim();

    const statusMatch = part.match(/^- \*\*Status:\*\*\s+(\S+)/m);
    if (!statusMatch) continue;
    const status = statusMatch[1];

    const ownerMatch = part.match(/^- \*\*Owner role:\*\*\s+(\S+)/m);
    const ownerRole = ownerMatch ? ownerMatch[1] : 'developer';

    const verificationMatch = part.match(/^- \*\*Verification type:\*\*\s+(\S+)/m);
    const verificationType = verificationMatch ? verificationMatch[1] : 'TBD';

    const supersededMatch = part.match(/^- \*\*Superseded by:\*\*\s*(.+)$/m);
    const supersededRaw = supersededMatch ? supersededMatch[1].trim() : '';
    const supersededBy = supersededRaw && supersededRaw !== '—' ? supersededRaw : null;

    map.set(taskId, { status, title, ownerRole, verificationType, supersededBy });
  }

  return map;
}

/**
 * Parse the Active tasks section of TASK_STATUS.md and return the Set of
 * task ids (e.g. "T-123") present within it. Bounded the same way as
 * parseBacklogTasks — from "## Active tasks" to the next "## " heading (or
 * end of file) — so archived/recently-completed sections never count.
 */
function parseTaskStatusActiveIds(content) {
  const ids = new Set();

  const activeMatch = content.match(/^## Active tasks\b/m);
  if (!activeMatch) {
    return ids;
  }

  const startIdx = activeMatch.index;
  const afterStart = content.slice(startIdx + activeMatch[0].length);
  const nextSectionMatch = afterStart.match(/^## /m);
  const section = nextSectionMatch
    ? content.slice(startIdx, startIdx + activeMatch[0].length + nextSectionMatch.index)
    : content.slice(startIdx);

  for (const m of section.matchAll(/^###\s+(T-\d+)\b/gm)) {
    ids.add(m[1]);
  }

  return ids;
}

/**
 * Given the parsed BACKLOG task map and the set of task ids already present
 * in TASK_STATUS.md's Active tasks section, determine which tasks need a
 * skeleton entry created — skipping `deprecated` status and any task with a
 * real `Superseded by:` value (both are validly absent from TASK_STATUS.md).
 *
 * Returns an array of { taskId, info } in BACKLOG document order.
 */
function findMissingEntries(backlogMap, existingIds) {
  const missing = [];
  for (const [taskId, info] of backlogMap) {
    if (existingIds.has(taskId)) continue;
    if (info.status === 'deprecated') continue;
    if (info.supersededBy) continue;
    missing.push({ taskId, info });
  }
  return missing;
}

/**
 * Update the first `- **Status:**` line within each task block in TASK_STATUS.md
 * for tasks that appear in the backlogMap, and rewrite each task heading's
 * title (T-432) when it differs from BACKLOG's title for the same task id.
 *
 * @param {string} content - TASK_STATUS.md content
 * @param {Map} backlogMap - taskId -> { status, title, ... } (from parseBacklogTasks)
 * Returns { updatedContent, changes: [{taskId, oldStatus, newStatus}], retitles: [{taskId, oldTitle, newTitle}] }.
 */
function applyStatuses(content, backlogMap) {
  const changes = [];
  const retitles = [];

  // Split content into task blocks by ### T-NNN headings
  // We rebuild the file by processing each block
  const lines = content.split('\n');
  const result = [];
  let currentTaskId = null;
  let statusUpdatedForCurrentTask = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect a new task heading — capture the id, the separator (em-dash or
    // hyphen, if any), and the title text so a mismatched title can be
    // rewritten in place (T-432).
    const headingMatch = line.match(/^###\s+(T-\d+)\s+(?:([—-])\s*)?(.*)$/);
    if (headingMatch) {
      currentTaskId = headingMatch[1];
      statusUpdatedForCurrentTask = false;

      const separator = headingMatch[2] || '—';
      const oldTitle = (headingMatch[3] || '').trim();
      const backlogInfo = backlogMap.get(currentTaskId);
      if (backlogInfo && backlogInfo.title && oldTitle !== backlogInfo.title) {
        retitles.push({ taskId: currentTaskId, oldTitle, newTitle: backlogInfo.title });
        result.push(`### ${currentTaskId} ${separator} ${backlogInfo.title}`);
        continue;
      }

      result.push(line);
      continue;
    }

    // If we're inside a task block and haven't yet updated its Status line
    if (currentTaskId && !statusUpdatedForCurrentTask && backlogMap.has(currentTaskId)) {
      const statusMatch = line.match(/^(- \*\*Status:\*\*)\s+(\S+)/);
      if (statusMatch) {
        const oldStatus = statusMatch[2];
        const newStatus = backlogMap.get(currentTaskId).status;
        statusUpdatedForCurrentTask = true;
        if (oldStatus !== newStatus) {
          changes.push({ taskId: currentTaskId, oldStatus, newStatus });
          result.push(`${statusMatch[1]} ${newStatus}`);
          continue;
        }
      }
    }

    // If we hit another ## heading (non-task), reset task context
    if (line.match(/^## /)) {
      currentTaskId = null;
      statusUpdatedForCurrentTask = false;
    }

    result.push(line);
  }

  return { updatedContent: result.join('\n'), changes, retitles };
}

function main() {
  // Read files — exit 0 with warning if missing
  if (!fs.existsSync(BACKLOG_MD)) {
    process.stderr.write('sync-status: BACKLOG.md not found at ' + BACKLOG_MD + '\n');
    process.exit(0);
  }
  if (!fs.existsSync(TASK_STATUS_MD)) {
    process.stderr.write('sync-status: TASK_STATUS.md not found at ' + TASK_STATUS_MD + '\n');
    process.exit(0);
  }

  let backlogContent, taskStatusContent;
  try {
    backlogContent = fs.readFileSync(BACKLOG_MD, 'utf8');
  } catch (e) {
    process.stderr.write('sync-status: failed to read BACKLOG.md — ' + e.message + '\n');
    process.exit(0);
  }
  try {
    taskStatusContent = fs.readFileSync(TASK_STATUS_MD, 'utf8');
  } catch (e) {
    process.stderr.write('sync-status: failed to read TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  // Parse BACKLOG.md active section
  let backlogMap;
  try {
    backlogMap = parseBacklogTasks(backlogContent);
  } catch (e) {
    process.stderr.write('sync-status: failed to parse BACKLOG.md — ' + e.message + '\n');
    process.exit(0);
  }

  // No tasks to sync is a no-op — stay silent (T-418).
  if (backlogMap.size === 0) {
    process.exit(0);
  }

  // Determine which BACKLOG tasks are missing a TASK_STATUS.md Active-tasks
  // entry and need one created (T-419).
  let missingEntries;
  try {
    const existingIds = parseTaskStatusActiveIds(taskStatusContent);
    missingEntries = findMissingEntries(backlogMap, existingIds);
  } catch (e) {
    process.stderr.write('sync-status: failed to process TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  // Insert skeleton entries for any missing tasks first, so the subsequent
  // status-sync pass runs over a TASK_STATUS.md that already contains them
  // (their seeded status already matches BACKLOG, so no duplicate "synced"
  // line is produced for a task we just created).
  let workingContent = taskStatusContent;
  for (const { taskId, info } of missingEntries) {
    const entry = buildTaskStatusEntry(taskId, info.title, info.ownerRole, info.verificationType, info.status);
    workingContent = insertIntoActiveTasks(workingContent, entry);
  }

  // Apply status updates to TASK_STATUS.md
  let result;
  try {
    result = applyStatuses(workingContent, backlogMap);
  } catch (e) {
    process.stderr.write('sync-status: failed to process TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  // Nothing created, no titles to rewrite, and statuses already in sync is a
  // no-op — stay silent (T-418).
  if (missingEntries.length === 0 && result.changes.length === 0 && result.retitles.length === 0) {
    process.exit(0);
  }

  // Write only if something changed
  try {
    fs.writeFileSync(TASK_STATUS_MD, result.updatedContent, 'utf8');
  } catch (e) {
    process.stderr.write('sync-status: failed to write TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  for (const { taskId } of missingEntries) {
    process.stderr.write('sync-status: created ' + taskId + ' entry\n');
  }

  for (const { taskId } of result.retitles) {
    process.stderr.write('sync-status: retitled ' + taskId + '\n');
  }

  for (const { taskId, oldStatus, newStatus } of result.changes) {
    process.stderr.write('sync-status: synced ' + taskId + ': ' + oldStatus + ' -> ' + newStatus + '\n');
  }

  process.exit(0);
}

main();
