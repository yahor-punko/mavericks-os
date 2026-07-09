'use strict';
// Regression test: T-253 — resolveMode() precedence in mavp-operator-close-session.js

const assert = require('node:assert');

const { resolveMode } = require('./mavp-operator-close-session.js');

// 1. --interactive flag always wins → 'interactive'
assert.strictEqual(
  resolveMode({ interactive: true }),
  'interactive',
  'Case 1 FAIL: interactive:true should return "interactive"'
);

// 2. --non-interactive flag (no --interactive) → 'non-interactive'
assert.strictEqual(
  resolveMode({ nonInteractive: true }),
  'non-interactive',
  'Case 2 FAIL: nonInteractive:true should return "non-interactive"'
);

// 3. No flags, TTY detected → 'interactive'
assert.strictEqual(
  resolveMode({ isTTY: true }),
  'interactive',
  'Case 3 FAIL: isTTY:true with no flags should return "interactive"'
);

// 4. No flags, non-TTY → 'non-interactive'
assert.strictEqual(
  resolveMode({ isTTY: false }),
  'non-interactive',
  'Case 4 FAIL: isTTY:false with no flags should return "non-interactive"'
);

// 5. No flags, isTTY undefined (e.g. piped stdin) → 'non-interactive'
assert.strictEqual(
  resolveMode({ isTTY: undefined }),
  'non-interactive',
  'Case 5 FAIL: isTTY:undefined with no flags should return "non-interactive"'
);

// 6. Both --interactive and --non-interactive set → --interactive wins
assert.strictEqual(
  resolveMode({ interactive: true, nonInteractive: true }),
  'interactive',
  'Case 6 FAIL: interactive:true should win over nonInteractive:true'
);

// 7. --non-interactive set, TTY present → explicit flag beats TTY detect
assert.strictEqual(
  resolveMode({ nonInteractive: true, isTTY: true }),
  'non-interactive',
  'Case 7 FAIL: nonInteractive:true should win over isTTY:true'
);

console.log('All T-253 assertions passed.');
