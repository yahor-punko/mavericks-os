'use strict';
// Regression test: T-264 — archiveActiveWaveInBacklog reinserts fresh "## Active Wave" heading

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const { archiveActiveWaveInBacklog, insertIntoActiveWave } = require('./mavp-operator-lib.js');

const TMP_DIR = path.join(os.tmpdir(), 't264-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture: BACKLOG.md with Active Wave containing tasks, plus an existing archived wave
// ---------------------------------------------------------------------------
const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first
- end-to-end value second

## Active Wave

### T-001 — Some active task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact

## Wave 38 — Archived

### T-000 — Old archived task
- **Status:** merged
`;

const BACKLOG_PATH = path.join(TMP_DIR, 'BACKLOG.md');

// ---------------------------------------------------------------------------
// Test 1: archive leaves exactly one "## Active Wave" heading
// ---------------------------------------------------------------------------
fs.writeFileSync(BACKLOG_PATH, BACKLOG_FIXTURE, 'utf8');

const result = archiveActiveWaveInBacklog(BACKLOG_PATH, 39);
assert.strictEqual(result.ok, true, 'Test 1 FAIL: archiveActiveWaveInBacklog should return ok:true');
assert.strictEqual(result.archived, true, 'Test 1 FAIL: archiveActiveWaveInBacklog should return archived:true');

const afterArchive = fs.readFileSync(BACKLOG_PATH, 'utf8');

// Count how many "## Active Wave" headings remain
const activeWaveMatches = afterArchive.match(/^## Active Wave/gm) || [];
assert.strictEqual(
  activeWaveMatches.length,
  1,
  `Test 1 FAIL: expected exactly 1 "## Active Wave" heading after archive, got ${activeWaveMatches.length}`
);

// The old heading should now be archived
assert.ok(
  afterArchive.includes('## Wave 39 — Archived'),
  'Test 1 FAIL: expected "## Wave 39 — Archived" to appear after archiving wave 39'
);

// The fresh "## Active Wave" should come BEFORE the archived section
const activeIdx = afterArchive.indexOf('## Active Wave');
const archivedIdx = afterArchive.indexOf('## Wave 39 — Archived');
assert.ok(
  activeIdx < archivedIdx,
  `Test 1 FAIL: fresh "## Active Wave" (at ${activeIdx}) should appear before "## Wave 39 — Archived" (at ${archivedIdx})`
);

// The fresh "## Active Wave" should come AFTER "## Selection rules"
const selectionIdx = afterArchive.indexOf('## Selection rules');
assert.ok(
  selectionIdx < activeIdx,
  `Test 1 FAIL: "## Selection rules" (at ${selectionIdx}) should appear before fresh "## Active Wave" (at ${activeIdx})`
);

// ---------------------------------------------------------------------------
// Test 2: a subsequent insertIntoActiveWave call lands under "## Active Wave"
//         and not inside the archived section
// ---------------------------------------------------------------------------
const newTaskEntry = `### T-264 — New task after archive
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime

`;

const afterInsert = insertIntoActiveWave(afterArchive, newTaskEntry);

// T-264 should appear BEFORE the archived wave heading
const newTaskIdx = afterInsert.indexOf('### T-264');
const archivedIdxAfterInsert = afterInsert.indexOf('## Wave 39 — Archived');
assert.ok(
  newTaskIdx !== -1,
  'Test 2 FAIL: inserted task heading not found in result'
);
assert.ok(
  newTaskIdx < archivedIdxAfterInsert,
  `Test 2 FAIL: inserted task (at ${newTaskIdx}) should be before "## Wave 39 — Archived" (at ${archivedIdxAfterInsert})`
);

// ---------------------------------------------------------------------------
// Test 3: calling archiveActiveWaveInBacklog when no Active Wave heading exists
//         should return archived:false (no fresh heading added, no error)
// ---------------------------------------------------------------------------
const BACKLOG_NO_ACTIVE = `# BACKLOG

## Selection rules

- unblockers first

## Wave 5 — Archived

### T-099 — Old task
`;

fs.writeFileSync(BACKLOG_PATH, BACKLOG_NO_ACTIVE, 'utf8');
const result3 = archiveActiveWaveInBacklog(BACKLOG_PATH, 6);
assert.strictEqual(result3.ok, true, 'Test 3 FAIL: should return ok:true with no Active Wave');
assert.strictEqual(result3.archived, false, 'Test 3 FAIL: should return archived:false when nothing to archive');

// File should be unchanged (no fresh heading inserted when there was nothing to archive)
const afterNoOp = fs.readFileSync(BACKLOG_PATH, 'utf8');
const activeHeadingsNoOp = afterNoOp.match(/^## Active Wave/gm) || [];
assert.strictEqual(
  activeHeadingsNoOp.length,
  0,
  'Test 3 FAIL: no "## Active Wave" should have been inserted when there was nothing to archive'
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-264 assertions passed.');
