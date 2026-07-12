'use strict';
// Regression test: T-381 — mavp-install.js must write the generated bash
// wrapper (scripts/mavp-operator) atomically (temp file → chmod → rename),
// never via an in-place truncate-rewrite.
//
// Why this matters: when --update is invoked THROUGH the very wrapper file
// being regenerated (e.g. `./scripts/mavp-operator --install --update .`),
// an in-place fs.writeFileSync on the destination mutates the same inode
// the running bash process has open and is reading from. Bash's read
// cursor into that file gets invalidated mid-execution, producing a
// spurious "syntax error near ')'" and a non-zero exit even though the
// update itself already succeeded underneath.
//
// This test reproduces the defect end-to-end through a REAL on-disk
// wrapper (not exec'd — exec would replace the bash process image and
// mask the bug) and fails if anyone reverts writeExecutableAtomicSync()
// back to a plain fs.writeFileSync + chmod.
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// This test lives at <repo>/scripts/, the same directory as mavp-install.js.
const FRAMEWORK_SCRIPTS = __dirname;
const INSTALL_SCRIPT = path.join(FRAMEWORK_SCRIPTS, 'mavp-install.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runProcess(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

const scratch = makeScratchDir('mavp-install-atomic-');
const scratch2 = makeScratchDir('mavp-install-atomic-fresh-');

try {
  const scriptsDir = path.join(scratch, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const wrapperPath = path.join(scriptsDir, 'mavp-operator');

  // Seed an OLD-LAYOUT wrapper that is:
  //  (a) valid bash (bash -n clean)
  //  (b) delegates to the real framework installer via
  //      `node <FRAMEWORK>/mavp-install.js --update <scratch>` WITHOUT exec
  //  (c) deliberately layout-divergent: the delegation lives inside an
  //      if/then/fi block, followed by a large block of trailing padding
  //      comment lines so this stale wrapper's tail extends well past the
  //      freshly generated wrapper's length (~5.7KB / 128 lines) — this is
  //      what lets an in-place truncate-rewrite race against bash's
  //      in-progress read of the script it is currently executing.
  const paddingLines = [];
  for (let i = 0; i < 400; i++) {
    paddingLines.push(
      `# padding line ${i} — extends the stale wrapper well past the freshly ` +
      `generated wrapper's length so an in-place rewrite races bash's read cursor`
    );
  }
  const staleWrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `FRAMEWORK_SCRIPTS="${FRAMEWORK_SCRIPTS}"`,
    'if [[ "${1-}" == "--install" ]]; then',
    '  shift',
    '  node "$FRAMEWORK_SCRIPTS/mavp-install.js" "$@"',
    'fi',
    ...paddingLines,
    '',
  ].join('\n');
  fs.writeFileSync(wrapperPath, staleWrapper, 'utf8');
  fs.chmodSync(wrapperPath, 0o755);

  // Sanity: the seeded stale wrapper must itself be valid bash.
  const seedCheck = runProcess('bash', ['-n', wrapperPath]);
  assert.strictEqual(seedCheck.code, 0, `FAIL: seeded stale wrapper is not valid bash:\n${seedCheck.stderr}`);

  // Run the update THROUGH the on-disk wrapper (not via `node mavp-install.js`
  // directly) — this is what exercises the in-place-write race.
  const result = runProcess('bash', [wrapperPath, '--install', '--update', scratch]);

  assert.strictEqual(
    result.code,
    0,
    `FAIL: update-through-wrapper exited ${result.code}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`
  );
  assert.ok(
    !/syntax error/i.test(result.stderr),
    `FAIL: stderr contains a syntax error:\n${result.stderr}`
  );
  console.log('Assertion 1 passed: update-through-wrapper exited 0 with no syntax error in stderr');

  // The resulting on-disk wrapper must itself be valid bash.
  const postCheck = runProcess('bash', ['-n', wrapperPath]);
  assert.strictEqual(postCheck.code, 0, `FAIL: regenerated wrapper is not valid bash:\n${postCheck.stderr}`);
  console.log('Assertion 2 passed: regenerated wrapper is valid bash (bash -n clean)');

  // It must contain current routing (e.g. --validate).
  const regenerated = fs.readFileSync(wrapperPath, 'utf8');
  assert.ok(regenerated.includes('--validate'), 'FAIL: regenerated wrapper missing --validate routing');
  console.log('Assertion 3 passed: regenerated wrapper contains current routing (--validate)');

  // Its mode must be executable.
  const mode = fs.statSync(wrapperPath).mode;
  assert.ok((mode & 0o111) !== 0, 'FAIL: regenerated wrapper is not executable');
  console.log('Assertion 4 passed: regenerated wrapper is executable');

  // No temp-file residue left behind.
  const leftoverTmp = fs.readdirSync(scriptsDir).filter((n) => n.startsWith('mavp-operator.tmp-'));
  assert.strictEqual(leftoverTmp.length, 0, `FAIL: temp file residue left in scripts/: ${leftoverTmp.join(', ')}`);
  console.log('Assertion 5 passed: no mavp-operator.tmp-* residue in scripts/');

  // Second leg: fresh install into a separate scratch dir.
  const freshResult = runProcess('node', [INSTALL_SCRIPT, scratch2]);
  assert.strictEqual(
    freshResult.code,
    0,
    `FAIL: fresh install exited ${freshResult.code}.\nstderr:\n${freshResult.stderr}\nstdout:\n${freshResult.stdout}`
  );
  const freshWrapperPath = path.join(scratch2, 'scripts', 'mavp-operator');
  assert.ok(fs.existsSync(freshWrapperPath), 'FAIL: fresh install did not create scripts/mavp-operator');
  const freshMode = fs.statSync(freshWrapperPath).mode;
  assert.ok((freshMode & 0o111) !== 0, 'FAIL: freshly installed wrapper is not executable');
  const freshCheck = runProcess('bash', ['-n', freshWrapperPath]);
  assert.strictEqual(freshCheck.code, 0, `FAIL: freshly installed wrapper is not valid bash:\n${freshCheck.stderr}`);
  console.log('Assertion 6 passed: fresh-install wrapper exists, executable, bash -n clean');

  console.log('\nAll T-381 atomic-wrapper-write assertions passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(scratch2, { recursive: true, force: true });
}
