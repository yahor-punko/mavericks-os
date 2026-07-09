'use strict';
// Regression test: T-313 — renderTrajectories RangeError on negative/overflow successPct
//
// Bug: String.repeat() throws RangeError: Invalid count value when given a
// negative count. `filled = Math.round(pct / 10)` could exceed 10
// (successPct > 100) making `10 - filled` negative, or go negative itself
// (successPct < 0). Both must be clamped to [0, 10] before repeat() is called,
// identically to the T-307 fix in renderContextBar.

const assert = require('node:assert');

const { renderTrajectories } = require('./mavp-operator-dashboard.js');

function baseRow(successPct) {
  return {
    role: 'developer',
    count: 10,
    successCount: 8,
    successPct,
    needsFixCount: 0,
    blockedCount: 0,
  };
}

// --- Test 1: empty/missing trajectorySummary returns placeholder without throwing ---
{
  const result = renderTrajectories([]);
  assert.ok(Array.isArray(result), 'Test 1 FAIL: expected an array result for empty trajectorySummary');
  console.log('Test 1 passed: empty trajectorySummary does not throw');
}

// --- Test 2: successPct = 130 (overflow) does not throw and renders full bar ---
{
  let threw = null;
  let result;
  try {
    result = renderTrajectories([baseRow(130)]);
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 2 FAIL: renderTrajectories threw on successPct=130: ${threw && threw.message}`);
  const line = result.join('\n');
  assert.ok(line.includes('██████████'), 'Test 2 FAIL: expected fully-filled bar for successPct=130');
  assert.ok(!line.includes('░'), 'Test 2 FAIL: expected no empty blocks for successPct=130');
  console.log('Test 2 passed: successPct=130 does not throw and renders fully-filled bar');
}

// --- Test 3: successPct = -5 (negative) does not throw and renders empty bar ---
{
  let threw = null;
  let result;
  try {
    result = renderTrajectories([baseRow(-5)]);
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 3 FAIL: renderTrajectories threw on successPct=-5: ${threw && threw.message}`);
  const line = result.join('\n');
  assert.ok(line.includes('░░░░░░░░░░'), 'Test 3 FAIL: expected fully-empty bar for successPct=-5');
  assert.ok(!line.includes('█'), 'Test 3 FAIL: expected no filled blocks for successPct=-5');
  console.log('Test 3 passed: successPct=-5 does not throw and renders empty bar');
}

// --- Test 4: valid mid-range input still renders the expected fill count ---
// (regression guard: clamp must not alter behavior for in-range values)
{
  const result = renderTrajectories([baseRow(50)]);
  const line = result.join('\n');
  assert.ok(line.includes('█████░░░░░'), `Test 4 FAIL: expected '█████░░░░░' for successPct=50, got: ${line}`);
  console.log('Test 4 passed: successPct=50 still renders 5 filled / 5 empty blocks');
}

console.log('\nAll T-313 assertions passed.');
