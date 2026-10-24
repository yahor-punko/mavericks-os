'use strict';
// Regression test: T-788 — the canonical pre-commit hook runs an optional,
// adopter-owned .claude/hooks/pre-commit.local.
//
// The canonical hook is executed via bash in a bare fixture directory (cwd =
// fixture, as git runs hooks from the repo root). Every other stanza in the
// hook is made inert without editing it:
//   - the validator: the fixture has no scripts/mavp-validator.js, so the hook
//     falls through to MAVERICKS_HOME, pinned to a stub whose
//     scripts/mavp-validator.js exits 0 (silent);
//   - the manifest, frozen-changelog and private-names stanzas are each gated
//     on a scripts/<checker>.js that the fixture does not contain, so they are
//     no-ops.
// The only variable is therefore .claude/hooks/pre-commit.local.
//
// Cases: (a) absent -> exit 0, no output; (b) present+executable, exits 0 ->
// exit 0; (c) present+executable, exits 1 -> exit 1 and the COMMIT BLOCKED
// line; (d) present, not executable -> exit 0 plus a chmod warning.
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '.claude', 'hooks', 'pre-commit');
const BLOCKED_LINE = 'COMMIT BLOCKED: project pre-commit.local failed (see message above)';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t788-hook-'));
const stubHome = path.join(root, 'stub-framework');
fs.mkdirSync(path.join(stubHome, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(stubHome, 'scripts', 'mavp-validator.js'), 'process.exit(0);\n');

function makeFixture(name, localBody, mode) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  if (localBody !== null) {
    const f = path.join(dir, '.claude', 'hooks', 'pre-commit.local');
    fs.writeFileSync(f, localBody);
    fs.chmodSync(f, mode);
  }
  return dir;
}

function runHook(dir) {
  // Pin the framework-root var so the validator lookup never consults the
  // home-directory fallback chain; drop MAVERICKS_SCRIPTS so it cannot override.
  const env = { ...process.env, MAVERICKS_HOME: stubHome };
  delete env.MAVERICKS_SCRIPTS;
  const r = spawnSync('bash', [HOOK], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

try {
  // (a) absent: no behaviour change, no output.
  {
    const r = runHook(makeFixture('absent', null, 0));
    assert.strictEqual(r.code, 0, `(a) expected exit 0, got ${r.code}: ${r.out}`);
    assert.strictEqual(r.out, '', `(a) expected no output when pre-commit.local is absent, got: ${JSON.stringify(r.out)}`);
    console.log('Test (a) passed: absent pre-commit.local -> exit 0, no output');
  }

  // (b) executable, exits 0: the file really ran (marker) and the hook exits 0.
  {
    const r = runHook(makeFixture('pass', '#!/usr/bin/env bash\necho local-ran\nexit 0\n', 0o755));
    assert.strictEqual(r.code, 0, `(b) expected exit 0, got ${r.code}: ${r.out}`);
    assert.ok(r.out.includes('local-ran'), `(b) pre-commit.local did not run; output: ${JSON.stringify(r.out)}`);
    assert.ok(!r.out.includes('COMMIT BLOCKED'), `(b) unexpected COMMIT BLOCKED: ${r.out}`);
    console.log('Test (b) passed: pre-commit.local exiting 0 -> hook exit 0');
  }

  // (c) executable, exits 1: blocked.
  {
    const r = runHook(makeFixture('fail', '#!/usr/bin/env bash\necho local-says-no\nexit 1\n', 0o755));
    assert.strictEqual(r.code, 1, `(c) expected exit 1, got ${r.code}: ${r.out}`);
    assert.ok(r.out.includes('local-says-no'), `(c) pre-commit.local output missing: ${r.out}`);
    assert.ok(r.out.includes(BLOCKED_LINE), `(c) expected the COMMIT BLOCKED line, got: ${r.out}`);
    console.log('Test (c) passed: pre-commit.local exiting 1 -> hook exit 1 with COMMIT BLOCKED line');
  }

  // (d) present but not executable: warn, never run, proceed.
  {
    const r = runHook(makeFixture('noexec', '#!/usr/bin/env bash\necho local-ran\nexit 1\n', 0o644));
    assert.strictEqual(r.code, 0, `(d) expected exit 0, got ${r.code}: ${r.out}`);
    assert.ok(r.out.includes('chmod +x'), `(d) expected a chmod +x warning, got: ${r.out}`);
    assert.ok(!r.out.includes('local-ran'), `(d) a non-executable pre-commit.local must not run: ${r.out}`);
    assert.ok(!r.out.includes('COMMIT BLOCKED'), `(d) unexpected COMMIT BLOCKED: ${r.out}`);
    console.log('Test (d) passed: non-executable pre-commit.local -> hook exit 0 with chmod +x warning');
  }

  console.log('\nAll T-788 pre-commit.local hook tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
