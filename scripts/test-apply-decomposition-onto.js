'use strict';
// T-912 — `--apply-decomposition [FILE] --onto LIST` re-scopes already-registered
// tasks from a decomposition block in place (or registers `new` ones).
//
// Covers the acceptance criteria:
//   (a) full in-place re-scope of one task with a two-paragraph old Problem
//   (b) absent key leaves the field alone, present key replaces under the
//       registration normalisation, and the command names the replaced fields
//   (c) `T-5,new` re-scopes one task and registers the other, depends_on titles
//       resolving to the right id in both directions
//   (d) every refusal exits 1 with both artifacts byte-identical
//   (e) no --onto -> parseCliArgs keeps its two-key shape
//   plus the lib helpers the command builds on (bounded paragraph / removal).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const lib = require('./mavp-operator-lib.js');
const apply = require('./mavp-operator-apply-decomposition.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't912-apply-onto-'));
const CLI = path.join(__dirname, 'mavp-operator-apply-decomposition.js');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

function backlogFixture({ t5Status = 'planned', dupHeading = false } = {}) {
  return `# Backlog

## Active Wave

### T-4 — Before task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Origin:** manual

**Problem:** Before problem.

${dupHeading ? `### T-4 — Before task again
- **Status:** planned

` : ''}### T-5 — Old title
- **Status:** ${t5Status}
- **Owner role:** qa
- **Verification type:** runtime
- **Origin:** manual
- **Depends on:** T-4
- **Touches:** old/file.js

**Problem:** Old problem paragraph one.

Old problem paragraph two, still the Problem.

**Acceptance criteria:** Old acceptance criteria.

**Evidence expected:** Old evidence expected.

### T-6 — After task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Origin:** manual

**Problem:** After problem.
`;
}

function taskStatusFixture({ t5Status = 'planned' } = {}) {
  return `# Task Status

## Active tasks

### T-4 — Before task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —

### T-5 — Old title
- **Status:** ${t5Status}
- **Owner role:** qa
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** hand-written evidence line
- **Notes:** hand-written notes line

### T-6 — After task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
`;
}

function makeRoot(name, opts = {}) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlogFixture(opts), 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), opts.taskStatus || taskStatusFixture(opts), 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'fixture', stage: 'execution', wave: 1, wave_status: 'execution', active_slices: [],
    next_action: 'noop', blocker: null, stage_owner: 'main_agent', last_task_id: 6, last_updated: '2026-01-01',
  }, null, 2) + '\n', 'utf8');
  return root;
}

const wrap = (...tasks) => `<!-- mavp-decomposition-start -->\n${tasks.join('\n---\n')}\n<!-- mavp-decomposition-end -->`;
const FULL = [
  'title: New title',
  'owner_role: developer',
  'verification_type: unit',
  'problem: New problem.',
  'acceptance_criteria: New acceptance criteria.',
  'evidence_expected: New evidence expected.',
  'requires_ux: true',
  'touches: scripts/a.js, scripts/b.js',
].join('\n');

function run(root, blockText, args) {
  const file = path.join(root, 'decomposition.md');
  fs.writeFileSync(file, blockText, 'utf8');
  return spawnSync(process.execPath, [CLI, file, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root, MAVERICKS_SCRIPTS: __dirname },
  });
}

const validatorStatus = (root) => spawnSync(process.execPath, [VALIDATOR, root], { encoding: 'utf8' }).status;
const block = (doc, id) => lib.locateTaskBlock(doc, id).rawBlock;

