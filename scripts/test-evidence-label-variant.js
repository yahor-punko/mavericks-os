'use strict';
// Regression test: T-745 — Evidence-label exactness.
//
// getFieldMultiline()/extractBlockField()/setBlockField() all match the
// exact label "- **Evidence:**" / "- **Notes:**" only. A top-level, non-
// indented ANNOTATED key — e.g. "- **Evidence (2026-09-20, QA):**" — is
// invisible to every one of those readers, and setBlockField() (reached by
// --set-status --commit) INSERTS a brand-new canonical field next to it
// rather than recognizing the annotated one, silently forking a second
// field. This test covers three things:
//
//   1. findAnnotatedFieldVariant() (mavp-operator-lib.js) unit behavior —
//      detects the top-level annotated form, never the sanctioned indented
//      sub-bullet form.
//   2. The validator's evidence_label_variant check (warning severity) —
//      fires on the defect shape, names the remedy, quotes the offending
//      key verbatim; does NOT fire on the sanctioned form (canonical field
//      + indented sub-bullets, including a bold-keyed one), and confirms
//      getFieldMultiline() still reads that sanctioned content.
//   3. The writer refusal in --set-status --commit: a block with an
//      annotated Evidence key and NO canonical field must exit non-zero and
//      write NOTHING (asserted via grep -c '^- \*\*Evidence' staying at 1);
//      the sanctioned form must still succeed normally.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const { findAnnotatedFieldVariant } = require('./mavp-operator-lib.js');
const { parseArtifacts, getFieldMultiline } = require('./mavp-validator.js');

const SCRIPTS_DIR = __dirname;
const SET_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-status.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function countTopLevelEvidenceBullets(markdown) {
  return (markdown.match(/^- \*\*Evidence/gm) || []).length;
}

