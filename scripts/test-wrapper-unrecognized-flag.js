'use strict';
// Regression test: T-679 — both operator wrappers (canonical
// scripts/mavp-operator and the adopter wrapper produced by
// buildBashWrapper() in mavp-install.js) must gate their dashboard
// fall-through branch on zero-args-or-`--watch` and refuse any other
// unrecognized argument at exit 1, instead of silently rendering the
// dashboard at exit 0.
//
// Before this fix, both wrappers ended their dispatch chain in a bare
// `else` that fell through to the dashboard for ANY unrecognized flag —
// a typo or a flag newer than the wrapper silently rendered the dashboard
// and exited 0 (observed live 2026-08-21 with a pre-T-567 `--integrate`
// call).
//
// Three behavioral assertions, run against BOTH wrappers:
//   1. bare invocation still renders the dashboard at exit 0
//   2. --watch still reaches the dashboard
//   3. an unrecognized flag (--nonexistent-flag) exits 1, names the
//      offending argument, and does NOT print the dashboard
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const FRAMEWORK_SCRIPTS = __dirname;
const FRAMEWORK_ROOT = path.join(FRAMEWORK_SCRIPTS, '..');
const CANONICAL_WRAPPER = path.join(FRAMEWORK_SCRIPTS, 'mavp-operator');
const INSTALL_SCRIPT = path.join(FRAMEWORK_SCRIPTS, 'mavp-install.js');

// A marker that must NOT appear when the dashboard renders — the box-drawing
// corner glyph used by the dashboard's panel border. Absence of dashboard
// output is asserted by checking neither this marker nor the "Commands:"
// footer line appears in the captured output.
function looksLikeDashboardOutput(text) {
  return text.includes('Commands:') || text.includes('┌') || text.includes('└');
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    input: '',
    ...opts,
    // Pin MAVERICKS_HOME to the repo under test (this framework checkout),
    // the resolution chain's designed first branch. Without this, the
    // adopter wrapper falls through to `~/.mavericks` (if present) or the
    // legacy `~/Documents/mavericks` fallback — on a CI runner neither
    // exists, so the bare-invocation assertion dies with MODULE_NOT_FOUND;
    // on the author's machine `~/.mavericks` is a clone of the PUBLISHED
    // MIRROR, so the adopter assertions were silently exercising the
    // mirror's dashboard instead of this repo's HEAD. Pinning fixes both
    // the CI nondeterminism and that fidelity gap in the same line.
    env: { ...process.env, MAVERICKS_HOME: FRAMEWORK_ROOT },
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function assertWrapperBehavior(wrapperPath, label) {
  // 1. bare invocation still renders the dashboard at exit 0
  const bare = run(wrapperPath, [], { cwd: path.dirname(path.dirname(wrapperPath)) });
  assert.strictEqual(bare.code, 0, `FAIL (${label}): bare invocation exited ${bare.code}, expected 0. stderr:\n${bare.stderr}`);
  assert.ok(
    looksLikeDashboardOutput(bare.stdout + bare.stderr),
    `FAIL (${label}): bare invocation did not render the dashboard`
  );
  console.log(`Assertion 1 passed (${label}): bare invocation exit=0, dashboard rendered`);

  // 2. --watch still reaches the dashboard
  const watch = run(wrapperPath, ['--watch'], { cwd: path.dirname(path.dirname(wrapperPath)) });
  assert.strictEqual(watch.code, 0, `FAIL (${label}): --watch exited ${watch.code}, expected 0. stderr:\n${watch.stderr}`);
  assert.ok(
    looksLikeDashboardOutput(watch.stdout + watch.stderr),
    `FAIL (${label}): --watch did not render the dashboard`
  );
  console.log(`Assertion 2 passed (${label}): --watch exit=0, dashboard rendered`);

  // 3. an unrecognized flag exits 1, names it, and does NOT print the dashboard
  const bad = run(wrapperPath, ['--nonexistent-flag'], { cwd: path.dirname(path.dirname(wrapperPath)) });
  assert.strictEqual(bad.code, 1, `FAIL (${label}): --nonexistent-flag exited ${bad.code}, expected 1. stdout:\n${bad.stdout}\nstderr:\n${bad.stderr}`);
  assert.ok(
    (bad.stdout + bad.stderr).includes('--nonexistent-flag'),
    `FAIL (${label}): refusal message does not name the offending argument`
  );
  assert.ok(
    !looksLikeDashboardOutput(bad.stdout + bad.stderr),
    `FAIL (${label}): --nonexistent-flag still rendered the dashboard`
  );
  console.log(`Assertion 3 passed (${label}): --nonexistent-flag exit=1, names it, no dashboard`);
}

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- Canonical wrapper (scripts/mavp-operator, run in place) ---
assertWrapperBehavior(CANONICAL_WRAPPER, 'canonical');

// --- Adopter wrapper (freshly generated via mavp-install.js) ---
const scratch = makeScratchDir('mavp-wrapper-unrecognized-flag-');
try {
  execFileSync('node', [INSTALL_SCRIPT, scratch, '--yes'], { encoding: 'utf8' });
  const adopterWrapper = path.join(scratch, 'scripts', 'mavp-operator');
  assert.ok(fs.existsSync(adopterWrapper), 'FAIL: fresh install did not create scripts/mavp-operator');
  assertWrapperBehavior(adopterWrapper, 'adopter');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('\nAll T-679 wrapper-unrecognized-flag assertions passed.');