// ---------------------------------------------------------------------------
// Lib helpers: bounded bold-paragraph replacement and bullet removal.
// ---------------------------------------------------------------------------
{
  const b = '### T-1 — X\n- **Status:** planned\n\n**Problem:** one\n\ntwo\n\n**Acceptance criteria:** AC\n\n';
  const out = lib.setBlockParagraphField(b, 'Problem', 'new');
  assert.strictEqual(out, '### T-1 — X\n- **Status:** planned\n\n**Problem:** new\n\n**Acceptance criteria:** AC\n\n',
    'helper 1 FAIL: a two-paragraph Problem must be replaced as one field, spacing and next field kept');

  const last = '### T-1 — X\n- **Status:** planned\n\n**Problem:** p\n\n**Evidence expected:** one\n\ntwo\n\n';
  assert.strictEqual(lib.setBlockParagraphField(last, 'Evidence expected', 'e'),
    '### T-1 — X\n- **Status:** planned\n\n**Problem:** p\n\n**Evidence expected:** e\n\n',
    'helper 2 FAIL: the last field runs to the end of the block, trailing blank lines kept');

  assert.strictEqual(lib.setBlockParagraphField('### T-1 — X\n- **Status:** planned\n\n', 'Problem', 'added'),
    '### T-1 — X\n- **Status:** planned\n\n**Problem:** added\n\n',
    'helper 3 FAIL: a missing paragraph is appended after the last non-blank line');

  assert.strictEqual(lib.setBlockParagraphField('### T-1 — X\n- **Problem:** old\n- **Status:** planned\n', 'Problem', 'new'),
    '### T-1 — X\n- **Problem:** new\n- **Status:** planned\n',
    'helper 4 FAIL: the single-line bullet form is replaced in place');

  assert.strictEqual(lib.removeBlockField('### T-1 — X\n- **A:** 1\n- **B:** 2\n  - sub\n- **C:** 3\n', 'B'),
    '### T-1 — X\n- **A:** 1\n- **C:** 3\n', 'helper 5 FAIL: removal drops the bullet and its indented continuation only');
  assert.strictEqual(lib.removeBlockField('### T-1 — X\n- **A:** 1\n', 'B'), '### T-1 — X\n- **A:** 1\n',
    'helper 6 FAIL: removing an absent field is a no-op');

  assert.strictEqual(lib.setBlockField('### T-1 — X\n- **A:** 1\n', 'A', 'cost $& and $1'), '### T-1 — X\n- **A:** cost $& and $1\n',
    'helper 7 FAIL: replacement patterns in a value must land verbatim');
  assert.strictEqual(lib.setBlockField('### T-1 — X\n- **A:** 1\n- **B:** 2\n\ntext\n', 'C', '3', { afterBullets: true }),
    '### T-1 — X\n- **A:** 1\n- **B:** 2\n- **C:** 3\n\ntext\n', 'helper 8 FAIL: afterBullets inserts after the bullet run');
  console.log('Helper tests passed: setBlockParagraphField, removeBlockField, setBlockField (verbatim value, afterBullets)');
}

// ---------------------------------------------------------------------------
// (e) parseCliArgs keeps its shape without --onto and parses --onto.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(apply.parseCliArgs(['f.md']), { filePath: 'f.md', repoName: null }, '(e) FAIL: no --onto keeps the two-key shape');
  assert.deepStrictEqual(apply.parseCliArgs(['f.md', '--onto', 'T-5,new']), { filePath: 'f.md', repoName: null, onto: 'T-5,new' });
  assert.deepStrictEqual(apply.parseCliArgs(['--onto=T-5', 'f.md', '--repo', 'r']), { filePath: 'f.md', repoName: 'r', onto: 'T-5' });
  assert.deepStrictEqual(apply.parseCliArgs(['--onto']), { filePath: null, repoName: null, onto: '' });
  console.log('Test (e) passed: parseCliArgs shape unchanged without --onto');
}

