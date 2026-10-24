'use strict';
// Regression test: T-788 — adopter-owned extension points survive install and --update.
//
// Contract under guard: neither a fresh install nor `--update` ever writes or
// deletes (a) .claude/rules/project-*.md or (b) .claude/hooks/pre-commit.local.
// Both are adopter-owned; the framework-owned files beside them are re-copied.
//
// Steps: install a fixture adopter, add an adopter rule file and an executable
// pre-commit.local, tamper with one framework rule file, run --update, then
// assert (1) both adopter files are present and byte-identical (content and
// executable bit), (2) the tampered framework rule file WAS re-copied (proves
// the update really ran over that directory), (3) the pre-commit hook beside
// pre-commit.local was refreshed too.
//
// Plain node, no npm deps. Env pinned (framework-root var) and --stale-source-ok
// passed because the installer is a means here, not the subject.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const ENV = { ...process.env, MAVERICKS_HOME: FRAMEWORK_ROOT };

function runInstaller(args) {
  return execFileSync('node', [INSTALL_SCRIPT, ...args, '--stale-source-ok'], { encoding: 'utf8', env: ENV });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t788-update-'));
try {
  runInstaller([scratch]);

  const rulesDir = path.join(scratch, '.claude', 'rules');
  const hooksDir = path.join(scratch, '.claude', 'hooks');

  const ruleSrc = path.join(FRAMEWORK_ROOT, '.claude', 'rules', 'scripts.md');
  const frameworkRule = path.join(rulesDir, 'scripts.md');
  assert.ok(fs.existsSync(frameworkRule), 'precondition: fresh install copied .claude/rules/scripts.md');

  const projectRule = path.join(rulesDir, 'project-redlines.md');
  const projectRuleBody = '# Project redlines\n\n- never touch the billing module\n';
  fs.writeFileSync(projectRule, projectRuleBody);

  const localHook = path.join(hooksDir, 'pre-commit.local');
  const localHookBody = '#!/usr/bin/env bash\necho "project check"\nexit 0\n';
  fs.writeFileSync(localHook, localHookBody);
  fs.chmodSync(localHook, 0o755);

  // Tamper with a framework-owned rule file and the framework hook so --update
  // has real work to do beside the adopter files.
  fs.writeFileSync(frameworkRule, 'TAMPERED\n');
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/usr/bin/env bash\nexit 0 # TAMPERED\n');

  runInstaller(['--update', scratch]);

  // (1) adopter-owned files: present, byte-identical, executable bit kept.
  assert.ok(fs.existsSync(projectRule), 'FAIL: --update deleted .claude/rules/project-redlines.md');
  assert.strictEqual(fs.readFileSync(projectRule, 'utf8'), projectRuleBody, 'FAIL: --update modified project-redlines.md');
  assert.ok(fs.existsSync(localHook), 'FAIL: --update deleted .claude/hooks/pre-commit.local');
  assert.strictEqual(fs.readFileSync(localHook, 'utf8'), localHookBody, 'FAIL: --update modified pre-commit.local');
  assert.ok((fs.statSync(localHook).mode & 0o111) !== 0, 'FAIL: --update cleared the executable bit on pre-commit.local');
  console.log('Test 1 passed: project-redlines.md and pre-commit.local present and byte-identical after --update');

  // (2) framework rule file re-copied from source.
  assert.strictEqual(
    fs.readFileSync(frameworkRule, 'utf8'),
    fs.readFileSync(ruleSrc, 'utf8'),
    'FAIL: --update did not re-copy the framework rule file (the update never ran over .claude/rules)'
  );
  console.log('Test 2 passed: framework rule file scripts.md re-copied by --update');

  // (3) the framework hook beside pre-commit.local was refreshed.
  assert.strictEqual(
    fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8'),
    fs.readFileSync(path.join(FRAMEWORK_ROOT, '.claude', 'hooks', 'pre-commit'), 'utf8'),
    'FAIL: --update did not refresh .claude/hooks/pre-commit'
  );
  console.log('Test 3 passed: framework pre-commit hook refreshed beside the untouched pre-commit.local');

  // (4) a second --update is also a no-op for the adopter files.
  runInstaller(['--update', scratch]);
  assert.strictEqual(fs.readFileSync(projectRule, 'utf8'), projectRuleBody);
  assert.strictEqual(fs.readFileSync(localHook, 'utf8'), localHookBody);
  console.log('Test 4 passed: repeated --update leaves adopter files untouched');

  console.log('\nAll T-788 update-preserves-project-files tests passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
