'use strict';
// T-629 (RC-2, docs/rca/2026-08-operator-channel-state-artifacts.md):
// --close-session, when sweeping completed tasks (merged/deployed_dev/
// deployed_prod/runtime_verified), must check each task's literal task id
// against EXECUTION_LOG.md's full text and print a prominently placed
// non-blocking warning line — before the results table — listing every id
// with zero occurrences. No warning line when all ids are present. Deferred
// and deprecated tasks are never checked. The close must never abort on this
// condition regardless of the outcome.
//
// Coverage:
//   Part 1 (unit) — findExecutionLogOmissions(): fired / silent / mixed, plus
//     dedup and a missing-EXECUTION_LOG.md-content edge (empty string treated
//     as "every id missing").
//   Part 2 (end-to-end, fixture artifacts) — FIRED: a real close-session run
//     against a fixture repo whose EXECUTION_LOG.md mentions neither
//     completed task id; asserts the warning line prints, names both ids,
//     cites "RC-2" and the RCA doc path, appears BEFORE the results table,
//     and the run still exits 0 (non-blocking).
//   Part 3 (end-to-end) — SILENT: EXECUTION_LOG.md mentions both ids; no
//     warning line prints at all.
//   Part 4 (end-to-end) — MIXED: EXECUTION_LOG.md mentions only one of two
//     completed ids; the warning names only the missing one.
//   Part 5 — deferred/deprecated entries swept out of Active tasks alongside
//     a completed task are never named in the warning, even when absent from
//     EXECUTION_LOG.md.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { findExecutionLogOmissions } = require('./mavp-operator-close-session.js');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't629-execlog-'));

