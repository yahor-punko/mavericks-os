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

// ---------------------------------------------------------------------------
// T-907 — `runtime_verified` is a completed (post-merge) status. A task at that
// status, mirrored in TASK_STATUS Active tasks and present in the BACKLOG Active
// Wave, must be treated exactly like a `merged` task: no missing_in_backlog,
// reachable commit evidence -> exit 0; no commit evidence -> the same
// merged_missing_commit_field finding a merged task gets (exit 2).
// ---------------------------------------------------------------------------
const { spawnSync } = require('node:child_process');

function vcs(root, args) {
  return execFileSync('git', ['-c', 'user.email=demo@example.invalid', '-c', 'user.name=Fixture', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildCompletedFixture({ status, evidence }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't907-completed-'));
  vcs(root, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  vcs(root, ['add', '-A']);
  vcs(root, ['commit', '-q', '-m', 'initial']);
  const head = vcs(root, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), buildBacklogFixture(status), 'utf8');
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    buildTaskStatusFixture(status).replace('- **Evidence:** —', `- **Evidence:** ${evidence.replace('<HEAD>', head)}`),
    'utf8'
  );
  return root;
}

function runCompleted(opts) {
  const root = buildCompletedFixture(opts);
  const result = spawnSync('node', [VALIDATOR_PATH, root], { encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
  return { out: `${result.stdout || ''}${result.stderr || ''}`, code: result.status };
}

// (a) runtime_verified + reachable commit evidence -> no missing_in_backlog, exit 0.
{
  const { out, code } = runCompleted({ status: 'runtime_verified', evidence: 'commit: <HEAD>' });
  assert.ok(!/missing_in_backlog/.test(out), `T-907 (a) FAIL: unexpected missing_in_backlog for runtime_verified:\n${out}`);
  assert.strictEqual(code, 0, `T-907 (a) FAIL: expected exit 0, got ${code}:\n${out}`);
}

// (b) runtime_verified without commit evidence -> merged_missing_commit_field, exactly as merged.
{
  const rv = runCompleted({ status: 'runtime_verified', evidence: '—' });
  const merged = runCompleted({ status: 'merged', evidence: '—' });
  assert.ok(/merged_missing_commit_field/.test(merged.out), `T-907 (b) control FAIL: merged task must carry merged_missing_commit_field:\n${merged.out}`);
  assert.ok(/merged_missing_commit_field/.test(rv.out), `T-907 (b) FAIL: runtime_verified must carry merged_missing_commit_field:\n${rv.out}`);
  assert.ok(!/missing_in_backlog/.test(rv.out), `T-907 (b) FAIL: unexpected missing_in_backlog:\n${rv.out}`);
  assert.strictEqual(rv.code, merged.code, `T-907 (b) FAIL: runtime_verified exit ${rv.code} differs from merged exit ${merged.code}`);
  assert.strictEqual(rv.code, 2, `T-907 (b) FAIL: expected exit 2, got ${rv.code}`);
}

console.log('All T-907 assertions passed (runtime_verified validates like merged: exit 0 with reachable commit; merged_missing_commit_field without).');
