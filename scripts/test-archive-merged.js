'use strict';
// Regression test: T-420 — --archive-merged mid-wave archival command.
//
// Covers:
//   1. archiveMergedTasksFromActiveWave() moves merged/deployed_dev blocks
//      out of BACKLOG.md's "## Active Wave" section into a
//      "## Wave <N> — Archived (mid-wave)" section, leaving in-flight
//      (in_progress) task blocks untouched in place.
//   2. A repeat run appends to the existing mid-wave archive section rather
//      than creating a duplicate heading.
//   3. Running the actual `mavp-operator-archive-merged.js` script end-to-end
//      moves the matching TASK_STATUS.md "## Active tasks" block into
//      "## Recently completed tasks", and the validator reports Healthy
//      afterward.
//   4. parseActiveWaveMergedTitles(backlog, waveNumber) and
//      parseMidWaveArchivedTasks(backlog, waveNumber) surface the
//      mid-wave-archived task's title/id — the mechanism --close-session
//      relies on to still report it.
//   5. End-to-end: running --archive-merged, then finishing the wave and
//      calling --close-session --non-interactive, still lists the
//      mid-wave-archived task (with its evidence) in the session-completed
//      results table, and the wave-close that follows (T-820: --close-wave is
//      the only path that writes the auto wave_summary) includes its title in
//      wave_summary — the literal T-420 acceptance criterion, verified
//      explicitly rather than assumed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  archiveMergedTasksFromActiveWave,
  parseActiveWaveMergedTitles,
  parseMidWaveArchivedTasks,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const ARCHIVE_MERGED_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-archive-merged.js');
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');
const CLOSE_WAVE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-wave.js');
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, 'mavp-validator.js');

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