// ---------------------------------------------------------------------------
// (a) full in-place re-scope.
// ---------------------------------------------------------------------------
{
  const root = makeRoot('a-rescope');
  const beforeBacklog = read(root, 'BACKLOG.md');
  const beforeStatus = read(root, 'TASK_STATUS.md');
  const res = run(root, wrap(FULL), ['--onto', 'T-5']);
  assert.strictEqual(res.status, 0, `(a) FAIL: exit ${res.status}\n${res.stdout}\n${res.stderr}`);
  const backlog = read(root, 'BACKLOG.md');
  const status = read(root, 'TASK_STATUS.md');

  const b5 = block(backlog, 'T-5');
  assert.ok(b5.startsWith('### T-5 — New title\n'), `(a) FAIL: BACKLOG heading, got ${b5.split('\n')[0]}`);
  assert.ok(block(status, 'T-5').startsWith('### T-5 — New title\n'), '(a) FAIL: TASK_STATUS heading');
  const expectOne = [
    ['- **Owner role:** developer'], ['- **Verification type:** unit'],
    ['**Problem:** New problem.'], ['**Acceptance criteria:** New acceptance criteria.'],
    ['**Evidence expected:** New evidence expected.'], ['- **Requires ux:** true'],
    ['- **Touches:** scripts/a.js, scripts/b.js'],
  ];
  for (const [line] of expectOne) assert.strictEqual(count(b5, line), 1, `(a) FAIL: "${line}" must occur exactly once in the T-5 block:\n${b5}`);
  for (const label of ['**Problem:**', '**Acceptance criteria:**', '**Evidence expected:**', '- **Owner role:**', '- **Verification type:**', '- **Requires ux:**', '- **Touches:**', '- **Origin:**', '- **Status:**']) {
    assert.strictEqual(count(b5, label), 1, `(a) FAIL: label ${label} must occur once, got ${count(b5, label)}`);
  }
  assert.ok(!b5.includes('Old problem') && !b5.includes('Old acceptance') && !b5.includes('Old evidence') && !b5.includes('old/file.js'), '(a) FAIL: old content must be gone, including the second Problem paragraph');
  assert.strictEqual(lib.extractBlockField(b5, 'Status'), 'planned', '(a) FAIL: Status unchanged');
  assert.strictEqual(lib.extractBlockField(b5, 'Origin'), 'architect', '(a) FAIL: Origin reads architect');
  assert.strictEqual(lib.extractBlockField(b5, 'Depends on'), 'T-4', '(a) FAIL: absent depends_on leaves Depends on alone');

  const s5 = block(status, 'T-5');
  assert.strictEqual(lib.extractBlockField(s5, 'Evidence'), 'hand-written evidence line', '(a) FAIL: TASK_STATUS Evidence byte-identical');
  assert.strictEqual(lib.extractBlockField(s5, 'Notes'), 'hand-written notes line', '(a) FAIL: TASK_STATUS Notes byte-identical');
  assert.strictEqual(lib.extractBlockField(s5, 'Owner role'), 'developer');
  assert.strictEqual(lib.extractBlockField(s5, 'Verification type'), 'unit');
  assert.strictEqual(lib.extractBlockField(s5, 'Status'), 'planned');

  for (const id of ['T-4', 'T-6']) {
    assert.strictEqual(block(backlog, id), block(beforeBacklog, id), `(a) FAIL: BACKLOG ${id} block must be byte-identical`);
    assert.strictEqual(block(status, id), block(beforeStatus, id), `(a) FAIL: TASK_STATUS ${id} block must be byte-identical`);
  }
  assert.strictEqual(backlog.slice(0, lib.locateTaskBlock(backlog, 'T-5').startIndex), beforeBacklog.slice(0, lib.locateTaskBlock(beforeBacklog, 'T-5').startIndex), '(a) FAIL: bytes before T-5 (BACKLOG)');
  assert.strictEqual(count(backlog, '\n### T-'), count(beforeBacklog, '\n### T-'), '(a) FAIL: BACKLOG heading count');
  assert.strictEqual(count(status, '\n### T-'), count(beforeStatus, '\n### T-'), '(a) FAIL: TASK_STATUS heading count');
  assert.strictEqual(JSON.parse(read(root, 'PROCESS_STATE.json')).last_task_id, 6, '(a) FAIL: last_task_id unchanged');
  assert.strictEqual(validatorStatus(root), 0, '(a) FAIL: validator must exit 0');
  const bundle = fs.readFileSync(path.join(root, '.mavp', 'context', 'T-5.md'), 'utf8');
  assert.ok(bundle.includes('New title'), '(a) FAIL: context bundle regenerated for the re-scoped task');
  console.log('Test (a) passed: in-place re-scope, two-paragraph Problem replaced, neighbours byte-identical, validator 0');
}

