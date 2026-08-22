'use strict';
// T-700 — failure-batch contrast disclosure in skill-reflect proposals.
//
// Regression coverage for renderFailureContrastDisclosure() in
// mavp-operator-lib.js, added after a real adopter run of
// `--reflect-skill developer` produced a proposal whose stated rationale
// generalized from a single failure (T-098) while the Metadata section
// only reported "Trajectories used: 212 / 304" — a large-looking number
// that hid a one-trajectory contrast from the Section 9 human reviewer.
//
// This test exercises the rendering function with plain fixture objects
// only — zero network, no SDK import — per docs/SKILL_OPTIMIZATION.md
// v1 scope and the offline-testability pattern already used by
// parseOptimizerResponse and splitTrajectoriesForReflect.

const assert = require('node:assert');

const lib = require('./mavp-operator-lib');
const { renderFailureContrastDisclosure, FAILURE_CONTRAST_FLOOR } = lib;

assert.strictEqual(
  typeof renderFailureContrastDisclosure,
  'function',
  'renderFailureContrastDisclosure must be exported as a function from mavp-operator-lib.js'
);

assert.strictEqual(
  FAILURE_CONTRAST_FLOOR,
  3,
  'FAILURE_CONTRAST_FLOOR must be 3, anchored to docs/SKILL_OPTIMIZATION.md §12.2\'s v2 contrast requirement ("≥ 3 with qaOutcome != passed")'
);

const successBatch = [
  { taskId: 'T-050', score: 1.0 },
  { taskId: 'T-051', score: 0.9 },
];

// ---------------------------------------------------------------------------
// Fixture 1: a size-1 failure batch (the exact live-incident shape) renders
// the metadata lines, a low-contrast warning naming the exact count and the
// failure task ID, and a prompt caveat — and is flagged lowContrast: true.
// ---------------------------------------------------------------------------
{
  const failureBatch = [{ taskId: 'T-098', score: 0.1 }];

  const result = renderFailureContrastDisclosure(successBatch, failureBatch);

  assert.strictEqual(result.successCount, 2, 'Fixture 1 FAIL: successCount must be 2');
  assert.strictEqual(result.failureCount, 1, 'Fixture 1 FAIL: failureCount must be 1');
  assert.deepStrictEqual(result.failureIds, ['T-098'], 'Fixture 1 FAIL: failureIds must be [\'T-098\']');
  assert.strictEqual(result.lowContrast, true, 'Fixture 1 FAIL: a size-1 failure batch must be flagged lowContrast');

  assert.ok(
    Array.isArray(result.metadataLines) && result.metadataLines.length === 2,
    'Fixture 1 FAIL: metadataLines must contain exactly two lines'
  );
  assert.ok(
    result.metadataLines.some((l) => l.includes('Success batch size: 2')),
    'Fixture 1 FAIL: metadata must disclose success-batch size'
  );
  assert.ok(
    result.metadataLines.some((l) => l.includes('Failure batch size: 1') && l.includes('T-098')),
    'Fixture 1 FAIL: metadata must disclose failure-batch size AND enumerate the failure task ID'
  );

  assert.ok(typeof result.warning === 'string' && result.warning.length > 0, 'Fixture 1 FAIL: warning must be a non-empty string for a size-1 failure batch');
  assert.ok(result.warning.includes('1'), 'Fixture 1 FAIL: warning must name the exact count (1)');
  assert.ok(result.warning.includes('T-098'), 'Fixture 1 FAIL: warning must name the exact failure task ID (T-098)');

  assert.ok(typeof result.promptCaveat === 'string' && result.promptCaveat.length > 0, 'Fixture 1 FAIL: promptCaveat must be a non-empty string for a size-1 failure batch');
  assert.ok(
    /generaliz/i.test(result.promptCaveat),
    'Fixture 1 FAIL: promptCaveat must instruct the model not to generalize from so few cases'
  );
  assert.ok(
    /prefer proposing no edits/i.test(result.promptCaveat),
    'Fixture 1 FAIL: promptCaveat must instruct the model to prefer proposing no edits over weakly supported ones'
  );
}