// ---------------------------------------------------------------------------
// Part 1 — unit: archiveMergedTasksFromActiveWave() moves merged/deployed
// blocks out, leaves in-flight blocks untouched.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't420-unit-'));
  const backlogPath = path.join(TMP, 'BACKLOG.md');

  writeUtf8(backlogPath, `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-100 — Merged task one
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** artifact

### T-101 — In flight task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-102 — Deployed task
- **Status:** deployed_dev
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

## Deferred Tasks

### T-200 — deferred thing
- **Status:** deferred
`);

  const result = archiveMergedTasksFromActiveWave(backlogPath, 9);
  assert.strictEqual(result.ok, true, 'Test 1 FAIL: expected ok:true');
  assert.deepStrictEqual(result.archivedIds.sort(), ['T-100', 'T-102'], 'Test 1 FAIL: expected T-100 and T-102 archived');
  assert.deepStrictEqual(result.remainingIds, ['T-101'], 'Test 1 FAIL: expected T-101 to remain');

  const after = readUtf8(backlogPath);
  assert.ok(after.includes('## Wave 9 — Archived (mid-wave)'), 'Test 1 FAIL: expected mid-wave archive heading');

  // In-flight task stays under Active Wave, before the mid-wave archive heading.
  const activeIdx = after.indexOf('## Active Wave');
  const archIdx = after.indexOf('## Wave 9 — Archived (mid-wave)');
  const t101Idx = after.indexOf('### T-101');
  const t100Idx = after.indexOf('### T-100');
  const deferredIdx = after.indexOf('## Deferred Tasks');
  assert.ok(activeIdx < t101Idx && t101Idx < archIdx, 'Test 1 FAIL: T-101 should remain between Active Wave heading and the archive heading');
  assert.ok(archIdx < t100Idx && t100Idx < deferredIdx, 'Test 1 FAIL: T-100 should be inside the mid-wave archive section');
  assert.ok(!after.slice(activeIdx, archIdx).includes('### T-100'), 'Test 1 FAIL: T-100 must not remain under Active Wave');
  assert.ok(!after.slice(activeIdx, archIdx).includes('### T-102'), 'Test 1 FAIL: T-102 must not remain under Active Wave');
  assert.ok(after.includes('### T-200'), 'Test 1 FAIL: Deferred Tasks section must survive untouched');

  console.log('Test 1 passed: archiveMergedTasksFromActiveWave() moves merged/deployed blocks, leaves in-flight in place');

  // --- Part 2: repeat run appends, no duplicate heading ---
  let content = readUtf8(backlogPath);
  content = content.replace('- **Status:** in_progress', '- **Status:** merged');
  writeUtf8(backlogPath, content);

  const result2 = archiveMergedTasksFromActiveWave(backlogPath, 9);
  assert.strictEqual(result2.ok, true, 'Test 2 FAIL: expected ok:true on repeat run');
  assert.deepStrictEqual(result2.archivedIds, ['T-101'], 'Test 2 FAIL: expected only T-101 archived on repeat run');
  assert.deepStrictEqual(result2.remainingIds, [], 'Test 2 FAIL: expected no remaining tasks');

  const after2 = readUtf8(backlogPath);
  const headingMatches = after2.match(/^## Wave 9 — Archived \(mid-wave\)$/gm) || [];
  assert.strictEqual(headingMatches.length, 1, `Test 2 FAIL: expected exactly one mid-wave archive heading, got ${headingMatches.length}`);
  assert.ok(after2.includes('### T-100') && after2.includes('### T-101'), 'Test 2 FAIL: both T-100 and T-101 should be present in the (merged) archive section');

  console.log('Test 2 passed: repeat --archive-merged run appends to the existing mid-wave section (no duplicate heading)');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — unit: parseActiveWaveMergedTitles / parseMidWaveArchivedTasks
// surface mid-wave-archived titles/ids when given the wave number.
// ---------------------------------------------------------------------------
{
  const FIXTURE = `# BACKLOG

## Active Wave

### T-301 — Still open task
- **Status:** in_progress

## Wave 7 — Archived (mid-wave)

### T-300 — Archived earlier this wave
- **Status:** merged
`;

  const withoutWave = parseActiveWaveMergedTitles(FIXTURE);
  assert.deepStrictEqual(withoutWave, [], 'Test 3 FAIL: omitting waveNumber must not include mid-wave archived titles (legacy behavior)');

  const withWave = parseActiveWaveMergedTitles(FIXTURE, 7);
  assert.deepStrictEqual(withWave, ['Archived earlier this wave'], 'Test 3 FAIL: expected mid-wave archived title when waveNumber given');

  const parsed = parseMidWaveArchivedTasks(FIXTURE, 7);
  assert.deepStrictEqual(parsed, [{ id: 'T-300', title: 'Archived earlier this wave', status: 'merged' }], 'Test 3 FAIL: parseMidWaveArchivedTasks mismatch');

  assert.deepStrictEqual(parseMidWaveArchivedTasks(FIXTURE, 8), [], 'Test 3 FAIL: a different wave number must return no results');

  console.log('Test 3 passed: parseActiveWaveMergedTitles/parseMidWaveArchivedTasks surface mid-wave archived tasks by wave number');
}

// ---------------------------------------------------------------------------
// Part 4 — end-to-end: run the actual mavp-operator-archive-merged.js script
// against a fixture project, then run --close-session --non-interactive and
// verify wave_summary + the session-completed results table both include the
// mid-wave-archived task's title/evidence.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't420-e2e-'));
  const BACKLOG_PATH = path.join(TMP, 'BACKLOG.md');
  const TASK_STATUS_PATH = path.join(TMP, 'TASK_STATUS.md');
  const PROCESS_STATE_JSON_PATH = path.join(TMP, 'PROCESS_STATE.json');

  writeUtf8(BACKLOG_PATH, `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-100 — Merged task one
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>

### T-101 — In flight task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>
`);

  writeUtf8(TASK_STATUS_PATH, `# TASK_STATUS

## Active tasks

### T-100 — Merged task one
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —

### T-101 — In flight task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`);

  writeUtf8(PROCESS_STATE_JSON_PATH, JSON.stringify({
    initiative: 'T-420 test fixture',
    stage: 'execution',
    wave: 9,
    wave_status: 'execution',
    wave_goal: 'T-420 fixture goal',
    parked_waves: [],
    active_slices: ['T-101'],
    next_action: 'T-101 → developer → do the thing',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 101,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP, MAVERICKS_SCRIPTS: SCRIPTS_DIR };

  // --- run --archive-merged ---
  const archiveOutput = execFileSync('node', [ARCHIVE_MERGED_PATH], { cwd: TMP, env, encoding: 'utf8' });
  assert.ok(archiveOutput.includes('archived 1 task(s): T-100'), `Test 4 FAIL: expected archive output to report T-100 archived, got:\n${archiveOutput}`);
  assert.ok(archiveOutput.includes('Validator: healthy'), `Test 4 FAIL: expected validator healthy after archive-merged, got:\n${archiveOutput}`);
  console.log('Test 4a passed: --archive-merged moved T-100 out of Active Wave / Active tasks and validator reports Healthy');

  const backlogAfterArchive = readUtf8(BACKLOG_PATH);
  const taskStatusAfterArchive = readUtf8(TASK_STATUS_PATH);
  const activeWaveSection = backlogAfterArchive.slice(
    backlogAfterArchive.indexOf('## Active Wave'),
    backlogAfterArchive.indexOf('## Wave 9 — Archived (mid-wave)')
  );
  assert.ok(!activeWaveSection.includes('### T-100'), 'Test 4 FAIL: T-100 must not remain under BACKLOG Active Wave');
  assert.ok(activeWaveSection.includes('### T-101'), 'Test 4 FAIL: T-101 (in-flight) must remain under BACKLOG Active Wave');
  assert.ok(
    taskStatusAfterArchive.indexOf('### T-100') > taskStatusAfterArchive.indexOf('## Recently completed tasks'),
    'Test 4 FAIL: T-100 must have moved to TASK_STATUS.md Recently completed tasks'
  );
  assert.ok(
    taskStatusAfterArchive.indexOf('### T-101') < taskStatusAfterArchive.indexOf('## Recently completed tasks'),
    'Test 4 FAIL: T-101 (in-flight) must remain in TASK_STATUS.md Active tasks'
  );

  // Sanity: validator run directly against the fixture also reports healthy.
  const validatorOutput = execFileSync('node', [VALIDATOR_PATH, TMP], { encoding: 'utf8' });
  assert.ok(/Healthy/.test(validatorOutput), `Test 4 FAIL: direct validator run should report Healthy, got:\n${validatorOutput}`);
  console.log('Test 4b passed: validator run directly against the fixture reports Healthy after --archive-merged');

  // --- finish the wave: mark T-101 merged too, then close the session ---
  let backlogForClose = readUtf8(BACKLOG_PATH);
  backlogForClose = backlogForClose.replace('- **Status:** in_progress', '- **Status:** merged');
  writeUtf8(BACKLOG_PATH, backlogForClose);

  let taskStatusForClose = readUtf8(TASK_STATUS_PATH);
  taskStatusForClose = taskStatusForClose.replace('- **Status:** in_progress', '- **Status:** merged');
  writeUtf8(TASK_STATUS_PATH, taskStatusForClose);

  // T-820: --close-wave commits, so the fixture needs a real (pinned-branch) git repo.
  const gitEnv = { ...process.env };
  for (const k of Object.keys(gitEnv)) if (k.startsWith('GIT_')) delete gitEnv[k];
  const gitIn = (...a) => spawnSync('git', a, { cwd: TMP, env: gitEnv, encoding: 'utf8' });
  gitIn('init', '-q', '-b', 'main');
  gitIn('config', 'user.email', 'fixture@example.com');
  gitIn('config', 'user.name', 'Fixture');
  gitIn('add', '-A');
  gitIn('commit', '-q', '-m', 'fixture init');

  const closeOutput = execFileSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], { cwd: TMP, env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH)).wave, 9, 'Test 5 FAIL: --close-session must not advance the wave (T-820)');
  execFileSync('node', [CLOSE_WAVE_PATH, '--operator-confirmed', 'fixture statement'], { cwd: TMP, env, encoding: 'utf8' });

  // --- assertion (a): wave_summary includes the mid-wave-archived title ---
  const processStateAfterClose = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
  assert.ok(
    typeof processStateAfterClose.wave_summary === 'string' && processStateAfterClose.wave_summary.includes('Merged task one'),
    `Test 5 FAIL: wave_summary should mention the mid-wave-archived title "Merged task one", got: ${processStateAfterClose.wave_summary}`
  );
  assert.ok(
    processStateAfterClose.wave_summary.includes('In flight task'),
    `Test 5 FAIL: wave_summary should also mention the task merged at close time, got: ${processStateAfterClose.wave_summary}`
  );
  console.log(`Test 5a passed: wave_summary includes the mid-wave-archived title — "${processStateAfterClose.wave_summary}"`);

  // --- assertion (b): the session-completed results table lists T-100 with its evidence ---
  assert.ok(
    /T-100\s+mavericks\s+aaaaaaa\s+main/.test(closeOutput),
    `Test 5 FAIL: expected the results table to list T-100 with its commit/branch evidence, got:\n${closeOutput}`
  );
  console.log('Test 5b passed: --close-session results table lists the mid-wave-archived task (T-100) with its evidence');

  // --- final sanity: validator still Healthy after the wave close ---
  assert.ok(/Validator passed/.test(closeOutput), `Test 5 FAIL: expected validator to pass after close-session, got:\n${closeOutput}`);
  console.log('Test 5c passed: validator still Healthy after --close-session finalizes the wave');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 5 — T-748: --archive-merged prunes PROCESS_STATE.json's active_slices
