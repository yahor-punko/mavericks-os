'use strict';
// Regression test: T-606 — canonical bounded task-block helpers promoted
// into mavp-operator-lib.js, and rescope-task's convergence onto them.
//
// Covers the acceptance criteria verbatim:
//   1. locateTaskBlock() is the one canonical locator: returns offsets and a
//      duplicate count, and stops at the next `### T-NNN` OR `## ` heading
//      (never running past a level-2 section boundary).
//   2. setBlockField() is the canonical insert-if-missing write: inserts a
//      missing field right after the heading line, replaces an existing
//      field's rest-of-line, and does NOT normalize a placeholder ("—") away
//      before overwriting it.
//   3. extractBlockField() is the sole within-block read (normalizes "—"/"-"
//      to null).
//   4. findTaskBlockById() is a thin wrapper over locateTaskBlock(): its
//      output for a task whose block precedes a level-2 heading is
//      byte-identical to what the OLD parseAllTaskBlocks()+
//      truncateTaskBlockAtLevel2Heading() pipeline produced (pinned against
//      a local re-implementation of the old code, not just "it doesn't
//      throw"), and it refuses (returns null) on a duplicate heading rather
//      than silently returning the first match.
//   5. updateTaskField() refuses to write with an explicit `reason` when the
//      task is missing (`task_not_found`) or duplicated (`duplicate_heading`);
//      on success, given a fixture where the target block lacks field F and
//      a LATER block (in a different section) carries F, it inserts F into
//      the target only and leaves the later block byte-identical — the exact
//      shape of the bug this task exists to close.
//   6. End-to-end via --rescope-task: un-deferring a task whose Owner role
//      field holds an em-dash placeholder creates a TASK_STATUS entry with
//      owner "developer" (not the placeholder) and an Evidence line matching
//      buildTaskStatusEntry()'s shape.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  locateTaskBlock,
  setBlockField,
  extractBlockField,
  findTaskBlockById,
  updateTaskField,
  readTaskField,
  truncateTaskBlockAtLevel2Heading,
  parseAllTaskBlocks,
  buildTaskStatusEntry,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const RESCOPE_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-rescope-task.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't606-task-block-helpers-'));

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function makeFixtureRoot(name, { backlog, taskStatus }) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  writeUtf8(path.join(root, 'BACKLOG.md'), backlog);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), taskStatus);
  writeUtf8(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        active_slices: [],
        next_action: 'noop',
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 999,
        last_updated: '2026-01-01',
      },
      null,
      2
    ) + '\n'
  );
  return root;
}

function runRescopeTask(root, args) {
  return spawnSync('node', [RESCOPE_TASK_PATH, ...args], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
  });
}

// A faithful local re-implementation of the OLD (pre-T-606) findTaskBlockById
// — parseAllTaskBlocks() + a `.find()` on the first heading match — used
// below to pin byte-identity against the NEW locateTaskBlock()-based
// implementation, independent of git history.
function oldFindTaskBlockById(markdown, taskId) {
  const blocks = parseAllTaskBlocks(markdown || '');
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^###\\s+${escaped}\\b`);
  return blocks.find((b) => re.test(b)) || null;
}

// ---------------------------------------------------------------------------
// Test 1: locateTaskBlock() — count 0 / 1 / >1, offsets, and the ## boundary.
// ---------------------------------------------------------------------------
{
  const markdown = `# Backlog

## Active Wave

### T-100 — First task
- **Status:** in_progress
- **Owner role:** developer

## Wave 40 — Archived

### T-050 — Archived task
- **Status:** merged
`;

  const missing = locateTaskBlock(markdown, 'T-999');
  assert.strictEqual(missing.count, 0, 'Test 1a FAIL: missing task should have count 0');
  assert.strictEqual(missing.rawBlock, undefined, 'Test 1a FAIL: missing task should not carry rawBlock');

  const found = locateTaskBlock(markdown, 'T-100');
  assert.strictEqual(found.count, 1, 'Test 1b FAIL: expected count 1 for T-100');
  assert.ok(found.rawBlock.startsWith('### T-100 — First task'), 'Test 1b FAIL: rawBlock should start at the heading');
  assert.ok(
    !/##\s+Wave 40/.test(found.rawBlock),
    `Test 1c FAIL: T-100's block must stop before the "## Wave 40" heading, got:\n${found.rawBlock}`
  );
  assert.ok(
    !found.rawBlock.includes('### T-050'),
    'Test 1c FAIL: T-100 block must not run into the archived T-050 block'
  );
  assert.strictEqual(
    markdown.slice(found.startIndex, found.endIndex),
    found.rawBlock,
    'Test 1d FAIL: rawBlock must equal markdown.slice(startIndex, endIndex)'
  );

  const duplicateMarkdown = markdown + '\n### T-100 — Duplicate heading\n- **Status:** planned\n';
  const dup = locateTaskBlock(duplicateMarkdown, 'T-100');
  assert.strictEqual(dup.count, 2, 'Test 1e FAIL: expected count 2 for a duplicated heading');
  assert.strictEqual(dup.rawBlock, undefined, 'Test 1e FAIL: a duplicate result must not carry rawBlock');

  console.log('Test 1 passed: locateTaskBlock() returns offsets + duplicate count and stops at the next ### or ## heading');
}

