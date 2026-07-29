'use strict';
// Regression test: T-558 — conflicting_needs_fix_rounds / conflicting_validator_blocked.
//
// appendNeedsFixRoundsIfMissing (mavp-operator-set-status.js) only ever
// inserts needs_fix_rounds: 0 when the field is ABSENT and never updates it
// in place, so every fix-round increment is a hand edit that appends a
// second occurrence further down the Evidence block — while
// extractTrajectories (mavp-operator-lib.js) reads the FIRST match only.
// Two corruptions were realized on the live artifact before this check was
// added (T-288, T-186). These two new validator checks fire on
// DISTINCT-VALUES, not occurrence-count, so an agreeing repeat (e.g.
// needs_fix_rounds: 0 twice — 28 such records exist on the live artifact)
// produces no finding.
//
// This test exercises the check functions directly (unit cases) and, via
// fixture BACKLOG/TASK_STATUS pairs run through parseArtifacts(), confirms
// the checks see task blocks in EVERY TASK_STATUS.md section (Active tasks
// AND Recently completed tasks), matching extractTrajectories' whole-file
// read scope.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const {
  parseArtifacts,
  checkConflictingNeedsFixRounds,
  checkConflictingValidatorBlocked,
} = require('./mavp-validator.js');

// ---------------------------------------------------------------------------
// Unit tests: call the check functions directly against constructed records
// (no fixture files needed). A "record" only needs `taskId` and `rawBlock`
// for these checks.
// ---------------------------------------------------------------------------

function record(taskId, evidenceLines) {
  const evidenceBlock = evidenceLines.map((l) => `  - ${l}`).join('\n');
  return {
    taskId,
    rawBlock: `### ${taskId} — Fixture\n- **Status:** merged\n- **Evidence:**\n${evidenceBlock}`,
  };
}

// (a) two DISTINCT needs_fix_rounds values -> finding fires.
{
  const findings = checkConflictingNeedsFixRounds([
    record('T-901', ['needs_fix_rounds: 1', 'needs_fix_rounds: 3']),
  ]);
  assert.strictEqual(findings.length, 1, 'Unit (a) FAIL: distinct needs_fix_rounds values should produce exactly one finding');
  assert.strictEqual(findings[0].checkName, 'conflicting_needs_fix_rounds');
  assert.strictEqual(findings[0].taskId, 'T-901');
  assert.ok(findings[0].message.includes('1, 3'), 'Unit (a) FAIL: message should list values in document order');
}

// (b) two AGREEING needs_fix_rounds values -> no finding (kills an
// occurrence-count predicate; 28 such records exist on the live artifact).
{
  const findings = checkConflictingNeedsFixRounds([
    record('T-902', ['needs_fix_rounds: 0', 'needs_fix_rounds: 0']),
  ]);
  assert.strictEqual(findings.length, 0, 'Unit (b) FAIL: agreeing repeat values must NOT fire (occurrence-count predicate would fire here)');
}

// (c) ONE digitless field-name mention ("needs_fix_rounds: N" as prose)
// alongside the REAL digit-valued canonical field -> no finding (kills a
// key-count predicate that ignores digit-validity). This shape (a digitless
// mention PLUS a real digit value, rather than two digitless mentions) is
// deliberate: a same-placeholder-twice fixture is structurally unable to
// discriminate a loose-regex mutant, because parseInt() on any non-digit
// capture yields NaN and JS Set treats NaN as equal to itself, so BOTH the
// correct digit-anchored regex (0 matches from the digitless text, 1 from
// the real field -> 1 total, no finding) AND a loose \S+-capturing mutant
// (2 matches: NaN from "N", 0 from the real field) would need to disagree
// on distinctness to be caught — and they do here, because NaN !== 0. Under
// the correct digit-anchored regex, "needs_fix_rounds: N" contributes ZERO
// matches (no digit), so only the single real "needs_fix_rounds: 0" counts
// -> below the 2-occurrence threshold -> no finding. Under a mutant regex
// that captures \S+ instead of \d+ (keeping the capture group and parseInt
// unchanged), "needs_fix_rounds: N" DOES contribute a match (raw "N",
// parsed to NaN) alongside "needs_fix_rounds: 0" (parsed to 0) -> two
// matches, NaN !== 0 -> distinct -> false finding.
{
  const findings = checkConflictingNeedsFixRounds([
    record('T-903', ['the needs_fix_rounds: N field documents fix-round counts', 'needs_fix_rounds: 0']),
  ]);
  assert.strictEqual(findings.length, 0, 'Unit (c) FAIL: a digitless mention alongside the real digit-valued field must never fire');
}

