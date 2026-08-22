'use strict';
// T-699 — deterministic stratified train/holdout split in skill-reflect.
//
// Regression coverage for splitTrajectoriesForReflect() in
// mavp-operator-lib.js, which replaced a taskId-localeCompare-prefix-slice
// split measured (on a real adopter corpus of 304 trajectories) to be
// chronological — holdout silently accumulated only the newest era, so
// BOTH of the corpus's two most recent failures sat in holdout, structurally
// unreachable to the optimizer, while training contained only one failure
// out of three total. This test exercises the fixed split with plain
// fixture objects only — zero network, no SDK import.

const assert = require('node:assert');

const lib = require('./mavp-operator-lib');
const { splitTrajectoriesForReflect } = lib;

assert.strictEqual(
  typeof splitTrajectoriesForReflect,
  'function',
  'splitTrajectoriesForReflect must be exported as a function from mavp-operator-lib.js'
);

// ---------------------------------------------------------------------------
// Fixture 1: a failure with the highest-numbered taskId lands in train.
//
// Under the OLD split (sort by taskId, prefix-slice 70% into train), the
// highest-numbered taskId always sorts last and would land in holdout no
// matter its score — exactly the defect measured on the real corpus (recent
// failures unreachable to the optimizer). The new rule sends every
// below-0.7 trajectory to train unconditionally, regardless of taskId.
// ---------------------------------------------------------------------------
{
  const scored = [
    { taskId: 'T-1', score: 1.0 },
    { taskId: 'T-2', score: 1.0 },
    { taskId: 'T-3', score: 1.0 },
    { taskId: 'T-4', score: 1.0 },
    { taskId: 'T-5', score: 1.0 },
    { taskId: 'T-6', score: 1.0 },
    { taskId: 'T-7', score: 1.0 },
    { taskId: 'T-8', score: 1.0 },
    { taskId: 'T-9', score: 1.0 },
    { taskId: 'T-999', score: 0.2 }, // highest-numbered id, a failure
  ];

  const { trainSet, holdoutSet } = splitTrajectoriesForReflect(scored);

  assert.ok(
    trainSet.some((t) => t.taskId === 'T-999'),
    'Fixture 1 FAIL: the failure with the highest-numbered taskId (T-999) must land in train'
  );
  assert.ok(
    !holdoutSet.some((t) => t.taskId === 'T-999'),
    'Fixture 1 FAIL: T-999 must NOT appear in holdout'
  );
}

// ---------------------------------------------------------------------------
// Fixture 2: determinism — two calls on identical input produce identical
// partitions (no RNG, no clock, no run-order dependence).
// ---------------------------------------------------------------------------
{
  const scored = [
    { taskId: 'T-101', score: 1.0 },
    { taskId: 'T-107', score: 1.0 },
    { taskId: 'T-118', score: 0.8 },
    { taskId: 'T-129', score: 0.9 },
    { taskId: 'T-130', score: 0.1 },
    { taskId: 'T-2007', score: 1.0 },
    { taskId: 'T-abc', score: 0.75 }, // unparsable id
  ];

  const run1 = splitTrajectoriesForReflect(scored);
  const run2 = splitTrajectoriesForReflect(scored);

  assert.deepStrictEqual(
    run1.trainSet.map((t) => t.taskId),
    run2.trainSet.map((t) => t.taskId),
    'Fixture 2 FAIL: trainSet must be identical across repeated calls on the same input'
  );
  assert.deepStrictEqual(
    run1.holdoutSet.map((t) => t.taskId),
    run2.holdoutSet.map((t) => t.taskId),
    'Fixture 2 FAIL: holdoutSet must be identical across repeated calls on the same input'
  );
}

// ---------------------------------------------------------------------------
// Fixture 3: a mixed 3-digit/4-digit corpus partitions by NUMERIC value, not
// string order. String order ("T-9" > "T-1000") would badly misclassify a
// four-digit id relative to a three-digit one beginning with a higher digit
// — the exact lexicographic-ordering defect the old split had at scale.
// ---------------------------------------------------------------------------
{
  const scored = [
    { taskId: 'T-999', score: 1.0 },  // numeric 999 % 10 = 9 -> holdout
    { taskId: 'T-1000', score: 1.0 }, // numeric 1000 % 10 = 0 -> train
    { taskId: 'T-1008', score: 1.0 }, // numeric 1008 % 10 = 8 -> holdout
    { taskId: 'T-901', score: 1.0 },  // numeric 901 % 10 = 1 -> train
  ];

  const { trainSet, holdoutSet } = splitTrajectoriesForReflect(scored);
  const trainIds = trainSet.map((t) => t.taskId).sort();
  const holdoutIds = holdoutSet.map((t) => t.taskId).sort();

  assert.deepStrictEqual(
    trainIds,
    ['T-1000', 'T-901'],
    'Fixture 3 FAIL: train must be selected by numeric id modulo, not lexicographic string order'
  );
  assert.deepStrictEqual(
    holdoutIds,
    ['T-1008', 'T-999'],
    'Fixture 3 FAIL: holdout must be selected by numeric id modulo, not lexicographic string order'
  );
}

// ---------------------------------------------------------------------------
// Fixture 4: unparsable taskId goes to train deterministically.
// ---------------------------------------------------------------------------
{
  const scored = [
    { taskId: 'not-a-task-id', score: 1.0 },
    { taskId: '', score: 1.0 },
  ];

  const { trainSet, holdoutSet } = splitTrajectoriesForReflect(scored);

  assert.strictEqual(trainSet.length, 2, 'Fixture 4 FAIL: both unparsable ids must land in train');
  assert.strictEqual(holdoutSet.length, 0, 'Fixture 4 FAIL: no unparsable id may land in holdout');
}

// ---------------------------------------------------------------------------
// Fixture 5: mavp-skill-reflect.js actually consumes splitTrajectoriesForReflect
// in place of the inline sort/slice it used to have (source assertion).
// ---------------------------------------------------------------------------
{
  const fs = require('node:fs');
  const path = require('node:path');
  const reflectSrc = fs.readFileSync(path.join(__dirname, 'mavp-skill-reflect.js'), 'utf8');

  assert.ok(
    reflectSrc.includes('splitTrajectoriesForReflect('),
    'Fixture 5 FAIL: mavp-skill-reflect.js must call splitTrajectoriesForReflect(...)'
  );
  assert.ok(
    !reflectSrc.includes('.sort((a, b) => a.taskId.localeCompare(b.taskId))'),
    'Fixture 5 FAIL: mavp-skill-reflect.js must not retain the old localeCompare sort/slice call'
  );
}

console.log('All T-699 assertions passed.');