// ---------------------------------------------------------------------------
// Test 2: setBlockField() — insert-if-missing, replace rest-of-line, and
// deliberate non-normalization of a placeholder value on write.
// ---------------------------------------------------------------------------
{
  const block = '### T-200 — Title\n- **Status:** planned\n- **Owner role:** —\n';

  const inserted = setBlockField(block, 'Verification type', 'runtime');
  assert.strictEqual(
    inserted,
    '### T-200 — Title\n- **Verification type:** runtime\n- **Status:** planned\n- **Owner role:** —\n',
    `Test 2a FAIL: missing field should be inserted right after the heading, got:\n${inserted}`
  );

  const replaced = setBlockField(block, 'Status', 'merged');
  assert.ok(replaced.includes('- **Status:** merged'), 'Test 2b FAIL: existing field should have its rest-of-line replaced');
  assert.ok(!replaced.includes('- **Status:** planned'), 'Test 2b FAIL: old value should be gone');

  // The pinned behavior change (BACKLOG.md problem statement): writing over a
  // placeholder value ("—") must REPLACE it, not skip/preserve it.
  const overwritten = setBlockField(block, 'Owner role', 'qa');
  assert.ok(
    overwritten.includes('- **Owner role:** qa'),
    `Test 2c FAIL: setBlockField() must replace a "—" placeholder, not skip it, got:\n${overwritten}`
  );
  assert.ok(!overwritten.includes('- **Owner role:** —'), 'Test 2c FAIL: placeholder must not survive the write');

  console.log('Test 2 passed: setBlockField() inserts when missing, replaces rest-of-line, and overwrites placeholders (does not skip them)');
}

// ---------------------------------------------------------------------------
// Test 3: extractBlockField() normalizes placeholders to null (the sole
// within-block read).
// ---------------------------------------------------------------------------
{
  const block = '### T-300 — Title\n- **Status:** —\n- **Owner role:** developer\n';
  assert.strictEqual(extractBlockField(block, 'Status'), null, 'Test 3a FAIL: "—" placeholder should read as null');
  assert.strictEqual(extractBlockField(block, 'Owner role'), 'developer', 'Test 3b FAIL: real value should read through');
  assert.strictEqual(extractBlockField(null, 'Status'), null, 'Test 3c FAIL: null block should read as null');
  console.log('Test 3 passed: extractBlockField() is the sole within-block read and normalizes placeholders to null');
}

