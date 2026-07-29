'use strict';
// Regression test: T-542 — the 2026-07-26 close-session incident.
//
// updateTaskStatusField()/moveTaskToCompleted() in mavp-operator-close-
// session.js used to test `line.includes(taskId + ' ')` when deciding
// whether a "### " heading belonged to a given task. That substring test
// matches ANY heading that merely MENTIONS the task's ID in its title —
// not only the heading that IS that task — e.g. a lookup for "T-540"
// matched "### T-541 — Close the four T-540 security residuals — ...".
// The real incident fabricated `merged` onto T-541 (still `planned`, never
// touched) and stranded T-540's real merged block in Active tasks.
//
// The fix anchors the match to the heading's LEADING id
// (isTaskHeadingFor(), see mavp-operator-close-session.js) plus a
// belt-and-braces identity check in moveTaskToCompleted()
// (headingLeadingTaskId()). This file exercises both the anchored matcher
// directly and the two failure modes named in T-542's acceptance criteria:
// (a) an adjacent next block whose title references the moved task's ID,
// (b) a non-adjacent title reference.
//
// Mutant demonstration (see this task's developer report for the quoted
// before/after output): reverting isTaskHeadingFor() back to
// `line.includes(taskId + ' ') || line.includes(taskId + ' —')` makes both
// (a) and (b) below fail — proving these tests actually catch the defect,
// not just exercise code that happens not to crash.

const assert = require('node:assert');
const {
  moveTaskToCompleted,
  updateTaskStatusField,
  isTaskHeadingFor,
  headingLeadingTaskId,
} = require('./mavp-operator-close-session.js');

// ---------------------------------------------------------------------------
// Unit-level: isTaskHeadingFor() boundary behavior.
// ---------------------------------------------------------------------------

// A heading whose title merely MENTIONS another task's ID must never match
// a lookup for that mentioned ID — the exact shape from the incident.
assert.strictEqual(
  isTaskHeadingFor('### T-541 — Close the four T-540 security residuals — follow-up audit', 'T-540'),
  false,
  'FAIL: a heading that only MENTIONS T-540 in its title must not match a T-540 lookup'
);

// The heading that genuinely IS the task, with the usual " — " separator, matches.
assert.strictEqual(
  isTaskHeadingFor('### T-540 — Fix the four security residuals', 'T-540'),
  true,
  'FAIL: the actual T-540 heading (with " — " separator) must match a T-540 lookup'
);

// A heading with NO " — " separator at all (bare "### T-540") must still match —
// the architect's alternation ends in \s*$ specifically to cover this shape.
assert.strictEqual(
  isTaskHeadingFor('### T-540', 'T-540'),
  true,
  'FAIL: a bare "### T-540" heading with no separator must still match a T-540 lookup'
);

// Trailing whitespace after a bare ID (no separator) must still match.
assert.strictEqual(
  isTaskHeadingFor('### T-540   ', 'T-540'),
  true,
  'FAIL: a bare "### T-540" heading with trailing whitespace must still match'
);

// A heading ID with extra characters glued directly onto the leading ID
// (no whitespace, no separator) must NOT match — e.g. looking up "T-54"
// must not match a "### T-540 — ..." heading (prefix collision).
assert.strictEqual(
  isTaskHeadingFor('### T-540 — Fix the four security residuals', 'T-54'),
  false,
  'FAIL: "T-54" must not match a "### T-540 — ..." heading (leading-ID prefix collision)'
);

// A non-heading line never matches, regardless of content.
assert.strictEqual(
  isTaskHeadingFor('- **Status:** planned — mentions T-540 in prose', 'T-540'),
  false,
  'FAIL: a non-"### " line must never match, even if it contains the taskId text'
);

console.log('isTaskHeadingFor() unit assertions passed.');

// ---------------------------------------------------------------------------
// Identity-invariant relationship: whenever isTaskHeadingFor(line, taskId)
// is true, headingLeadingTaskId(line) must equal that same taskId. This is
// the property moveTaskToCompleted()'s belt-and-braces guard relies on —
// a table-driven test so a future change to either regex in isolation
// (e.g. loosening isTaskHeadingFor without updating headingLeadingTaskId
// to match) would be caught here.
// ---------------------------------------------------------------------------

const HEADING_TABLE = [
  '### T-540 — Fix the four security residuals',
  '### T-541 — Close the four T-540 security residuals — follow-up audit',
  '### T-540',
  '### T-5400 — a different, longer task id',
  '### T-54 — a different, shorter task id',
];
const ID_TABLE = ['T-540', 'T-541', 'T-54', 'T-5400'];

