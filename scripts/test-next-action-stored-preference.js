'use strict';
// T-807: --agent prefers the stored PROCESS_STATE.json next_action while its task is
// an eligible candidate, normalises the "none"/empty placeholder to null, and emits
// the additive next_action_source field.
//
// Part 1 exercises resolveNextAction()/computeNextAction() against a scratch BACKLOG.md
// (dependency gating reads BACKLOG.md from ROOT, fixed at module load).
// Part 2 runs the real `--agent` script as a subprocess against scratch projects.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const BASE = path.join(process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), `test-next-action-stored-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

function backlog(blocks) {
  return '# BACKLOG\n\n## Active Wave\n\n' + blocks.map(b =>
    `### ${b.id} — ${b.title}\n- **Status:** ${b.status}\n- **Owner role:** developer\n` +
    (b.dep ? `- **Depends on:** ${b.dep}\n` : '') + '\n').join('');
}
function taskStatus(blocks) {
  return '# TASK_STATUS\n\n## Active tasks\n\n' + blocks.map(b =>
    `### ${b.id} — ${b.title}\n- **Status:** ${b.status}\n- **Owner:** developer\n- **Evidence:** none\n\n`).join('');
}
function makeProject(name, blocks, state) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), backlog(blocks), 'utf8');
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), taskStatus(blocks), 'utf8');
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return dir;
}
function runAgent(dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'mavp-operator-agent.js')], {
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir }, encoding: 'utf8',
  });
  const out = r.stdout || '';
  const start = out.indexOf('{');
  assert.ok(start >= 0, `agent produced no JSON: ${out} ${r.stderr}`);
  return JSON.parse(out.slice(start));
}

// ---- Part 1: resolveNextAction on a scratch BACKLOG ----------------------
const DEP_ROOT = makeProject('unit', [
  { id: 'T-1', title: 'task A', status: 'planned' },
  { id: 'T-2', title: 'task B', status: 'planned' },
  { id: 'T-3', title: 'task D', status: 'planned', dep: 'T-9' }, // T-9 never merged
  { id: 'T-4', title: 'task E', status: 'planned', dep: 'T-1' }, // T-1 planned, not merged
], { wave: 1 });
process.env.MAVERICKS_PROJECT_ROOT = DEP_ROOT;
const { resolveNextAction, computeNextAction, normalizeStaticNextAction } = require('./mavp-operator-agent.js');

const planned = [
  { id: 'T-1', title: 'task A', status: 'planned', owner: 'developer' },
  { id: 'T-2', title: 'task B', status: 'planned', owner: 'developer' },
  { id: 'T-3', title: 'task D', status: 'planned', owner: 'developer' },
  { id: 'T-4', title: 'task E', status: 'planned', owner: 'developer' },
];
const merged = [{ id: 'T-7', title: 'done', status: 'merged', owner: 'developer' }];