// ---------------------------------------------------------------------------
// Test 4: findTaskBlockById() is a thin wrapper over locateTaskBlock() —
// byte-identical to the OLD parseAllTaskBlocks()+truncateTaskBlockAtLevel2Heading
// pipeline for a task whose block precedes a level-2 heading, and refuses
// (null) on a duplicate heading instead of returning the first match.
// ---------------------------------------------------------------------------
{
  const markdown = `# Backlog

## Active Wave

### T-401 — Task immediately followed by an archived wave heading
- **Status:** merged
- **Owner role:** developer

## Wave 55 — Archived

Some archived-wave prose that must never leak into T-401's block.
`;

  // buildContextBundle() calls `.trim()` on the findTaskBlockById() result
  // before (defensively) truncating it — see mavp-operator-lib.js's
  // buildContextBundle(). The NEW locator's raw block can retain a trailing
  // blank line right up to the next heading (an artifact of where its
  // boundary regex matches); the OLD pipeline's truncateTaskBlockAtLevel2Heading()
  // trimEnd()s that same blank line away. Comparing through the same `.trim()`
  // call buildContextBundle() actually makes is what pins real byte-identity
  // of the CONTEXT-BUNDLE OUTPUT (the acceptance criterion), not merely of
  // the two functions' raw, untrimmed return values.
  const newResult = findTaskBlockById(markdown, 'T-401').trim();
  const oldResult = truncateTaskBlockAtLevel2Heading(oldFindTaskBlockById(markdown, 'T-401'));
  assert.strictEqual(
    newResult,
    oldResult,
    `Test 4a FAIL: new findTaskBlockById() must be byte-identical (once trimmed, exactly as buildContextBundle() does) to the old bounded pipeline, got:\nNEW:\n${newResult}\nOLD:\n${oldResult}`
  );
  // truncateTaskBlockAtLevel2Heading is now a defensive no-op on the new
  // result (per BACKLOG.md ruling) — applying it again must be idempotent.
  assert.strictEqual(
    truncateTaskBlockAtLevel2Heading(newResult),
    newResult,
    'Test 4b FAIL: truncateTaskBlockAtLevel2Heading() should be a no-op on an already-bounded block'
  );

  const duplicateMarkdown = markdown + '\n### T-401 — Duplicate heading\n- **Status:** planned\n';
  assert.strictEqual(
    findTaskBlockById(duplicateMarkdown, 'T-401'),
    null,
    'Test 4c FAIL: findTaskBlockById() must refuse (return null) on a duplicated heading, not silently return the first match'
  );

  assert.strictEqual(findTaskBlockById(markdown, 'T-999'), null, 'Test 4d FAIL: missing task should return null');
  assert.strictEqual(findTaskBlockById('', 'T-1'), null, 'Test 4e FAIL: empty markdown should return null, not throw');

  console.log('Test 4 passed: findTaskBlockById() is byte-identical to the old bounded pipeline and refuses duplicate headings');
}

// ---------------------------------------------------------------------------
// Test 5: updateTaskField() composer — refusal reasons, and the exact
// regression shape: target block lacks field F, a LATER block (in a
// different section) carries F — only the target is written, the later
// block stays byte-identical.
// ---------------------------------------------------------------------------
{
  const markdown = `# Task Status

## Active tasks

### T-070 — Active task missing the Evidence field
- **Status:** qa_passed
- **Owner role:** developer

## Recently completed tasks

### T-012 — Archived task with real evidence
- **Status:** merged
- **Owner role:** developer
- **Evidence:** commit: 1a2b3c4
`;

  const t012BlockBefore = locateTaskBlock(markdown, 'T-012').rawBlock;

  const notFound = updateTaskField(markdown, 'T-999', 'Evidence', 'commit: deadbee');
  assert.strictEqual(notFound.ok, false, 'Test 5a FAIL: expected ok:false for a missing task');
  assert.strictEqual(notFound.reason, 'task_not_found', 'Test 5a FAIL: expected reason task_not_found');
  assert.strictEqual(notFound.updated, markdown, 'Test 5a FAIL: markdown must be echoed back unchanged on failure');

  const duplicateMarkdown = markdown + '\n### T-070 — Duplicate heading\n- **Status:** planned\n';
  const dupResult = updateTaskField(duplicateMarkdown, 'T-070', 'Evidence', 'commit: deadbee');
  assert.strictEqual(dupResult.ok, false, 'Test 5b FAIL: expected ok:false for a duplicated heading');
  assert.strictEqual(dupResult.reason, 'duplicate_heading', 'Test 5b FAIL: expected reason duplicate_heading');
  assert.strictEqual(dupResult.updated, duplicateMarkdown, 'Test 5b FAIL: markdown must be echoed back unchanged on failure');

  // The regression shape: T-070 (target) lacks Evidence; T-012 (a LATER,
  // ARCHIVED block) carries a real Evidence value. Writing Evidence onto
  // T-070 must never touch T-012.
  const success = updateTaskField(markdown, 'T-070', 'Evidence', 'commit: deadbee');
  assert.strictEqual(success.ok, true, 'Test 5c FAIL: expected ok:true for a well-formed single-match write');
  assert.strictEqual(success.reason, null, 'Test 5c FAIL: reason should be null on success');

  const t070BlockAfter = locateTaskBlock(success.updated, 'T-070').rawBlock;
  assert.ok(
    t070BlockAfter.includes('- **Evidence:** commit: deadbee'),
    `Test 5d FAIL: T-070 should now carry the written Evidence value, got:\n${t070BlockAfter}`
  );

  const t012BlockAfter = locateTaskBlock(success.updated, 'T-012').rawBlock;
  assert.strictEqual(
    t012BlockAfter,
    t012BlockBefore,
    `Test 5e FAIL: T-012 (the later, archived block) must stay byte-identical — this is the exact falsified-provenance defect the task exists to close.\nBEFORE:\n${t012BlockBefore}\nAFTER:\n${t012BlockAfter}`
  );

  console.log('Test 5 passed: updateTaskField() refuses on task_not_found/duplicate_heading, and a successful write never touches a later block');
}

