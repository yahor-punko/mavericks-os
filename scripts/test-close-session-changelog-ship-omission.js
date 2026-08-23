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
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');

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
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
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
fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

console.log('\nAll T-718 CHANGELOG ship-omission advisory assertions passed.');