for (const line of HEADING_TABLE) {
  for (const id of ID_TABLE) {
    if (isTaskHeadingFor(line, id)) {
      assert.strictEqual(
        headingLeadingTaskId(line),
        id,
        `FAIL: isTaskHeadingFor("${line}", "${id}") was true but headingLeadingTaskId() returned "${headingLeadingTaskId(line)}" — the identity invariant moveTaskToCompleted() relies on does not hold`
      );
    }
  }
}

console.log('isTaskHeadingFor()/headingLeadingTaskId() identity-invariant table passed.');

// ---------------------------------------------------------------------------
// (a) moveTaskToCompleted() — an ADJACENT next block whose title references
// the moved task's ID: the correct block moves, and the referencing block
// is byte-unchanged.
// ---------------------------------------------------------------------------

const REFERENCING_BLOCK_TEXT = [
  '### T-541 — Close the four T-540 security residuals — follow-up audit',
  '- **Status:** planned',
  '- **Owner role:** developer',
  '- **Verification type:** artifact',
  '- **Last verified by:** —',
  '- **Evidence:** —',
  '- **Notes:** —',
].join('\n');

const FIXTURE_A = [
  '## Active tasks',
  '',
  '### T-540 — Fix the four security residuals',
  '- **Status:** qa_passed',
  '- **Owner role:** developer',
  '- **Verification type:** artifact',
  '- **Last verified by:** —',
  '- **Evidence:** commit: aaaaaaa branch: main',
  '- **Notes:** —',
  '',
  REFERENCING_BLOCK_TEXT,
  '',
  '## Recently completed tasks',
  '',
].join('\n');

{
  const result = moveTaskToCompleted(FIXTURE_A, 'T-540');
  const completedIdx = result.indexOf('## Recently completed tasks');

  assert.ok(
    result.indexOf('### T-540') > completedIdx,
    `Case (a) FAIL: T-540 must be moved below "## Recently completed tasks", got:\n${result}`
  );
  assert.ok(
    result.indexOf('### T-541') !== -1 && result.indexOf('### T-541') < completedIdx,
    `Case (a) FAIL: T-541 must remain above "## Recently completed tasks" (not moved), got:\n${result}`
  );
  assert.ok(
    result.includes(REFERENCING_BLOCK_TEXT),
    `Case (a) FAIL: T-541's referencing block must be byte-unchanged, got:\n${result}`
  );

  console.log('Case (a) passed: adjacent referencing block untouched, correct block moved');
}

// ---------------------------------------------------------------------------
// (b) updateTaskStatusField() — a NON-ADJACENT title reference: the
// referencing block's Status line is left unchanged.
// ---------------------------------------------------------------------------

const FIXTURE_B = [
  '## Active tasks',
  '',
  '### T-540 — Fix the four security residuals',
  '- **Status:** qa_passed',
  '- **Owner role:** developer',
  '- **Verification type:** artifact',
  '- **Last verified by:** —',
  '- **Evidence:** commit: aaaaaaa branch: main',
  '- **Notes:** —',
  '',
  '### T-550 — Unrelated task in between',
  '- **Status:** in_progress',
  '- **Owner role:** developer',
  '- **Verification type:** artifact',
  '- **Last verified by:** —',
  '- **Evidence:** —',
  '- **Notes:** —',
  '',
  '### T-560 — Follow-up to T-540 security residuals',
  '- **Status:** planned',
  '- **Owner role:** developer',
  '- **Verification type:** artifact',
  '- **Last verified by:** —',
  '- **Evidence:** —',
  '- **Notes:** —',
  '',
  '## Recently completed tasks',
  '',
].join('\n');

{
  const result = updateTaskStatusField(FIXTURE_B, 'T-540', 'Status', 'merged');

  assert.ok(
    /### T-540 — Fix the four security residuals\n- \*\*Status:\*\* merged/.test(result),
    `Case (b) FAIL: T-540's Status must be updated to merged, got:\n${result}`
  );
  assert.ok(
    /### T-550 — Unrelated task in between\n- \*\*Status:\*\* in_progress/.test(result),
    `Case (b) FAIL: T-550 (unrelated, in between) must be untouched, got:\n${result}`
  );
  assert.ok(
    /### T-560 — Follow-up to T-540 security residuals\n- \*\*Status:\*\* planned/.test(result),
    `Case (b) FAIL: T-560's Status line (title references T-540, non-adjacent) must remain "planned", got:\n${result}`
  );

  console.log('Case (b) passed: non-adjacent title reference left untouched by updateTaskStatusField');
}

console.log('All T-542 unit/fixture assertions passed.');