// (d) a single digit-valued occurrence -> no finding (including the
// multiline sub-bullet shape protected by test-evidence-multiline.js).
{
  const findings = checkConflictingNeedsFixRounds([record('T-904', ['commit: abc1234', 'needs_fix_rounds: 0'])]);
  assert.strictEqual(findings.length, 0, 'Unit (d) FAIL: a single occurrence must never fire (over-eager evidence-region regex)');
}

// (e) two DISTINCT validator_blocked booleans -> finding fires (kills
// dropping the second check entirely).
{
  const findings = checkConflictingValidatorBlocked([
    record('T-905', ['validator_blocked: true', 'validator_blocked: false']),
  ]);
  assert.strictEqual(findings.length, 1, 'Unit (e) FAIL: distinct validator_blocked values should produce exactly one finding');
  assert.strictEqual(findings[0].checkName, 'conflicting_validator_blocked');
  assert.ok(findings[0].message.includes('true, false'), 'Unit (e) FAIL: message should list values in document order');
}

// (f) two AGREEING validator_blocked booleans -> no finding.
{
  const findings = checkConflictingValidatorBlocked([
    record('T-906', ['validator_blocked: false', 'validator_blocked: false']),
  ]);
  assert.strictEqual(findings.length, 0, 'Unit (f) FAIL: agreeing validator_blocked repeats must not fire');
}

// (g) no-space / trailing-punctuation shape, e.g. "validator_blocked:false)."
// — this is the exact shape T-186 carried and must still be parsed.
{
  const findings = checkConflictingValidatorBlocked([
    record('T-907', ['validator_blocked:true', 'discussion text (validator_blocked:false).']),
  ]);
  assert.strictEqual(findings.length, 1, 'Unit (g) FAIL: no-space/trailing-punctuation validator_blocked matches must still be detected');
}

console.log('Unit tests (checkConflictingNeedsFixRounds / checkConflictingValidatorBlocked) passed.');

