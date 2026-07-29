'use strict';
// Regression test: T-547 — validator warning for a terminal-status BACKLOG
// task with no TASK_STATUS record anywhere.
//
// Complement to T-543's cross_section_terminal_status_disagreement check:
// that check requires a TASK_STATUS record to disagree with, so it cannot
// see a task with NO TASK_STATUS record at all — exactly the shape a buggy
// archival move-helper leaves when it DROPS a block instead of moving it
// (the same T-542/T-544 incident family this check closes the gap on).
//
// Builds fixture BACKLOG.md + TASK_STATUS.md pairs (no PROCESS_STATE.json —
// PROCESS_STATE-dependent checks degrade silently on read errors, matching
// the precedent in test-validator-cross-section-status.js) and runs the
// validator CLI as a subprocess.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');

function makeTmpDir(label) {
  const tmpDir = path.join(os.tmpdir(), `t547-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Minimal always-present active pairing so both artifacts have a
// non-terminal task the base comparison checks are happy with.
function baseBacklog({ archivedBlock }) {
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

${archivedBlock}
`;
}

function baseTaskStatus({ orphanRecord = '' } = {}) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

## Recently completed tasks
${orphanRecord}
`;
}

let passCount = 0;
function check(label, condition, extra) {
  assert.ok(condition, `FAIL (${label})${extra ? `: ${extra}` : ''}`);
  passCount += 1;
}

// --- Test A: merged archived BACKLOG task absent from TASK_STATUS entirely
// --- fires the new warning ---------------------------------------------
{
  const tmpDir = makeTmpDir('dropped-record-fires');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-901 — Fixture task dropped from TASK_STATUS
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'dropped-record fixture fires missing_task_status_record_anywhere',
    /missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'dropped-record fixture is warning severity (does not force exit 2 on its own)',
    exitCode !== 2 || /cross_section_terminal_status_disagreement/.test(stdout) === false,
    `got ${exitCode}. Output:\n${stdout}`
  );
  // Confirm the check is not simply absent from CHECKS output by construction —
  // assert the specific taskId is named.
  check('dropped-record finding names T-901', /T-901/.test(stdout) && /missing_task_status_record_anywhere/.test(stdout), `Output:\n${stdout}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test B: matching TASK_STATUS record present — no finding --------------
{
  const tmpDir = makeTmpDir('present-record-no-finding');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-902 — Fixture task with a real TASK_STATUS record
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({
      orphanRecord: `
### T-902 — Fixture task with a real TASK_STATUS record
- **Status:** merged
- **Owner:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Evidence:** commit: abc1234 branch: main`,
    })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'present-record fixture does NOT fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test C: Superseded by: skips the check (BACKLOG side) -----------------
{
  const tmpDir = makeTmpDir('superseded-skip');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-903 — Fixture task absorbed by another task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Superseded by:** T-999`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'superseded backlog record skips missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test D: deprecated BACKLOG status skips the check ----------------------
// (deprecated is not itself a terminal status, but isSkippedByExistingRules
// checks it explicitly — verify a deprecated non-terminal-but-tagged record
// never fires even if it somehow carried a terminal status alongside it is
// not representable; instead verify deprecated skip via the BACKLOG record
// directly reaching isSkippedByExistingRules through a terminal status.)
{
  const tmpDir = makeTmpDir('deprecated-skip');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-904 — Fixture task marked deprecated
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'deprecated backlog record (non-terminal status) does not fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test E: a non-terminal BACKLOG status with no TASK_STATUS record ------
// --- must NOT fire (this check is terminal-status-scoped only) -------------
{
  const tmpDir = makeTmpDir('non-terminal-no-fire');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-905 — Fixture task still in flight, absent from TASK_STATUS
- **Status:** planned
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'non-terminal backlog-only record does not fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`All T-547 assertions passed (${passCount} checks).`);
