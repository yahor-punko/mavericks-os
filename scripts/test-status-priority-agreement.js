'use strict';
// T-528 — Pin STATUS_PRIORITY/IN_FLIGHT_STATUSES agreement and make the
// unknown-in-flight fallback fail-safe.
//
// Problem: STATUS_PRIORITY in computeNextAction() (mavp-operator-agent.js)
// was a function-local map consulted with a `?? 99` default at three call
// sites. Any status present in IN_FLIGHT_STATUSES (mavp-operator-lib.js) but
// absent from STATUS_PRIORITY therefore silently ranked at 99 — BELOW
// planned's 4 — so next_action could misroute to fresh work while an active
// task sat unaddressed. T-525 added the two entries missing at the time but
// left the hazard open: nothing pinned the two sets against drifting apart
// again.
//
// Fix: STATUS_PRIORITY is promoted to a module-scope, additively-exported
// constant (the CLI JSON output schema is unchanged) so it is directly
// testable; the in-flight candidate call site's `?? 99` fallback becomes
// `?? 3` (the active-development tier) — a candidate reaching that lookup
// has, by construction, already passed the IN_FLIGHT_STATUSES filter, so an
// unrecognised status there is still active work, never absent work. The
// other two STATUS_PRIORITY call sites are pre-filtered to
// PLANNED_STATUSES = {'planned'}, which always has an explicit entry (4) —
// their fallback is dead code in practice and is intentionally left alone.
//
// Covers:
//   1. Unit: every member of IN_FLIGHT_STATUSES plus 'planned' has an
//      explicit STATUS_PRIORITY entry (the set-agreement pin). Deleting any
//      single in-flight key from STATUS_PRIORITY must turn this red.
//   2. Unit: injecting a synthetic status into the exported
//      IN_FLIGHT_STATUSES set (no STATUS_PRIORITY entry for it) and calling
//      computeNextAction() directly routes to that in-flight task ahead of
//      a dependency-free planned task — proving the fail-safe fallback
//      ranks as active work, not below planned. Reverting the fallback to
//      `?? 99` must turn this red.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

// computeNextAction() reads BACKLOG.md internally (for planned-task
// "Depends on:" gating) via a ROOT constant resolved from
// MAVERICKS_PROJECT_ROOT at module load time. Point ROOT at an isolated,
// empty scratch directory BEFORE requiring mavp-operator-agent.js below, so
// this test's fabricated task ids never collide with — or get gated by —
// this repo's real BACKLOG.md contents.
const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-status-priority-agreement-${process.pid}-${Date.now()}`
);
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
process.on('exit', () => fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

const priorEnvRoot = process.env.MAVERICKS_PROJECT_ROOT;
process.env.MAVERICKS_PROJECT_ROOT = SCRATCH_ROOT;

const { IN_FLIGHT_STATUSES } = require('./mavp-operator-lib.js');
const { STATUS_PRIORITY, computeNextAction } = require('./mavp-operator-agent.js');

// Restore the env var for cleanliness — mavp-operator-agent.js's ROOT
// constant is already fixed to SCRATCH_ROOT from the require() above, so
// this has no effect on the module under test; it just avoids leaking the
// override to anything else that might run later in this process.
if (priorEnvRoot === undefined) delete process.env.MAVERICKS_PROJECT_ROOT;
else process.env.MAVERICKS_PROJECT_ROOT = priorEnvRoot;

// ---------------------------------------------------------------------------
// Test 1 — set-agreement: every IN_FLIGHT_STATUSES member (+ 'planned') has
// an explicit STATUS_PRIORITY entry.
// ---------------------------------------------------------------------------
{
  const required = new Set([...IN_FLIGHT_STATUSES, 'planned']);
  const missing = [...required].filter(
    (status) => !Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, status)
  );
  assert.strictEqual(
    missing.length,
    0,
    `Test 1 FAIL: STATUS_PRIORITY is missing explicit entries for: ${missing.join(', ')} ` +
      '(deleting any single in-flight key from STATUS_PRIORITY — e.g. the ux_needs_fix line — must turn this red)'
  );
  console.log('Test 1 passed: STATUS_PRIORITY has an explicit entry for every IN_FLIGHT_STATUSES member plus planned');
}

// ---------------------------------------------------------------------------
// Test 2 — fail-safe fallback: a synthetic in-flight status with NO
// STATUS_PRIORITY entry must still outrank a dependency-free planned task.
// ---------------------------------------------------------------------------
{
  const SYNTHETIC_STATUS = 'synthetic_status_for_test_t528';
  assert.ok(
    !Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, SYNTHETIC_STATUS),
    'Test 2 setup FAIL: synthetic status must not already have a STATUS_PRIORITY entry'
  );

  // Inject the synthetic status into the exported IN_FLIGHT_STATUSES set.
  // require() caches modules, so this is the SAME Set instance
  // computeNextAction's inFlightCandidates filter consults — not a copy.
  IN_FLIGHT_STATUSES.add(SYNTHETIC_STATUS);
  try {
    assert.ok(
      IN_FLIGHT_STATUSES.has(SYNTHETIC_STATUS),
      'Test 2 setup FAIL: injected synthetic status did not land in the exported IN_FLIGHT_STATUSES set'
    );

    const activeTasks = [
      { id: 'T-940001', title: 'a synthetic in-flight task', status: SYNTHETIC_STATUS, owner: 'developer' },
    ];
    // Dependency-free planned task: no entry for this id exists anywhere
    // (the scratch BACKLOG.md doesn't even exist), so computeNextAction's
    // backlogDeps lookup defaults to [] and the every() dependency gate
    // passes trivially — this planned task is genuinely a live candidate,
    // not excluded for an unrelated reason, so the routing result below is
    // evidence of priority ranking, not of the planned task being filtered
    // out of contention.
    const plannedTasks = [
      { id: 'T-940002', title: 'a fresh planned task with no dependencies', status: 'planned', owner: 'developer' },
    ];

    const next_action = computeNextAction(activeTasks, plannedTasks, null);

    assert.ok(
      typeof next_action === 'string' && next_action.startsWith('T-940001'),
      'Test 2 FAIL: expected next_action to route to the synthetic in-flight task T-940001 ahead of the ' +
        `dependency-free planned task T-940002, got: ${JSON.stringify(next_action)} ` +
        '(reverting the fallback to "?? 99" must turn this red)'
    );
    console.log(`Test 2 passed: next_action (${JSON.stringify(next_action)}) routes to the synthetic in-flight status ahead of a dependency-free planned task`);
  } finally {
    IN_FLIGHT_STATUSES.delete(SYNTHETIC_STATUS);
  }
}

console.log('\nAll T-528 assertions passed.');
