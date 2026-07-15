'use strict';
// Regression test: T-412 — CI hotfix: fresh-install validate must be Healthy
// (unknown_repo_id firing on the BACKLOG template's Repo placeholder).
//
// Root cause: a fresh `node scripts/mavp-install.js <tmp>` seeds BACKLOG.md
// from templates/BACKLOG_TEMPLATE.md and docs/REPO_MAP.md from
// templates/REPO_MAP_TEMPLATE.md (which declares real repo-a/repo-b entries).
// If the example task in BACKLOG_TEMPLATE.md carries a bracket-wrapped
// `- **Repo:** [optional — ...]` placeholder, checkRepoIds() in
// scripts/mavp-validator.js parses that prose as a literal repo id, finds it
// absent from docs/REPO_MAP.md, and emits `unknown_repo_id` — pushing a
// freshly-installed project straight to exit 1 (drifting) instead of Healthy.
//
// This test guards two things:
//   Part A — a genuine fresh install + validate against it is Healthy, exit 0.
//   Part B — even if a task's Repo: field IS the exact bracketed placeholder
//            string (bug reproduction fixture, not the fixed template itself),
//            the validator's placeholder-normalization treats it as absent
//            rather than parsing it as a repo id: no unknown_repo_id finding.
//
// Plain node, no npm deps. Exit 0 = pass.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const VALIDATOR_SCRIPT = path.join(__dirname, 'mavp-validator.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Child env with no MAVERICKS_PROJECT_ROOT leaking in from the parent process —
// the validator resolves docs/MODULES.md and docs/REPO_MAP.md via
// MAVERICKS_PROJECT_ROOT (falling back to cwd) BEFORE it looks at the argv[2]
// repo root used for BACKLOG.md/TASK_STATUS.md, so a leaked value would
// validate the wrong project's repo map.
function childEnv(tmpDir) {
  const env = { ...process.env };
  delete env.MAVERICKS_PROJECT_ROOT;
  env.MAVERICKS_PROJECT_ROOT = tmpDir;
  return env;
}

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error('FAIL: ' + message);
  } else {
    console.log('PASS: ' + message);
  }
}

const tmpDirs = [];
function scratch(prefix) {
  const d = makeScratchDir(prefix);
  tmpDirs.push(d);
  return d;
}

try {
  // --- Part A: fresh-install contract ---
  {
    const tmp = scratch('mavp-fresh-install-validate-a-');

    const installResult = spawnSync(process.execPath, [INSTALL_SCRIPT, tmp], {
      cwd: REPO_ROOT,
      env: childEnv(tmp),
      encoding: 'utf8',
    });
    check(installResult.status === 0, `(A) fresh install exited 0 (got ${installResult.status}; stderr: ${installResult.stderr})`);
    check(fs.existsSync(path.join(tmp, 'BACKLOG.md')), '(A) BACKLOG.md was seeded');
    check(fs.existsSync(path.join(tmp, 'docs', 'REPO_MAP.md')), '(A) docs/REPO_MAP.md was seeded');

    const validateResult = spawnSync(process.execPath, [VALIDATOR_SCRIPT, tmp], {
      cwd: tmp,
      env: childEnv(tmp),
      encoding: 'utf8',
    });
    const combinedOutput = (validateResult.stdout || '') + (validateResult.stderr || '');
    check(validateResult.status === 0, `(A) fresh-install validate exited 0 (got ${validateResult.status})`);
    check(/healthy/i.test(combinedOutput), '(A) fresh-install validate reports Healthy');
    check(!/unknown_repo_id/.test(combinedOutput), '(A) fresh-install validate has no unknown_repo_id finding');
    console.log('--- (A) validator output ---\n' + combinedOutput.trim() + '\n--- end (A) output ---');
  }

  // --- Part B: guard behavioral — bracketed placeholder Repo value must not
  //     be parsed as a repo id even when a real repo map is active ---
  {
    const tmp = scratch('mavp-fresh-install-validate-b-');

    const installResult = spawnSync(process.execPath, [INSTALL_SCRIPT, tmp], {
      cwd: REPO_ROOT,
      env: childEnv(tmp),
      encoding: 'utf8',
    });
    check(installResult.status === 0, `(B) fresh install exited 0 (got ${installResult.status})`);

    const placeholderLine = '- **Repo:** [optional — repo name(s) this task touches, e.g. example-service]';

    const backlogPath = path.join(tmp, 'BACKLOG.md');
    let backlog = fs.readFileSync(backlogPath, 'utf8');
    const backlogTaskBlock = [
      '',
      '### T-002 — Placeholder repro task',
      '- **Status:** planned',
      '- **Owner:** developer',
      '- **Depends on:** —',
      placeholderLine,
      '- **Acceptance criteria:** n/a — fixture only.',
      '- **Verification type:** artifact',
      '- **Evidence expected:** n/a',
      '',
    ].join('\n');
    backlog = backlog.replace('## Completed tasks', `${backlogTaskBlock}\n## Completed tasks`);
    fs.writeFileSync(backlogPath, backlog, 'utf8');

    const taskStatusPath = path.join(tmp, 'TASK_STATUS.md');
    let taskStatus = fs.readFileSync(taskStatusPath, 'utf8');
    const taskStatusBlock = [
      '',
      '### T-002 — Placeholder repro task',
      '- **Status:** planned',
      '- **Owner:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** —',
      '- **Evidence:** —',
      '- **Notes:** —',
      '',
    ].join('\n');
    taskStatus = taskStatus.replace('## Recently completed tasks', `${taskStatusBlock}\n## Recently completed tasks`);
    fs.writeFileSync(taskStatusPath, taskStatus, 'utf8');

    const validateResult = spawnSync(process.execPath, [VALIDATOR_SCRIPT, tmp], {
      cwd: tmp,
      env: childEnv(tmp),
      encoding: 'utf8',
    });
    const combinedOutput = (validateResult.stdout || '') + (validateResult.stderr || '');
    check(validateResult.status === 0, `(B) validate with planned placeholder-Repo task exited 0 (got ${validateResult.status})`);
    check(!/unknown_repo_id/.test(combinedOutput), '(B) placeholder Repo value produced no unknown_repo_id finding');

    // --- Part B2: an in_progress task with the same placeholder DOES surface
    //     the missing-repo warning (placeholder correctly treated as absent,
    //     not as a satisfied Repo: field) ---
    backlog = backlog.replace(
      '### T-002 — Placeholder repro task\n- **Status:** planned',
      '### T-002 — Placeholder repro task\n- **Status:** in_progress'
    );
    fs.writeFileSync(backlogPath, backlog, 'utf8');
    taskStatus = taskStatus.replace(
      '### T-002 — Placeholder repro task\n- **Status:** planned',
      '### T-002 — Placeholder repro task\n- **Status:** in_progress'
    );
    fs.writeFileSync(taskStatusPath, taskStatus, 'utf8');

    const validateResult2 = spawnSync(process.execPath, [VALIDATOR_SCRIPT, tmp], {
      cwd: tmp,
      env: childEnv(tmp),
      encoding: 'utf8',
    });
    const combinedOutput2 = (validateResult2.stdout || '') + (validateResult2.stderr || '');
    check(/missing_repo_field/.test(combinedOutput2), '(B2) in_progress task with placeholder Repo surfaces missing_repo_field warning');
    check(!/unknown_repo_id/.test(combinedOutput2), '(B2) still no unknown_repo_id finding for the placeholder');
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll T-412 fresh-install-validate assertions passed.');
  }
} finally {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
