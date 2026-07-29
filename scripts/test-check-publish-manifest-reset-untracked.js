'use strict';
// Regression test: T-529 — reset-bucket keys may be untracked, but their
// mapped STARTER path must stay git-tracked.
//
// scripts/check-publish-manifest.js's validateManifest() treats any manifest
// path absent from `git ls-files` as a STALE entry — a fail-closed default
// that is correct for `ship`/`exclude` entries but wrong for `reset` entries
// after T-529: a reset destination (e.g. .claude/settings.json) is a
// live-state artifact the assembler always repopulates from its mapped
// `templates/` starter, never from the live file, so nothing requires the
// destination path itself to be tracked. The narrow replacement invariant is
// that the STARTER path must still be tracked, since that is what ships.
//
// This test exercises validateManifest() directly against fixture data (the
// same pattern scripts/test-publish-overlay.js Tests 2/3 use) — no git
// fixture needed, since validateManifest() is a pure function of
// (manifest, trackedList).
//
// Covers the invariant BOTH ways:
//   Test 1: an untracked reset key whose starter IS tracked passes cleanly
//           (no STALE finding, no RESET STARTER UNTRACKED finding).
//   Test 2 (mutation): the same reset key's starter is ALSO untracked —
//           validateManifest() must now fail, naming the destination and its
//           untracked starter, and the killer is a "RESET STARTER UNTRACKED"
//           problem entry (not a plain STALE finding, which is deliberately
//           suppressed for reset keys).
//   Test 3 (regression): a non-reset (ship) path that is untracked is still
//           reported as a plain STALE entry — the T-529 exemption is narrow
//           to reset keys only, it must not silently swallow real staleness
//           elsewhere in the manifest.

const assert = require('node:assert');
const { validateManifest } = require('./check-publish-manifest.js');

const DEST = '.claude/settings.json';
const STARTER = 'templates/SETTINGS_TEMPLATE.json';

function baseManifest() {
  return {
    ship: ['a.js', STARTER],
    reset: { [DEST]: STARTER },
    exclude: {},
    preserve: {},
  };
}

// ---------------------------------------------------------------------------
// Test 1: untracked reset key + tracked starter -> passes cleanly.
// ---------------------------------------------------------------------------
{
  const manifest = baseManifest();
  const tracked = ['a.js', STARTER]; // DEST intentionally absent (untracked)

  const result = validateManifest(manifest, tracked);

  assert.strictEqual(
    result.ok,
    true,
    `Test 1 FAIL: expected an untracked reset key with a tracked starter to pass, got problems:\n${JSON.stringify(result.problems, null, 2)}`
  );
  const staleTitles = result.problems.filter((p) => p.title.startsWith('STALE'));
  assert.strictEqual(staleTitles.length, 0, 'Test 1 FAIL: untracked reset key must not be reported as a STALE entry');
  console.log('Test 1 passed: untracked reset destination with a git-tracked starter passes (no STALE finding).');
}

// ---------------------------------------------------------------------------
// Test 2 (mutation): untracked reset key + starter ALSO untracked -> fails,
// naming the destination and starter via a RESET STARTER UNTRACKED problem.
// ---------------------------------------------------------------------------
{
  const manifest = baseManifest();
  const tracked = ['a.js']; // both DEST and STARTER are untracked now

  const result = validateManifest(manifest, tracked);

  assert.strictEqual(
    result.ok,
    false,
    'Test 2 FAIL: expected validateManifest() to fail when a reset key\'s starter is also untracked'
  );
  const killer = result.problems.find((p) => p.title.startsWith('RESET STARTER UNTRACKED'));
  assert.ok(
    killer,
    `Test 2 FAIL: expected a "RESET STARTER UNTRACKED" problem, got:\n${JSON.stringify(result.problems, null, 2)}`
  );
  assert.ok(
    killer.lines.some((line) => line.includes(DEST) && line.includes(STARTER)),
    `Test 2 FAIL: expected the RESET STARTER UNTRACKED line to name both "${DEST}" and "${STARTER}", got:\n${killer.lines.join('\n')}`
  );
  console.log(
    `Test 2 passed (killer named): mutating the starter to also be untracked flips validateManifest() to fail via ` +
      `"${killer.title}" naming ${DEST} -> ${STARTER}.`
  );
}

// ---------------------------------------------------------------------------
// Test 3 (regression): a non-reset (ship) path being untracked is still a
// plain STALE finding — the T-529 exemption must stay narrow to reset keys.
// ---------------------------------------------------------------------------
{
  const manifest = baseManifest();
  const tracked = [STARTER]; // 'a.js' (a ship entry) is untracked; DEST also untracked but starter is tracked

  const result = validateManifest(manifest, tracked);

  assert.strictEqual(
    result.ok,
    false,
    'Test 3 FAIL: expected validateManifest() to fail when a SHIP entry is untracked (unrelated to the reset exemption)'
  );
  const stale = result.problems.find((p) => p.title.startsWith('STALE'));
  assert.ok(stale, `Test 3 FAIL: expected a plain STALE finding for the untracked ship entry, got:\n${JSON.stringify(result.problems, null, 2)}`);
  assert.ok(
    stale.lines.includes('a.js'),
    `Test 3 FAIL: expected the STALE finding to name "a.js", got:\n${stale.lines.join('\n')}`
  );
  assert.ok(
    !stale.lines.includes(DEST),
    `Test 3 FAIL: the untracked reset destination "${DEST}" must NOT appear in the STALE finding (it has its own exemption)`
  );
  console.log('Test 3 passed: an untracked SHIP entry is still reported as a plain STALE finding — the reset exemption stays narrow.');
}

console.log('\nAll T-529 reset-untracked invariant assertions passed.');
