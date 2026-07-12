'use strict';
// Regression test: T-350 — classifyNextAction helper + --agent JSON additive
// signals (next_action_unverified / next_action_volatile_facts) + close-session
// preserve notice for freeform next_action carrying volatile facts.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { classifyNextAction } = require('./mavp-operator-lib.js');
const { buildVolatileNextActionNotice } = require('./mavp-operator-close-session.js');

// ---------------------------------------------------------------------------
// Unit tests: classifyNextAction(str) directly
// ---------------------------------------------------------------------------

// Case 1: freeform prose with copied volatile facts — not a directive
{
  const result = classifyNextAction('Wave shipped. Framework v0.25.0, 14 commits unpushed');
  assert.strictEqual(result.directive, false, 'Case 1 FAIL: expected directive false for freeform prose');
  assert.ok(result.volatile_facts.includes('v0.25.0'), `Case 1 FAIL: expected volatile_facts to include "v0.25.0", got ${JSON.stringify(result.volatile_facts)}`);
  assert.ok(
    result.volatile_facts.some(f => /14\s+(?:unpushed\s+)?commits?/i.test(f)),
    `Case 1 FAIL: expected volatile_facts to include a commit-count phrase, got ${JSON.stringify(result.volatile_facts)}`
  );
  console.log('Case 1 passed: classifyNextAction detects freeform prose with semver + commit-count facts');
}

// Case 2: a routing directive — clean, no volatile facts
{
  const result = classifyNextAction('T-123 → developer → fix parser');
  assert.strictEqual(result.directive, true, 'Case 2 FAIL: expected directive true for "T-123 → ..." string');
  assert.deepStrictEqual(result.volatile_facts, [], 'Case 2 FAIL: expected no volatile_facts for a clean directive');
  console.log('Case 2 passed: classifyNextAction recognizes a routing directive with no volatile facts');
}

// Case 3: empty string and null — both treated as directive (no next_action to guard)
{
  const emptyResult = classifyNextAction('');
  assert.strictEqual(emptyResult.directive, true, 'Case 3 FAIL: expected directive true for empty string');
  assert.deepStrictEqual(emptyResult.volatile_facts, [], 'Case 3 FAIL: expected no volatile_facts for empty string');

  const nullResult = classifyNextAction(null);
  assert.strictEqual(nullResult.directive, true, 'Case 3 FAIL: expected directive true for null');
  assert.deepStrictEqual(nullResult.volatile_facts, [], 'Case 3 FAIL: expected no volatile_facts for null');
  console.log('Case 3 passed: classifyNextAction treats empty string and null as directive with no volatile facts');
}

