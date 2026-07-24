#!/usr/bin/env node

/**
 * mavp-operator-park-wave.js
 *
 * T-440: --park-wave / --unpark-wave — symmetrically MOVE a wave's task
 * blocks out of (and back into) the Active sections of BOTH BACKLOG.md and
 * TASK_STATUS.md, so a parked wave stops bloating session-start, artifact
 * size budgets, and next-action routing.
 *
 * Today `parked_waves` in PROCESS_STATE.json is an annotation only — parking
 * a wave does not relocate anything, so its task blocks stay fully visible
 * to the validator, --agent, and the artifact-size budget checks even though
 * the wave is meant to be dormant. This command makes parking a real move:
 *
 *   BACKLOG.md:      "## Active Wave" task blocks  -> "## Wave <N> — Parked"
 *   TASK_STATUS.md:  "## Active tasks" task blocks  -> "## Parked tasks (Wave <N>)"
 *   PROCESS_STATE.json: parked_waves gets "Wave <N> — <reason>" appended
 *
 * --unpark-wave <N> is the exact inverse: it restores every block back to
 * its original Active section, byte-for-byte (see
 * moveActiveBlocksToParkedSection() / moveParkedBlocksToActiveSection() in
 * mavp-operator-lib.js for the reversibility guarantee), and removes the
 * matching parked_waves entry.
 *
 * Usage:
 *   ./scripts/mavp-operator --park-wave [N] --reason "text"
 *   ./scripts/mavp-operator --unpark-wave <N>
 *
 * N defaults to the current wave (PROCESS_STATE.json's `wave` field) when
 * omitted from --park-wave. --unpark-wave always requires an explicit N.
 *
 * The validator runs exactly once, at the end of each command. Its exit
 * code is forwarded as this script's exit code (0 = healthy, 1 = drifting,
 * 2 = repair required).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const {
  ROOT,
  moveActiveBlocksToParkedSection,
  moveParkedBlocksToActiveSection,
  parkedBacklogHeading,
  parkedTaskStatusHeading,
  printRepoIdentityHeader,
} = require('./mavp-operator-lib.js');

const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, content) { fs.writeFileSync(p, content, 'utf8'); }
function today() { return new Date().toISOString().slice(0, 10); }

function readProcessState() {
  if (!fs.existsSync(PROCESS_STATE_JSON)) {
    throw new Error(`PROCESS_STATE.json not found at ${PROCESS_STATE_JSON}`);
  }
  return JSON.parse(readUtf8(PROCESS_STATE_JSON));
}

function writeProcessState(state) {
  writeUtf8(PROCESS_STATE_JSON, JSON.stringify(state, null, 2) + '\n');
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

function printUsage() {
  console.error('Usage:');
  console.error('  mavp-operator --park-wave [N] --reason "text"');
  console.error('  mavp-operator --unpark-wave <N>');
  console.error('');
  console.error('  N          Wave number (defaults to the current wave for --park-wave; required for --unpark-wave)');
  console.error('  --reason   Required for --park-wave — one-line reason recorded in parked_waves');
}

/**
 * --park-wave: move every BACKLOG.md Active Wave block and every
 * TASK_STATUS.md Active tasks block for `waveNumber` into their respective
 * parked sections, then append the wave + reason to parked_waves.
 *
 * Both file transforms are computed in-memory before either file is
 * written, so a failure on either side leaves both files untouched.
 */
function parkWave(waveNumber, reason) {
  if (!fs.existsSync(BACKLOG_MD)) {
    throw new Error(`BACKLOG.md not found at ${BACKLOG_MD}`);
  }

  const backlogContent = readUtf8(BACKLOG_MD);
  const backlogResult = moveActiveBlocksToParkedSection(
    backlogContent,
    /^##\s+Active Wave/i,
    parkedBacklogHeading(waveNumber)
  );
  if (!backlogResult.ok) {
    throw new Error(`BACKLOG.md: ${backlogResult.error}`);
  }

  let taskStatusResult = null;
  if (fs.existsSync(TASK_STATUS_MD)) {
    const taskStatusContent = readUtf8(TASK_STATUS_MD);
    taskStatusResult = moveActiveBlocksToParkedSection(
      taskStatusContent,
      /^##\s+Active tasks\s*$/m,
      parkedTaskStatusHeading(waveNumber)
    );
    if (!taskStatusResult.ok) {
      throw new Error(`TASK_STATUS.md: ${taskStatusResult.error}`);
    }
  }

  // Both transforms succeeded — now write.
  writeUtf8(BACKLOG_MD, backlogResult.updated);
  if (taskStatusResult) writeUtf8(TASK_STATUS_MD, taskStatusResult.updated);

  const state = readProcessState();
  if (!Array.isArray(state.parked_waves)) state.parked_waves = [];
  state.parked_waves.push(`Wave ${waveNumber} — ${reason}`);
  state.last_updated = today();
  writeProcessState(state);

  return {
    backlogTaskIds: backlogResult.taskIds,
    taskStatusTaskIds: taskStatusResult ? taskStatusResult.taskIds : [],
  };
}

/**
 * --unpark-wave: restore every block parked under BACKLOG.md's
 * "## Wave <N> — Parked" and TASK_STATUS.md's "## Parked tasks (Wave <N>)"
 * back into their Active sections byte-for-byte, then remove the matching
 * parked_waves entry.
 */