{ // Test 1: stored B (eligible, second in order) is emitted verbatim
  const stored = 'T-2 → developer → do B second-step';
  const r = resolveNextAction(merged, planned, stored);
  assert.strictEqual(r.value, stored, 'Test 1 FAIL: eligible stored directive must be emitted verbatim');
  assert.strictEqual(r.source, 'stored');
  assert.strictEqual(computeNextAction(merged, planned, stored), stored);
  console.log('Test 1 passed: eligible stored directive emitted verbatim, source=stored');
}
{ // Test 2: stored C where C is merged -> computed A
  const r = resolveNextAction(merged, planned, 'T-7 → developer → stale step');
  assert.strictEqual(r.value, 'T-1 → developer → task A', 'Test 2 FAIL');
  assert.strictEqual(r.source, 'computed');
  console.log('Test 2 passed: ineligible stored directive replaced by computed candidate');
}
{ // Test 3: stored task depends on an unmerged task -> A's directive
  for (const id of ['T-3', 'T-4']) {
    const r = resolveNextAction(merged, planned, `${id} → developer → blocked step`);
    assert.strictEqual(r.value, 'T-1 → developer → task A', `Test 3 FAIL for ${id}`);
    assert.strictEqual(r.source, 'computed');
  }
  console.log('Test 3 passed: stored directive with unmerged dependency is not preferred');
}
{ // Test 4: in-flight stored task is eligible even when a higher-priority task exists
  const active = [
    { id: 'T-5', title: 'in dev', status: 'in_progress', owner: 'developer' },
    { id: 'T-6', title: 'needs qa', status: 'ready_for_qa', owner: 'qa' },
  ];
  const stored = 'T-5 → developer → keep going';
  assert.strictEqual(resolveNextAction(active, [], stored).value, stored, 'Test 4 FAIL');
  assert.strictEqual(resolveNextAction(active, [], null).value, 'T-6 → qa → needs qa');
  console.log('Test 4 passed: in-flight stored directive preferred over higher-ranked in-flight task');
}
{ // Test 5: no candidates -> fallback; none/empty normalised
  assert.deepStrictEqual(resolveNextAction([], [], 'Open next wave'), { value: 'Open next wave', source: 'fallback' });
  for (const v of ['none', 'None', '  NONE  ', '', '   ', null, undefined]) {
    assert.strictEqual(normalizeStaticNextAction(v), null, `Test 5 FAIL: ${JSON.stringify(v)}`);
    assert.deepStrictEqual(resolveNextAction([], [], v), { value: null, source: null });
  }
  assert.strictEqual(normalizeStaticNextAction('T-1 → x'), 'T-1 → x');
  console.log('Test 5 passed: fallback source, and none/empty placeholders normalise to null');
}