// ---------------------------------------------------------------------------
// (b) absent key untouched; present key replaced under registration's
// normalisation; per-task replaced-field report.
// ---------------------------------------------------------------------------
{
  const root = makeRoot('b-fields');
  const minimal = 'title: Minimal retitle\nowner_role: developer\nverification_type: manual';
  let res = run(root, wrap(minimal), ['--onto', 'T-5']);
  assert.strictEqual(res.status, 0, `(b) FAIL: ${res.stdout}\n${res.stderr}`);
  let b5 = block(read(root, 'BACKLOG.md'), 'T-5');
  assert.ok(b5.includes('**Problem:** Old problem paragraph one.\n\nOld problem paragraph two, still the Problem.'), '(b) FAIL: absent problem key leaves both Problem paragraphs untouched');
  assert.ok(b5.includes('**Acceptance criteria:** Old acceptance criteria.'), '(b) FAIL: absent acceptance_criteria untouched');
  assert.ok(b5.includes('- **Touches:** old/file.js') && b5.includes('- **Depends on:** T-4'), '(b) FAIL: absent touches/depends_on untouched');
  const line = res.stdout.split('\n').find((l) => l.includes('re-scoped "Minimal retitle"'));
  assert.ok(line, `(b) FAIL: per-task report line missing:\n${res.stdout}`);
  assert.ok(line.includes('replaced: Title, Owner role, Verification type, Origin'), `(b) FAIL: report must list exactly the written fields: ${line}`);
  for (const absent of ['Problem', 'Touches', 'Depends on', 'Acceptance criteria', 'Requires ux']) {
    assert.ok(!line.includes(absent), `(b) FAIL: report must not list ${absent}: ${line}`);
  }

  // Present keys: depends_on em-dash clears, touches replaces, requires_ux false writes no line.
  const root2 = makeRoot('b-normalise');
  const withUx = run(root2, wrap(FULL), ['--onto', 'T-5']);
  assert.strictEqual(withUx.status, 0);
  assert.ok(block(read(root2, 'BACKLOG.md'), 'T-5').includes('- **Requires ux:** true'));
  const second = 'title: Second pass\nowner_role: developer\nverification_type: unit\ndepends_on: —\nrequires_ux: false\ntouches: x/y.js\ntype: docs';
  res = run(root2, wrap(second), ['--onto', 'T-5']);
  assert.strictEqual(res.status, 0, `(b) FAIL: ${res.stdout}\n${res.stderr}`);
  b5 = block(read(root2, 'BACKLOG.md'), 'T-5');
  assert.ok(!b5.includes('Depends on'), `(b) FAIL: depends_on "—" removes the Depends on line, as registration writes none:\n${b5}`);
  assert.ok(!b5.includes('Requires ux'), '(b) FAIL: requires_ux false removes the line');
  assert.strictEqual(lib.extractBlockField(b5, 'Touches'), 'x/y.js');
  assert.strictEqual(lib.extractBlockField(b5, 'Type'), 'docs');
  assert.ok(b5.includes('**Problem:** New problem.'), '(b) FAIL: problem from the first pass untouched by the second');
  const l2 = res.stdout.split('\n').find((l) => l.includes('re-scoped "Second pass"'));
  assert.ok(l2.includes('Depends on') && l2.includes('Requires ux') && l2.includes('Touches') && l2.includes('Type'), `(b) FAIL: ${l2}`);
  assert.strictEqual(validatorStatus(root2), 0, '(b) FAIL: validator healthy');
  console.log('Test (b) passed: absent keys untouched, present keys replaced/cleared, replaced fields reported');
}