// through pruneStaleActiveSlices() (mavp-operator-lib.js), which derives its
// stale set as the COMPLEMENT of the validator's own ACTIVE_SLICES_STATUSES
// — not a hand-maintained {qa_passed, merged} list. A deferred id (T-003)
// must be pruned too, alongside the merged id (T-001); the in_progress id
// (T-002) must survive. After the run, the validator must report no
// active_slices_mismatch finding for any of the ids that were just pruned.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't748-prune-'));
  const BACKLOG_PATH = path.join(TMP, 'BACKLOG.md');
  const TASK_STATUS_PATH = path.join(TMP, 'TASK_STATUS.md');
  const PROCESS_STATE_JSON_PATH = path.join(TMP, 'PROCESS_STATE.json');

  writeUtf8(BACKLOG_PATH, `# BACKLOG

## Active Wave

### T-001 — Merged task
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>

### T-002 — In flight task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>

## Deferred Tasks

### T-003 — Deferred task
- **Status:** deferred
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);

  writeUtf8(TASK_STATUS_PATH, `# TASK_STATUS

## Active tasks

### T-001 — Merged task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —

### T-002 — In flight task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

## Recently completed tasks

## Deferred tasks

### T-003 — Deferred task
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —
`);

  writeUtf8(PROCESS_STATE_JSON_PATH, JSON.stringify({
    initiative: 'T-748 test fixture',
    stage: 'execution',
    wave: 9,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: ['T-001', 'T-002', 'T-003'],
    next_action: 'T-002 → developer → do the thing',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 3,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP, MAVERICKS_SCRIPTS: SCRIPTS_DIR };

  const archiveOutput = execFileSync('node', [ARCHIVE_MERGED_PATH], { cwd: TMP, env, encoding: 'utf8' });

  const processStateAfter = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
  assert.deepStrictEqual(
    processStateAfter.active_slices,
    ['T-002'],
    `Test 6 FAIL: expected active_slices pruned to ["T-002"] (merged T-001 and deferred T-003 both dropped), got: ${JSON.stringify(processStateAfter.active_slices)}`
  );
  assert.ok(
    !/active_slices_mismatch/.test(archiveOutput),
    `Test 6 FAIL: expected no active_slices_mismatch finding after pruning, got:\n${archiveOutput}`
  );

  console.log('Test 6 passed: --archive-merged prunes active_slices to ["T-002"] via pruneStaleActiveSlices() (merged AND deferred ids dropped); no active_slices_mismatch finding');

  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\nAll T-420/T-748 assertions passed.');
