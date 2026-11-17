'use strict';
// T-907 — `runtime_verified` is a post-merge COMPLETED status. Beyond the
// validator sets (covered in test-validator-review-statuses.js and
// test-commit-reachable.js), three other status sites had to learn it:
//   1. mavp-operator-update-status.js VALID_STATUSES — `--update-status T-N
//      runtime_verified` used to be refused as an unknown status.
//   2. getDeployLabel() in mavp-operator-close-session.js — with
//      deploy_contours >= 2 a runtime_verified task rendered as "not merged";
//      it must render exactly like a merged task (awaiting deploy), including
//      the Deploy: none variant.
//   3. extractTrajectories() in mavp-operator-lib.js — the terminal-success
//      DONE set omitted runtime_verified, so such tasks were dropped from
//      skill-reflection trajectories.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const UPDATE_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-update-status.js');
const { getDeployLabel, NO_DEPLOY_LABEL } = require('./mavp-operator-close-session.js');
const { extractTrajectories } = require('./mavp-operator-lib.js');

// ---------------------------------------------------------------------------
// 1. --update-status accepts runtime_verified and writes it to both artifacts.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't907-update-status-'));
  const block = (owner) => `### T-950 — Fixture task
- **Status:** merged
- **${owner}:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
`;
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG\n\n## Active Wave\n\n${block('Owner role')}`, 'utf8');
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS\n\n## Active tasks\n\n${block('Owner')}\n## Recently completed tasks\n`, 'utf8');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: dir };
  const res = spawnSync(process.execPath, [UPDATE_STATUS_PATH, 'T-950', 'runtime_verified'], { cwd: dir, env, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  assert.ok(!/unknown status/.test(out), `Test 1 FAIL: runtime_verified refused as unknown status:\n${out}`);
  for (const file of ['BACKLOG.md', 'TASK_STATUS.md']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/- \*\*Status:\*\* runtime_verified/.test(text), `Test 1 FAIL: ${file} Status not set to runtime_verified:\n${text}\n${out}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Test 1 passed: --update-status accepts runtime_verified');
}

// ---------------------------------------------------------------------------
// 2. getDeployLabel(): runtime_verified renders like merged at contours >= 2.
// ---------------------------------------------------------------------------
{
  const label = (contours, status, noDeploy) => getDeployLabel(contours, status, null, os.tmpdir(), noDeploy);
  const mergedLabel = label(2, 'merged');
  const notMergedLabel = label(2, 'in_progress');
  assert.notStrictEqual(mergedLabel, notMergedLabel, 'Test 2 setup FAIL: merged and not-merged labels must differ');
  assert.strictEqual(label(2, 'runtime_verified'), mergedLabel, 'Test 2a FAIL: runtime_verified must render like merged, not as "not merged"');
  assert.strictEqual(label(3, 'runtime_verified'), mergedLabel, 'Test 2b FAIL: contours 3 same as 2');
  assert.strictEqual(label(2, 'runtime_verified', true), NO_DEPLOY_LABEL, 'Test 2c FAIL: Deploy: none renders NO_DEPLOY_LABEL for runtime_verified, as for merged');
  assert.strictEqual(label(2, 'merged', true), NO_DEPLOY_LABEL, 'Test 2c control FAIL');
  // Unchanged neighbours.
  assert.notStrictEqual(label(2, 'deployed_prod'), notMergedLabel, 'Test 2d FAIL: deployed_prod label unchanged');
  assert.notStrictEqual(label(2, 'deployed_dev'), notMergedLabel, 'Test 2d FAIL: deployed_dev label unchanged');
  assert.notStrictEqual(label(2, 'deployed_prod'), label(2, 'deployed_dev'), 'Test 2d FAIL: prod and dev labels stay distinct');
  console.log('Test 2 passed: getDeployLabel() renders runtime_verified like merged');
}

// ---------------------------------------------------------------------------
// 3. extractTrajectories() counts runtime_verified as terminal-success.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't907-trajectories-'));
  const taskStatusPath = path.join(dir, 'TASK_STATUS.md');
  const backlogPath = path.join(dir, 'BACKLOG.md');
  fs.writeFileSync(taskStatusPath, `# TASK_STATUS

## Recently completed tasks

### T-960 — runtime_verified developer task
- **Status:** runtime_verified
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234 branch: main needs_fix_rounds: 0

### T-961 — in_progress developer task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** —
`, 'utf8');
  fs.writeFileSync(backlogPath, '# BACKLOG\n\n## Active Wave\n', 'utf8');
  const ids = extractTrajectories('developer', { taskStatusPath, backlogPath }).map((t) => t.taskId);
  assert.deepStrictEqual(ids, ['T-960'], `Test 3 FAIL: expected only the runtime_verified task, got ${JSON.stringify(ids)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Test 3 passed: extractTrajectories() includes runtime_verified and still excludes in_progress');
}

console.log('\nAll T-907 status-site assertions passed.');
