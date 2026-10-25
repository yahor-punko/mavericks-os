'use strict';
// T-718: --close-session, when sweeping completed tasks (merged/deployed_dev/
// deployed_prod/runtime_verified), must check each such task's evidence
// commit — when it resolves locally and its changed files intersect
// scripts/publish-manifest.json's `ship` classification — against
// CHANGELOG.md's full text, and print a prominently placed non-blocking
// advisory line, before the results table, naming every task id with ZERO
// occurrences. Silent when the id is already mentioned, when the manifest or
// CHANGELOG.md is absent/unparseable, when git is unavailable, or when the
// evidence hash does not resolve. Advisory tier only — exit code and the
// session-commit contract are unchanged in every case (DR-009).
//
// Wave 93's exact shape is the acceptance test: T-710 present in
// CHANGELOG.md, T-711/T-712/T-713 absent while their commits touched `ship`
// paths.
//
// Coverage:
//   Part 1 (unit) — findShipTouchingChangelogOmissions(): fires when the
//     commit touches a ship-classified path and the id is absent from
//     CHANGELOG.md; silent when the id is present; silent when the manifest
//     has no `ship` entries matching the changed files; degrades silently on
//     an unresolved hash and on a null/empty completedTaskRecords list.
//     T-721 Case A: a commit touching ONLY CHANGELOG.md (itself
//     ship-classified in this fixture) is exempted — NOT returned, the
//     proven wave-94 T-716/T-719 false-positive class. T-721 Case B: a
//     commit touching BOTH CHANGELOG.md and another ship path IS still
//     returned — the exemption must not swallow a mixed commit.
//     T-724 Case C: the release bump-and-fold ritual (scripts/mavp-version.js
//     + package.json + CHANGELOG.md, exactly) is exempted. T-724 Case D: the
//     ritual set plus another ship path still fires (smuggle guard). T-724
//     Case E: version files with no CHANGELOG.md fold still fires (noteless-
//     bump guard). T-724 Case F: package.json alone still fires (the
//     path-exemption killer the architect's refusal turns on).
//   Part 2 (end-to-end, real git fixture) — FIRING: a completed task's
//     evidence commit touches a ship-classified path, its id is absent from
//     CHANGELOG.md → the advisory line prints, names that id, appears BEFORE
//     the results table, and the run still exits 0.
//   Part 3 (end-to-end) — SILENT: same fixture, id present in CHANGELOG.md →
//     no line prints.
//   Part 4 (end-to-end) — degrade silently when scripts/publish-manifest.json
//     is absent.
//
//   Part 5 (T-845, end-to-end) — RECAP: the `Advisories this close (N):` block
//     prints immediately before `Session closed.`, after the results table,
//     names T-711, and survives a `tail -6`; `RENAME_SESSION:` stays last.
//   Part 6 (T-845) — both the T-629 and T-718 advisories fire → `(2)`.
//   Part 7 (T-845) — neither fires → `Advisories this close: none` exactly once.
//   Part 8 (T-845) — the same recap on the interactive path.
//   Part 9 (T-845 round 2) — an advisory other than T-629/T-718 (the
//     shipped-but-unbooked one, T-637) reaches the recap, with count (1); Part 7
//     additionally asserts no advisory-shaped line printed in the `none` fixture.
//   Part 10 (T-845 round 3) — the BACKLOG.md archive warning (a merged task and
//     two Active Wave headings) reaches the recap on both paths with the right
//     count, and the recap never reads `none` right after that warning.
//   Part 11 (T-845 round 4) — the shipped-but-unbooked shallow-clone stand-down
//     (a qa_passed task in a `--depth 1` clone) reaches the recap, count (1),
//     tagged (T-637), and the recap never reads `none` after it.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { execSync, spawnSync, spawn } = require('node:child_process');

const { findShipTouchingChangelogOmissions } = require('./mavp-operator-close-session.js');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't718-changelog-ship-'));

