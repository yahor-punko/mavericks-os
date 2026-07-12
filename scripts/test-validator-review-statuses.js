'use strict';
// Regression test: T-362 — validator ACTIVE_BACKLOG_STATUSES gap causing a
// false missing_in_backlog (exit 2) for review-stage lifecycle statuses.
//
// Builds a fixture BACKLOG.md + TASK_STATUS.md pair with a single task present
// and consistent in both artifacts, then runs the validator CLI as a
// subprocess (`node scripts/mavp-validator.js <fixtureDir>`) and asserts a
// clean exit (0) with no `missing_in_backlog` finding for each of the four
// lifecycle statuses this fix restores: security_review, security_passed,
// security_needs_fix, ux_passed.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');
const STATUSES_TO_CHECK = ['security_review', 'security_passed', 'security_needs_fix', 'ux_passed'];

function buildBacklogFixture(status) {
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture task for review-stage status ${status}
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
`;
}

function buildTaskStatusFixture(status) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture task for review-stage status ${status}
- **Status:** ${status}
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`;
}

for (const status of STATUSES_TO_CHECK) {
  const tmpDir = path.join(os.tmpdir(), `t362-test-${status}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), buildBacklogFixture(status), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'TASK_STATUS.md'), buildTaskStatusFixture(status), 'utf8');

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [VALIDATOR_PATH, tmpDir], { encoding: 'utf8' });
  } catch (error) {
    // execFileSync throws when the child exits non-zero — capture both.
    stdout = error.stdout ? error.stdout.toString() : '';
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }

  assert.strictEqual(
    exitCode,
    0,
    `FAIL (status: ${status}): expected exit code 0, got ${exitCode}. Validator output:\n${stdout}`
  );

  assert.ok(
    !/missing_in_backlog/.test(stdout),
    `FAIL (status: ${status}): validator output unexpectedly contains a missing_in_backlog finding:\n${stdout}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('All T-362 assertions passed (security_review, security_passed, security_needs_fix, ux_passed all validate exit 0 with no missing_in_backlog finding).');
