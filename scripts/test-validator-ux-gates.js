'use strict';
// T-860 — validator ux_gate check: `visual_without_ux` and `ux_evidence_missing`.
//
// Builds fixture BACKLOG.md + TASK_STATUS.md pairs and runs the validator CLI
// as a subprocess (`node scripts/mavp-validator.js <fixtureDir>`), asserting
// on the finding names in its output and on its exit code. Cases cover both
// spellings of the Requires ux field, the evidence-token boundary (`linux:`
// prose must not satisfy it), and the Active-Wave-only / skip-status scope.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');

function backlogBlock({ id, status, verification, requiresLine, extra = '' }) {
  return `### ${id} — Fixture task ${id}
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** ${verification}
- **Repo:** fixture-repo
${requiresLine ? `${requiresLine}\n` : ''}${extra}`;
}

function taskStatusBlock({ id, status, evidence }) {
  return `### ${id} — Fixture task ${id}
- **Status:** ${status}
- **Owner:** developer
- **Verification type:** visual
- **Repo:** fixture-repo
- **Last verified by:** —
- **Evidence:** ${evidence}
- **Notes:** —
`;
}

// activeBlocks: backlog blocks under Active Wave; archivedBlocks: under an archived wave heading.
function runFixture({ activeBlocks = [], archivedBlocks = [], taskStatusBlocks = [] }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't860-ux-gate-'));
  const backlog = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

${activeBlocks.join('\n')}
${archivedBlocks.length ? `\n## Wave 1\n\n${archivedBlocks.join('\n')}\n` : ''}`;
  const taskStatus = `# TASK_STATUS

## Active tasks

${taskStatusBlocks.join('\n')}
## Recently completed tasks
`;
  fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'TASK_STATUS.md'), taskStatus, 'utf8');
  const result = spawnSync('node', [VALIDATOR_PATH, tmpDir], { encoding: 'utf8' });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  return { out, code: result.status };
}

function count(out, name) {
  return (out.match(new RegExp(name, 'g')) || []).length;
}

// 1. Visual Active-Wave task without Requires ux: exactly one visual_without_ux, exit 1.
{
  const { out, code } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-900', status: 'in_progress', verification: 'visual' })],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-900', status: 'in_progress', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 1, `case 1: expected exactly one visual_without_ux:\n${out}`);
  assert.strictEqual(code, 1, `case 1: expected exit 1, got ${code}:\n${out}`);
}

// 2. Same task with the template spelling `Requires UX review: true`: no finding.
{
  const { out } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-900', status: 'in_progress', verification: 'visual', requiresLine: '- **Requires UX review:** true' })],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-900', status: 'in_progress', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 0, `case 2: unexpected visual_without_ux:\n${out}`);
}

// 2b. Same with the written spelling `Requires ux: true`, and a mixed-case `Visual`.
{
  const { out } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-900', status: 'in_progress', verification: 'Visual', requiresLine: '- **Requires ux:** true' })],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-900', status: 'in_progress', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 0, `case 2b: unexpected visual_without_ux:\n${out}`);
}

// 2c. Mixed-case verification type `Visual` without the field still fires.
{
  const { out } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-900', status: 'in_progress', verification: 'Visual' })],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-900', status: 'in_progress', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 1, `case 2c: expected one visual_without_ux:\n${out}`);
}

// 3. requires ux task at qa_passed, Evidence without a ux: line: ux_evidence_missing.
const uxTask = (status) => backlogBlock({ id: 'T-901', status, verification: 'visual', requiresLine: '- **Requires ux:** true' });
{
  const { out } = runFixture({
    activeBlocks: [uxTask('qa_passed')],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-901', status: 'qa_passed', evidence: 'commit: abc1234' })],
  });
  assert.strictEqual(count(out, 'ux_evidence_missing'), 1, `case 3: expected one ux_evidence_missing:\n${out}`);
  assert.ok(/ux: <pass\|needs_fix> frames: <id> viewed: <n img>\/<m txt>\/<k unopened>/.test(out),
    `case 3: suggestedAction should name the ux: line form:\n${out}`);
}

// 4. Same with a real ux: line: no finding.
{
  const { out } = runFixture({
    activeBlocks: [uxTask('qa_passed')],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-901', status: 'qa_passed', evidence: 'ux: pass frames: f-2026-11-03 viewed: 12 img/4 txt/0 unopened' })],
  });
  assert.strictEqual(count(out, 'ux_evidence_missing'), 0, `case 4: unexpected ux_evidence_missing:\n${out}`);
}

// 5. Evidence with only `linux: ok` (and `flux:`) still yields ux_evidence_missing.
{
  const { out } = runFixture({
    activeBlocks: [uxTask('qa_passed')],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-901', status: 'qa_passed', evidence: 'linux: ok flux: fine' })],
  });
  assert.strictEqual(count(out, 'ux_evidence_missing'), 1, `case 5: expected one ux_evidence_missing:\n${out}`);
}

// 5b. Statuses before ux_passed (e.g. ux_review) do not fire ux_evidence_missing.
{
  const { out } = runFixture({
    activeBlocks: [uxTask('ux_review')],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-901', status: 'ux_review', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'ux_evidence_missing'), 0, `case 5b: unexpected ux_evidence_missing at ux_review:\n${out}`);
}

// 5c. A terminal (merged) requires-ux task in the Active Wave without ux: evidence fires.
{
  const { out } = runFixture({
    activeBlocks: [uxTask('merged')],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-901', status: 'merged', evidence: 'commit: abc1234' })],
  });
  assert.strictEqual(count(out, 'ux_evidence_missing'), 1, `case 5c: expected one ux_evidence_missing for merged:\n${out}`);
}

// 6. A visual task under an archived `## Wave N` heading yields no finding.
{
  const { out } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-902', status: 'in_progress', verification: 'runtime' })],
    archivedBlocks: [backlogBlock({ id: 'T-800', status: 'merged', verification: 'visual' })],
    taskStatusBlocks: [taskStatusBlock({ id: 'T-902', status: 'in_progress', evidence: '—' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 0, `case 6: archived visual task fired visual_without_ux:\n${out}`);
  assert.strictEqual(count(out, 'ux_evidence_missing'), 0, `case 6: unexpected ux_evidence_missing:\n${out}`);
}

// 7. A deprecated visual task yields no finding.
{
  const { out } = runFixture({
    activeBlocks: [backlogBlock({ id: 'T-903', status: 'deprecated', verification: 'visual' })],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 0, `case 7: deprecated visual task fired:\n${out}`);
}

// 7b. A deferred visual task and a superseded visual task yield no finding.
{
  const { out } = runFixture({
    activeBlocks: [
      backlogBlock({ id: 'T-904', status: 'deferred', verification: 'visual' }),
      backlogBlock({ id: 'T-905', status: 'in_progress', verification: 'visual', extra: '- **Superseded by:** T-906\n' }),
    ],
  });
  assert.strictEqual(count(out, 'visual_without_ux'), 0, `case 7b: deferred/superseded fired:\n${out}`);
}

console.log('All T-860 ux_gate assertions passed.');
