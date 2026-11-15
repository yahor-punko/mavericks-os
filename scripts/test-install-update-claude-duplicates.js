'use strict';
// Behavioural test: T-895 — `mavp-install.js --update` ends with exactly one pointer line
// when part of the target's CLAUDE.md already loads on demand from the framework, and
// prints nothing of the kind otherwise.
//
// Contract under guard (from the acceptance criteria, not from observed output):
//   - fixture A: CLAUDE.md holds one line copied at runtime from the repository's
//     .claude/rules/backlog.md (first line of trimmed length 60 or more) plus
//     project-authored lines carrying a sentinel token -> --update stdout holds one
//     pointer line whose count equals that line's length plus 1 (the newline), names
//     ./scripts/mavp-operator --check-sync, and never contains the sentinel.
//   - fixture B: CLAUDE.md entirely project-authored -> no pointer line.
//   - fixture C: no CLAUDE.md at all -> no pointer line.
//   - CLAUDE.md is byte-identical before and after --update in every fixture.
//
// Plain node, no npm deps. Framework root pinned in the spawn env and --stale-source-ok
// on every installer call, because the installer is the subject but its resolution chain
// is not (see .claude/rules/scripts.md — hermetic test env pinning).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const SPAWN_ENV = { ...process.env, MAVERICKS_HOME: REPO_ROOT };
const SENTINEL = 'T895-SENTINEL-QZX7';
const POINTER_PREFIX = 'CLAUDE.md duplicates:';

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

function pointerLines(out) {
  return out.split('\n').filter((l) => l.includes(POINTER_PREFIX));
}

// The duplicated line is read at runtime from the repository, never hard-coded.
const backlogRule = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'rules', 'backlog.md'), 'utf8');
const dupLine = backlogRule.split('\n').find((l) => l.trim().length >= 60);
assert.ok(dupLine, 'setup FAIL: .claude/rules/backlog.md has no line of trimmed length 60 or more');

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t895-'));
try {
  function makeFixture(name, claudeMd) {
    const dir = path.join(scratchRoot, name);
    fs.mkdirSync(dir);
    run([dir]); // fresh install seeds the framework rule files into the project
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (claudeMd === null) {
      fs.rmSync(claudePath, { force: true });
    } else {
      fs.writeFileSync(claudePath, claudeMd, 'utf8');
    }
    return { dir, claudePath };
  }

  // --- Fixture A: one duplicated line plus sentinel-carrying project-authored lines ---
  const claudeA = [
    `# Project notes ${SENTINEL}`,
    '',
    `${SENTINEL} this project keeps its release checklist in the team wiki, not in this repository.`,
    dupLine,
    `${SENTINEL} deploys run from the staging branch after the nightly integration job turns green.`,
    '',
  ].join('\n');
  const a = makeFixture('with-duplicate', claudeA);
  const beforeA = fs.readFileSync(a.claudePath);
  const outA = run(['--update', a.dir]);
  const ptrA = pointerLines(outA);
  assert.strictEqual(ptrA.length, 1, `Test A FAIL: expected exactly one pointer line, got ${ptrA.length}\n${outA}`);
  const mA = ptrA[0].match(/^CLAUDE\.md duplicates: (\d+) chars\b/);
  assert.ok(mA, `Test A FAIL: pointer line does not start with the count: ${ptrA[0]}`);
  assert.strictEqual(Number(mA[1]), dupLine.length + 1, `Test A FAIL: count ${mA[1]} !== line length + 1 (${dupLine.length + 1})`);
  assert.ok(ptrA[0].includes('./scripts/mavp-operator --check-sync'), `Test A FAIL: pointer line does not name the command: ${ptrA[0]}`);
  assert.ok(!outA.includes(SENTINEL), 'Test A FAIL: update stdout leaked project-authored CLAUDE.md text');
  assert.ok(!outA.includes(dupLine.trim()), 'Test A FAIL: update stdout leaked the duplicated line text');
  assert.ok(beforeA.equals(fs.readFileSync(a.claudePath)), 'Test A FAIL: CLAUDE.md changed during --update');

  // --- Fixture B: entirely project-authored CLAUDE.md ---
  const claudeB = [
    `# Project notes ${SENTINEL}`,
    '',
    `${SENTINEL} this project keeps its release checklist in the team wiki, not in this repository.`,
    `${SENTINEL} deploys run from the staging branch after the nightly integration job turns green.`,
    '',
  ].join('\n');
  const b = makeFixture('project-authored', claudeB);
  const beforeB = fs.readFileSync(b.claudePath);
  const outB = run(['--update', b.dir]);
  assert.strictEqual(pointerLines(outB).length, 0, `Test B FAIL: pointer line printed for a project-authored CLAUDE.md\n${outB}`);
  assert.ok(beforeB.equals(fs.readFileSync(b.claudePath)), 'Test B FAIL: CLAUDE.md changed during --update');

  // --- Fixture C: no CLAUDE.md ---
  const c = makeFixture('no-claude-md', null);
  const outC = run(['--update', c.dir]);
  assert.strictEqual(pointerLines(outC).length, 0, `Test C FAIL: pointer line printed with no CLAUDE.md\n${outC}`);
  assert.ok(!fs.existsSync(c.claudePath), 'Test C FAIL: --update created a CLAUDE.md');

  console.log('PASS: test-install-update-claude-duplicates (3 fixtures)');
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
