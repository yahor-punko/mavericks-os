'use strict';
// T-785: `mavp-install.js --update` seeds MISSING project-owned artifacts from
// templates/ (if-missing only, never overwriting) and reports them. Runs the real
// installer against a scratch fixture adopter. Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const TEMPLATES = path.join(REPO_ROOT, 'templates');

// Pin the framework root explicitly so the spawn never consults the home-directory
// resolution chain (see .claude/rules/scripts.md — hermetic test env pinning).
const SPAWN_ENV = { ...process.env, MAVERICKS_HOME: REPO_ROOT };

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function run(args) {
  return stripAnsi(execFileSync('node', [INSTALL_SCRIPT, ...args, '--stale-source-ok'], {
    input: 'y\n',
    encoding: 'utf8',
    env: SPAWN_ENV,
  }));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-install-update-seeds-'));
try {
  // Fixture adopter: fresh install seeds every template-backed artifact.
  run([scratch]);

  const modulesPath = path.join(scratch, 'docs', 'MODULES.md');
  const repoMapPath = path.join(scratch, 'docs', 'REPO_MAP.md');
  const archPath = path.join(scratch, 'docs', 'ARCHITECTURE.md');
  for (const p of [modulesPath, repoMapPath, archPath]) {
    assert.ok(fs.existsSync(p), `fixture setup: ${p} should exist after fresh install`);
  }

  fs.rmSync(modulesPath);
  fs.rmSync(repoMapPath);
  const CUSTOM = '# Custom architecture\n\nProject-specific content that must survive --update.\n';
  fs.writeFileSync(archPath, CUSTOM, 'utf8');

  // --- First --update: seeds exactly the two deleted files ---
  const out1 = run(['--update', scratch]);

  assert.ok(fs.existsSync(modulesPath), 'docs/MODULES.md was not re-seeded by --update');
  assert.ok(fs.existsSync(repoMapPath), 'docs/REPO_MAP.md was not re-seeded by --update');
  assert.strictEqual(
    fs.readFileSync(modulesPath, 'utf8'),
    fs.readFileSync(path.join(TEMPLATES, 'MODULES.md'), 'utf8'),
    'docs/MODULES.md is not byte-identical to templates/MODULES.md'
  );
  assert.strictEqual(
    fs.readFileSync(repoMapPath, 'utf8'),
    fs.readFileSync(path.join(TEMPLATES, 'REPO_MAP_TEMPLATE.md'), 'utf8'),
    'docs/REPO_MAP.md is not byte-identical to templates/REPO_MAP_TEMPLATE.md'
  );
  assert.strictEqual(
    fs.readFileSync(archPath, 'utf8'),
    CUSTOM,
    'existing docs/ARCHITECTURE.md was overwritten by --update (must never be touched)'
  );

  assert.match(out1, /^ {2}new {2}docs[\\/]MODULES\.md \(from template\)$/m, 'missing "new  docs/MODULES.md (from template)" line');
  assert.match(out1, /^ {2}new {2}docs[\\/]REPO_MAP\.md \(from template\)$/m, 'missing "new  docs/REPO_MAP.md (from template)" line');
  assert.strictEqual((out1.match(/\(from template\)/g) || []).length, 2, 'expected exactly two "(from template)" lines');
  assert.match(out1, /^seeded 2 missing project artifact\(s\) from templates$/m, 'missing "seeded 2 missing project artifact(s) from templates" line');
  assert.doesNotMatch(out1, /were not touched/, '"were not touched" line must be suppressed when N > 0');
  console.log('Case 1 passed: --update seeds the 2 missing artifacts, leaves custom ARCHITECTURE.md byte-identical, reports N=2');

  // --- Second --update: nothing missing, N=0, no new lines ---
  const out2 = run(['--update', scratch]);
  assert.doesNotMatch(out2, /\(from template\)/, 'second --update must print no "(from template)" lines');
  assert.doesNotMatch(out2, /seeded \d+ missing project artifact/, 'second --update must not print a seeded line (N=0)');
  assert.match(out2, /Artifacts \(BACKLOG\.md, TASK_STATUS\.md, PROCESS_STATE\.\*\) were not touched\./, 'second --update should print the "were not touched" line');
  assert.strictEqual(fs.readFileSync(archPath, 'utf8'), CUSTOM, 'ARCHITECTURE.md changed on second --update');
  console.log('Case 2 passed: second --update seeds nothing (N=0) and prints the "not touched" line');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('test-install-update-seeds-artifacts: all cases passed');
