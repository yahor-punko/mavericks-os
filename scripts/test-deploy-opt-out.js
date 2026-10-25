'use strict';
// Regression test: T-815 — the BACKLOG-only `- **Deploy:** none` field removes
// a task from every deploy-pending surface (buildDeployQueue,
// getDeployPendingForRepo, the --snapshot/dashboard deployPendingTasks filter,
// the --agent deploy_queue + next_action prefix, and the close-session deploy
// label). Behavioural assertions only; expected values come from the
// acceptance contract, not from observed output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const lib = require('./mavp-operator-lib.js');
const { getDeployLabel, NO_DEPLOY_LABEL, parseBacklogNoDeploy } = require('./mavp-operator-close-session.js');
const { buildDeployQueue, getDeployPendingForRepo, parseTasksWithRepo } = lib;

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-deploy-opt-out-${process.pid}-${Date.now()}`
);
process.on('exit', () => fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

function backlogFor(deployLine) {
  return `# BACKLOG

## Active Wave

### T-901 — Opt-out task
- **Status:** merged
- **Owner role:** developer
- **Repo:** sample-repo
${deployLine ? `- **Deploy:** ${deployLine}\n` : ''}- **Verification type:** unit

### T-902 — Plain task
- **Status:** merged
- **Owner role:** developer
- **Repo:** sample-repo
- **Verification type:** unit
`;
}

const TASK_STATUS = `# TASK_STATUS

## Active tasks

### T-901 — Opt-out task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: abc1234 branch: main

