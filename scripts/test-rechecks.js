'use strict';
// Unit test: T-265 — computeDueRechecks helper

const assert = require('node:assert');

const { computeDueRechecks } = require('./mavp-operator-lib.js');

// --- Fixtures ---

const TODAY = '2026-06-25';
const YESTERDAY = '2026-06-24';
const LAST_WEEK = '2026-06-18';
const TOMORROW = '2026-06-26';
const NEXT_MONTH = '2026-07-25';

const DUE_TODAY = {
  id: 'RC-1',
  task: 'T-100',
  title: 'Retrain sentiment model',
  due: TODAY,
  interval: '8w',
  armed_at: '2026-04-30',
  note: 'Check accuracy drift',
};

const OVERDUE_YESTERDAY = {
  id: 'RC-2',
  task: 'T-101',
  title: 'Review feature flag TTL',
  due: YESTERDAY,
  armed_at: '2026-05-01',
};

const OVERDUE_OLD = {
  id: 'RC-3',
  task: 'T-102',
  title: 'Audit cache eviction policy',
  due: LAST_WEEK,
  interval: '4w',
  armed_at: '2026-05-21',
};

const FUTURE_TOMORROW = {
  id: 'RC-4',
  task: 'T-103',
  title: 'Verify external API contract',
  due: TOMORROW,
  armed_at: '2026-06-01',
};

const FUTURE_NEXT_MONTH = {
  id: 'RC-5',
  task: 'T-104',
  title: 'Re-evaluate vendor SLA',
  due: NEXT_MONTH,
  armed_at: '2026-06-01',
};

// --- Test 1: due entry (due === today) ---
{
  const result = computeDueRechecks([DUE_TODAY], TODAY);
  assert.strictEqual(result.due.length, 1, 'Test 1 FAIL: expected 1 entry in due');
  assert.strictEqual(result.overdue.length, 0, 'Test 1 FAIL: expected 0 entries in overdue');
  assert.strictEqual(result.due[0].id, 'RC-1', 'Test 1 FAIL: wrong entry in due');
  console.log('Test 1 passed: due entry (due === today)');
}

// --- Test 2: overdue entry (due < today) ---
{
  const result = computeDueRechecks([OVERDUE_YESTERDAY], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 2 FAIL: expected 0 entries in due');
  assert.strictEqual(result.overdue.length, 1, 'Test 2 FAIL: expected 1 entry in overdue');
  assert.strictEqual(result.overdue[0].id, 'RC-2', 'Test 2 FAIL: wrong entry in overdue');
  console.log('Test 2 passed: overdue entry (due < today)');
}

// --- Test 3: future entry not returned ---
{
  const result = computeDueRechecks([FUTURE_TOMORROW, FUTURE_NEXT_MONTH], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 3 FAIL: expected 0 entries in due');
  assert.strictEqual(result.overdue.length, 0, 'Test 3 FAIL: expected 0 entries in overdue');
  console.log('Test 3 passed: future entries excluded');
}

// --- Test 4: malformed due date skipped without throwing ---
{
  const malformedEntries = [
    { id: 'RC-bad1', task: 'T-200', title: 'Missing due field', armed_at: TODAY },
    { id: 'RC-bad2', task: 'T-201', title: 'Null due', due: null, armed_at: TODAY },
    { id: 'RC-bad3', task: 'T-202', title: 'Empty string due', due: '', armed_at: TODAY },
    { id: 'RC-bad4', task: 'T-203', title: 'Invalid format', due: '25-06-2026', armed_at: TODAY },
    { id: 'RC-bad5', task: 'T-204', title: 'Non-string due', due: 20260625, armed_at: TODAY },
    null,
    42,
    'not-an-object',
  ];
  let threw = false;
  let result;
  try {
    result = computeDueRechecks(malformedEntries, TODAY);
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'Test 4 FAIL: computeDueRechecks threw on malformed entries');
  assert.strictEqual(result.due.length, 0, 'Test 4 FAIL: expected 0 due entries for malformed data');
  assert.strictEqual(result.overdue.length, 0, 'Test 4 FAIL: expected 0 overdue entries for malformed data');
  console.log('Test 4 passed: malformed due dates skipped without throwing');
}

// --- Test 5: empty array yields empty result ---
{
  const result = computeDueRechecks([], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 5 FAIL: expected 0 due entries for empty array');
  assert.strictEqual(result.overdue.length, 0, 'Test 5 FAIL: expected 0 overdue entries for empty array');
  console.log('Test 5 passed: empty array yields empty result');
}

// --- Test 6: absent (undefined) rechecks yields empty result ---
{
  const result = computeDueRechecks(undefined, TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 6 FAIL: expected 0 due entries for undefined');
  assert.strictEqual(result.overdue.length, 0, 'Test 6 FAIL: expected 0 overdue entries for undefined');
  console.log('Test 6 passed: undefined rechecks yields empty result');
}

// --- Test 7: null rechecks yields empty result ---
{
  const result = computeDueRechecks(null, TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 7 FAIL: expected 0 due entries for null');
  assert.strictEqual(result.overdue.length, 0, 'Test 7 FAIL: expected 0 overdue entries for null');
  console.log('Test 7 passed: null rechecks yields empty result');
}

// --- Test 8: mixed set — due, overdue, and future entries together ---
{
  const all = [DUE_TODAY, OVERDUE_YESTERDAY, OVERDUE_OLD, FUTURE_TOMORROW, FUTURE_NEXT_MONTH];
  const result = computeDueRechecks(all, TODAY);
  assert.strictEqual(result.due.length, 1, 'Test 8 FAIL: expected 1 due entry');
  assert.strictEqual(result.overdue.length, 2, 'Test 8 FAIL: expected 2 overdue entries');
  assert.strictEqual(result.due[0].id, 'RC-1', 'Test 8 FAIL: wrong entry in due');
  const overdueIds = result.overdue.map((e) => e.id).sort();
  assert.deepStrictEqual(overdueIds, ['RC-2', 'RC-3'], 'Test 8 FAIL: wrong overdue IDs');
  console.log('Test 8 passed: mixed set correctly partitioned');
}

console.log('\nAll T-265 assertions passed.');
