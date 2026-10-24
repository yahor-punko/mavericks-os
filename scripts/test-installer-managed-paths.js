'use strict';
// Regression test: T-799 — the shared installer-managed-path predicate in
// scripts/mavp-operator-lib.js (isFrameworkSourceTree, isInstallerManagedPath,
// partitionInstallerManaged) and the installer's use of the lib-owned write-set
// constants. Expected values come from the contract (T-799 acceptance
// criteria): a path is managed only when `mavp-install.js --update` rewrites it.
//
// The --agent and --check-archive integration cases live in test-must-read.js
// and test-doc-archive-check.js; this file pins the predicate itself.
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('./mavp-operator-lib.js');
const {
  HOOK_NAMES,
  CLAUDE_DIRS,
  SYNC_SCRIPTS,
  PROJECT_FILES,
  BASH_FILE,
  isFrameworkSourceTree,
  isInstallerManagedPath,
  partitionInstallerManaged,
} = lib;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't799-managed-'));
function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

let cases = 0;
function test(name, fn) {
  fn();
  cases += 1;
  console.log(`  ok - ${name}`);
}

try {
  // A fixture framework source tree with one counterpart per managed directory,
  // and a rule named like an adopter rule, to prove the project-* guard is
  // independent of whether a same-path file exists.
  const fw = path.join(tmp, 'framework');
  write(fw, '.claude/agents/sample-agent.md', 'agent\n');
  write(fw, '.claude/skills/sample-skill/SKILL.md', 'skill\n');
  write(fw, '.claude/rules/sample-rule.md', 'rule\n');
  write(fw, '.claude/rules/project-sample.md', 'a framework-side file that must still never count as managed\n');
  fs.mkdirSync(path.join(fw, '.claude', 'rules', 'a-directory.md'), { recursive: true });
  const opts = { frameworkRoot: fw };

  test('the installer write-set constants are exported from the lib', () => {
    assert.deepStrictEqual([...HOOK_NAMES], ['pre-commit', 'pre-push']);
    assert.deepStrictEqual([...CLAUDE_DIRS], ['agents', 'skills', 'rules']);
    assert.deepStrictEqual([...SYNC_SCRIPTS], ['mavp-operator-agent.js', 'mavp-operator-close-session.js']);
    assert.deepStrictEqual([...PROJECT_FILES], [...SYNC_SCRIPTS]);
    assert.strictEqual(BASH_FILE, 'mavp-operator');
  });

  test('mavp-install.js requires those constants from the lib and keeps no local copy', () => {
    const src = fs.readFileSync(path.join(__dirname, 'mavp-install.js'), 'utf8');
    assert.ok(/require\('\.\/mavp-operator-lib\.js'\)/.test(src), 'FAIL: installer must require the lib');
    for (const name of ['HOOK_NAMES', 'CLAUDE_DIRS', 'SYNC_SCRIPTS', 'PROJECT_FILES', 'BASH_FILE']) {
      assert.ok(!new RegExp(`^\\s*const ${name}\\s*=`, 'm').test(src), `FAIL: installer still defines its own ${name}`);
    }
  });

  test('.claude/agents|skills|rules paths are managed only with a same-relative-path file in the framework tree', () => {
    assert.strictEqual(isInstallerManagedPath('.claude/agents/sample-agent.md', opts), true);
    assert.strictEqual(isInstallerManagedPath('.claude/skills/sample-skill/SKILL.md', opts), true);
    assert.strictEqual(isInstallerManagedPath('.claude/rules/sample-rule.md', opts), true);
    assert.strictEqual(isInstallerManagedPath('./.claude/rules/sample-rule.md', opts), true, 'a leading ./ is normalized');
    // No counterpart: an adopter-created file the installer never writes.
    assert.strictEqual(isInstallerManagedPath('.claude/rules/adopter-only.md', opts), false);
    assert.strictEqual(isInstallerManagedPath('.claude/agents/adopter-agent.md', opts), false);
    assert.strictEqual(isInstallerManagedPath('.claude/skills/adopter-skill/SKILL.md', opts), false);
    // A directory is not a file the installer copies.
    assert.strictEqual(isInstallerManagedPath('.claude/rules/a-directory.md', opts), false);
  });

  test('.claude/rules/project-*.md is never managed, even when the framework tree has the same path', () => {
    assert.strictEqual(isInstallerManagedPath('.claude/rules/project-sample.md', opts), false);
    assert.strictEqual(isInstallerManagedPath('.claude/rules/project-x.md', opts), false);
  });

  test('the two hooks and the three synced script paths are managed', () => {
    assert.strictEqual(isInstallerManagedPath('.claude/hooks/pre-commit', opts), true);
    assert.strictEqual(isInstallerManagedPath('.claude/hooks/pre-push', opts), true);
    assert.strictEqual(isInstallerManagedPath('scripts/mavp-operator', opts), true);
    assert.strictEqual(isInstallerManagedPath('scripts/mavp-operator-agent.js', opts), true);
    assert.strictEqual(isInstallerManagedPath('scripts/mavp-operator-close-session.js', opts), true);
  });

  test('everything else is not managed', () => {
    for (const p of [
      '.claude/hooks/pre-commit.local',
      '.claude/settings.json',
      '.claude/settings.local.json',
      'docs/MODULES.md',
      'docs/REPO_MAP.md',
      'scripts/mavp-operator-lib.js',
      'scripts/mavp-validator.js',
      'scripts/other.js',
      'src/x.js',
      'CLAUDE.md',
      'BACKLOG.md',
      '',
      '../outside.md',
      '.claude/rules/../../etc/x',
      '/abs/.claude/rules/sample-rule.md',
    ]) {
      assert.strictEqual(isInstallerManagedPath(p, opts), false, `FAIL: ${JSON.stringify(p)} must not be managed`);
    }
  });

  test('default frameworkRoot is the checkout the lib lives in: its own rules, agents and skills are managed', () => {
    const repo = path.resolve(__dirname, '..');
    for (const rel of ['.claude/rules/docs.md', '.claude/rules/scripts.md', '.claude/agents/developer.md', '.claude/skills/session-start/SKILL.md']) {
      assert.ok(fs.existsSync(path.join(repo, rel)), `precondition: ${rel} exists in this checkout`);
      assert.strictEqual(isInstallerManagedPath(rel), true, `FAIL: ${rel} must be managed against the default framework root`);
    }
    assert.strictEqual(isInstallerManagedPath('.claude/rules/project-x.md'), false);
  });

  test('isFrameworkSourceTree is true iff the root contains scripts/mavp-operator-lib.js', () => {
    const adopter = path.join(tmp, 'adopter');
    fs.mkdirSync(adopter, { recursive: true });
    assert.strictEqual(isFrameworkSourceTree(adopter), false);
    write(adopter, 'scripts/mavp-operator-agent.js', '// synced script, not the marker\n');
    assert.strictEqual(isFrameworkSourceTree(adopter), false);
    write(adopter, 'scripts/mavp-operator-lib.js', '// stub framework marker\n');
    assert.strictEqual(isFrameworkSourceTree(adopter), true);
    assert.strictEqual(isFrameworkSourceTree(path.join(tmp, 'does-not-exist')), false);
    assert.strictEqual(isFrameworkSourceTree(path.resolve(__dirname, '..')), true, 'this checkout is a framework source tree');
    // Revision-judged variant used by --check-archive.
    assert.strictEqual(isFrameworkSourceTree(adopter, { exists: () => false }), false);
    assert.strictEqual(isFrameworkSourceTree(adopter, { exists: (rel) => rel === 'scripts/mavp-operator-lib.js' }), true);
  });

  test('partitionInstallerManaged splits an adopter list and leaves a framework source tree untouched', () => {
    const adopter = path.join(tmp, 'adopter-partition');
    fs.mkdirSync(adopter, { recursive: true });
    const paths = ['src/x.js', '.claude/hooks/pre-commit', '.claude/rules/sample-rule.md', '.claude/rules/adopter-only.md', '.claude/rules/project-sample.md'];
    const r = partitionInstallerManaged(adopter, paths, opts);
    assert.deepStrictEqual(r.framework, ['.claude/hooks/pre-commit', '.claude/rules/sample-rule.md']);
    assert.deepStrictEqual(r.kept, ['src/x.js', '.claude/rules/adopter-only.md', '.claude/rules/project-sample.md']);
    // protect keeps a declared context doc in kept.
    const p = partitionInstallerManaged(adopter, paths, { ...opts, protect: ['.claude/rules/sample-rule.md'] });
    assert.deepStrictEqual(p.framework, ['.claude/hooks/pre-commit']);
    // A framework source tree: no-op.
    write(adopter, 'scripts/mavp-operator-lib.js', '// stub framework marker\n');
    const canon = partitionInstallerManaged(adopter, paths, opts);
    assert.deepStrictEqual(canon.framework, []);
    assert.deepStrictEqual(canon.kept, paths);
  });

  console.log(`PASS: test-installer-managed-paths (${cases} cases)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
