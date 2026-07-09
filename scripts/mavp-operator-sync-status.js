#!/usr/bin/env node

/**
 * mavp-operator-sync-status.js
 *
 * Reads task statuses from BACKLOG.md (Active Wave section only) and updates
 * the matching `- **Status:**` lines in TASK_STATUS.md.
 *
 * Only touches `- **Status:**` lines — never evidence blocks, Notes, or any
 * other fields.
 *
 * Called automatically by the PostToolUse hook when BACKLOG.md is edited.
 * Also available as:
 *   ./scripts/mavp-operator --sync-status
 *
 * Exit 0 always — non-fatal. Warnings go to stderr.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');

/**
 * Parse the Active Wave section of BACKLOG.md.
 * Returns a Map of { taskId (e.g. "T-123") → status string }.
 */
function parseBacklogStatuses(content) {
  const map = new Map();

  // Find the start of the Active Wave section
  const activeWaveMatch = content.match(/^## Active Wave\b/m);
  if (!activeWaveMatch) {
    process.stderr.write('sync-status: no "## Active Wave" section found in BACKLOG.md\n');
    return map;
  }

  const startIdx = activeWaveMatch.index;

  // Find the end of the Active Wave section (next ## heading, or end of file)
  const afterStart = content.slice(startIdx + activeWaveMatch[0].length);
  const nextSectionMatch = afterStart.match(/^## /m);
  const section = nextSectionMatch
    ? content.slice(startIdx, startIdx + activeWaveMatch[0].length + nextSectionMatch.index)
    : content.slice(startIdx);

  // Extract task headings and the first Status line within each task block
  // Split by ### T-NNN headings
  const taskHeadingRe = /^###\s+(T-\d+)\s+/m;
  const parts = section.split(/^(?=###\s+T-\d+\s+)/m);

  for (const part of parts) {
    const headingMatch = part.match(/^###\s+(T-\d+)\s+/m);
    if (!headingMatch) continue;
    const taskId = headingMatch[1];

    const statusMatch = part.match(/^- \*\*Status:\*\*\s+(\S+)/m);
    if (!statusMatch) continue;

    map.set(taskId, statusMatch[1]);
  }

  return map;
}

/**
 * Update the first `- **Status:**` line within each task block in TASK_STATUS.md
 * for tasks that appear in the backlogMap.
 *
 * Returns { updatedContent, changes: [{taskId, oldStatus, newStatus}] }.
 */
function applyStatuses(content, backlogMap) {
  const changes = [];

  // Split content into task blocks by ### T-NNN headings
  // We rebuild the file by processing each block
  const lines = content.split('\n');
  const result = [];
  let currentTaskId = null;
  let statusUpdatedForCurrentTask = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect a new task heading
    const headingMatch = line.match(/^###\s+(T-\d+)\s+/);
    if (headingMatch) {
      currentTaskId = headingMatch[1];
      statusUpdatedForCurrentTask = false;
      result.push(line);
      continue;
    }

    // If we're inside a task block and haven't yet updated its Status line
    if (currentTaskId && !statusUpdatedForCurrentTask && backlogMap.has(currentTaskId)) {
      const statusMatch = line.match(/^(- \*\*Status:\*\*)\s+(\S+)/);
      if (statusMatch) {
        const oldStatus = statusMatch[2];
        const newStatus = backlogMap.get(currentTaskId);
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

  return { updatedContent: result.join('\n'), changes };
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
    backlogMap = parseBacklogStatuses(backlogContent);
  } catch (e) {
    process.stderr.write('sync-status: failed to parse BACKLOG.md — ' + e.message + '\n');
    process.exit(0);
  }

  if (backlogMap.size === 0) {
    process.stderr.write('sync-status: no tasks found in Active Wave section\n');
    process.exit(0);
  }

  // Apply updates to TASK_STATUS.md
  let result;
  try {
    result = applyStatuses(taskStatusContent, backlogMap);
  } catch (e) {
    process.stderr.write('sync-status: failed to process TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  if (result.changes.length === 0) {
    process.stderr.write('sync-status: no status changes needed\n');
    process.exit(0);
  }

  // Write only if something changed
  try {
    fs.writeFileSync(TASK_STATUS_MD, result.updatedContent, 'utf8');
  } catch (e) {
    process.stderr.write('sync-status: failed to write TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  for (const { taskId, oldStatus, newStatus } of result.changes) {
    process.stderr.write('sync-status: synced ' + taskId + ': ' + oldStatus + ' → ' + newStatus + '\n');
  }

  process.exit(0);
}

main();
