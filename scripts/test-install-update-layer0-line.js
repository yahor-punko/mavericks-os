'use strict';
// Behavioural test: T-902 — `mavp-install.js --update` ends with exactly one line giving the
// target's always-loaded character count against the project's resolved validator budget,
// discloses a budget raised above the framework default, and marks over-budget.
//
// Contract under guard (from the acceptance criteria, not from observed output):
//   - N is the sum of the JavaScript string lengths of CLAUDE.md, the file its one @ import
//     line names, and every unscoped rule file present in the fixture after the update. The
//     test computes N from the fixture files; it never reads it back from a first run.
//   - fixture one (no artifact_budgets): prints N and 160000 as the budget, no raised wording,
//     no over-budget marker.
//   - fixture two (always_loaded_max_chars 280000): prints N and 280000, the raised wording
//     naming 160000, no over-budget marker.
//   - fixture three (budget N - 1): prints the over-budget marker naming
//     ./scripts/mavp-operator --validate, without the raised wording.
//   - fixture four (no CLAUDE.md): no such line.
//   - a sentinel token placed in CLAUDE.md never reaches stdout; the line names no project file.
//   - CLAUDE.md and PROCESS_STATE.json are byte-identical before and after in every fixture.
//
// Plain node, no npm deps. Framework root pinned in the spawn env and --stale-source-ok on
// every installer call, because the installer is the subject but its resolution chain is not
// (see .claude/rules/scripts.md — hermetic test env pinning).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const SPAWN_ENV = { ...process.env, MAVERICKS_HOME: REPO_ROOT };
const SENTINEL = 'T902-SENTINEL-QZX7';
const LINE_PREFIX = 'always-loaded context:';
const IMPORT_NAME = 'sample-notes.md';
// The framework default budget the acceptance criteria name for a project with no override.
const FRAMEWORK_DEFAULT = 160000;
const VALIDATE_COMMAND = './scripts/mavp-operator --validate';

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

function sizeLines(out) {
  return out.split('\n').filter((l) => l.startsWith(LINE_PREFIX));
}

function listMarkdown(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdown(p));
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

// A rule file is path-scoped when its frontmatter carries a paths: key.
function isPathScoped(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return Boolean(fm) && /^paths:/m.test(fm[1]);
}

// N, computed from the fixture tree: JavaScript string lengths of CLAUDE.md, the imported
// file and every unscoped rule file present after the update.
function expectedCount(dir) {
  let total = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').length;
  total += fs.readFileSync(path.join(dir, 'docs', IMPORT_NAME), 'utf8').length;
  for (const rule of listMarkdown(path.join(dir, '.claude', 'rules'))) {
    const body = fs.readFileSync(rule, 'utf8');
    if (!isPathScoped(body)) total += body.length;
  }
  return total;
}