// ---------------------------------------------------------------------------
// Integration: --agent JSON additive fields via a synthetic project
//
// NOTE on isolation strategy: since T-354, mavp-operator-agent.js resolves its
// data ROOT as `process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname,
// '..')` (see the file's `const ROOT = ...` near the top) — the same
// env-var-first pattern used by mavp-operator-lib.js and
// mavp-operator-close-session.js, so a single --agent run reads task/state
// fields and permission fields from the same root. (See
// scripts/test-permission-mode.js for a regression test that redirects
// BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.json via MAVERICKS_PROJECT_ROOT
// directly against the mavericks repo's own copy of the script.)
//
// This test instead mirrors the actual bootstrapped-project deployment
// topology, which remains valuable coverage independent of the ROOT env-var
// fix above: copy mavp-operator-agent.js into a fixture project's own
// scripts/ directory (so its __dirname/.. correctly resolves to the fixture
// root, exactly as a real bootstrapped project's own copy does) and set
// MAVERICKS_SCRIPTS to the real mavericks scripts dir (so it can still
// resolve the shared lib + validator), exactly as a real bootstrapped
// project's bash wrapper does.
// ---------------------------------------------------------------------------

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-next-action-classify-${process.pid}-${Date.now()}`
);

const REAL_SCRIPTS_DIR = __dirname;
const REAL_AGENT_SCRIPT = path.join(REAL_SCRIPTS_DIR, 'mavp-operator-agent.js');

function makeFixtureProject(name, { backlog, taskStatus, processState }) {
  const root = path.join(SCRATCH_ROOT, name);
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n', 'utf8');
  // Copy (not symlink) the real agent script into the fixture's own scripts/
  // dir, matching how a bootstrapped project holds its own copy.
  fs.copyFileSync(REAL_AGENT_SCRIPT, path.join(scriptsDir, 'mavp-operator-agent.js'));
  return { root, scriptPath: path.join(scriptsDir, 'mavp-operator-agent.js') };
}

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanup);

function runAgent(scriptPath) {
  const stdout = execFileSync('node', [scriptPath], {
    env: { ...process.env, MAVERICKS_SCRIPTS: REAL_SCRIPTS_DIR },
    encoding: 'utf8',
    timeout: 10000,
  });
  return JSON.parse(stdout);
}

// Test A: no active/planned tasks, prose next_action with volatile facts ->
// next_action_unverified true, next_action_volatile_facts populated.
{
  const { scriptPath } = makeFixtureProject('prose-next-action', {
    backlog: '# BACKLOG\n\n## Active Wave\n\n',
    taskStatus: '# TASK_STATUS\n\n## Active tasks\n',
    processState: {
      initiative: 'test',
      stage: 'execution',
      wave: 1,
      next_action: 'Wave shipped. Framework v0.25.0, 14 commits unpushed',
      active_slices: [],
    },
  });
  const output = runAgent(scriptPath);
  assert.strictEqual(output.next_action_unverified, true, `Test A FAIL: expected next_action_unverified true. Output: ${JSON.stringify(output)}`);
  assert.ok(Array.isArray(output.next_action_volatile_facts), 'Test A FAIL: expected next_action_volatile_facts array');
  assert.ok(output.next_action_volatile_facts.includes('v0.25.0'), `Test A FAIL: expected "v0.25.0" in next_action_volatile_facts, got ${JSON.stringify(output.next_action_volatile_facts)}`);
  assert.ok(
    output.next_action_volatile_facts.some(f => /14\s+(?:unpushed\s+)?commits?/i.test(f)),
    `Test A FAIL: expected a commit-count phrase in next_action_volatile_facts, got ${JSON.stringify(output.next_action_volatile_facts)}`
  );
  console.log('Test A passed: --agent JSON emits next_action_unverified:true and next_action_volatile_facts for prose next_action with no active/planned tasks');
}

// Test B: directive-shaped next_action referencing an in_progress task ->
// neither new field present, existing next_action_stale behavior unchanged
// (T-123 is in_progress, so it is NOT stale/terminal).
{
  const { scriptPath } = makeFixtureProject('directive-next-action', {
    backlog: '# BACKLOG\n\n## Active Wave\n\n### T-123 — fix parser\n- **Status:** in_progress\n- **Owner role:** developer\n\n',
    taskStatus: '# TASK_STATUS\n\n## Active tasks\n\n### T-123 — fix parser\n- **Status:** in_progress\n\n',
    processState: {
      initiative: 'test',
      stage: 'execution',
      wave: 1,
      next_action: 'T-123 → developer → fix parser',
      active_slices: [],
    },
  });

  const output = runAgent(scriptPath);
  assert.ok(!('next_action_unverified' in output), `Test B FAIL: expected next_action_unverified to be absent, got ${JSON.stringify(output.next_action_unverified)}`);
  assert.ok(!('next_action_volatile_facts' in output), `Test B FAIL: expected next_action_volatile_facts to be absent, got ${JSON.stringify(output.next_action_volatile_facts)}`);
  assert.ok(!('next_action_stale' in output), `Test B FAIL: expected next_action_stale to be absent (T-123 is in_progress, not terminal), got ${JSON.stringify(output.next_action_stale)}`);
  console.log('Test B passed: --agent JSON omits both new fields for a clean directive referencing an in_progress task; next_action_stale unchanged (absent)');
}

// ---------------------------------------------------------------------------
// close-session preserve notice: buildVolatileNextActionNotice(allMerged, currentNextAction)
// ---------------------------------------------------------------------------

// Test C: wave not complete, preserved next_action has volatile facts -> notice text produced
{
  const notice = buildVolatileNextActionNotice(false, 'Framework v0.25.0, 14 commits unpushed');
  assert.ok(typeof notice === 'string' && notice.length > 0, 'Test C FAIL: expected a notice string');
  assert.ok(notice.includes('v0.25.0'), `Test C FAIL: expected notice to include "v0.25.0", got: ${notice}`);
  assert.ok(/14\s+(?:unpushed\s+)?commits?/i.test(notice), `Test C FAIL: expected notice to include a commit-count phrase, got: ${notice}`);
  assert.ok(notice.includes('HANDOFF.md'), `Test C FAIL: expected notice to recommend HANDOFF.md, got: ${notice}`);
  console.log('Test C passed: buildVolatileNextActionNotice produces a HANDOFF.md-recommending notice for a preserved volatile-fact next_action');
}

// Test D: wave not complete, preserved next_action is a clean directive -> no notice
{
  const notice = buildVolatileNextActionNotice(false, 'T-123 → developer → fix parser');
  assert.strictEqual(notice, null, `Test D FAIL: expected null (no notice) for a clean directive, got: ${notice}`);
  console.log('Test D passed: buildVolatileNextActionNotice returns null for a clean directive next_action');
}

// Test E: wave complete (allMerged true) -> no notice regardless of content (no preserve happens)
{
  const notice = buildVolatileNextActionNotice(true, 'Framework v0.25.0, 14 commits unpushed');
  assert.strictEqual(notice, null, `Test E FAIL: expected null when allMerged is true (nothing preserved), got: ${notice}`);
  console.log('Test E passed: buildVolatileNextActionNotice returns null when the wave is complete (no preserve)');
}

// Test F: no current next_action to preserve -> no notice
{
  const notice = buildVolatileNextActionNotice(false, null);
  assert.strictEqual(notice, null, 'Test F FAIL: expected null when currentNextAction is null');
  console.log('Test F passed: buildVolatileNextActionNotice returns null when there is nothing to preserve');
}

console.log('\nAll T-350 next_action classify assertions passed.');