// ---------------------------------------------------------------------------
// Fixture 2: a size-2 failure batch is still below the floor of 3 — warning
// and caveat must still be present.
// ---------------------------------------------------------------------------
{
  const failureBatch = [
    { taskId: 'T-098', score: 0.1 },
    { taskId: 'T-099', score: 0.2 },
  ];

  const result = renderFailureContrastDisclosure(successBatch, failureBatch);

  assert.strictEqual(result.lowContrast, true, 'Fixture 2 FAIL: a size-2 failure batch must be flagged lowContrast');
  assert.ok(result.warning, 'Fixture 2 FAIL: warning must be present for a size-2 failure batch');
  assert.ok(result.warning.includes('T-098') && result.warning.includes('T-099'), 'Fixture 2 FAIL: warning must enumerate both failure task IDs');
  assert.ok(result.promptCaveat, 'Fixture 2 FAIL: promptCaveat must be present for a size-2 failure batch');
}

// ---------------------------------------------------------------------------
// Fixture 3: at the contrast floor (size-3), the warning and caveat are
// ABSENT — the metadata lines still disclose size and IDs, but no low-
// contrast warning is added because 3 meets the floor, not below it.
// ---------------------------------------------------------------------------
{
  const failureBatch = [
    { taskId: 'T-098', score: 0.1 },
    { taskId: 'T-099', score: 0.2 },
    { taskId: 'T-100', score: 0.3 },
  ];

  const result = renderFailureContrastDisclosure(successBatch, failureBatch);

  assert.strictEqual(result.failureCount, 3, 'Fixture 3 FAIL: failureCount must be 3');
  assert.strictEqual(result.lowContrast, false, 'Fixture 3 FAIL: a size-3 failure batch must NOT be flagged lowContrast (3 meets the floor)');
  assert.strictEqual(result.warning, null, 'Fixture 3 FAIL: warning must be absent (null) for a size-3 failure batch');
  assert.strictEqual(result.promptCaveat, null, 'Fixture 3 FAIL: promptCaveat must be absent (null) for a size-3 failure batch');

  assert.ok(
    result.metadataLines.some((l) => l.includes('Failure batch size: 3') && l.includes('T-098') && l.includes('T-099') && l.includes('T-100')),
    'Fixture 3 FAIL: metadata must still disclose failure-batch size and enumerate all IDs even without a low-contrast warning'
  );
}

// ---------------------------------------------------------------------------
// Fixture 4: mavp-skill-reflect.js actually wires the disclosure in — never
// blocking (no process.exit added on account of low contrast), the
// disclosure function is called, the warning is printed to stdout, the
// metadata lines land in the proposal, and the prompt caveat is threaded
// into the optimizer prompt (source assertions).
// ---------------------------------------------------------------------------
{
  const fs = require('node:fs');
  const path = require('node:path');
  const reflectSrc = fs.readFileSync(path.join(__dirname, 'mavp-skill-reflect.js'), 'utf8');

  assert.ok(
    reflectSrc.includes('renderFailureContrastDisclosure('),
    'Fixture 4 FAIL: mavp-skill-reflect.js must call renderFailureContrastDisclosure(...)'
  );
  assert.ok(
    reflectSrc.includes('contrastDisclosure.warning'),
    'Fixture 4 FAIL: mavp-skill-reflect.js must reference contrastDisclosure.warning (stdout print + proposal body)'
  );
  assert.ok(
    reflectSrc.includes('contrastDisclosure.metadataLines'),
    'Fixture 4 FAIL: mavp-skill-reflect.js must fold contrastDisclosure.metadataLines into the proposal Metadata section'
  );
  assert.ok(
    reflectSrc.includes('contrastDisclosure.promptCaveat'),
    'Fixture 4 FAIL: mavp-skill-reflect.js must thread contrastDisclosure.promptCaveat into the optimizer prompt'
  );
}

console.log('All T-700 assertions passed.');
