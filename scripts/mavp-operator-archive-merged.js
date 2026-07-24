#!/usr/bin/env node

/**
 * mavp-operator-archive-merged.js
 *
 * Mid-wave archival: move `merged` (and `deployed_dev`/`deployed_prod`) task
 * blocks out of BACKLOG.md's "## Active Wave" section and TASK_STATUS.md's
 * "## Active tasks" section into the same archive destinations
 * --close-session uses at wave close — WITHOUT closing the wave (no wave
 * increment, no wave_summary write, no git commit ritual). In-flight
 * (non-merged) tasks are left untouched.
 *
 * BACKLOG.md destination: "## Wave <N> — Archived (mid-wave)" (created on
 * demand, appended to on repeat runs within the same wave). This is
 * deliberately a distinct heading from the final "## Wave <N> — Archived"
 * heading that --close-session produces when the wave completes, so a
 * mid-wave run never collides with the eventual wave-close rename.
 * parseActiveWaveMergedTitles() and --close-session's session-completed
 * results table both read this heading (scoped to the currently open wave
 * number) so archived titles/evidence remain discoverable when the wave
 * eventually closes — see mavp-operator-lib.js and mavp-operator-close-session.js.
 *
 * TASK_STATUS.md destination: "## Recently completed tasks", via the same
 * moveTaskToCompleted() helper --close-session uses.
 *
 * Usage:
 *   ./scripts/mavp-operator --archive-merged
 *
 * The validator runs exactly once, at the end. Its exit code is forwarded as
 * this script's exit code (0 = healthy, 1 = drifting, 2 = repair required).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const { archiveMergedTasksFromActiveWave, printRepoIdentityHeader } = require('./mavp-operator-lib.js');
const { moveTaskToCompleted } = require('./mavp-operator-close-session.js');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, content) { fs.writeFileSync(p, content, 'utf8'); }

function readCurrentWave() {
  try {
    if (fs.existsSync(PROCESS_STATE_JSON)) {
      const ps = JSON.parse(readUtf8(PROCESS_STATE_JSON));
      return Number(ps.wave) || 1;
    }
  } catch { /* fall through to default */ }
  return 1;
}

function runValidatorOnce() {
  console.log('');
  let validatorExitCode = 0;
  try {
    const output = execSync(`node "${VALIDATOR}" "${ROOT}"`, { encoding: 'utf8', stdio: 'pipe' });
    if (output && output.trim()) console.log(output.trim());
    console.log(`${GREEN}Validator: healthy (exit 0)${RESET}`);
  } catch (err) {
    validatorExitCode = err.status || 2;
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    if (combined) console.log(combined);
    if (validatorExitCode === 1) {
      console.log(`${YELLOW}Validator: drifting (exit 1) — review warnings above${RESET}`);
    } else {
      console.error(`${RED}Validator: repair required (exit ${validatorExitCode}) — fix artifacts before proceeding${RESET}`);
    }
  }
  return validatorExitCode;
}

function main() {
  printRepoIdentityHeader(ROOT);

  if (!fs.existsSync(BACKLOG_MD)) {
    console.error(`${RED}BACKLOG.md not found at ${BACKLOG_MD}${RESET}`);
    process.exitCode = 2;
    return;
  }

  const waveNumber = readCurrentWave();
  const result = archiveMergedTasksFromActiveWave(BACKLOG_MD, waveNumber);

  if (!result.ok) {
    console.error(`${RED}${result.warning}${RESET}`);
    process.exitCode = 2;
    return;
  }

  if (result.archivedIds.length === 0) {
    console.log(`${DIM}No merged tasks found in BACKLOG.md's Active Wave — nothing to archive.${RESET}`);
    if (result.warning) console.log(`${YELLOW}${result.warning}${RESET}`);
    process.exitCode = 0;
    return;
  }

  console.log(`${GREEN}✓ BACKLOG.md — archived ${result.archivedIds.length} task(s): ${result.archivedIds.join(', ')}${RESET}`);

  // Mirror the move in TASK_STATUS.md's "## Active tasks" -> "## Recently
  // completed tasks", reusing the exact helper --close-session uses.
  if (fs.existsSync(TASK_STATUS_MD)) {
    let taskStatusContent = readUtf8(TASK_STATUS_MD);
    for (const taskId of result.archivedIds) {
      taskStatusContent = moveTaskToCompleted(taskStatusContent, taskId);
    }
    writeUtf8(TASK_STATUS_MD, taskStatusContent);
    console.log(`${GREEN}✓ TASK_STATUS.md — moved ${result.archivedIds.length} task(s) to Recently completed tasks${RESET}`);
  } else {
    console.log(`${YELLOW}⚠ TASK_STATUS.md not found — BACKLOG.md archived but TASK_STATUS.md untouched${RESET}`);
  }

  console.log(`${DIM}Remaining in-flight tasks untouched: ${result.remainingIds.length ? result.remainingIds.join(', ') : '(none)'}${RESET}`);

  const validatorExitCode = runValidatorOnce();
  process.exitCode = validatorExitCode;
}

main();