function unparkWave(waveNumber) {
  if (!fs.existsSync(BACKLOG_MD)) {
    throw new Error(`BACKLOG.md not found at ${BACKLOG_MD}`);
  }

  const backlogContent = readUtf8(BACKLOG_MD);
  const backlogParkedHeading = parkedBacklogHeading(waveNumber);
  if (!backlogContent.split(/\r?\n/).some((l) => l.trim() === backlogParkedHeading)) {
    throw new Error(`BACKLOG.md: no "${backlogParkedHeading}" section found — is Wave ${waveNumber} actually parked?`);
  }
  const backlogResult = moveParkedBlocksToActiveSection(backlogContent, /^##\s+Active Wave/i, backlogParkedHeading);
  if (!backlogResult.ok) {
    throw new Error(`BACKLOG.md: ${backlogResult.error}`);
  }

  let taskStatusResult = null;
  if (fs.existsSync(TASK_STATUS_MD)) {
    const taskStatusContent = readUtf8(TASK_STATUS_MD);
    const taskStatusParkedHeading = parkedTaskStatusHeading(waveNumber);
    if (taskStatusContent.split(/\r?\n/).some((l) => l.trim() === taskStatusParkedHeading)) {
      taskStatusResult = moveParkedBlocksToActiveSection(taskStatusContent, /^##\s+Active tasks\s*$/m, taskStatusParkedHeading);
      if (!taskStatusResult.ok) {
        throw new Error(`TASK_STATUS.md: ${taskStatusResult.error}`);
      }
    }
  }

  writeUtf8(BACKLOG_MD, backlogResult.updated);
  if (taskStatusResult) writeUtf8(TASK_STATUS_MD, taskStatusResult.updated);

  const state = readProcessState();
  if (Array.isArray(state.parked_waves)) {
    const re = new RegExp(`^Wave\\s+${waveNumber}\\b`);
    state.parked_waves = state.parked_waves.filter((entry) => !re.test(String(entry)));
  }
  state.last_updated = today();
  writeProcessState(state);

  return {
    backlogTaskIds: backlogResult.taskIds,
    taskStatusTaskIds: taskStatusResult ? taskStatusResult.taskIds : [],
  };
}

function main() {
  printRepoIdentityHeader(ROOT);

  const mode = process.argv[2];
  const rest = process.argv.slice(3);

  if (mode === '--park-wave') {
    let waveNumber = null;
    let reason = null;
    let i = 0;
    if (rest[0] && !rest[0].startsWith('--')) {
      waveNumber = rest[0];
      i = 1;
    }
    for (; i < rest.length; i++) {
      if (rest[i] === '--reason' && rest[i + 1] !== undefined) {
        reason = rest[++i];
      } else if (rest[i].startsWith('--reason=')) {
        reason = rest[i].slice('--reason='.length);
      } else {
        console.error(`Error: Unknown argument "${rest[i]}".`);
        console.error('');
        printUsage();
        process.exitCode = 1;
        return;
      }
    }

    if (!reason) {
      console.error('Error: --reason "text" is required for --park-wave.');
      console.error('');
      printUsage();
      process.exitCode = 1;
      return;
    }

    let resolvedWave;
    if (waveNumber !== null) {
      if (!/^\d+$/.test(waveNumber)) {
        console.error(`Error: Invalid wave number "${waveNumber}". Expected an integer.`);
        process.exitCode = 1;
        return;
      }
      resolvedWave = waveNumber;
    } else {
      let state;
      try {
        state = readProcessState();
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      resolvedWave = state.wave;
    }

    let result;
    try {
      result = parkWave(resolvedWave, reason);
    } catch (err) {
      console.error(`${RED}Error: ${err.message}${RESET}`);
      process.exitCode = 2;
      return;
    }

    console.log(`${GREEN}✓ BACKLOG.md — parked ${result.backlogTaskIds.length} task(s) into "${parkedBacklogHeading(resolvedWave)}": ${result.backlogTaskIds.join(', ') || '(none)'}${RESET}`);
    console.log(`${GREEN}✓ TASK_STATUS.md — parked ${result.taskStatusTaskIds.length} task(s) into "${parkedTaskStatusHeading(resolvedWave)}": ${result.taskStatusTaskIds.join(', ') || '(none)'}${RESET}`);
    console.log(`${DIM}parked_waves: "Wave ${resolvedWave} — ${reason}"${RESET}`);

    process.exitCode = runValidatorOnce();
    return;
  }

  if (mode === '--unpark-wave') {
    const waveNumber = rest[0];
    if (!waveNumber || waveNumber.startsWith('--') || !/^\d+$/.test(waveNumber)) {
      console.error('Error: --unpark-wave requires a wave number, e.g. --unpark-wave 5');
      console.error('');
      printUsage();
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = unparkWave(waveNumber);
    } catch (err) {
      console.error(`${RED}Error: ${err.message}${RESET}`);
      process.exitCode = 2;
      return;
    }

    console.log(`${GREEN}✓ BACKLOG.md — restored ${result.backlogTaskIds.length} task(s) to Active Wave: ${result.backlogTaskIds.join(', ') || '(none)'}${RESET}`);
    console.log(`${GREEN}✓ TASK_STATUS.md — restored ${result.taskStatusTaskIds.length} task(s) to Active tasks: ${result.taskStatusTaskIds.join(', ') || '(none)'}${RESET}`);
    console.log(`${DIM}removed parked_waves entry for Wave ${waveNumber}${RESET}`);

    process.exitCode = runValidatorOnce();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main();
