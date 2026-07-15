'use strict';
// Regression test: T-409 — getField(block, 'Evidence') only ever returned the
// first line/sub-bullet of a multi-line evidence block, so several validator
// checks silently missed fields (needs_fix_rounds:, commit:, branch:, etc.)
// written as a later sub-bullet. This test exercises the new getFieldMultiline()
// helper directly (unit cases) and, via fixture BACKLOG/TASK_STATUS pairs run
// through parseArtifacts(), confirms the 7 switched call sites now see the
// full multi-line field.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const { parseArtifacts, getFieldMultiline } = require('./mavp-validator.js');

// ---------------------------------------------------------------------------
// Helper unit tests (case 7): exercise getFieldMultiline() directly, no fixture
// files needed.
// ---------------------------------------------------------------------------

// (a) inline value only, no sub-bullets.
assert.strictEqual(
  getFieldMultiline('- **Evidence:** commit: abc1234', 'Evidence'),
  'commit: abc1234',
  'Unit test FAIL: inline-only value should be returned as-is'
);

// (b) inline value + sub-bullets, joined with \n.
assert.strictEqual(
  getFieldMultiline('- **Evidence:** first\n  - second\n  - third', 'Evidence'),
  'first\nsecond\nthird',
  'Unit test FAIL: inline + sub-bullets should be joined with \\n, sub-bullet prefix stripped'
);

// (c) termination at the next top-level bold field bullet — the next field's
// sub-bullets must NOT be swept in.
assert.strictEqual(
  getFieldMultiline('- **Evidence:**\n  - a\n  - b\n- **Notes:** stop\n  - c', 'Evidence'),
  'a\nb',
  'Unit test FAIL: getFieldMultiline should stop collecting at the next top-level "- **Field:**" bullet'
);

// (d) null when the field label is absent entirely.
assert.strictEqual(
  getFieldMultiline('- **Status:** merged', 'Evidence'),
  null,
  'Unit test FAIL: absent field label should return null'
);

// (e) null for an empty label immediately followed by the next top-level field
// (no inline value, no sub-bullets collected before the next field bullet).
assert.strictEqual(
  getFieldMultiline('- **Evidence:**\n- **Notes:** something', 'Evidence'),
  null,
  'Unit test FAIL: empty label with no sub-bullets before the next field should return null'
);

console.log('Helper unit tests (getFieldMultiline) passed.');

// ---------------------------------------------------------------------------
// Fixture: BACKLOG.md + TASK_STATUS.md pair covering the switched call sites.
// ---------------------------------------------------------------------------
const TMP_DIR = path.join(os.tmpdir(), 't409-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-915 — Fixture dev_done task with branch as later sub-bullet
- **Status:** dev_done
- **Owner role:** developer
- **Verification type:** runtime

### T-916 — Fixture cross-repo merged task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Repos:** repo-a, repo-b
`;

const TASK_STATUS_FIXTURE = `# TASK_STATUS

## Active tasks

### T-910 — Fixture merged runtime task, needs_fix_rounds as a later sub-bullet
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: abc1234
  - needs_fix_rounds: 0

### T-911 — Fixture merged runtime task, no needs_fix_rounds anywhere
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: abc1234

### T-912 — Fixture merged runtime task, commit as a non-first sub-bullet
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - stale_verified: true
  - commit: abcd123

### T-913 — Fixture merged runtime task with empty evidence
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** —

### T-914 — Fixture merged artifact task, artifact: sub-bullet, no commit
- **Status:** merged
- **Owner:** developer
- **Verification type:** artifact
- **Evidence:**
  - artifact: docs/AUDIT.md

### T-915 — Fixture dev_done task with branch as later sub-bullet
- **Status:** dev_done
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: abc1234
  - branch: main

### T-916 — Fixture cross-repo merged task
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Repos:** repo-a, repo-b
- **Evidence:**
  - commit: aaa1111 (repo-a)
  - commit: bbb2222 (repo-b)

## Recently completed tasks
`;

const backlogPath = path.join(TMP_DIR, 'BACKLOG.md');
const taskStatusPath = path.join(TMP_DIR, 'TASK_STATUS.md');
fs.writeFileSync(backlogPath, BACKLOG_FIXTURE, 'utf8');
fs.writeFileSync(taskStatusPath, TASK_STATUS_FIXTURE, 'utf8');

const parsed = parseArtifacts({ backlogPath, taskStatusPath });
const findings = parsed.comparison.findings;

function findFinding(checkName, taskId) {
  return findings.find((f) => f.checkName === checkName && f.taskId === taskId);
}

// Case 1: needs_fix_rounds present as a LATER sub-bullet — no finding.
assert.strictEqual(
  findFinding('merged_missing_needs_fix_rounds', 'T-910'),
  undefined,
  `FAIL (case 1): T-910 has needs_fix_rounds: as a later sub-bullet, expected no merged_missing_needs_fix_rounds finding, got: ${JSON.stringify(findFinding('merged_missing_needs_fix_rounds', 'T-910'))}`
);

// Case 2: same shape but WITHOUT needs_fix_rounds — finding present.
assert.ok(
  findFinding('merged_missing_needs_fix_rounds', 'T-911'),
  'FAIL (case 2): T-911 has no needs_fix_rounds: anywhere, expected merged_missing_needs_fix_rounds finding'
);

// Case 3: commit: as a NON-first sub-bullet — no merged_missing_commit_field.
assert.strictEqual(
  findFinding('merged_missing_commit_field', 'T-912'),
  undefined,
  `FAIL (case 3): T-912 has commit: as a non-first sub-bullet, expected no merged_missing_commit_field finding, got: ${JSON.stringify(findFinding('merged_missing_commit_field', 'T-912'))}`
);

// Case 4: empty evidence ("—") — merged_missing_commit_field present.
assert.ok(
  findFinding('merged_missing_commit_field', 'T-913'),
  'FAIL (case 4): T-913 has empty evidence, expected merged_missing_commit_field finding'
);

// Case 5: artifact: sub-bullet on an artifact-verification task, no commit — no finding.
assert.strictEqual(
  findFinding('merged_missing_commit_field', 'T-914'),
  undefined,
  `FAIL (case 5): T-914 is verification_type artifact with an artifact: sub-bullet, expected no merged_missing_commit_field finding, got: ${JSON.stringify(findFinding('merged_missing_commit_field', 'T-914'))}`
);

// Case 6: dev_done task, commit: first + branch: later — no dev_done_missing_branch.
assert.strictEqual(
  findFinding('dev_done_missing_branch', 'T-915'),
  undefined,
  `FAIL (case 6): T-915 has branch: as a later sub-bullet, expected no dev_done_missing_branch finding, got: ${JSON.stringify(findFinding('dev_done_missing_branch', 'T-915'))}`
);

// Case 8 (bonus): cross-repo task with per-repo commit: sub-bullets — no cross_repo_missing_evidence.
assert.strictEqual(
  findFinding('cross_repo_missing_evidence', 'T-916'),
  undefined,
  `FAIL (case 8): T-916 has commit: for both repo-a and repo-b as separate sub-bullets, expected no cross_repo_missing_evidence finding, got: ${JSON.stringify(findFinding('cross_repo_missing_evidence', 'T-916'))}`
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-409 fixture assertions passed.');
