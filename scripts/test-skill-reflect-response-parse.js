'use strict';
// Regression test: T-697 — mavp-skill-reflect.js optimizer response handling
// mislabelled response-shape failures (a non-text block first, e.g. a
// `thinking` block, causing the block-zero-indexed text access to evaluate
// to undefined) as transport ("API call failed:") failures. This test
// exercises the fixed selection logic, `parseOptimizerResponse()` in
// mavp-operator-lib.js, using only plain fixture objects — zero network,
// no SDK import.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const lib = require('./mavp-operator-lib');
const { parseOptimizerResponse } = lib;

assert.strictEqual(
  typeof parseOptimizerResponse,
  'function',
  'parseOptimizerResponse must be exported as a function from mavp-operator-lib.js'
);

// ---------------------------------------------------------------------------
// Fixture 1: thinking-block-first regression (the actual reported defect)
// ---------------------------------------------------------------------------
{
  const validPayload = { rationale: 'test rationale', edits: [] };
  const response = {
    content: [
      { type: 'thinking', thinking: 'reasoning about the trajectories...' },
      { type: 'text', text: JSON.stringify(validPayload) },
    ],
    stop_reason: 'end_turn',
  };

  const { result, error } = parseOptimizerResponse(response);

  assert.strictEqual(error, null, `Fixture 1 FAIL: expected no error, got: ${error}`);
  assert.deepStrictEqual(
    result,
    validPayload,
    'Fixture 1 FAIL: expected parsed result to match the text block payload'
  );
}

// ---------------------------------------------------------------------------
// Fixture 2: plain happy path (single text block, no thinking block)
// ---------------------------------------------------------------------------
{
  const validPayload = { rationale: 'plain happy path', edits: [{ op: 'add', targetSection: 'end of file', rationale: 'r', before: '', after: 'x' }] };
  const response = {
    content: [{ type: 'text', text: JSON.stringify(validPayload) }],
    stop_reason: 'end_turn',
  };

  const { result, error } = parseOptimizerResponse(response);

  assert.strictEqual(error, null, `Fixture 2 FAIL: expected no error, got: ${error}`);
  assert.deepStrictEqual(result, validPayload, 'Fixture 2 FAIL: expected parsed result to match payload');
}

// ---------------------------------------------------------------------------
// Fixture 3: prose-wrapped JSON — extracted via the embedded-brace fallback
// ---------------------------------------------------------------------------
{
  const validPayload = { rationale: 'wrapped in prose', edits: [] };
  const response = {
    content: [
      {
        type: 'text',
        text: `Sure, here is the JSON you requested:\n${JSON.stringify(validPayload)}\nLet me know if you need anything else.`,
      },
    ],
    stop_reason: 'end_turn',
  };

  const { result, error } = parseOptimizerResponse(response);

  assert.strictEqual(error, null, `Fixture 3 FAIL: expected no error, got: ${error}`);
  assert.deepStrictEqual(result, validPayload, 'Fixture 3 FAIL: expected parsed result extracted from surrounding prose');
}

// ---------------------------------------------------------------------------
// Fixture 4: no text block at all — must be an honest response-shape error,
// not a transport error, and must name the block types + stop_reason.
// ---------------------------------------------------------------------------
{
  const response = {
    content: [{ type: 'thinking', thinking: 'still reasoning, ran out of budget' }],
    stop_reason: 'max_tokens',
  };

  const { result, error } = parseOptimizerResponse(response);

  assert.strictEqual(result, null, 'Fixture 4 FAIL: expected result to be null when no text block exists');
  assert.ok(error, 'Fixture 4 FAIL: expected a non-null error');
  assert.ok(
    !error.includes('API call failed'),
    `Fixture 4 FAIL: response-shape error must NOT contain "API call failed", got: ${error}`
  );
  assert.ok(
    error.includes('thinking'),
    `Fixture 4 FAIL: error must name the block types present (expected "thinking"), got: ${error}`
  );
  assert.ok(
    error.includes('max_tokens'),
    `Fixture 4 FAIL: error must name the stop_reason (expected "max_tokens"), got: ${error}`
  );
}

// ---------------------------------------------------------------------------
// Fixture 5: unparseable text — parse error must include a snippet (first
// 200 chars of the raw text) and the stop_reason, so a budget-truncated
// text block is diagnosable.
// ---------------------------------------------------------------------------
{
  const truncatedText = '{"rationale": "this looks like JSON but never closes and keeps going on and on ' + 'x'.repeat(300);
  const response = {
    content: [{ type: 'text', text: truncatedText }],
    stop_reason: 'max_tokens',
  };

  const { result, error } = parseOptimizerResponse(response);

  assert.strictEqual(result, null, 'Fixture 5 FAIL: expected result to be null on unparseable text');
  assert.ok(error, 'Fixture 5 FAIL: expected a non-null error');
  assert.ok(
    error.includes(truncatedText.slice(0, 200)),
    'Fixture 5 FAIL: error must include the first 200 chars of the raw text'
  );
  assert.ok(
    error.includes('max_tokens'),
    `Fixture 5 FAIL: error must name the stop_reason (expected "max_tokens"), got: ${error}`
  );
}

// ---------------------------------------------------------------------------
// Source assertion: mavp-skill-reflect.js must no longer index block zero
// directly (the exact bug pattern) and must route response handling through
// parseOptimizerResponse.
// ---------------------------------------------------------------------------
{
  const reflectSrc = fs.readFileSync(path.join(__dirname, 'mavp-skill-reflect.js'), 'utf8');

  // Built at runtime (concatenation) so this file itself never contains the
  // literal block-zero indexing pattern as a contiguous substring — see
  // .claude/rules/scripts.md "Reserved shapes" for why a static matcher's
  // detection target must not be reproduced literally in prose about it.
  const blockZeroIndexingPattern = 'content' + '[0]';

  assert.ok(
    !reflectSrc.includes(blockZeroIndexingPattern),
    'Source assertion FAIL: mavp-skill-reflect.js must not contain the block-zero indexing pattern'
  );

  assert.ok(
    reflectSrc.includes('parseOptimizerResponse('),
    'Source assertion FAIL: mavp-skill-reflect.js must call parseOptimizerResponse(...)'
  );

  assert.ok(
    reflectSrc.includes('max_tokens: 8000'),
    'Source assertion FAIL: mavp-skill-reflect.js must request max_tokens: 8000'
  );

  assert.ok(
    !reflectSrc.includes('thinking:'),
    'Source assertion FAIL: mavp-skill-reflect.js must not add a thinking: request parameter'
  );
}

console.log('All T-697 assertions passed.');