// CLAUDE.md with one @ import line; the docs file carries a multi-byte character so a byte
// count and a string length differ.
const CLAUDE_TEXT = [
  `# Fixture project ${SENTINEL}`,
  '',
  `@docs/${IMPORT_NAME}`,
  '',
  'Deploys run from the staging branch.',
  '',
].join('\n');
const IMPORT_TEXT = `Sample notes — known text for the length check.\n`;
const UNSCOPED_RULE_TEXT = '# Unscoped fixture rule\n\nThis rule loads at every start, so it counts toward N.\n';
const SCOPED_RULE_TEXT = '---\npaths:\n  - "src/**"\n---\n\n# Scoped fixture rule\n\nThis rule loads on demand, so it does not count toward N.\n';

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t902-'));
try {
  function makeFixture(name, { claudeMd = CLAUDE_TEXT, budget = null } = {}) {
    const dir = path.join(scratchRoot, name);
    fs.mkdirSync(dir);
    run([dir]); // fresh install seeds the framework rule files and PROCESS_STATE.json
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (claudeMd === null) {
      fs.rmSync(claudePath, { force: true });
    } else {
      fs.writeFileSync(claudePath, claudeMd, 'utf8');
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', IMPORT_NAME), IMPORT_TEXT, 'utf8');
      // Two adopter-owned rule files the update never touches: one unscoped (loaded at every
      // start, so part of N) and one path-scoped (loaded on demand, so not part of N).
      fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'rules', 'project-unscoped.md'), UNSCOPED_RULE_TEXT, 'utf8');
      fs.writeFileSync(path.join(dir, '.claude', 'rules', 'project-scoped.md'), SCOPED_RULE_TEXT, 'utf8');
    }
    const statePath = path.join(dir, 'PROCESS_STATE.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    delete state.artifact_budgets;
    if (budget !== null) state.artifact_budgets = { always_loaded_max_chars: budget };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return { dir, claudePath, statePath };
  }

  function updateAndCheckBytes(fx) {
    const claudeBefore = fs.existsSync(fx.claudePath) ? fs.readFileSync(fx.claudePath) : null;
    const stateBefore = fs.readFileSync(fx.statePath);
    const out = run(['--update', fx.dir]);
    if (claudeBefore !== null) {
      assert.ok(claudeBefore.equals(fs.readFileSync(fx.claudePath)), 'FAIL: CLAUDE.md changed during --update');
    } else {
      assert.ok(!fs.existsSync(fx.claudePath), 'FAIL: --update created a CLAUDE.md');
    }
    assert.ok(stateBefore.equals(fs.readFileSync(fx.statePath)), 'FAIL: PROCESS_STATE.json changed during --update');
    return out;
  }

  function parseLine(out, label) {
    const lines = sizeLines(out);
    assert.strictEqual(lines.length, 1, `${label} FAIL: expected exactly one size line, got ${lines.length}\n${out}`);
    const m = lines[0].match(/^always-loaded context: (\d+) chars against a budget of (\d+)/);
    assert.ok(m, `${label} FAIL: size line does not carry the count and the budget: ${lines[0]}`);
    return { line: lines[0], n: Number(m[1]), b: Number(m[2]) };
  }

  // --- Fixture one: no artifact_budgets ---
  const one = makeFixture('default-budget');
  const outOne = updateAndCheckBytes(one);
  const nOne = expectedCount(one.dir);
  const gotOne = parseLine(outOne, 'Test 1');
  assert.strictEqual(gotOne.n, nOne, `Test 1 FAIL: count ${gotOne.n} !== computed sum of file lengths ${nOne}`);
  assert.strictEqual(gotOne.b, FRAMEWORK_DEFAULT, `Test 1 FAIL: budget ${gotOne.b} !== ${FRAMEWORK_DEFAULT}`);
  assert.ok(!gotOne.line.includes('raised'), `Test 1 FAIL: raised wording on the default budget: ${gotOne.line}`);
  assert.ok(!gotOne.line.includes(VALIDATE_COMMAND), `Test 1 FAIL: over-budget marker under budget: ${gotOne.line}`);
  assert.ok(!outOne.includes(SENTINEL), 'Test 1 FAIL: update stdout leaked project-authored CLAUDE.md text');
  assert.ok(!gotOne.line.includes(IMPORT_NAME) && !gotOne.line.includes('CLAUDE.md'), `Test 1 FAIL: size line names a project file: ${gotOne.line}`);
  // The unscoped rule term of N is exercised: N is above the two project files alone, and the
  // path-scoped rule is not in it (the test's own sum already excludes it).
  assert.ok(nOne >= CLAUDE_TEXT.length + IMPORT_TEXT.length + UNSCOPED_RULE_TEXT.length, 'Test 1 FAIL: setup — the unscoped rule term of N is unexercised');
  assert.ok(isPathScoped(SCOPED_RULE_TEXT) && !isPathScoped(UNSCOPED_RULE_TEXT), 'Test 1 FAIL: setup — scoped and unscoped rule fixtures are misclassified');

  // --- Fixture two: budget raised above the framework default ---
  const two = makeFixture('raised-budget', { budget: 280000 });
  const outTwo = updateAndCheckBytes(two);
  const gotTwo = parseLine(outTwo, 'Test 2');
  assert.strictEqual(gotTwo.n, expectedCount(two.dir), 'Test 2 FAIL: count differs from the computed sum of file lengths');
  assert.strictEqual(gotTwo.b, 280000, `Test 2 FAIL: budget ${gotTwo.b} !== 280000`);
  assert.ok(gotTwo.line.includes('raised above the framework default'), `Test 2 FAIL: raised wording missing: ${gotTwo.line}`);
  assert.ok(gotTwo.line.includes(String(FRAMEWORK_DEFAULT)), `Test 2 FAIL: raised wording does not name ${FRAMEWORK_DEFAULT}: ${gotTwo.line}`);
  assert.ok(!gotTwo.line.includes(VALIDATE_COMMAND), `Test 2 FAIL: over-budget marker under budget: ${gotTwo.line}`);

  // --- Fixture three: budget one below N ---
  const three = makeFixture('over-budget', { budget: nOne - 1 });
  const outThree = updateAndCheckBytes(three);
  const gotThree = parseLine(outThree, 'Test 3');
  assert.strictEqual(gotThree.n, expectedCount(three.dir), 'Test 3 FAIL: count differs from the computed sum of file lengths');
  assert.strictEqual(gotThree.b, nOne - 1, `Test 3 FAIL: budget ${gotThree.b} !== ${nOne - 1}`);
  assert.ok(gotThree.n > gotThree.b, 'Test 3 FAIL: setup — N is not above the budget');
  assert.ok(gotThree.line.includes(VALIDATE_COMMAND), `Test 3 FAIL: over-budget marker missing: ${gotThree.line}`);
  assert.ok(!gotThree.line.includes('raised'), `Test 3 FAIL: raised wording under the default: ${gotThree.line}`);

  // --- Fixture four: no CLAUDE.md ---
  const four = makeFixture('no-claude-md', { claudeMd: null });
  const outFour = updateAndCheckBytes(four);
  assert.strictEqual(sizeLines(outFour).length, 0, `Test 4 FAIL: size line printed with no CLAUDE.md\n${outFour}`);

  console.log('PASS: test-install-update-layer0-line (4 fixtures)');
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
