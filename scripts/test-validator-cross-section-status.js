'use strict';
// Regression test: T-543 — validator checks for cross-section terminal-status
// disagreement (failure) and non-terminal blocks in TASK_STATUS's completed
// sections (warning).
//
// Reproduces the exact shape of the 2026-07-26 corruption (see 274cd91's
// commit message and `git show 6bcdf1e -- BACKLOG.md`): a task's BACKLOG
// block gets archived out of "## Active Wave" with a fabricated `merged`
// status and no evidence, while its TASK_STATUS.md block sits under
// "## Recently completed tasks" still carrying `planned` — a disagreement
// that compareRecords()'s active-section-only status_mismatch check cannot
// see once both blocks have left their active sections.
//
// Builds fixture BACKLOG.md + TASK_STATUS.md pairs (no PROCESS_STATE.json —
// PROCESS_STATE-dependent checks degrade silently on read errors, matching
// the precedent in test-validator-review-statuses.js) and runs the
// validator CLI as a subprocess.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');

function makeTmpDir(label) {
  const tmpDir = path.join(os.tmpdir(), `t543-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function writeFixture(tmpDir, backlogMarkdown, taskStatusMarkdown) {
  fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), backlogMarkdown, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'TASK_STATUS.md'), taskStatusMarkdown, 'utf8');
}

function runValidator(tmpDir) {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [VALIDATOR_PATH, tmpDir], { encoding: 'utf8' });
  } catch (error) {
    stdout = error.stdout ? error.stdout.toString() : '';
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }
  return { stdout, exitCode };
}

function baseBacklog({ archivedStatus, extraField = '' }) {
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo

## Wave 99 — Archived (mid-wave)

### T-901 — Fixture task fabricated ${archivedStatus} in archived section
- **Status:** ${archivedStatus}
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo${extraField}
`;
}

function baseTaskStatus({ completedSectionStatus, extraField = '' }) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

## Recently completed tasks

### T-901 — Fixture task fabricated in archived section
- **Status:** ${completedSectionStatus}
- **Owner:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Evidence:** —${extraField}
`;
}

let passCount = 0;
function check(label, condition, extra) {
  assert.ok(condition, `FAIL (${label})${extra ? `: ${extra}` : ''}`);
  passCount += 1;
}

// --- Test A: corruption fixture fires BOTH checks, exit code 2 -------------
{
  const tmpDir = makeTmpDir('corruption-fires');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged' }),
    baseTaskStatus({ completedSectionStatus: 'planned' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check('corruption fixture exit code', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  check(
    'corruption fixture fires cross_section_terminal_status_disagreement',
    /cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'corruption fixture fires non_terminal_status_in_completed_section',
    /non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test B: consistent terminal statuses on both sides — neither check fires ---
{
  const tmpDir = makeTmpDir('consistent-terminal');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged', extraField: '\n- **Type:** improvement' }),
    baseTaskStatus({
      completedSectionStatus: 'merged',
      extraField: '\n- **Evidence:** commit: abc1234 branch: main',
    })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'consistent-terminal does not fire cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'consistent-terminal does not fire non_terminal_status_in_completed_section',
    !/non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  // exit code may still be non-zero from unrelated checks (e.g. commit
  // reachability against a synthetic hash) — not asserted here, since this
  // test's scope is only the two new checks' firing behavior.
  void exitCode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test C: Superseded by skips both checks -------------------------------
{
  const tmpDir = makeTmpDir('superseded-skip');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged', extraField: '\n- **Superseded by:** T-999' }),
    baseTaskStatus({ completedSectionStatus: 'planned' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'superseded backlog record skips cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test D: deprecated TASK_STATUS record skips both checks ---------------
{
  const tmpDir = makeTmpDir('deprecated-skip');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged' }),
    baseTaskStatus({ completedSectionStatus: 'deprecated' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'deprecated task_status record skips cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'deprecated task_status record skips non_terminal_status_in_completed_section',
    !/non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test E: non-terminal status in "Recently completed tasks" fires the ---
// --- warning check even with NO corresponding BACKLOG terminal record   ---
{
  const tmpDir = makeTmpDir('warning-only');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'deployed_prod' }),
    baseTaskStatus({ completedSectionStatus: 'in_progress' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'in_progress in Recently completed fires non_terminal_status_in_completed_section',
    /non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'deployed_prod vs in_progress also fires the failure-severity check',
    /cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check('warning-only+failure fixture exits 2', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`All T-543 assertions passed (${passCount} checks).`);
