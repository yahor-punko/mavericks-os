'use strict';
// Regression test: T-736 — buildBashWrapper()'s generated resolution chain
// must honor its mavericksDirHint parameter (the install-time framework
// directory) and must refuse loudly, naming every candidate tried, when no
// candidate resolves — instead of deferring to node's module loader under
// `set -euo pipefail`.
//
// Resolution order under test:
//   1. MAVERICKS_HOME env — unconditional override.
//   2. The baked install-time hint, used only when it still probes
//      framework-shaped (a -f test on <hint>/scripts/mavp-validator.js).
//   3. $HOME/.mavericks, if it exists.
//   4. $HOME/Documents/mavericks, if it exists.
//   5. A single terminal existence check on the resolved path — on failure,
//      print every candidate tried plus the MAVERICKS_HOME remedy and exit 1.
//
// Before this fix, buildBashWrapper(mavericksDirHint) never referenced its
// parameter at all (grep: one hit, the declaration) and the emitted
// resolution line used -d as a SELECTOR between ~/.mavericks and
// ~/Documents/mavericks, not a guard — when neither existed, the wrapper
// (running under set -euo pipefail) deferred failure to node's own
// module-loader stack trace.
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBashWrapper } = require('./mavp-install.js');

const FRAMEWORK_SCRIPTS = __dirname;
const FRAMEWORK_ROOT = path.join(FRAMEWORK_SCRIPTS, '..');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeWrapper(hint, destDir) {
  const scriptsDir = path.join(destDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const wrapperPath = path.join(scriptsDir, 'mavp-operator');
  fs.writeFileSync(wrapperPath, buildBashWrapper(hint), { mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function runWrapper(wrapperPath, args, env) {
  const result = spawnSync(wrapperPath, args, { encoding: 'utf8', env });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------
// (red) no candidate resolves: the baked hint was framework-shaped at
// generation time but is deleted before the wrapper runs, HOME points at an
// empty scratch dir (no .mavericks, no Documents/mavericks), and
// MAVERICKS_HOME is unset. Must exit nonzero, name every candidate tried,
// and must NOT print a node module-loader stack trace.
// ---------------------------------------------------------------------
function runRedCase() {
  const hintSource = makeScratchDir('mavp-wrapper-root-hint-');
  const wrapperDir = makeScratchDir('mavp-wrapper-root-red-');
  const home = makeScratchDir('mavp-wrapper-root-home-');
  try {
    // Bake the hint honestly — it IS framework-shaped at generation time.
    fs.mkdirSync(path.join(hintSource, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(hintSource, 'scripts', 'mavp-validator.js'), '// stub\n');
    const wrapperPath = writeWrapper(hintSource, wrapperDir);

    // Baked dir deleted after generation — this machine no longer has it.
    fs.rmSync(hintSource, { recursive: true, force: true });

    const env = { ...process.env, HOME: home };
    delete env.MAVERICKS_HOME;
    const result = runWrapper(wrapperPath, ['--version'], env);

    console.log('--- (red) exit=' + result.code + ' ---');
    console.log('stdout:\n' + result.stdout);
    console.log('stderr:\n' + result.stderr);

    assert.notStrictEqual(result.code, 0, `FAIL (red): expected nonzero exit, got ${result.code}`);
    const combined = result.stdout + result.stderr;
    assert.ok(combined.includes(hintSource), 'FAIL (red): refusal does not name the baked install-time hint');
    assert.ok(combined.includes(path.join(home, '.mavericks')), 'FAIL (red): refusal does not name $HOME/.mavericks');
    assert.ok(
      combined.includes(path.join(home, 'Documents', 'mavericks')),
      'FAIL (red): refusal does not name $HOME/Documents/mavericks'
    );
    assert.ok(/MAVERICKS_HOME/.test(combined), 'FAIL (red): refusal does not name the MAVERICKS_HOME remedy');
    assert.ok(!/MODULE_NOT_FOUND/.test(combined), 'FAIL (red): a node module-loader stack trace leaked through');
    assert.ok(!/at Module\./.test(combined), 'FAIL (red): a node module-loader stack trace leaked through');
    console.log('(red) PASS: no-candidate refusal — exit ' + result.code + ', candidates named, no node stack trace');
  } finally {
    fs.rmSync(wrapperDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    // hintSource already removed above.
  }
}

// ---------------------------------------------------------------------
// (green) baked hint dir present and framework-shaped — resolves via the
// hint, --version succeeds.
// ---------------------------------------------------------------------
function runGreenHintCase() {
  const wrapperDir = makeScratchDir('mavp-wrapper-root-green-');
  const home = makeScratchDir('mavp-wrapper-root-green-home-');
  try {
    // Use the REAL framework root as the baked hint — it genuinely has
    // scripts/mavp-validator.js and scripts/mavp-version.js.
    const wrapperPath = writeWrapper(FRAMEWORK_ROOT, wrapperDir);

    const env = { ...process.env, HOME: home };
    delete env.MAVERICKS_HOME;
    const result = runWrapper(wrapperPath, ['--version'], env);

    console.log('--- (green/hint) exit=' + result.code + ' ---');
    console.log('stdout:\n' + result.stdout);
    console.log('stderr:\n' + result.stderr);

    assert.strictEqual(result.code, 0, `FAIL (green/hint): expected exit 0, got ${result.code}. stderr:\n${result.stderr}`);
    assert.ok(/mavericks v/.test(result.stdout), `FAIL (green/hint): --version did not print a version. stdout:\n${result.stdout}`);
    console.log('(green/hint) PASS: --version succeeded via the baked hint — ' + result.stdout.trim());
  } finally {
    fs.rmSync(wrapperDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// (green) MAVERICKS_HOME pinning still wins over an existing, valid baked
// hint.
// ---------------------------------------------------------------------
function runGreenPinCase() {
  const wrapperDir = makeScratchDir('mavp-wrapper-root-pin-');
  const home = makeScratchDir('mavp-wrapper-root-pin-home-');
  const overrideRoot = makeScratchDir('mavp-wrapper-root-pin-override-');
  try {
    // Baked hint is the REAL framework root (would resolve fine on its own
    // — see the green/hint case above), but MAVERICKS_HOME points somewhere
    // else entirely, with its own distinct mavp-version.js.
    fs.mkdirSync(path.join(overrideRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(overrideRoot, 'scripts', 'mavp-validator.js'), '// stub\n');
    fs.writeFileSync(
      path.join(overrideRoot, 'scripts', 'mavp-version.js'),
      "module.exports = { MAVERICKS_VERSION: '0.0.0-pin-test' };\n"
    );

    const wrapperPath = writeWrapper(FRAMEWORK_ROOT, wrapperDir);

    const env = { ...process.env, HOME: home, MAVERICKS_HOME: overrideRoot };
    const result = runWrapper(wrapperPath, ['--version'], env);

    console.log('--- (green/pin) exit=' + result.code + ' ---');
    console.log('stdout:\n' + result.stdout);
    console.log('stderr:\n' + result.stderr);

    assert.strictEqual(result.code, 0, `FAIL (green/pin): expected exit 0, got ${result.code}. stderr:\n${result.stderr}`);
    assert.ok(
      result.stdout.includes('0.0.0-pin-test'),
      `FAIL (green/pin): MAVERICKS_HOME override was not honored over the baked hint. stdout:\n${result.stdout}`
    );
    console.log('(green/pin) PASS: MAVERICKS_HOME override won over the baked hint — ' + result.stdout.trim());
  } finally {
    fs.rmSync(wrapperDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(overrideRoot, { recursive: true, force: true });
  }
}

runRedCase();
runGreenHintCase();
runGreenPinCase();

console.log('\nAll T-736 wrapper-framework-root-resolution assertions passed.');
