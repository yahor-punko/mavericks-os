'use strict';
// Regression test: T-308 — merged-evidence validator findings name the task's
// verification type and the exact accepted evidence field(s) for it.
//
// Fixture-based: builds a synthetic BACKLOG.md + TASK_STATUS.md pair describing
// a `merged` task with `Verification type: artifact` and no evidence, then runs
// the validator's parseArtifacts() against the fixture and asserts the
// merged_missing_commit_field finding names `artifact:` as an accepted field.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const { parseArtifacts, getAcceptedEvidenceGuidance } = require('./mavp-validator.js');

const TMP_DIR = path.join(os.tmpdir(), 't308-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Unit test: getAcceptedEvidenceGuidance() returns the correct accepted
// field(s) text per verification type.
// ---------------------------------------------------------------------------
const artifactGuidance = getAcceptedEvidenceGuidance('artifact');
assert.ok(
  /artifact:/.test(artifactGuidance.fieldsText) && /commit:/.test(artifactGuidance.fieldsText),
  `Unit test FAIL: artifact-type guidance should mention both artifact: and commit:, got "${artifactGuidance.fieldsText}"`
);

const runtimeGuidance = getAcceptedEvidenceGuidance('runtime');
assert.ok(
  /commit:/.test(runtimeGuidance.fieldsText) && /infra:/.test(runtimeGuidance.fieldsText),
  `Unit test FAIL: runtime-type guidance should mention commit: with infra: as the infra-only alternative, got "${runtimeGuidance.fieldsText}"`
);

const unitGuidance = getAcceptedEvidenceGuidance('unit');
assert.ok(
  /commit:/.test(unitGuidance.fieldsText) && /infra:/.test(unitGuidance.fieldsText),
  `Unit test FAIL: unit-type guidance should mention commit: with infra: as the infra-only alternative, got "${unitGuidance.fieldsText}"`
);

// ---------------------------------------------------------------------------
// Fixture: BACKLOG.md with an empty Active Wave section (the merged task lives
// only in TASK_STATUS.md's Active tasks section, which is where the
// merged-evidence check reads from).
// ---------------------------------------------------------------------------
const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave
`;

const TASK_STATUS_FIXTURE = `# TASK_STATUS

## Active tasks

### T-900 — Fixture artifact-verification task with no evidence
- **Status:** merged
- **Owner:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`;

const backlogPath = path.join(TMP_DIR, 'BACKLOG.md');
const taskStatusPath = path.join(TMP_DIR, 'TASK_STATUS.md');
fs.writeFileSync(backlogPath, BACKLOG_FIXTURE, 'utf8');
fs.writeFileSync(taskStatusPath, TASK_STATUS_FIXTURE, 'utf8');

const parsed = parseArtifacts({ backlogPath, taskStatusPath });
const findings = parsed.comparison.findings;

const finding = findings.find(
  (f) => f.checkName === 'merged_missing_commit_field' && f.taskId === 'T-900'
);

assert.ok(
  finding,
  `FAIL: expected a merged_missing_commit_field finding for T-900, got findings: ${JSON.stringify(findings, null, 2)}`
);

assert.ok(
  /artifact:/.test(finding.message),
  `FAIL: message should name artifact: as an accepted field for an artifact-verification task, got: "${finding.message}"`
);

assert.ok(
  /verification_type:\s*artifact/i.test(finding.message),
  `FAIL: message should name the task's verification type (artifact), got: "${finding.message}"`
);

assert.strictEqual(
  finding.severity,
  'failure',
  `FAIL: merged_missing_commit_field severity should remain "failure" (unchanged behavior), got: "${finding.severity}"`
);

assert.ok(
  /artifact:/.test(finding.suggestedAction),
  `FAIL: suggestedAction should mention artifact: for an artifact-verification task, got: "${finding.suggestedAction}"`
);

assert.strictEqual(
  parsed.comparison.overallCandidateState,
  'misleading_repair_required',
  `FAIL: overallCandidateState should remain misleading_repair_required (unchanged exit-code behavior), got: "${parsed.comparison.overallCandidateState}"`
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-308 assertions passed.');