// ---------------------------------------------------------------------------
// (c) `T-5,new`: re-scope + register; depends_on titles resolve both ways.
// ---------------------------------------------------------------------------
{
  const root = makeRoot('c-mixed');
  const first = 'title: Alpha rescoped\nowner_role: developer\nverification_type: unit\ndepends_on: Beta fresh';
  const secondTask = 'title: Beta fresh\nowner_role: qa\nverification_type: runtime\ndepends_on: Alpha rescoped\nproblem: Beta problem.';
  const res = run(root, wrap(first, secondTask), ['--onto', 'T-5,new']);
  assert.strictEqual(res.status, 0, `(c) FAIL: ${res.stdout}\n${res.stderr}`);
  const backlog = read(root, 'BACKLOG.md');
  const status = read(root, 'TASK_STATUS.md');
  assert.strictEqual(lib.extractBlockField(block(backlog, 'T-5'), 'Depends on'), 'T-007', '(c) FAIL: T-5 depends on the new task title -> T-007');
  assert.strictEqual(lib.locateTaskBlock(backlog, 'T-007').count, 1, '(c) FAIL: second task registered as the next id T-007');
  assert.strictEqual(lib.extractBlockField(block(backlog, 'T-007'), 'Depends on'), 'T-5', '(c) FAIL: new task depends on re-scoped title -> T-5');
  assert.ok(block(backlog, 'T-007').startsWith('### T-007 — Beta fresh\n'));
  assert.strictEqual(lib.extractBlockField(block(backlog, 'T-007'), 'Origin'), 'architect');
  assert.strictEqual(lib.extractBlockField(block(status, 'T-007'), 'Status'), 'planned');
  assert.strictEqual(JSON.parse(read(root, 'PROCESS_STATE.json')).last_task_id, 7, '(c) FAIL: last_task_id advanced to 7');
  assert.ok(fs.existsSync(path.join(root, '.mavp', 'context', 'T-007.md')) && fs.existsSync(path.join(root, '.mavp', 'context', 'T-5.md')), '(c) FAIL: bundles for both');
  assert.strictEqual(validatorStatus(root), 0, '(c) FAIL: validator healthy');

  // `new,T-5` (reverse order) resolves the same way.
  const root2 = makeRoot('c-mixed-reverse');
  const res2 = run(root2, wrap(secondTask, first), ['--onto', 'new,T-5']);
  assert.strictEqual(res2.status, 0, `(c) FAIL reverse: ${res2.stdout}\n${res2.stderr}`);
  const b2 = read(root2, 'BACKLOG.md');
  assert.strictEqual(lib.extractBlockField(block(b2, 'T-007'), 'Depends on'), 'T-5');
  assert.strictEqual(lib.extractBlockField(block(b2, 'T-5'), 'Depends on'), 'T-007');
  console.log('Test (c) passed: T-5,new re-scopes and registers; depends_on titles resolve both ways');
}