function newFixtureDir(label) {
  const dir = path.join(TMP_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCloseSession(dir, argv = ['--non-interactive']) {
  const r = spawnSync('node', [CLOSE_SESSION_PATH, ...argv], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    input: '',
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function writeProcessState(dir, overrides) {
  const state = {
    initiative: 'T-629 test fixture',
    stage: 'execution',
    wave: 90,
    wave_session: 3,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 902,
    last_updated: '2026-08-15',
    deploy_contours: 0,
    wave_summary: 'Wave 89: prior wave.',
    rechecks: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Two completed (merged, verification_type: artifact) tasks — T-900, T-901 —
 * already terminal when the run starts (mirrors buildIncidentFixture's
 * pattern in test-close-session-terminal-sweep.js), plus optional extra
 * BACKLOG/Active-tasks text for the deferred/deprecated fixture in Part 5.
 */
function buildFixture(dir, { executionLog = null, extraActive = '', extraBacklog = '', processState = {} } = {}) {
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave
${extraBacklog}
## Wave 89 — Archived

### T-900 — Fixture task one
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact

### T-901 — Fixture task two
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-900 — Fixture task one
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** artifact: fixture
- **Notes:** —

### T-901 — Fixture task two
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** artifact: fixture
- **Notes:** —
${extraActive}
## Recently completed tasks
`, 'utf8');

  writeProcessState(dir, processState);

  if (executionLog !== null) {
    fs.writeFileSync(path.join(dir, 'EXECUTION_LOG.md'), executionLog, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Part 1 — unit: findExecutionLogOmissions()
// ---------------------------------------------------------------------------
{
  // Fired: neither id present.
  const fired = findExecutionLogOmissions(
    [{ id: 'T-900', status: 'merged' }, { id: 'T-901', status: 'merged' }],
    '# EXECUTION_LOG\n\n- 2026-08-01 — T-800 spawned developer.\n'
  );
  assert.deepStrictEqual(fired, ['T-900', 'T-901'], `Part 1 FAIL (fired): got ${JSON.stringify(fired)}`);

  // Silent: both present anywhere in the text.
  const silent = findExecutionLogOmissions(
    [{ id: 'T-900', status: 'merged' }, { id: 'T-901', status: 'merged' }],
    '# EXECUTION_LOG\n\n- 2026-08-01 — T-900 spawned developer. tool_uses: 40/140 outcome: completed\n- 2026-08-02 — T-901 registered.\n'
  );
  assert.deepStrictEqual(silent, [], `Part 1 FAIL (silent): got ${JSON.stringify(silent)}`);

  // Mixed: T-900 present, T-901 not.
  const mixed = findExecutionLogOmissions(
    [{ id: 'T-900', status: 'merged' }, { id: 'T-901', status: 'merged' }],
    '# EXECUTION_LOG\n\n- 2026-08-01 — T-900 spawned developer.\n'
  );
  assert.deepStrictEqual(mixed, ['T-901'], `Part 1 FAIL (mixed): got ${JSON.stringify(mixed)}`);

  // Dedup: same id twice in the input records only ever reported once.
  const deduped = findExecutionLogOmissions(
    [{ id: 'T-900', status: 'merged' }, { id: 'T-900', status: 'merged' }],
    ''
  );
  assert.deepStrictEqual(deduped, ['T-900'], `Part 1 FAIL (dedup): got ${JSON.stringify(deduped)}`);

  // Empty/absent content degrades to "every id missing", never throws.
  const emptyContent = findExecutionLogOmissions([{ id: 'T-900', status: 'merged' }], '');
  assert.deepStrictEqual(emptyContent, ['T-900'], `Part 1 FAIL (empty content): got ${JSON.stringify(emptyContent)}`);
  const nullContent = findExecutionLogOmissions([{ id: 'T-900', status: 'merged' }], null);
  assert.deepStrictEqual(nullContent, ['T-900'], `Part 1 FAIL (null content): got ${JSON.stringify(nullContent)}`);

  // Deferred/deprecated records are this function's caller's business (see
  // its doc comment) — mergedTaskRecords never contains them by construction.
  // This just confirms the function itself has no status filter of its own
  // that could silently diverge from that contract.
  const anyStatus = findExecutionLogOmissions([{ id: 'T-902', status: 'deferred' }], '');
  assert.deepStrictEqual(anyStatus, ['T-902'], `Part 1 FAIL: function unexpectedly filters by status`);

  console.log('Part 1 (unit: findExecutionLogOmissions fired/silent/mixed/dedup/empty) passed.');
}

// ---------------------------------------------------------------------------
// Part 2 — end-to-end FIRED: EXECUTION_LOG.md mentions neither completed id.
// ---------------------------------------------------------------------------
{
  const dir = newFixtureDir('fired');
  buildFixture(dir, { executionLog: '# EXECUTION_LOG\n\n- 2026-08-01 — T-800 spawned developer. tool_uses: 12/140 outcome: completed\n' });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 2 FAIL: close-session must not abort on this condition, got exit ${status}:\n${out}`);

  assert.ok(
    out.includes('EXECUTION_LOG.md has no entry for: T-900, T-901'),
    `Part 2 FAIL: expected the warning naming both T-900 and T-901, got:\n${out}`
  );
  assert.ok(
    out.includes('RC-2') && out.includes('docs/rca/2026-08-operator-channel-state-artifacts.md'),
    `Part 2 FAIL: expected the warning to cite RC-2 and the RCA doc path, got:\n${out}`
  );

  const warnIdx = out.indexOf('EXECUTION_LOG.md has no entry for:');
  const tableIdx = out.indexOf('Сессия завершена');
  assert.ok(warnIdx !== -1 && tableIdx !== -1 && warnIdx < tableIdx,
    `Part 2 FAIL: warning must print BEFORE the results table. warnIdx=${warnIdx} tableIdx=${tableIdx}\n${out}`);

  console.log('Part 2 (end-to-end: fired — both ids missing) passed.');
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end SILENT: EXECUTION_LOG.md mentions both completed ids.
// ---------------------------------------------------------------------------
{
  const dir = newFixtureDir('silent');
  buildFixture(dir, {
    executionLog: '# EXECUTION_LOG\n\n- 2026-08-01 — T-900 spawned developer. tool_uses: 12/140 outcome: completed\n' +
      '- 2026-08-02 — T-901 spawned developer. tool_uses: 20/140 outcome: completed\n',
  });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 3 FAIL: unexpected exit ${status}:\n${out}`);
  assert.ok(
    !out.includes('EXECUTION_LOG.md has no entry for:'),
    `Part 3 FAIL: no warning line expected when all ids are present, got:\n${out}`
  );

  console.log('Part 3 (end-to-end: silent — both ids present) passed.');
}

// ---------------------------------------------------------------------------
// Part 4 — end-to-end MIXED: only T-901 is missing.
// ---------------------------------------------------------------------------
{
  const dir = newFixtureDir('mixed');
  buildFixture(dir, {
    executionLog: '# EXECUTION_LOG\n\n- 2026-08-01 — T-900 spawned developer. tool_uses: 12/140 outcome: completed\n',
  });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 4 FAIL: unexpected exit ${status}:\n${out}`);
  assert.ok(
    out.includes('EXECUTION_LOG.md has no entry for: T-901'),
    `Part 4 FAIL: expected the warning to name only T-901, got:\n${out}`
  );
  assert.ok(
    !/no entry for:[^\n]*T-900/.test(out),
    `Part 4 FAIL: T-900 (present in the log) must not be named, got:\n${out}`
  );

  console.log('Part 4 (end-to-end: mixed — only the missing id is named) passed.');
}

// ---------------------------------------------------------------------------
// Part 5 — deferred/deprecated entries swept alongside a completed task are
// never named, even though they too are absent from EXECUTION_LOG.md.
// ---------------------------------------------------------------------------
{
  const dir = newFixtureDir('deferred-deprecated-excluded');
  buildFixture(dir, {
    executionLog: '# EXECUTION_LOG\n\n- 2026-08-01 — T-900 spawned developer. tool_uses: 12/140 outcome: completed\n' +
      '- 2026-08-02 — T-901 spawned developer. tool_uses: 20/140 outcome: completed\n',
    extraActive: `
### T-902 — Deferred sibling
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

### T-903 — Deprecated sibling
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —
`,
    extraBacklog: `
### T-902 — Deferred sibling
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact

### T-903 — Deprecated sibling
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** artifact
`,
  });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 5 FAIL: unexpected exit ${status}:\n${out}`);
  assert.ok(
    !out.includes('EXECUTION_LOG.md has no entry for:'),
    `Part 5 FAIL: no warning expected (T-900/T-901 both present, T-902/T-903 must never be checked), got:\n${out}`
  );

  console.log('Part 5 (deferred/deprecated entries are never checked) passed.');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

console.log('All T-629 assertions passed.');
