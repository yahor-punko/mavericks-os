'use strict';
// Regression test: T-773 — mavp-skill-reflect.js must refuse an unknown
// role (no matching .claude/agents/<role>.md) BEFORE any trajectory
// read/write, so the full suite never leaves an untracked
// .mavp/trajectories/<role>.jsonl file behind for a role that has no
// spec at all.
//
// Two behaviors asserted, both run as a real subprocess with
// MAVERICKS_PROJECT_ROOT pointed at a scratch dir (never the real repo):
//   1. no .claude/agents/nonexistent-role.md present -> exit 1, stderr
//      names the missing spec path, and no .mavp directory is created.
//   2. a minimal .claude/agents/somerole.md plus minimal state artifacts
//      present -> exit 0, stdout says "insufficient trajectories", and
//      .mavp/trajectories/somerole.jsonl exists (the N<8 gate is a
//      distinct, already-correct exit-0 path this test must not disturb).
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const REFLECT_SCRIPT = path.join(SCRIPTS_DIR, 'mavp-skill-reflect.js');

const EMPTY_BACKLOG = '# BACKLOG\n\n## Active Wave\n\n';
const EMPTY_TASK_STATUS = '# TASK_STATUS\n\n## Active tasks\n\n';

function makeScratchRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedMinimalState(root) {
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), EMPTY_BACKLOG, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), EMPTY_TASK_STATUS, 'utf8');
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify({ wave: 1, last_updated: '2026-01-01' }, null, 2) + '\n',
    'utf8'
  );
}

function runReflect(root, role) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  const result = spawnSync('node', [REFLECT_SCRIPT, role], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// --- Test 1: unknown role -- no .claude/agents/<role>.md at all ---
{
  const root = makeScratchRoot('mavp-skill-reflect-unknown-role-');
  try {
    seedMinimalState(root);
    // Deliberately do NOT create .claude/agents/nonexistent-role.md.

    const result = runReflect(root, 'nonexistent-role');

    assert.strictEqual(
      result.code,
      1,
      `Test 1 FAIL: expected exit 1 for unknown role, got ${result.code}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    const expectedSpecPath = path.join(root, '.claude', 'agents', 'nonexistent-role.md');
    assert.ok(
      result.stderr.includes(expectedSpecPath),
      `Test 1 FAIL: stderr does not name the missing spec path (${expectedSpecPath}). stderr:\n${result.stderr}`
    );

    const mavpDir = path.join(root, '.mavp');
    assert.ok(
      !fs.existsSync(mavpDir),
      `Test 1 FAIL: .mavp directory must not exist for an unknown role, but found it at ${mavpDir}`
    );

    console.log('Test 1 passed: unknown role exits 1, names the missing spec path, writes no .mavp directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- Test 2: known role, agent spec present, insufficient trajectories (N<8) ---
{
  const root = makeScratchRoot('mavp-skill-reflect-known-role-');
  try {
    seedMinimalState(root);

    const agentsDir = path.join(root, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'somerole.md'),
      '---\nname: somerole\n---\n\n# somerole\n\nMinimal fixture agent spec.\n',
      'utf8'
    );

    const result = runReflect(root, 'somerole');

    assert.strictEqual(
      result.code,
      0,
      `Test 2 FAIL: expected exit 0 for a known role with insufficient trajectories, got ${result.code}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    assert.ok(
      result.stdout.includes('insufficient trajectories'),
      `Test 2 FAIL: stdout does not mention "insufficient trajectories". stdout:\n${result.stdout}`
    );

    const trajectoryFile = path.join(root, '.mavp', 'trajectories', 'somerole.jsonl');
    assert.ok(
      fs.existsSync(trajectoryFile),
      `Test 2 FAIL: expected trajectory file to exist at ${trajectoryFile}`
    );

    console.log('Test 2 passed: known role with a spec passes the check, hits the N<8 gate at exit 0, writes its trajectory file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nAll T-773 unknown-role assertions passed.');