// ---------------------------------------------------------------------------
// (d) refusals: exit 1, both files (and PROCESS_STATE.json) byte-identical.
// ---------------------------------------------------------------------------
{
  const refuse = (name, rootOpts, text, args, expected) => {
    const root = makeRoot('d-' + name, rootOpts);
    const files = ['BACKLOG.md', 'TASK_STATUS.md', 'PROCESS_STATE.json'].map((f) => path.join(root, f));
    const before = files.map(sha);
    const res = run(root, text, args);
    assert.strictEqual(res.status, 1, `(d) ${name} FAIL: expected exit 1, got ${res.status}\n${res.stdout}\n${res.stderr}`);
    assert.ok(res.stderr.includes(expected), `(d) ${name} FAIL: expected "${expected}" in stderr:\n${res.stderr}`);
    assert.deepStrictEqual(files.map(sha), before, `(d) ${name} FAIL: artifacts must be byte-identical after the refusal`);
    assert.ok(!fs.existsSync(path.join(root, '.mavp')), `(d) ${name} FAIL: no context bundle may be written`);
  };
  const one = FULL;
  const two = 'title: Other\nowner_role: developer\nverification_type: unit';

  refuse('too-few', {}, wrap(one, two), ['--onto', 'T-5'], '--onto has 1 entry but the block has 2 task(s)');
  refuse('too-many', {}, wrap(one), ['--onto', 'T-5,new'], '--onto has 2 entries but the block has 1 task(s)');
  refuse('empty-list', {}, wrap(one), ['--onto', ''], 'is neither an existing task id (T-NNN) nor "new"');
  refuse('bad-entry', {}, wrap(one), ['--onto', 'later'], 'entry 1 "later" is neither an existing task id');
  refuse('no-heading', {}, wrap(one), ['--onto', 'T-99'], 'T-99 has no heading in BACKLOG.md');
  refuse('dup-heading', { dupHeading: true }, wrap(one), ['--onto', 'T-4'], 'T-4 has a duplicated heading in BACKLOG.md');
  refuse('same-id-twice', {}, wrap(one, two), ['--onto', 'T-5,T-5'], '--onto names T-5 more than once');
  for (const st of ['merged', 'deployed_dev', 'deployed_prod', 'runtime_verified', 'deprecated']) {
    refuse('status-' + st, { t5Status: st }, wrap(one), ['--onto', 'T-5'], `T-5 has status ${st} in BACKLOG.md`);
  }
  refuse('status-in-task-status-only', { taskStatus: taskStatusFixture({ t5Status: 'merged' }) }, wrap(one), ['--onto', 'T-5'], 'T-5 has status merged in TASK_STATUS.md');
  refuse('missing-required', {}, wrap('title: No owner\nverification_type: unit'), ['--onto', 'T-5'], 'missing required field(s): owner_role');
  refuse('missing-required-on-new', {}, wrap(one, 'title: No type\nowner_role: developer'), ['--onto', 'T-5,new'], 'missing required field(s): verification_type');
  refuse('unknown-vt', {}, wrap('title: Bad vt\nowner_role: developer\nverification_type: integration'), ['--onto', 'T-5'], 'unknown verification_type "integration"');
  console.log('Test (d) passed: every refusal exits 1 with BACKLOG.md, TASK_STATUS.md and PROCESS_STATE.json byte-identical');
}

// ---------------------------------------------------------------------------
// Repo handling and bullet-form paragraphs inside the re-scope.
// ---------------------------------------------------------------------------
{
  const r1 = apply.rescopeBacklogBlock('### T-1 — X\n- **Status:** planned\n- **Repo:** a\n\n- **Problem:** old\n', {
    title: 'Y', owner_role: 'developer', verification_type: 'unit', repo: 'a, b', problem: 'cost $& now',
  }, null);
  assert.ok(r1.block.includes('- **Repos:** a, b') && !r1.block.includes('- **Repo:** a\n'), `repo FAIL: two repos must replace the single Repo line:\n${r1.block}`);
  assert.ok(r1.block.includes('- **Problem:** cost $& now'), 'bullet-form Problem replaced in place, value verbatim');
  assert.ok(r1.replaced.includes('Repo') && r1.replaced.includes('Problem'));
  const r2 = apply.rescopeBacklogBlock('### T-1 — X\n- **Status:** planned\n', {
    title: 'Y', owner_role: 'developer', verification_type: 'unit',
  }, 'batch-repo');
  assert.ok(r2.block.includes('- **Repo:** batch-repo'), 'batch --repo default applies to a task without its own repo');
  console.log('Test passed: Repo/Repos switch and bullet-form paragraph handling');
}

console.log('apply-decomposition --onto: all tests passed');