{ // Test 8 (T-850): dependency present only under an archived heading counts when terminal-completed
  const archived = (id, status) =>
    `\n## Wave 1 — Archived (mid-wave)\n\n### ${id} — archived dep\n- **Status:** ${status}\n- **Owner role:** developer\n\n`;
  const blockFor = (id, dep) =>
    `### ${id} — gated ${id}\n- **Status:** planned\n- **Owner role:** developer\n- **Depends on:** ${dep}\n\n`;
  const origBacklog = fs.readFileSync(path.join(DEP_ROOT, 'BACKLOG.md'), 'utf8');
  const plannedGated = id => [{ id, title: `gated ${id}`, status: 'planned', owner: 'developer' }];
  try {
    for (const [status, expected] of [['merged', true], ['runtime_verified', true], ['deployed_dev', true],
      ['deployed_prod', true], ['deprecated', false], ['deferred', false], ['planned', false]]) {
      fs.writeFileSync(path.join(DEP_ROOT, 'BACKLOG.md'),
        '# BACKLOG\n\n## Active Wave\n\n' + blockFor('T-20', 'T-21') + archived('T-21', status), 'utf8');
      const r = resolveNextAction([], plannedGated('T-20'), null);
      assert.strictEqual(r.value, expected ? 'T-20 → developer → gated T-20' : null,
        `Test 8 FAIL: archived dep status ${status} expected satisfied=${expected}, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.writeFileSync(path.join(DEP_ROOT, 'BACKLOG.md'), origBacklog, 'utf8');
  }
  console.log('Test 8 passed: archived-section dependency satisfied only for merged/runtime_verified/deployed_*');
}

// ---- Part 2: real --agent subprocess ------------------------------------
{ // Test 6: JSON next_action null + generated PROCESS_STATE.md "- none"
  const dir = makeProject('agent-none', [], { wave: 1, stage: 'execution', next_action: null });
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.md'),
    '# PROCESS_STATE\n\n## Next expected handoff\n- none\n', 'utf8');
  const out = runAgent(dir);
  assert.ok(!('next_action_unverified' in out), 'Test 6 FAIL: next_action_unverified must be absent');
  assert.ok(out.next_action == null || !/^none$/i.test(out.next_action), 'Test 6 FAIL: next_action must never be "none"');
  assert.ok(!('next_action_source' in out), 'Test 6 FAIL: no source when next_action is null');
  console.log('Test 6 passed: --agent emits no next_action_unverified / "none" for the generated placeholder');
}
{ // Test 7: adopter case — stored T-993 (second planned) beats first planned T-990
  const dir = makeProject('agent-stored', [
    { id: 'T-990', title: 'first planned', status: 'planned' },
    { id: 'T-993', title: 'later planned', status: 'planned' },
  ], { wave: 1, stage: 'execution', next_action: 'T-993 → developer → do the second-step' });
  const out = runAgent(dir);
  assert.strictEqual(out.next_action, 'T-993 → developer → do the second-step', 'Test 7 FAIL');
  assert.strictEqual(out.next_action_source, 'stored');
  assert.ok(!('next_action_unverified' in out));
  const dir2 = makeProject('agent-computed', [
    { id: 'T-990', title: 'first planned', status: 'planned' },
    { id: 'T-993', title: 'later planned', status: 'planned', dep: 'T-995' },
  ], { wave: 1, stage: 'execution', next_action: 'T-993 → developer → blocked' });
  const out2 = runAgent(dir2);
  assert.strictEqual(out2.next_action, 'T-990 → developer → first planned', 'Test 7b FAIL');
  assert.strictEqual(out2.next_action_source, 'computed');
  console.log('Test 7 passed: --agent emits stored directive (source=stored) / computed when ineligible');
}

{ // Test 9 (T-850): --agent keeps the stored directive when its dependency was archived as merged
  const makeArchivedProject = (name, archivedStatus, state) => {
    const dir = path.join(BASE, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BACKLOG.md'),
      '# BACKLOG\n\n## Active Wave\n\n' +
      '### T-1 — first task\n- **Status:** planned\n- **Owner role:** developer\n- **Depends on:** T-9\n\n' +
      '### T-2 — second task\n- **Status:** planned\n- **Owner role:** developer\n\n' +
      '## Wave 1 — Archived (mid-wave)\n\n' +
      `### T-9 — archived dep\n- **Status:** ${archivedStatus}\n- **Owner role:** developer\n\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'),
      '# TASK_STATUS\n\n## Active tasks\n\n' +
      '### T-1 — first task\n- **Status:** planned\n- **Owner:** developer\n- **Evidence:** none\n\n' +
      '### T-2 — second task\n- **Status:** planned\n- **Owner:** developer\n- **Evidence:** none\n\n' +
      '## Recently completed tasks\n\n' +
      `### T-9 — archived dep\n- **Status:** ${archivedStatus}\n- **Owner:** developer\n- **Evidence:** commit: abc1234\n\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'),
      JSON.stringify({ wave: 1, stage: 'execution', ...state }, null, 2) + '\n', 'utf8');
    return dir;
  };
  const stored = 'T-1 → developer → do it first';
  const a = runAgent(makeArchivedProject('arch-merged', 'merged', { next_action: stored }));
  assert.strictEqual(a.next_action, stored, 'Test 9 FAIL: stored directive must survive archived-merged dependency');
  assert.strictEqual(a.next_action_source, 'stored');
  const b = runAgent(makeArchivedProject('arch-deferred', 'deferred', { next_action: stored }));
  assert.strictEqual(b.next_action, 'T-2 → developer → second task', 'Test 9b FAIL');
  assert.strictEqual(b.next_action_source, 'computed');
  const c = runAgent(makeArchivedProject('arch-nostored', 'merged', { next_action: null }));
  assert.strictEqual(c.next_action, 'T-1 → developer → first task', 'Test 9c FAIL');
  assert.strictEqual(c.next_action_source, 'computed');
  console.log('Test 9 passed: --agent stored directive survives archived-merged dependency; deferred does not');
}

console.log('All T-807 tests passed');