// ---------------------------------------------------------------------------
// Test 6: readTaskField() — the bounded read counterpart.
// ---------------------------------------------------------------------------
{
  const markdown = `# Backlog

## Active Wave

### T-600 — Task with a real field
- **Status:** in_progress
- **Owner role:** —
`;
  const found = readTaskField(markdown, 'T-600', 'Status');
  assert.strictEqual(found.ok, true, 'Test 6a FAIL: expected ok:true');
  assert.strictEqual(found.value, 'in_progress', 'Test 6a FAIL: expected the real field value');

  const placeholder = readTaskField(markdown, 'T-600', 'Owner role');
  assert.strictEqual(placeholder.value, null, 'Test 6b FAIL: placeholder should read as null, same normalization as extractBlockField');

  const missing = readTaskField(markdown, 'T-999', 'Status');
  assert.strictEqual(missing.ok, false, 'Test 6c FAIL: expected ok:false for a missing task');
  assert.strictEqual(missing.reason, 'task_not_found', 'Test 6c FAIL: expected reason task_not_found');

  console.log('Test 6 passed: readTaskField() is the bounded read counterpart to updateTaskField()');
}

// ---------------------------------------------------------------------------
// Test 7 (end-to-end via --rescope-task): un-deferring a task whose Owner
// role field holds an em-dash placeholder creates a TASK_STATUS entry with
// owner "developer" (not the placeholder), via buildTaskStatusEntry() — so
// the created entry also carries an Evidence line, matching every other
// entry-creation path.
// ---------------------------------------------------------------------------
{
  const backlog = `# Backlog

## Active Wave


## Deferred Tasks

Tasks preserved for future waves.

### T-700 — Deferred task with a placeholder Owner role
- **Status:** deferred
- **Owner role:** —
- **Verification type:** runtime
`;

  const taskStatus = `# Task Status

## Active tasks


## Recently completed tasks
`;

  const root = makeFixtureRoot('placeholder-owner', { backlog, taskStatus });
  const result = runRescopeTask(root, ['T-700', '--status', 'planned']);
  assert.strictEqual(
    result.status,
    0,
    `Test 7a FAIL: expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );

  const updatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));
  assert.ok(
    /### T-700 —[\s\S]*?- \*\*Owner role:\*\* developer/.test(updatedTaskStatus),
    `Test 7b FAIL: an em-dash placeholder Owner role must resolve to "developer", not the placeholder, got:\n${updatedTaskStatus}`
  );
  assert.ok(
    !/### T-700 —[\s\S]*?- \*\*Owner role:\*\* —/.test(updatedTaskStatus),
    'Test 7b FAIL: the placeholder must not have been propagated into the created entry'
  );

  // The created entry's shape must match buildTaskStatusEntry()'s own
  // rendering exactly (including the Evidence line the old hand-rolled
  // version omitted).
  const expectedEntry = buildTaskStatusEntry('T-700', 'Deferred task with a placeholder Owner role', 'developer', 'runtime', 'planned').trim();
  const actualEntryMatch = updatedTaskStatus.match(/### T-700 —[\s\S]*?(?=\n## |$)/);
  assert.ok(actualEntryMatch, 'Test 7c FAIL: could not locate the created T-700 entry');
  assert.strictEqual(
    actualEntryMatch[0].trim(),
    expectedEntry,
    `Test 7c FAIL: created entry must match buildTaskStatusEntry()'s shape exactly, got:\n${actualEntryMatch[0]}\nEXPECTED:\n${expectedEntry}`
  );
  assert.ok(
    actualEntryMatch[0].includes('- **Evidence:** —'),
    'Test 7c FAIL: created entry must carry an Evidence line (the omission that made the falsification reachable)'
  );

  console.log('Test 7 passed: un-deferring a placeholder-Owner-role task creates a developer-owned entry matching buildTaskStatusEntry()\'s shape, including the Evidence line');
}

console.log('\nAll T-606 task-block-helpers tests passed.');