function gitQuiet(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function runSetStatus(args, cwd, env) {
  const result = spawnSync(NODE_BIN, [SET_STATUS_PATH, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

// ---------------------------------------------------------------------------
// Part 1 — unit: findAnnotatedFieldVariant() (mavp-operator-lib.js).
// ---------------------------------------------------------------------------
{
  // (a) top-level annotated key, no canonical field anywhere -> detected,
  // canonicalExists: false.
  const a = findAnnotatedFieldVariant(
    '### T-1 — Fixture\n- **Status:** merged\n- **Evidence (2026-09-20, QA):** commit: abc1234',
    'Evidence'
  );
  assert.ok(a, 'Unit (a) FAIL: top-level annotated Evidence key should be detected');
  assert.strictEqual(a.key, 'Evidence (2026-09-20, QA)', 'Unit (a) FAIL: key should be quoted verbatim (label + parenthetical, no asterisks/colon)');
  assert.strictEqual(a.canonicalExists, false, 'Unit (a) FAIL: no canonical - **Evidence:** field exists in this block');

  // (b) top-level annotated key PLUS a separate canonical field elsewhere ->
  // detected, canonicalExists: true (the forked-field shape).
  const b = findAnnotatedFieldVariant(
    '### T-2 — Fixture\n- **Status:** merged\n- **Evidence:** commit: abc1234\n- **Evidence (2026-09-20, QA):** commit: def5678',
    'Evidence'
  );
  assert.ok(b, 'Unit (b) FAIL: top-level annotated Evidence key should be detected even alongside a canonical field');
  assert.strictEqual(b.canonicalExists, true, 'Unit (b) FAIL: canonical - **Evidence:** field exists elsewhere in this block');

  // (c) SANCTIONED form: canonical field + an INDENTED sub-bullet carrying
  // the same annotated bold key -> null (never flagged as the defect shape).
  const c = findAnnotatedFieldVariant(
    '### T-3 — Fixture\n- **Status:** merged\n- **Evidence:** commit: abc1234\n  - **Evidence (2026-09-20, QA):** re-verified, still commit: abc1234',
    'Evidence'
  );
  assert.strictEqual(c, null, 'Unit (c) FAIL: an INDENTED sub-bullet with an annotated bold key is the sanctioned form and must never be flagged');

  // (d) no annotated key at all -> null.
  const d = findAnnotatedFieldVariant('### T-4 — Fixture\n- **Status:** merged\n- **Evidence:** commit: abc1234', 'Evidence');
  assert.strictEqual(d, null, 'Unit (d) FAIL: a plain canonical field with no annotated variant should return null');

  // (e) absent block -> null (no throw).
  assert.strictEqual(findAnnotatedFieldVariant(null, 'Evidence'), null, 'Unit (e) FAIL: null block should return null, not throw');

  console.log('Unit tests (findAnnotatedFieldVariant) passed.');
}

// ---------------------------------------------------------------------------
// Part 2 — validator fixture: evidence_label_variant check.
// ---------------------------------------------------------------------------
const TMP_DIR = path.join(os.tmpdir(), 't745-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-940 — Fixture task, top-level annotated Evidence, no canonical field
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

### T-941 — Fixture task, top-level annotated Evidence, canonical field also present (forked)
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

### T-942 — Fixture task, sanctioned dated sub-bullet under canonical field
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

### T-943 — Fixture task, top-level annotated Notes, no canonical field
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

### T-944 — Fixture task, an unrelated annotated label outside scope
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
`;

const TASK_STATUS_FIXTURE = `# TASK_STATUS

## Active tasks

### T-940 — Fixture task, top-level annotated Evidence, no canonical field
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence (2026-09-20, QA):** commit: abc1234

### T-941 — Fixture task, top-level annotated Evidence, canonical field also present (forked)
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234
- **Evidence (2026-09-20, QA):** re-verified, still commit: abc1234

### T-942 — Fixture task, sanctioned dated sub-bullet under canonical field
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234
  - **Evidence (2026-09-20, QA):** re-verified, still commit: abc1234

### T-943 — Fixture task, top-level annotated Notes, no canonical field
- **Status:** merged
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234
- **Notes (2026-09-20, QA):** re-verified by QA, no changes needed

### T-944 — Fixture task, an unrelated annotated label outside scope
- **Status:** deferred
- **Owner:** developer
- **Verification type:** runtime
- **Evidence:** —
- **Deferred reason (2026-09-20):** waiting on external review
`;

const backlogPath = path.join(TMP_DIR, 'BACKLOG.md');
const taskStatusPath = path.join(TMP_DIR, 'TASK_STATUS.md');
writeUtf8(backlogPath, BACKLOG_FIXTURE);
writeUtf8(taskStatusPath, TASK_STATUS_FIXTURE);

const parsed = parseArtifacts({ backlogPath, taskStatusPath });
const findings = parsed.comparison.findings;

function findFinding(checkName, taskId) {
  return findings.find((f) => f.checkName === checkName && f.taskId === taskId);
}

// Case 1: T-940 — top-level annotated Evidence, no canonical field -> finding
// fires, warning severity, message quotes the key verbatim, remedy names
// creating the canonical field.
{
  const finding = findFinding('evidence_label_variant', 'T-940');
  assert.ok(finding, 'FAIL (case 1): T-940 has a top-level annotated Evidence key with no canonical field, expected an evidence_label_variant finding');
  assert.strictEqual(finding.severity, 'warning', 'FAIL (case 1): evidence_label_variant must be warning severity');
  assert.ok(
    finding.message.includes('Evidence (2026-09-20, QA)'),
    `FAIL (case 1): message should quote the offending key verbatim, got: ${finding.message}`
  );
  assert.ok(
    /create a - \*\*Evidence:\*\* field/i.test(finding.suggestedAction),
    `FAIL (case 1): remedy should name creating the canonical field (none exists), got: ${finding.suggestedAction}`
  );
  console.log('Case 1 passed: top-level annotated Evidence with no canonical field fires evidence_label_variant, warning severity, key quoted, remedy names field creation');
}

// Case 2: T-941 — top-level annotated Evidence PLUS a canonical field
// (forked) -> finding fires, remedy names demotion (not creation, since the
// canonical field already exists).
{
  const finding = findFinding('evidence_label_variant', 'T-941');
  assert.ok(finding, 'FAIL (case 2): T-941 has a forked top-level annotated Evidence key, expected an evidence_label_variant finding');
  assert.ok(
    /demote/i.test(finding.suggestedAction) && !/create a - \*\*Evidence:\*\* field/i.test(finding.suggestedAction),
    `FAIL (case 2): remedy should name demotion, not field creation (canonical already exists), got: ${finding.suggestedAction}`
  );
  console.log('Case 2 passed: forked top-level annotated Evidence (canonical also present) fires with a demote-only remedy');
}

// Case 3: T-942 — SANCTIONED form (canonical field + indented dated
// sub-bullet, bold-keyed) -> NO finding, and getFieldMultiline() still reads
// the sub-bullet content as part of the canonical field. Without this case
// the check could reasonably be implemented to fire on the very form the
// doctrine recommends.
{
  const finding = findFinding('evidence_label_variant', 'T-942');
  assert.strictEqual(finding, undefined, `FAIL (case 3): T-942 uses the sanctioned indented-sub-bullet form, expected NO evidence_label_variant finding, got: ${JSON.stringify(finding)}`);

  const record = parsed.records.taskStatus.find((r) => r.taskId === 'T-942');
  assert.ok(record, 'FAIL (case 3) setup: T-942 record should exist');
  const evidenceText = getFieldMultiline(record.rawBlock, 'Evidence');
  assert.ok(evidenceText.includes('commit: abc1234'), `FAIL (case 3): canonical inline value should still be read, got: ${evidenceText}`);
  assert.ok(
    evidenceText.includes('**Evidence (2026-09-20, QA):** re-verified, still commit: abc1234'),
    `FAIL (case 3): the sanctioned dated sub-bullet's content must still be read as part of the canonical field, got: ${evidenceText}`
  );
  console.log('Case 3 passed: sanctioned form (canonical + indented dated sub-bullet) produces no finding, and its content is still read via getFieldMultiline');
}

// Case 4: T-943 — top-level annotated NOTES key, no canonical Notes field ->
// finding fires (Notes is in scope, alongside Evidence).
{
  const finding = findFinding('evidence_label_variant', 'T-943');
  assert.ok(finding, 'FAIL (case 4): T-943 has a top-level annotated Notes key with no canonical field, expected an evidence_label_variant finding');
  assert.ok(finding.message.includes('Notes (2026-09-20, QA)'), `FAIL (case 4): message should quote the offending Notes key verbatim, got: ${finding.message}`);
  console.log('Case 4 passed: top-level annotated Notes key (no canonical field) also fires evidence_label_variant');
}

// Case 5: T-944 — an annotated label OUTSIDE the Evidence/Notes scope (e.g.
// "Deferred reason (...)") -> NO finding. Nothing reads that label, so
// firing on it would be noise, not signal.
{
  const finding = findFinding('evidence_label_variant', 'T-944');
  assert.strictEqual(finding, undefined, `FAIL (case 5): T-944's annotated label is outside the Evidence/Notes scope, expected no finding, got: ${JSON.stringify(finding)}`);
  console.log('Case 5 passed: an annotated label outside Evidence/Notes scope (Deferred reason) produces no finding');
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Part 3 — end-to-end: the --set-status --commit writer refusal.
// ---------------------------------------------------------------------------
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't745-repo-'));
gitQuiet(REPO, ['init', '-q', '-b', 'main']);
gitQuiet(REPO, ['config', 'user.email', 'demo@example.invalid']);
gitQuiet(REPO, ['config', 'user.name', 'Test']);
writeUtf8(path.join(REPO, 'seed.txt'), 'hello\n');
gitQuiet(REPO, ['add', 'seed.txt']);
gitQuiet(REPO, ['commit', '-q', '-m', 'seed commit']);
const REAL_COMMIT_SHORT = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

function writeDefectFixture(root, taskId) {
  writeUtf8(path.join(root, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### ${taskId} — Fixture task
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
`);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### ${taskId} — Fixture task
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence (2026-09-20, QA):** commit: deadbee1

## Recently completed tasks
`);
}

function writeSanctionedFixture(root, taskId) {
  writeUtf8(path.join(root, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### ${taskId} — Fixture task
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
`);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### ${taskId} — Fixture task
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** qa notes: verified manually
  - **Evidence (2026-09-15, QA):** first pass, all cases pass

## Recently completed tasks
`);
}

// Case 6: writer refusal — a block with an annotated Evidence key and NO
// canonical field. --set-status --commit must exit non-zero and write
// NOTHING: grep -c '^- \*\*Evidence' stays at 1 (the annotated line only)
// both before and after the run.
{
  writeDefectFixture(REPO, 'T-960');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const before = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  const countBefore = countTopLevelEvidenceBullets(before);
  assert.strictEqual(countBefore, 1, `Case 6 setup FAIL: expected exactly 1 top-level Evidence-labeled bullet before the run, got ${countBefore}`);

  const { status, output } = runSetStatus(['T-960', 'merged', '--commit', REAL_COMMIT_SHORT, '--branch', 'main'], REPO, env);

  assert.notStrictEqual(status, 0, 'Case 6 FAIL: --set-status --commit on an annotated-Evidence-with-no-canonical-field block must exit non-zero');
  assert.ok(
    output.includes('Evidence (2026-09-20, QA)'),
    `Case 6 FAIL: error output must name the offending variant verbatim, got:\n${output}`
  );

  const after = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  assert.strictEqual(after, before, 'Case 6 FAIL: TASK_STATUS.md must be byte-for-byte unchanged — the refusal must write nothing');
  const countAfter = countTopLevelEvidenceBullets(after);
  assert.strictEqual(countAfter, 1, `Case 6 FAIL: expected the top-level Evidence-bullet count to STAY at 1 (no forked second field written), got ${countAfter}`);

  const backlogAfter = readUtf8(path.join(REPO, 'BACKLOG.md'));
  assert.ok(!/^- \*\*Status:\*\* merged$/m.test(backlogAfter), 'Case 6 FAIL: BACKLOG.md status must not have been advanced to merged either — the whole run must be refused');

  console.log(`Case 6 passed: writer refused, exited non-zero, wrote nothing (Evidence-bullet count stayed at ${countAfter})`);
}

// Case 7 (mutation-kill fixture): with the writer refusal guard REMOVED, the
// same fixture/command would instead let setBlockField() insert a brand-new
// canonical Evidence field next to the annotated one, forking the field —
// the top-level Evidence-bullet count would become 2. This is asserted as a
// live red/green pair below by toggling the guard in
// mavp-operator-set-status.js itself (the exact line implementing the
// contract this test guards), not merely described.
{
  const setStatusSrc = readUtf8(SET_STATUS_PATH);
  const guardMarker = "if (variant && !variant.canonicalExists) {";
  assert.ok(setStatusSrc.includes(guardMarker), 'Case 7 setup FAIL: expected to find the writer-refusal guard line in mavp-operator-set-status.js');

  // Named mutant: force the guard's condition to always be false, so the
  // refusal never fires and the write proceeds to fork a second field.
  const mutatedSrc = setStatusSrc.replace(guardMarker, 'if (false && variant && !variant.canonicalExists) {');
  assert.notStrictEqual(mutatedSrc, setStatusSrc, 'Case 7 setup FAIL: mutation should have changed the source');

  writeUtf8(SET_STATUS_PATH, mutatedSrc);
  try {
    writeDefectFixture(REPO, 'T-961');
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
    const before = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
    assert.strictEqual(countTopLevelEvidenceBullets(before), 1, 'Case 7 setup FAIL: expected exactly 1 top-level Evidence bullet before the mutated run');

    const { status } = runSetStatus(['T-961', 'merged', '--commit', REAL_COMMIT_SHORT, '--branch', 'main'], REPO, env);

    const after = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
    const countAfter = countTopLevelEvidenceBullets(after);
    assert.strictEqual(
      countAfter,
      2,
      `Case 7 (RED RUN, guard mutated out) FAIL: expected the mutant to fork a second top-level Evidence field (count 2), got ${countAfter} (status ${status}) — this proves the guard's condition is exactly what test Case 6 depends on`
    );
    console.log(`Case 7 (red run) passed: with the refusal guard mutated out, the writer forks a second Evidence field (count went to ${countAfter}) — confirms Case 6 is not a vacuous assertion`);
  } finally {
    // Restore the real guard unconditionally, even if an assertion above threw.
    writeUtf8(SET_STATUS_PATH, setStatusSrc);
  }

  // Green run: with the guard restored, re-run the identical scenario and
  // confirm the refusal is back in force.
  writeDefectFixture(REPO, 'T-962');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  const before2 = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  const { status: status2 } = runSetStatus(['T-962', 'merged', '--commit', REAL_COMMIT_SHORT, '--branch', 'main'], REPO, env);
  const after2 = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  assert.notStrictEqual(status2, 0, 'Case 7 (green run) FAIL: expected non-zero exit with the guard restored');
  assert.strictEqual(after2, before2, 'Case 7 (green run) FAIL: expected no write with the guard restored');
  assert.strictEqual(countTopLevelEvidenceBullets(after2), 1, 'Case 7 (green run) FAIL: expected the Evidence-bullet count to stay at 1 with the guard restored');
  console.log('Case 7 (green run) passed: with the guard restored, the refusal is back in force');
}

// Case 8: the SANCTIONED form (canonical field + indented dated sub-bullet)
// must NOT be refused — --set-status --commit succeeds normally, updating
// the canonical field's commit/branch token in place and preserving the
// dated sub-bullet's content.
{
  writeSanctionedFixture(REPO, 'T-963');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const { status, output } = runSetStatus(['T-963', 'merged', '--commit', REAL_COMMIT_SHORT, '--branch', 'main'], REPO, env);
  assert.notStrictEqual(status, 2, `Case 8 FAIL: expected the write to proceed (validator exit 0/1), got repair-required exit 2:\n${output}`);

  const after = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  assert.strictEqual(countTopLevelEvidenceBullets(after), 1, `Case 8 FAIL: sanctioned form must still carry exactly one top-level Evidence field after the write, got:\n${after}`);
  assert.ok(after.includes(`commit: ${REAL_COMMIT_SHORT} branch: main`), `Case 8 FAIL: expected the canonical field to carry the new commit/branch, got:\n${after}`);
  assert.ok(after.includes('qa notes: verified manually'), `Case 8 FAIL: prior canonical text should be preserved, got:\n${after}`);
  assert.ok(after.includes('**Evidence (2026-09-15, QA):** first pass, all cases pass'), `Case 8 FAIL: the sanctioned dated sub-bullet must be preserved untouched, got:\n${after}`);
  console.log('Case 8 passed: the sanctioned indented-sub-bullet form is never refused, and --commit updates the canonical field in place');
}

fs.rmSync(REPO, { recursive: true, force: true });

console.log('\nAll T-745 assertions passed.');
