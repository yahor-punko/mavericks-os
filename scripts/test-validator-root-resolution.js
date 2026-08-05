'use strict';
// Regression test: T-617 — mavp-validator.js main() root-resolution
// precedence.
//
// Before this fix, main()'s repoRoot resolved as `argv[2] || process.cwd()`
// while getProjectRoot() (used for project-level artifacts) already honored
// MAVERICKS_PROJECT_ROOT. A no-argument validator spawn from a mutating
// operator script that had written to the env-resolved root would instead
// judge process.cwd() — a green result about the wrong repo attached to a
// state mutation of the right one.
//
// Fixed precedence: explicit path argument (argv[2]) > MAVERICKS_PROJECT_ROOT
// > process.cwd(). getProjectRoot() itself is deliberately NOT touched (see
// the comment on that function in mavp-validator.js) — it is require()-
// consumed by mavp-operator-agent.js, where process.argv belongs to the
// requiring process, not this script.
//
// Verified full-stack: this test spawns the real
// `node scripts/mavp-validator.js` process with distinct argv/env/cwd
// combinations against a fixture repo whose direct validation exits 2 (a
// merged task lacking `commit:` evidence) and a second "elsewhere" fixture
// that validates healthy (exit 0) — so the exit code alone distinguishes
// which repo was actually judged, independent of anything read from output
// text.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const VALIDATOR_SCRIPT = path.join(__dirname, 'mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't617-root-resolution-'));

/**
 * A repo whose direct validation exits 2: a `merged` task in TASK_STATUS.md's
 * Active tasks section with no `commit:`/`infra:`/`artifact:` evidence field
 * fires `merged_missing_commit_field` at FAILURE severity, which always
 * yields overallCandidateState = 'misleading_repair_required' (exit 2)
 * regardless of any other finding present.
 */
function writeRepairRequiredFixture(root, taskId) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# BACKLOG\n\n## Active Wave\n\n### ${taskId} — Fixture task lacking commit evidence\n- **Status:** merged\n- **Verification type:** runtime\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# TASK_STATUS\n\n## Active tasks\n\n### ${taskId} — Fixture task lacking commit evidence\n- **Status:** merged\n- **Verification type:** runtime\n- **Evidence:** —\n\n## Recently completed tasks\n`,
    'utf8'
  );
}

/** A repo with no tasks at all — validates healthy (exit 0) on its own. */
function writeHealthyFixture(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    '# TASK_STATUS\n\n## Active tasks\n\n## Recently completed tasks\n',
    'utf8'
  );
}

const fixtureRoot = path.join(TMP_DIR, 'repair-required');
const elsewhereRoot = path.join(TMP_DIR, 'elsewhere-healthy');
writeRepairRequiredFixture(fixtureRoot, 'T-900');
writeHealthyFixture(elsewhereRoot);

function runValidator({ argRoot, envRoot, cwd }) {
  const args = argRoot ? [VALIDATOR_SCRIPT, argRoot] : [VALIDATOR_SCRIPT];
  const env = { ...process.env };
  if (envRoot) {
    env.MAVERICKS_PROJECT_ROOT = envRoot;
  } else {
    delete env.MAVERICKS_PROJECT_ROOT;
  }
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

// ---------------------------------------------------------------------------
// Assertion 1: an explicit path argument pointing at the fixture exits 2
// even when MAVERICKS_PROJECT_ROOT points elsewhere — explicit wins.
// ---------------------------------------------------------------------------
{
  const { status, output } = runValidator({ argRoot: fixtureRoot, envRoot: elsewhereRoot, cwd: elsewhereRoot });
  assert.strictEqual(
    status,
    2,
    `Assertion 1 FAIL: an explicit argv path argument must win over a conflicting MAVERICKS_PROJECT_ROOT — expected exit 2 naming the fixture repo, got ${status}. Output:\n${output}`
  );
  assert.ok(output.includes('T-900'), `Assertion 1 FAIL: expected the fixture's task T-900 named in output:\n${output}`);
  console.log('Assertion 1 passed: explicit argv path argument wins over a conflicting MAVERICKS_PROJECT_ROOT env var (exit 2, naming T-900)');
}

// ---------------------------------------------------------------------------
// Assertion 2: no argument, MAVERICKS_PROJECT_ROOT set to the fixture, cwd
// elsewhere — judges the ENV-VAR repo. This FLIPS the pre-fix behavior
// (which judged cwd and would have exited 0 here).
// ---------------------------------------------------------------------------
{
  const { status, output } = runValidator({ argRoot: null, envRoot: fixtureRoot, cwd: elsewhereRoot });
  assert.strictEqual(
    status,
    2,
    `Assertion 2 FAIL: with no argument, MAVERICKS_PROJECT_ROOT must be honored over cwd — expected exit 2 naming the fixture repo, got ${status}. Output:\n${output}`
  );
  assert.ok(output.includes('T-900'), `Assertion 2 FAIL: expected the fixture's task T-900 named in output:\n${output}`);
  console.log('Assertion 2 passed: no argument + MAVERICKS_PROJECT_ROOT set judges the env-var repo, not cwd (exit 2, naming T-900) — flips pre-fix behavior');
}

// ---------------------------------------------------------------------------
// Assertion 3: no argument and no env var — judges cwd (unchanged behavior).
// ---------------------------------------------------------------------------
{
  const { status, output } = runValidator({ argRoot: null, envRoot: null, cwd: fixtureRoot });
  assert.strictEqual(
    status,
    2,
    `Assertion 3 FAIL: with no argument and no env var, cwd must still be judged — expected exit 2 naming the fixture repo, got ${status}. Output:\n${output}`
  );
  assert.ok(output.includes('T-900'), `Assertion 3 FAIL: expected the fixture's task T-900 named in output:\n${output}`);
  console.log('Assertion 3 passed: no argument and no env var judges process.cwd() (exit 2, naming T-900) — unchanged behavior');
}

// ---------------------------------------------------------------------------
// Sanity check: the "elsewhere" fixture validates healthy (exit 0) entirely
// on its own, confirming the exit-2 results above are attributable to which
// root got judged, not to some unrelated cause.
// ---------------------------------------------------------------------------
{
  const { status, output } = runValidator({ argRoot: null, envRoot: null, cwd: elsewhereRoot });
  assert.strictEqual(
    status,
    0,
    `Sanity check FAIL: the "elsewhere" fixture alone should validate healthy (exit 0), got ${status}. Output:\n${output}`
  );
  console.log('Sanity check passed: the "elsewhere" fixture validates healthy (exit 0) on its own');
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-617 root-resolution assertions passed.');
