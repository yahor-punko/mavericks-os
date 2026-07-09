'use strict';
// Regression test: T-307 — renderContextBar RangeError on negative/overflow context_pct
//
// Bug: String.repeat() throws RangeError: Invalid count value when given a
// negative count. `filled = Math.round(context_pct / 10)` could exceed 10
// (context_pct > 100) making `10 - filled` negative, or go negative itself
// (context_pct < 0). Both must be clamped to [0, 10] before repeat() is called.

const assert = require('node:assert');

const { renderContextBar } = require('./mavp-operator-dashboard.js');

function baseUsage(context_pct) {
  return { context_used: 1000, context_window: 10000, context_pct };
}

// --- Test 1: no token usage returns placeholder without throwing ---
{
  const result = renderContextBar(null);
  assert.ok(typeof result === 'string', 'Test 1 FAIL: expected a string result for null tokenUsage');
  console.log('Test 1 passed: null tokenUsage does not throw');
}

// --- Test 2: negative context_pct does not throw ---
{
  let threw = null;
  let result;
  try {
    result = renderContextBar(baseUsage(-5));
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 2 FAIL: renderContextBar threw on context_pct=-5: ${threw && threw.message}`);
  assert.ok(typeof result === 'string', 'Test 2 FAIL: expected string result for context_pct=-5');
  console.log('Test 2 passed: context_pct=-5 does not throw');
}

// --- Test 3: context_pct = 0 renders without throwing ---
{
  let threw = null;
  let result;
  try {
    result = renderContextBar(baseUsage(0));
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 3 FAIL: renderContextBar threw on context_pct=0: ${threw && threw.message}`);
  assert.ok(typeof result === 'string', 'Test 3 FAIL: expected string result for context_pct=0');
  console.log('Test 3 passed: context_pct=0 does not throw');
}

// --- Test 4: context_pct = 100 (valid boundary) renders without throwing ---
{
  let threw = null;
  let result;
  try {
    result = renderContextBar(baseUsage(100));
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 4 FAIL: renderContextBar threw on context_pct=100: ${threw && threw.message}`);
  assert.ok(typeof result === 'string', 'Test 4 FAIL: expected string result for context_pct=100');
  console.log('Test 4 passed: context_pct=100 does not throw');
}

// --- Test 5: context_pct = 137 (overflow) does not throw ---
{
  let threw = null;
  let result;
  try {
    result = renderContextBar(baseUsage(137));
  } catch (err) {
    threw = err;
  }
  assert.strictEqual(threw, null, `Test 5 FAIL: renderContextBar threw on context_pct=137: ${threw && threw.message}`);
  assert.ok(typeof result === 'string', 'Test 5 FAIL: expected string result for context_pct=137');
  console.log('Test 5 passed: context_pct=137 does not throw');
}

// --- Test 6: valid mid-range input still renders the expected fill count ---
// (regression guard: clamp must not alter behavior for in-range values)
{
  const result = renderContextBar(baseUsage(50));
  const filledBlocks = (result.match(/█/g) || []).length;
  const emptyBlocks = (result.match(/░/g) || []).length;
  assert.strictEqual(filledBlocks, 5, `Test 6 FAIL: expected 5 filled blocks for context_pct=50, got ${filledBlocks}`);
  assert.strictEqual(emptyBlocks, 5, `Test 6 FAIL: expected 5 empty blocks for context_pct=50, got ${emptyBlocks}`);
  console.log('Test 6 passed: context_pct=50 still renders 5 filled / 5 empty blocks');
}

console.log('\nAll T-307 assertions passed.');
