'use strict';
// Regression test: T-685 — the adopter wrapper produced by buildBashWrapper()
// in mavp-install.js must dispatch every flag the canonical wrapper
// (scripts/mavp-operator) dispatches. T-685 fixed five flags that were
// silently dropped (--archive-merged, --park-wave, --unpark-wave,
// --worktree-report, --prune-worktrees) — before T-679 they fell through to
// the dashboard at exit 0; after T-679 they refuse at exit 1 in every
// adopter project. A hand-maintained baseline of "the five known-missing
// flags" would pin today's gap and miss the next one, so this test instead
// SELF-DERIVES the flag token set from both wrapper sources and asserts set
// equality, modulo an explicit named-exception list (currently empty).
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FRAMEWORK_SCRIPTS = __dirname;
const INSTALL_SCRIPT = path.join(FRAMEWORK_SCRIPTS, 'mavp-install.js');
const CANONICAL_WRAPPER = path.join(FRAMEWORK_SCRIPTS, 'mavp-operator');

// Explicit named-exception list: flags intentionally dispatched by only one
// of the two wrappers. Empty today (T-685) — a future divergence must be
// justified by adding a named entry here, not by weakening the regex below.
const EXPECTED_ASYMMETRIES = new Set([]);

// Extracts the set of `"${1-}" == "--flag"` dispatch tokens from a wrapper's
// literal bash source text. Both wrappers use the identical bash comparison
// shape (the adopter wrapper's generated OUTPUT — not the mavp-install.js
// template-literal source, which escapes the `$` — matches the canonical
// wrapper's syntax byte-for-byte), so one regex works against both.
function extractDispatchedFlags(bashSource) {
  const re = /\$\{1-\}"\s*==\s*"(--[A-Za-z0-9-]+)"/g;
  const flags = new Set();
  let m;
  while ((m = re.exec(bashSource)) !== null) {
    flags.add(m[1]);
  }
  return flags;
}

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const canonicalSource = fs.readFileSync(CANONICAL_WRAPPER, 'utf8');
const canonicalFlags = extractDispatchedFlags(canonicalSource);
assert.ok(canonicalFlags.size > 10, `FAIL: sanity check — extracted only ${canonicalFlags.size} flags from the canonical wrapper, regex likely broken`);
console.log(`Canonical wrapper dispatches ${canonicalFlags.size} flags: ${[...canonicalFlags].sort().join(', ')}`);

const scratch = makeScratchDir('mavp-wrapper-flag-parity-');
let adopterFlags;
try {
  execFileSync('node', [INSTALL_SCRIPT, scratch, '--yes', '--stale-source-ok'], { encoding: 'utf8' });
  const adopterWrapperPath = path.join(scratch, 'scripts', 'mavp-operator');
  assert.ok(fs.existsSync(adopterWrapperPath), 'FAIL: fresh install did not create scripts/mavp-operator');
  const adopterSource = fs.readFileSync(adopterWrapperPath, 'utf8');
  adopterFlags = extractDispatchedFlags(adopterSource);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
assert.ok(adopterFlags.size > 10, `FAIL: sanity check — extracted only ${adopterFlags.size} flags from the generated adopter wrapper, regex likely broken`);
console.log(`Adopter wrapper dispatches ${adopterFlags.size} flags: ${[...adopterFlags].sort().join(', ')}`);

const missingFromAdopter = setDiff(canonicalFlags, adopterFlags).filter((f) => !EXPECTED_ASYMMETRIES.has(f));
const missingFromCanonical = setDiff(adopterFlags, canonicalFlags).filter((f) => !EXPECTED_ASYMMETRIES.has(f));

assert.strictEqual(
  missingFromAdopter.length,
  0,
  `FAIL: canonical wrapper dispatches flag(s) the adopter wrapper does not: ${missingFromAdopter.join(', ')}. ` +
    `Add dispatch (and help text) for these in buildBashWrapper() (scripts/mavp-install.js), or add them to ` +
    `EXPECTED_ASYMMETRIES in this test with a justification if the asymmetry is intentional.`
);
assert.strictEqual(
  missingFromCanonical.length,
  0,
  `FAIL: adopter wrapper dispatches flag(s) the canonical wrapper does not: ${missingFromCanonical.join(', ')}. ` +
    `This usually means a flag was added to buildBashWrapper() without a matching entry in scripts/mavp-operator.`
);

console.log('\nAll T-685 wrapper-flag-parity assertions passed: canonical and adopter dispatch chains are set-equal.');