// ---------------------------------------------------------------------------
// Fixture: BACKLOG.md + TASK_STATUS.md pair covering every section the
// evidence parser reads (Active tasks AND Recently completed tasks), and
// re-confirming the single-occurrence multiline sub-bullet shape from
// scripts/test-evidence-multiline.js produces no finding under these new
// checks either.
// ---------------------------------------------------------------------------
const TMP_DIR = path.join(os.tmpdir(), 't558-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-920 — Fixture active task with conflicting needs_fix_rounds
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
`;

const TASK_STATUS_FIXTURE = `# TASK_STATUS

## Active tasks

### T-920 — Fixture active task with conflicting needs_fix_rounds
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: abc1234
  - needs_fix_rounds: 1
  - needs_fix_rounds: 3

### T-921 — Fixture active task with a single needs_fix_rounds sub-bullet
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: abcd123
  - needs_fix_rounds: 0

## Recently completed tasks

### T-922 — Fixture archived task with conflicting validator_blocked
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: def4567
  - validator_blocked: true
  - validator_blocked: false

### T-923 — Fixture archived task with agreeing needs_fix_rounds repeats
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:**
  - commit: ffff890
  - needs_fix_rounds: 0
  - needs_fix_rounds: 0

### T-924 — Fixture archived cross-repo merged task, repeated commit: is legitimate
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Repos:** repo-a, repo-b
- **Evidence:**
  - commit: aaa1111 (repo-a)
  - commit: bbb2222 (repo-b)

### T-925 — Fixture archived task, stray mentions live in Notes not Evidence
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234 needs_fix_rounds: 2 validator_blocked: false
- **Notes:** the round-1 report claimed needs_fix_rounds: 9 and validator_blocked: true before both were corrected
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

// Case 1: T-920 is in the ACTIVE tasks section with distinct needs_fix_rounds
// values -> finding fires.
assert.ok(
  findFinding('conflicting_needs_fix_rounds', 'T-920'),
  'FAIL (case 1): T-920 has conflicting needs_fix_rounds values in Active tasks, expected a finding'
);

// Case 2: T-921 has a single needs_fix_rounds sub-bullet -> no finding
// (kills an over-eager evidence-region regex).
assert.strictEqual(
  findFinding('conflicting_needs_fix_rounds', 'T-921'),
  undefined,
  'FAIL (case 2): T-921 has a single needs_fix_rounds occurrence, expected no finding'
);

// Case 3: T-922 is in the ARCHIVED ("Recently completed tasks") section with
// distinct validator_blocked values -> finding fires. This proves the checks
// run over every section the evidence parser reads, not just Active tasks.
assert.ok(
  findFinding('conflicting_validator_blocked', 'T-922'),
  'FAIL (case 3): T-922 has conflicting validator_blocked values in an archived section, expected a finding'
);

// Case 4: T-923 has agreeing needs_fix_rounds repeats in an archived section
// -> no finding (kills an occurrence-count predicate).
assert.strictEqual(
  findFinding('conflicting_needs_fix_rounds', 'T-923'),
  undefined,
  'FAIL (case 4): T-923 has agreeing needs_fix_rounds repeats, expected no finding'
);

// Case 5: T-924 is a cross-repo task with legitimately repeated commit: —
// commit:/branch: are excluded from this pattern entirely, and no
// conflicting_needs_fix_rounds/conflicting_validator_blocked finding should
// ever reference T-924 (there is no needs_fix_rounds/validator_blocked field
// on it at all).
assert.strictEqual(
  findFinding('conflicting_needs_fix_rounds', 'T-924'),
  undefined,
  'FAIL (case 5): T-924 has repeated commit: only, expected no conflicting_needs_fix_rounds finding'
);
assert.strictEqual(
  findFinding('conflicting_validator_blocked', 'T-924'),
  undefined,
  'FAIL (case 5): T-924 has repeated commit: only, expected no conflicting_validator_blocked finding'
);

// Case 6: T-925 has exactly ONE needs_fix_rounds occurrence and ONE
// validator_blocked occurrence inside the Evidence field itself, but a
// SECOND, disagreeing mention of each lives in the Notes field (outside
// Evidence). This kills an over-eager evidence-region regex — a mutant
// that scans record.rawBlock (the whole task block) instead of
// getFieldMultiline(record.rawBlock, 'Evidence') would pick up the stray
// Notes mentions and report a false conflict; the correct implementation,
// scoped to the Evidence field only, sees a single occurrence of each and
// produces no finding.
assert.strictEqual(
  findFinding('conflicting_needs_fix_rounds', 'T-925'),
  undefined,
  'FAIL (case 6): T-925 has a single needs_fix_rounds occurrence in Evidence (a disagreeing mention lives only in Notes), expected no finding'
);
assert.strictEqual(
  findFinding('conflicting_validator_blocked', 'T-925'),
  undefined,
  'FAIL (case 6): T-925 has a single validator_blocked occurrence in Evidence (a disagreeing mention lives only in Notes), expected no finding'
);

// Both checks are warning severity, explicitly declared (not inherited).
const t920Finding = findFinding('conflicting_needs_fix_rounds', 'T-920');
assert.strictEqual(t920Finding.severity, 'warning', 'FAIL: conflicting_needs_fix_rounds must be warning severity');
const t922Finding = findFinding('conflicting_validator_blocked', 'T-922');
assert.strictEqual(t922Finding.severity, 'warning', 'FAIL: conflicting_validator_blocked must be warning severity');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-558 fixture assertions passed.');