function runCloseSession(dir) {
  const r = spawnSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

// ---------------------------------------------------------------------------
// Part 1 — unit: findShipTouchingChangelogOmissions()
// ---------------------------------------------------------------------------
{
  const git = (dir, cmd) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = path.join(TMP_ROOT, 'unit-fixture');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init -q -b main .');
  git(dir, 'config user.email dev@example.com');
  git(dir, 'config user.name Dev');
  fs.mkdirSync(path.join(dir, 'docs', 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scripts', 'publish-manifest.json'),
    JSON.stringify({ ship: ['docs/core/ORCHESTRATION_RULES.md', 'CHANGELOG.md', 'scripts/mavp-version.js', 'package.json'], reset: [], reset_reasons: {}, exclude: [], preserve: [] }, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git(dir, 'add seed.txt scripts/publish-manifest.json');
  git(dir, 'commit -q -m seed');

  // A commit touching a ship-classified path.
  fs.writeFileSync(path.join(dir, 'docs', 'core', 'ORCHESTRATION_RULES.md'), 'rule text\n', 'utf8');
  git(dir, 'add docs/core/ORCHESTRATION_RULES.md');
  git(dir, 'commit -q -m ship-touching');
  const shipHash = git(dir, 'rev-parse --short HEAD').trim();

  // A commit touching a NON-ship path.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'internal notes\n', 'utf8');
  git(dir, 'add notes.txt');
  git(dir, 'commit -q -m non-ship-touching');
  const nonShipHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-721 Case A fixture: a commit touching ONLY CHANGELOG.md — the
  // self-referential shape (a release note about itself) that must be
  // exempted even though CHANGELOG.md is itself ship-classified above.
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n\n## [Unreleased]\n\n- noted.\n', 'utf8');
  git(dir, 'add CHANGELOG.md');
  git(dir, 'commit -q -m changelog-only');
  const changelogOnlyHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-721 Case B fixture: a commit touching BOTH CHANGELOG.md AND another
  // ship-classified path — the exemption must NOT swallow this mixed commit.
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n\n## [Unreleased]\n\n- noted again.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'docs', 'core', 'ORCHESTRATION_RULES.md'), 'rule text v2\n', 'utf8');
  git(dir, 'add CHANGELOG.md docs/core/ORCHESTRATION_RULES.md');
  git(dir, 'commit -q -m changelog-and-ship-mixed');
  const changelogAndShipHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-724 Case C fixture: a commit touching EXACTLY CHANGELOG.md +
  // scripts/mavp-version.js + package.json — the release bump-and-fold
  // ritual shape (docs/PUBLIC_RELEASE_STRATEGY.md §5) — must be exempted.
  fs.writeFileSync(path.join(dir, 'scripts', 'mavp-version.js'), 'module.exports = "0.0.2";\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.0.2"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n\n## [Unreleased]\n\n- noted a third time.\n', 'utf8');
  git(dir, 'add scripts/mavp-version.js package.json CHANGELOG.md');
  git(dir, 'commit -q -m version-ritual');
  const versionRitualHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-724 Case D fixture: the ritual set PLUS another ship path — a ritual
  // commit smuggling in a real shipped change must still fire (T-724's
  // reproduction: the real 0.47.1 bump commit 344928b also carried CLAUDE.md).
  fs.writeFileSync(path.join(dir, 'scripts', 'mavp-version.js'), 'module.exports = "0.0.3";\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.0.3"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n\n## [Unreleased]\n\n- noted a fourth time.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'docs', 'core', 'ORCHESTRATION_RULES.md'), 'rule text v3\n', 'utf8');
  git(dir, 'add scripts/mavp-version.js package.json CHANGELOG.md docs/core/ORCHESTRATION_RULES.md');
  git(dir, 'commit -q -m version-ritual-smuggle');
  const versionRitualSmuggleHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-724 Case E fixture: version files WITHOUT the CHANGELOG.md fold — a
  // noteless bump violates §5 in its own right and must still fire.
  fs.writeFileSync(path.join(dir, 'scripts', 'mavp-version.js'), 'module.exports = "0.0.4";\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.0.4"}\n', 'utf8');
  git(dir, 'add scripts/mavp-version.js package.json');
  git(dir, 'commit -q -m version-ritual-noteless');
  const versionRitualNotelessHash = git(dir, 'rev-parse --short HEAD').trim();

  // T-724 Case F fixture: package.json ALONE — the case that proves a path
  // exemption of package.json (refused by the architect) would be wrong: a
  // standalone dependency-change commit is a genuine shipped change.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.0.4","dependencies":{"x":"1.0.0"}}\n', 'utf8');
  git(dir, 'add package.json');
  git(dir, 'commit -q -m package-json-alone');
  const packageJsonAloneHash = git(dir, 'rev-parse --short HEAD').trim();

  const taskStatusContent = `# TASK_STATUS

## Recently completed tasks

### T-711 — Ship-touching, absent from CHANGELOG
- **Status:** merged
- **Evidence:** commit: ${shipHash} branch: main

### T-710 — Ship-touching, present in CHANGELOG
- **Status:** merged
- **Evidence:** commit: ${shipHash} branch: main

### T-720 — Non-ship-touching commit
- **Status:** merged
- **Evidence:** commit: ${nonShipHash} branch: main

### T-721 — Unresolved hash
- **Status:** merged
- **Evidence:** commit: deadbeefdeadbeef branch: main

### T-730 — CHANGELOG.md-only commit (self-referential exemption)
- **Status:** merged
- **Evidence:** commit: ${changelogOnlyHash} branch: main

### T-731 — Mixed CHANGELOG.md + ship-classified commit
- **Status:** merged
- **Evidence:** commit: ${changelogAndShipHash} branch: main

### T-732 — Version ritual (exempt)
- **Status:** merged
- **Evidence:** commit: ${versionRitualHash} branch: main

### T-733 — Version ritual smuggling another ship file
- **Status:** merged
- **Evidence:** commit: ${versionRitualSmuggleHash} branch: main

### T-734 — Version ritual with no CHANGELOG.md fold
- **Status:** merged
- **Evidence:** commit: ${versionRitualNotelessHash} branch: main

### T-735 — package.json alone
- **Status:** merged
- **Evidence:** commit: ${packageJsonAloneHash} branch: main
`;

  // Fires: T-711's commit touches a ship path, T-711 absent from CHANGELOG.
  const fired = findShipTouchingChangelogOmissions(
    [{ id: 'T-711', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(fired, ['T-711'], `Part 1 FAIL (fired): got ${JSON.stringify(fired)}`);

  // Silent: T-710's commit touches the same ship path, but T-710 IS mentioned.
  const silentPresent = findShipTouchingChangelogOmissions(
    [{ id: 'T-710', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\n- T-710: did a thing.\n',
    dir
  );
  assert.deepStrictEqual(silentPresent, [], `Part 1 FAIL (silent — present in CHANGELOG): got ${JSON.stringify(silentPresent)}`);

  // Silent: T-720's commit does NOT touch a ship-classified path.
  const silentNonShip = findShipTouchingChangelogOmissions(
    [{ id: 'T-720', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(silentNonShip, [], `Part 1 FAIL (silent — non-ship commit): got ${JSON.stringify(silentNonShip)}`);

  // Silent: T-721's evidence hash does not resolve locally.
  const silentUnresolved = findShipTouchingChangelogOmissions(
    [{ id: 'T-721', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(silentUnresolved, [], `Part 1 FAIL (silent — unresolved hash): got ${JSON.stringify(silentUnresolved)}`);

  // Degrades silently: empty/null completedTaskRecords, never throws.
  assert.deepStrictEqual(findShipTouchingChangelogOmissions([], taskStatusContent, '', dir), []);
  assert.deepStrictEqual(findShipTouchingChangelogOmissions(null, taskStatusContent, '', dir), []);

  // T-721 Case A: T-730's evidence commit touches ONLY CHANGELOG.md — the
  // proven wave-94 false-positive class (T-716/T-719) — must NOT be returned
  // even though CHANGELOG.md is itself ship-classified in this fixture.
  const caseA = findShipTouchingChangelogOmissions(
    [{ id: 'T-730', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseA, [], `Part 1 Case A FAIL (CHANGELOG.md-only commit must be exempt): got ${JSON.stringify(caseA)}`);

  // T-721 Case B: T-731's evidence commit touches BOTH CHANGELOG.md AND
  // docs/core/ORCHESTRATION_RULES.md — the exemption must not swallow this
  // mixed commit; it must still fire.
  const caseB = findShipTouchingChangelogOmissions(
    [{ id: 'T-731', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseB, ['T-731'], `Part 1 Case B FAIL (mixed CHANGELOG.md + ship commit must still fire): got ${JSON.stringify(caseB)}`);

  // T-724 Case C: the release bump-and-fold ritual (scripts/mavp-version.js +
  // package.json + CHANGELOG.md, exactly) — must NOT be returned.
  const caseC = findShipTouchingChangelogOmissions(
    [{ id: 'T-732', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseC, [], `Part 1 Case C FAIL (version-ritual commit must be exempt): got ${JSON.stringify(caseC)}`);

  // T-724 Case D: the ritual set PLUS another ship path — must still fire.
  const caseD = findShipTouchingChangelogOmissions(
    [{ id: 'T-733', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseD, ['T-733'], `Part 1 Case D FAIL (ritual + smuggled ship file must still fire): got ${JSON.stringify(caseD)}`);

  // T-724 Case E: version files WITHOUT the CHANGELOG.md fold — must still fire.
  const caseE = findShipTouchingChangelogOmissions(
    [{ id: 'T-734', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseE, ['T-734'], `Part 1 Case E FAIL (noteless version bump must still fire): got ${JSON.stringify(caseE)}`);

  // T-724 Case F: package.json ALONE — the path-exemption killer — must fire.
  const caseF = findShipTouchingChangelogOmissions(
    [{ id: 'T-735', status: 'merged' }],
    taskStatusContent,
    '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n',
    dir
  );
  assert.deepStrictEqual(caseF, ['T-735'], `Part 1 Case F FAIL (package.json alone must still fire): got ${JSON.stringify(caseF)}`);

  console.log('Part 1 (unit: findShipTouchingChangelogOmissions fired/silent-present/silent-non-ship/silent-unresolved/empty/T-721-case-A/T-721-case-B/T-724-case-C/D/E/F) passed.');
}

// ---------------------------------------------------------------------------
// Build a real git fixture reproducing Wave 93's shape for end-to-end Parts.
// ---------------------------------------------------------------------------
function buildGitFixture(dir, { changelogMentionsT711 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init -q -b main .');
  git('config user.email dev@example.com');
  git('config user.name Dev');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git('add seed.txt');
  git('commit -q -m seed');

  // scripts/publish-manifest.json — classifies docs/core/DECISIONS.md as ship.
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scripts', 'publish-manifest.json'),
    JSON.stringify({ ship: ['docs/core/DECISIONS.md'], reset: [], reset_reasons: {}, exclude: [], preserve: [] }, null, 2) + '\n',
    'utf8'
  );
  git('add scripts/publish-manifest.json');
  git('commit -q -m manifest');

  // T-711's commit — touches the ship-classified doc.
  fs.mkdirSync(path.join(dir, 'docs', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'core', 'DECISIONS.md'), 'DR-013: recorded.\n', 'utf8');
  git('add docs/core/DECISIONS.md');
  git('commit -q -m T-711');
  const t711Hash = git('rev-parse --short HEAD').trim();

  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Active Wave

## Wave 92 — Archived

### T-711 — Ship-touching completed task
- **Status:** merged
- **Owner role:** product-docs
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-711 — Ship-touching completed task
- **Status:** merged
- **Owner role:** product-docs
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: ${t711Hash} branch: main
- **Notes:** —

## Recently completed tasks
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-718 test fixture',
    stage: 'execution',
    wave: 93,
    wave_session: 1,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 718,
    last_updated: '2026-08-23',
    deploy_contours: 0,
    wave_summary: 'Wave 92: prior.',
    rechecks: [],
  }, null, 2) + '\n', 'utf8');

  const changelogBody = changelogMentionsT711
    ? '# CHANGELOG\n\n## [Unreleased]\n\n- T-711: recorded the tie-break.\n'
    : '# CHANGELOG\n\n## [Unreleased]\n\nNo entries yet.\n';
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelogBody, 'utf8');

  return t711Hash;
}

// ---------------------------------------------------------------------------
// Part 2 — end-to-end FIRING: T-711 absent from CHANGELOG.md.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-firing');
  buildGitFixture(dir, { changelogMentionsT711: false });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 2 FAIL: close-session must not abort on this condition, got exit ${status}:\n${out}`);

  assert.ok(
    out.includes('CHANGELOG.md has no entry for: T-711'),
    `Part 2 FAIL: expected the advisory naming T-711, got:\n${out}`
  );

  const warnIdx = out.indexOf('CHANGELOG.md has no entry for:');
  const tableIdx = out.indexOf('Сессия завершена');
  assert.ok(warnIdx !== -1 && tableIdx !== -1 && warnIdx < tableIdx,
    `Part 2 FAIL: advisory must print BEFORE the results table. warnIdx=${warnIdx} tableIdx=${tableIdx}\n${out}`);

  console.log('Part 2 (end-to-end: firing — T-711 absent from CHANGELOG.md) passed.');
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end SILENT: T-711 present in CHANGELOG.md.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-silent');
  buildGitFixture(dir, { changelogMentionsT711: true });

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 3 FAIL: unexpected exit ${status}:\n${out}`);
  assert.ok(
    !out.includes('CHANGELOG.md has no entry for:'),
    `Part 3 FAIL: no advisory line expected when the id is already present, got:\n${out}`
  );

  console.log('Part 3 (end-to-end: silent — T-711 present in CHANGELOG.md) passed.');
}

// ---------------------------------------------------------------------------
// Part 4 — end-to-end: scripts/publish-manifest.json absent — degrade silently.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-no-manifest');
  buildGitFixture(dir, { changelogMentionsT711: false });
  fs.rmSync(path.join(dir, 'scripts', 'publish-manifest.json'));

  const { status, out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 4 FAIL: unexpected exit ${status}:\n${out}`);
  assert.ok(
    !out.includes('CHANGELOG.md has no entry for:'),
    `Part 4 FAIL: no advisory expected with no manifest to classify against, got:\n${out}`
  );

  console.log('Part 4 (end-to-end: silent — scripts/publish-manifest.json absent) passed.');
}

// ---------------------------------------------------------------------------
// T-845 helpers. The recap sits between the results table and `Session closed.`
// ---------------------------------------------------------------------------
const RECAP_HEADER_RE = /Advisories this close/;
const LOG_WITH_T711 = '# EXECUTION_LOG\n\n- 2026-08-23 — T-711 spawned developer. tool_uses: 10/140 outcome: completed\n';

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// Verify the structural contract shared by both paths and return the lines.
function checkRecapPlacement(label, rawOut) {
  const lines = stripAnsi(rawOut).split('\n');
  const closedIdx = lines.findIndex((l) => l.trim() === 'Session closed.');
  assert.ok(closedIdx !== -1, `${label} FAIL: no "Session closed." line:\n${rawOut}`);
  const recapIdx = lines.findIndex((l) => RECAP_HEADER_RE.test(l));
  assert.ok(recapIdx !== -1 && recapIdx < closedIdx, `${label} FAIL: recap must precede "Session closed.". recap=${recapIdx} closed=${closedIdx}\n${rawOut}`);
  const renameIdx = lines.map((l, i) => (l.startsWith('RENAME_SESSION:') ? i : -1)).filter((i) => i !== -1);
  assert.strictEqual(renameIdx.length, 1, `${label} FAIL: expected exactly one RENAME_SESSION line`);
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  assert.ok(nonEmpty[nonEmpty.length - 1].startsWith('RENAME_SESSION:'), `${label} FAIL: RENAME_SESSION must stay the last output line`);
  return { lines, recapIdx, closedIdx };
}

// ---------------------------------------------------------------------------
// Part 5 — T-845 recap, non-interactive: T-711 absent from CHANGELOG.md.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-recap');
  buildGitFixture(dir, { changelogMentionsT711: false });

  // stdout only: the recap contract is about the stdout stream's tail.
  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 5 FAIL: unexpected exit ${status}:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement('Part 5', out);

  // Last row of the session-completed table: the T-711 row.
  const tableRowIdx = lines.map((l, i) => (/^\s*T-711\s/.test(l) ? i : -1)).filter((i) => i !== -1).pop();
  assert.ok(tableRowIdx !== undefined, `Part 5 FAIL: no T-711 table row:\n${out}`);

  const recapLineIdx = lines.findIndex((l, i) => i > recapIdx && l.includes('CHANGELOG.md has no entry for: T-711'));
  assert.ok(recapLineIdx !== -1, `Part 5 FAIL: no recap line naming T-711:\n${out}`);
  assert.ok(recapLineIdx > tableRowIdx, `Part 5 FAIL: recap line (${recapLineIdx}) must come after the table's last row (${tableRowIdx})`);
  assert.ok(recapLineIdx < closedIdx, `Part 5 FAIL: recap line (${recapLineIdx}) must come before "Session closed." (${closedIdx})`);

  // The original pre-table advisory is still printed at its position.
  const earlyIdx = lines.findIndex((l) => l.includes('⚠ CHANGELOG.md has no entry for: T-711'));
  assert.ok(earlyIdx !== -1 && earlyIdx < tableRowIdx, 'Part 5 FAIL: the original pre-table advisory must remain in place');

  // `tail -6` of the real stdout still contains T-711.
  const tail = spawnSync('tail', ['-6'], { input: out, encoding: 'utf8' }).stdout;
  assert.ok(tail.includes('T-711'), `Part 5 FAIL: tail -6 lost T-711:\n${tail}`);

  console.log('Part 5 (T-845 end-to-end: recap after table, before Session closed., survives tail -6) passed.');
  console.log('--- tail -6 ---\n' + tail + '---------------');
}

// ---------------------------------------------------------------------------
// Part 6 — T-845: both T-629 (no EXECUTION_LOG.md entry) and T-718 fire.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-recap-both');
  buildGitFixture(dir, { changelogMentionsT711: false });

  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 6 FAIL: unexpected exit ${status}:\n${out}`);
  const plain = stripAnsi(out);
  assert.strictEqual(plain.split('Advisories this close (2):').length - 1, 1, `Part 6 FAIL: expected exactly one "Advisories this close (2):" header:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement('Part 6', out);
  const block = lines.slice(recapIdx + 1, closedIdx).filter((l) => l.trim() !== '');
  assert.strictEqual(block.length, 2, `Part 6 FAIL: expected two recap lines, got ${JSON.stringify(block)}`);
  assert.ok(block.some((l) => l.includes('EXECUTION_LOG.md has no entry for: T-711')), `Part 6 FAIL: missing T-629 line: ${JSON.stringify(block)}`);
  assert.ok(block.some((l) => l.includes('CHANGELOG.md has no entry for: T-711')), `Part 6 FAIL: missing T-718 line: ${JSON.stringify(block)}`);

  console.log('Part 6 (T-845 end-to-end: both advisories fire — recap reads (2) with both lines) passed.');
}

// ---------------------------------------------------------------------------
// Part 7 — T-845: neither advisory fires → the `none` line, exactly once.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-recap-none');
  buildGitFixture(dir, { changelogMentionsT711: true });
  fs.writeFileSync(path.join(dir, 'EXECUTION_LOG.md'), LOG_WITH_T711, 'utf8');

  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 7 FAIL: unexpected exit ${status}:\n${out}`);
  const plain = stripAnsi(out);
  assert.strictEqual(plain.split('Advisories this close: none').length - 1, 1, `Part 7 FAIL: expected "Advisories this close: none" exactly once:\n${out}`);
  assert.ok(!/Advisories this close \(/.test(plain), `Part 7 FAIL: no counted header expected:\n${out}`);
  const { recapIdx, closedIdx } = checkRecapPlacement('Part 7', out);
  assert.strictEqual(closedIdx - recapIdx, 1, 'Part 7 FAIL: the none line must sit immediately before "Session closed."');
  // `none` must be trustworthy: no other advisory-shaped line (warning glyph,
  // WARN:, SKIPPED, validator issues, a hygiene or feedback block) printed in this run.
  assert.ok(!/⚠|WARN:|SKIPPED|Validator issues|Worktree hygiene|mavp-feedback/.test(plain), `Part 7 FAIL: an advisory printed in the "none" fixture:\n${out}`);
  assert.ok(plain.includes('Validator passed'), 'Part 7 FAIL: fixture validator must pass so no validator advisory is expected');

  console.log('Part 7 (T-845 end-to-end: nothing fired — "Advisories this close: none" once) passed.');
}

// ---------------------------------------------------------------------------
// Part 9 — T-845 round 2: an advisory OTHER than T-629/T-718 reaches the recap
// with the right count. T-712 sits at qa_passed with an evidence commit that
// is reachable on HEAD, so the shipped-but-unbooked advisory (T-637) fires;
// the execution log and CHANGELOG.md both mention T-711, so T-629/T-718 stay
// silent and the recap must read exactly `(1)`.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'e2e-recap-other');
  const t711Hash = buildGitFixture(dir, { changelogMentionsT711: true });
  fs.writeFileSync(path.join(dir, 'EXECUTION_LOG.md'), LOG_WITH_T711, 'utf8');
  const tsPath = path.join(dir, 'TASK_STATUS.md');
  fs.writeFileSync(tsPath, fs.readFileSync(tsPath, 'utf8').replace('## Recently completed tasks', `### T-712 — Booked late
- **Status:** qa_passed
- **Owner role:** product-docs
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** commit: ${t711Hash} branch: main
- **Notes:** —

## Recently completed tasks`), 'utf8');
  const blPath = path.join(dir, 'BACKLOG.md');
  fs.writeFileSync(blPath, fs.readFileSync(blPath, 'utf8').replace('## Active Wave\n', `## Active Wave

### T-712 — Booked late
- **Status:** qa_passed
- **Owner role:** product-docs
- **Repo:** fixture-repo
- **Verification type:** artifact
`), 'utf8');

  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 9 FAIL: unexpected exit ${status}:\n${out}`);
  const plain = stripAnsi(out);
  assert.ok(plain.includes('--set-status T-712 merged'), `Part 9 FAIL: fixture must make the shipped-but-unbooked proposal fire:\n${out}`);
  assert.strictEqual(plain.split('Advisories this close (1):').length - 1, 1, `Part 9 FAIL: expected exactly one "Advisories this close (1):" header:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement('Part 9', out);
  const block = lines.slice(recapIdx + 1, closedIdx).filter((l) => l.trim() !== '');
  assert.strictEqual(block.length, 1, `Part 9 FAIL: expected one recap line, got ${JSON.stringify(block)}`);
  assert.ok(block[0].includes('shipped but not booked: T-712') && block[0].includes('(T-637)'), `Part 9 FAIL: recap line wrong: ${JSON.stringify(block)}`);

  console.log('Part 9 (T-845 round 2: a non-T-629/T-718 advisory (T-637) reaches the recap, count (1)) passed.');
}

// ---------------------------------------------------------------------------
// Part 10 — T-845 round 3: the BACKLOG.md archive warning is fed to the recap.
// Fixture: merged T-711 plus a SECOND `## Active Wave` heading (lines 3 and 5),
// which makes archiveMergedTasksFromActiveWave() refuse and the close print the
// warning. T-629/T-718 stay silent (log + CHANGELOG mention T-711), so the
// recap must read exactly (1) and never `none`.
// ---------------------------------------------------------------------------
function buildDoubleActiveWaveFixture(dir) {
  buildGitFixture(dir, { changelogMentionsT711: true });
  fs.writeFileSync(path.join(dir, 'EXECUTION_LOG.md'), LOG_WITH_T711, 'utf8');
  const blPath = path.join(dir, 'BACKLOG.md');
  const bl = fs.readFileSync(blPath, 'utf8');
  assert.ok(bl.includes('## Wave 92 — Archived'), 'Part 10 setup: fixture shape changed');
  fs.writeFileSync(blPath, bl.replace('## Wave 92 — Archived', '## Active Wave'), 'utf8');
}

function checkArchiveWarningRecap(label, out) {
  const plain = stripAnsi(out);
  const warn = 'BACKLOG.md archive warning: Multiple ## Active Wave headings detected in BACKLOG.md at line(s): 3, 5.';
  assert.ok(plain.includes('⚠ ' + warn), `${label} FAIL: fixture must make the archive warning print:\n${out}`);
  assert.ok(!plain.includes('Advisories this close: none'), `${label} FAIL: recap must not read "none" after a warning:\n${out}`);
  assert.strictEqual(plain.split('Advisories this close (1):').length - 1, 1, `${label} FAIL: expected exactly one "Advisories this close (1):" header:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement(label, out);
  const block = lines.slice(recapIdx + 1, closedIdx).filter((l) => l.trim() !== '');
  assert.strictEqual(block.length, 1, `${label} FAIL: expected one recap line, got ${JSON.stringify(block)}`);
  assert.ok(block[0].includes(warn), `${label} FAIL: recap line must carry the archive warning with lines 3, 5: ${JSON.stringify(block)}`);
}

{
  const dir = path.join(TMP_ROOT, 'e2e-recap-archive-warning');
  buildDoubleActiveWaveFixture(dir);
  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 10 FAIL: unexpected exit ${status}:\n${out}`);
  checkArchiveWarningRecap('Part 10 (non-interactive)', out);
  console.log('Part 10 (T-845 round 3, non-interactive: archive warning reaches the recap, count (1), never "none") passed.');
}

// Part 10 (unit): the deferred/deprecated relocate-failure warnings of
// sweepTerminalSkipTasks() reach the recap. Neither id has a block in the
// content, so both relocations fail.
{
  const cs = require('./mavp-operator-close-session.js');
  cs.resetAdvisoryCollector();
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  try {
    cs.sweepTerminalSkipTasks('# TS\n\n## Active tasks\n\n## Recently completed tasks\n', [
      { id: 'T-901', status: 'deferred' },
      { id: 'T-902', status: 'deprecated' },
    ]);
    cs.printAdvisoryRecap();
  } finally {
    console.log = realLog;
    cs.resetAdvisoryCollector();
  }
  const plainLog = stripAnsi(logged.join('\n'));
  assert.ok(plainLog.includes('⚠ T-901 (deferred) — could not relocate'), `Part 10 (unit) FAIL: deferred warning did not print:\n${plainLog}`);
  assert.ok(plainLog.includes('⚠ T-902 (deprecated) — could not relocate'), `Part 10 (unit) FAIL: deprecated warning did not print:\n${plainLog}`);
  assert.ok(plainLog.includes('Advisories this close (2):'), `Part 10 (unit) FAIL: expected a (2) recap:\n${plainLog}`);
  assert.ok(plainLog.includes('T-901 (deferred) could not be relocated') && plainLog.includes('T-902 (deprecated) could not be relocated'), `Part 10 (unit) FAIL: recap lines missing:\n${plainLog}`);
  console.log('Part 10 (T-845 round 3, unit: deferred/deprecated relocate failures reach the recap, count (2)) passed.');
}

// ---------------------------------------------------------------------------
// Part 11 — T-845 round 4: the shipped-but-unbooked check's shallow-clone
// stand-down feeds the recap. Fixture: a qa_passed T-712 (a shipped-but-unbooked
// candidate) in a `git clone --depth 1` checkout of a multi-commit source repo
// (the source is created by buildGitFixture, whose init pins the branch). The
// stand-down line prints, and the recap must read `(1)` with a stand-down line
// tagged (T-637) — never `none`. Log + CHANGELOG mention T-711 so T-629/T-718
// stay silent.
// ---------------------------------------------------------------------------
{
  const srcDir = path.join(TMP_ROOT, 'e2e-recap-shallow-src');
  const dir = path.join(TMP_ROOT, 'e2e-recap-shallow');
  const t711Hash = buildGitFixture(srcDir, { changelogMentionsT711: true });
  fs.writeFileSync(path.join(srcDir, 'EXECUTION_LOG.md'), LOG_WITH_T711, 'utf8');
  const tsPath = path.join(srcDir, 'TASK_STATUS.md');
  fs.writeFileSync(tsPath, fs.readFileSync(tsPath, 'utf8').replace('## Recently completed tasks', `### T-712 — Booked late
- **Status:** qa_passed
- **Owner role:** product-docs
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** commit: ${t711Hash} branch: main
- **Notes:** —

## Recently completed tasks`), 'utf8');
  const blPath = path.join(srcDir, 'BACKLOG.md');
  fs.writeFileSync(blPath, fs.readFileSync(blPath, 'utf8').replace('## Active Wave\n', `## Active Wave

### T-712 — Booked late
- **Status:** qa_passed
- **Owner role:** product-docs
- **Repo:** fixture-repo
- **Verification type:** artifact
`), 'utf8');
  const srcGit = (cmd) => execSync(`git ${cmd}`, { cwd: srcDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  srcGit('add -A');
  srcGit('commit -q -m state');

  // file:// forces a real (shallow-capable) transport; a bare local path ignores --depth.
  execSync(`git clone -q --depth 1 "file://${srcDir}" "${dir}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execSync('git config user.email dev@example.com', { cwd: dir });
  execSync('git config user.name Dev', { cwd: dir });
  const shallow = execSync('git rev-parse --is-shallow-repository', { cwd: dir, encoding: 'utf8' }).trim();
  assert.strictEqual(shallow, 'true', 'Part 11 setup: the clone must be shallow');

  const { status, stdout: out } = runCloseSession(dir);
  assert.strictEqual(status, 0, `Part 11 FAIL: unexpected exit ${status}:\n${out}`);
  const plain = stripAnsi(out);
  assert.ok(plain.includes('Shipped-but-unbooked check stood down — shallow git clone'), `Part 11 FAIL: the stand-down line must print:\n${out}`);
  assert.ok(!plain.includes('--set-status T-712 merged'), `Part 11 FAIL: a stand-down must carry no booking proposal:\n${out}`);
  assert.ok(!plain.includes('Advisories this close: none'), `Part 11 FAIL: the recap must never read "none" after a stand-down:\n${out}`);
  assert.strictEqual(plain.split('Advisories this close (1):').length - 1, 1, `Part 11 FAIL: expected exactly one "Advisories this close (1):" header:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement('Part 11', out);
  const block = lines.slice(recapIdx + 1, closedIdx).filter((l) => l.trim() !== '');
  assert.strictEqual(block.length, 1, `Part 11 FAIL: expected one recap line, got ${JSON.stringify(block)}`);
  assert.ok(block[0].includes('stood down') && block[0].includes('shallow') && block[0].includes('(T-637)'), `Part 11 FAIL: recap line wrong: ${JSON.stringify(block)}`);

  console.log('Part 11 (T-845 round 4: shallow-clone stand-down reaches the recap, count (1), never "none") passed.');
  console.log('--- Part 11 recap ---\n' + lines.slice(recapIdx, closedIdx + 1).join('\n') + '\n---------------------');
}

// ---------------------------------------------------------------------------
// Part 8 — T-845: the interactive path prints the same recap. Answers are
// written only once their prompt has appeared (same technique as
// test-close-session-mode.js's sequential helper).
// ---------------------------------------------------------------------------
function runInteractiveSequential(dir, steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLOSE_SESSION_PATH, '--interactive'], {
      cwd: dir,
      env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    });
    let stdout = '';
    let stepIndex = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`interactive run timed out at step ${stepIndex} (${steps[stepIndex] && steps[stepIndex].match}); stdout so far:\n${stdout}`));
    }, 20000);
    function advance() {
      while (stepIndex < steps.length && stdout.includes(steps[stepIndex].match)) {
        child.stdin.write(steps[stepIndex].answer + '\n');
        stepIndex++;
      }
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); advance(); });
    child.stderr.on('data', () => { /* stdout stream only */ });
    child.on('exit', (status) => { clearTimeout(timer); resolve({ status, out: stdout }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

(async () => {
  const dir = path.join(TMP_ROOT, 'e2e-recap-interactive');
  buildGitFixture(dir, { changelogMentionsT711: false });
  // Set a wave goal so the interactive run has no wave-goal prompt to answer.
  const psPath = path.join(dir, 'PROCESS_STATE.json');
  const ps = JSON.parse(fs.readFileSync(psPath, 'utf8'));
  ps.wave_goal = 'fixture goal';
  fs.writeFileSync(psPath, JSON.stringify(ps, null, 2) + '\n', 'utf8');

  const { status, out } = await runInteractiveSequential(dir, [
    { match: 'Next action [', answer: '' },
    { match: 'Run git push?', answer: 'n' },
  ]);
  assert.strictEqual(status, 0, `Part 8 FAIL: unexpected exit ${status}:\n${out}`);
  const { lines, recapIdx, closedIdx } = checkRecapPlacement('Part 8', out);
  const tableRowIdx = lines.map((l, i) => (/^\s*T-711\s/.test(l) ? i : -1)).filter((i) => i !== -1).pop();
  assert.ok(tableRowIdx !== undefined && tableRowIdx < recapIdx, `Part 8 FAIL: recap must follow the table:\n${out}`);
  const block = lines.slice(recapIdx, closedIdx).join('\n');
  assert.ok(/Advisories this close \(2\):/.test(block), `Part 8 FAIL: expected (2) recap:\n${out}`);
  assert.ok(block.includes('CHANGELOG.md has no entry for: T-711'), `Part 8 FAIL: recap must name T-711:\n${out}`);
  console.log('Part 8 (T-845 interactive: recap before Session closed.) passed.');

  // Part 10, interactive path: syncBacklogMergedTasks() runs here as well.
  const dir10 = path.join(TMP_ROOT, 'e2e-recap-archive-warning-interactive');
  buildDoubleActiveWaveFixture(dir10);
  const ps10Path = path.join(dir10, 'PROCESS_STATE.json');
  const ps10 = JSON.parse(fs.readFileSync(ps10Path, 'utf8'));
  ps10.wave_goal = 'fixture goal';
  fs.writeFileSync(ps10Path, JSON.stringify(ps10, null, 2) + '\n', 'utf8');
  const r10 = await runInteractiveSequential(dir10, [
    { match: 'Next action [', answer: '' },
    { match: 'Run git push?', answer: 'n' },
  ]);
  assert.strictEqual(r10.status, 0, `Part 10 (interactive) FAIL: unexpected exit ${r10.status}:\n${r10.out}`);
  checkArchiveWarningRecap('Part 10 (interactive)', r10.out);
  console.log('Part 10 (T-845 round 3, interactive: archive warning reaches the recap, count (1), never "none") passed.');

  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('\nAll T-718 CHANGELOG ship-omission advisory assertions passed.');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