### T-902 — Plain task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: def5678 branch: main
`;

// --- parseTasksWithRepo: new `deploy` property ---
{
  const tasks = parseTasksWithRepo(TASK_STATUS, backlogFor('none'));
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.strictEqual(byId['T-901'].deploy, 'none', 'T-901 must parse deploy none');
  assert.ok(byId['T-902'].deploy == null, 'T-902 (no field) must have null/undefined deploy');
  assert.strictEqual(byId['T-901'].repo, 'sample-repo', 'repo property unchanged');
  assert.strictEqual(byId['T-901'].status, 'merged', 'status property unchanged');
  // value is trimmed and case-insensitive
  for (const v of ['None', 'NONE', '  none  ']) {
    const t = parseTasksWithRepo(TASK_STATUS, backlogFor(v)).find((x) => x.id === 'T-901');
    assert.strictEqual(t.deploy, 'none', `value "${v}" must normalize to none`);
  }
  // any other value is ignored
  for (const v of ['prod', 'none of the above', 'skip', 'false']) {
    const t = parseTasksWithRepo(TASK_STATUS, backlogFor(v)).find((x) => x.id === 'T-901');
    assert.ok(t.deploy == null, `reserved value "${v}" must be ignored`);
  }
  console.log('Test 1 passed: parseTasksWithRepo deploy property');
}

// --- buildDeployQueue ---
{
  const active = [
    { id: 'T-901', title: 'Opt-out task', status: 'merged' },
    { id: 'T-902', title: 'Plain task', status: 'merged' },
  ];
  const q2 = buildDeployQueue(active, { 'T-901': { deploy: 'none' }, 'T-902': { deploy: null } }, 2);
  assert.deepStrictEqual(q2.map((t) => t.id), ['T-902'], 'contours 2: only the plain task is queued');
  assert.strictEqual(q2[0].deploy_pending, true, 'plain task stays deploy_pending');
  // a deployed task carrying the opt-out is excluded too (deploy-state surface)
  const qd = buildDeployQueue(
    [{ id: 'T-901', title: 't', status: 'deployed_dev' }],
    { 'T-901': { deploy: 'none' } },
    2
  );
  assert.deepStrictEqual(qd, [], 'opt-out task excluded at every status in the queue');
  assert.deepStrictEqual(buildDeployQueue(active, { 'T-901': { deploy: 'none' } }, 0), [], 'contours 0: empty');
  // a non-none value changes nothing
  const qr = buildDeployQueue(active, { 'T-901': { deploy: null }, 'T-902': {} }, 2);
  assert.deepStrictEqual(qr.map((t) => t.id), ['T-901', 'T-902'], 'ignored value keeps both tasks queued');
  console.log('Test 2 passed: buildDeployQueue');
}

// --- getDeployPendingForRepo ---
{
  const tasks = parseTasksWithRepo(TASK_STATUS, backlogFor('none'));
  const pending = getDeployPendingForRepo(tasks, 'sample-repo', 2);
  assert.deepStrictEqual(pending.map((t) => t.id), ['T-902'], 'repo pending excludes the opt-out task');
  const plainOnly = getDeployPendingForRepo(parseTasksWithRepo(TASK_STATUS, backlogFor('prod')), 'sample-repo', 2);
  assert.deepStrictEqual(plainOnly.map((t) => t.id), ['T-901', 'T-902'], 'ignored value changes nothing');
  console.log('Test 3 passed: getDeployPendingForRepo');
}

// --- getDeployLabel ---
{
  const root = SCRATCH_ROOT;
  assert.strictEqual(NO_DEPLOY_LABEL, '— без деплоя');
  assert.strictEqual(getDeployLabel(2, 'merged', 'abc1234', root, true), '— без деплоя');
  assert.strictEqual(getDeployLabel(2, 'merged', 'abc1234', root, false), '⏳ не задеплоен');
  assert.strictEqual(getDeployLabel(2, 'merged', 'abc1234', root), '⏳ не задеплоен');
  assert.strictEqual(getDeployLabel(2, 'deployed_prod', 'abc1234', root, true), '✓ в проде', 'deployed label unchanged');
  assert.strictEqual(getDeployLabel(2, 'deployed_dev', 'abc1234', root, true), '✓ в dev', 'deployed label unchanged');
  const ids = ['T-901', 'T-902'];
  assert.deepStrictEqual([...parseBacklogNoDeploy(backlogFor('NONE'), ids)], ['T-901']);
  assert.deepStrictEqual([...parseBacklogNoDeploy(backlogFor('prod'), ids)], []);
  console.log('Test 4 passed: getDeployLabel + parseBacklogNoDeploy');
}

// --- --agent end to end: deploy_queue and the next_action prefix count ---
{
  const root = path.join(SCRATCH_ROOT, 'agent');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlogFor('none'), 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), TASK_STATUS, 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-815 fixture', stage: 'execution', wave: 1, active_slices: [],
    next_action: 'Open next wave', blocker: null, stage_owner: 'main_agent',
    last_task_id: 902, last_updated: '2026-01-01', deploy_contours: 2, rechecks: [],
  }, null, 2) + '\n', 'utf8');
  const out = JSON.parse(execFileSync('node', [path.join(SCRIPTS_DIR, 'mavp-operator-agent.js')], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 15000,
  }));
  assert.deepStrictEqual(out.deploy_queue.map((t) => t.id), ['T-902'], 'agent deploy_queue lists only the plain task');
  assert.ok(out.next_action.startsWith('⚠ 1 task(s) awaiting prod deploy'), `next_action prefix must count 1, got: ${out.next_action}`);
  console.log('Test 5 passed: --agent deploy_queue + next_action prefix');

  // --snapshot (shares the deployPendingTasks filter with the dashboard)
  const snap = execFileSync('node', [path.join(SCRIPTS_DIR, 'mavp-operator-snapshot.js')], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ok(/Pending prod deployment/.test(snap), `snapshot must still list the pending section for the plain task:\n${snap}`);
  assert.ok(/T-902 \(sample-repo\)/.test(snap), 'snapshot lists the plain task as pending');
  assert.ok(!/T-901 \(sample-repo\)/.test(snap), 'snapshot must not list the opt-out task as pending');
  console.log('Test 6 passed: --snapshot pending-deploy list');
}

console.log('All T-815 deploy opt-out tests passed');
