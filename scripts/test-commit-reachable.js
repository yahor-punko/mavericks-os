'use strict';
// Regression test: T-448 — Validator advisory: merged evidence commit hashes
// unreachable from HEAD. Extended by T-455 with two-tier reachability
// (held-on-a-local-branch vs reachable-from-no-local-ref). Extended by
// T-489 with hub-aware per-hash cross-repo annotation skipping and
// archived-section noise aggregation. Extended by T-565 with shallow-clone
// detection: the "no local ref" tier is unsound in a shallow clone (e.g.
// actions/checkout@v7's default fetch-depth: 1), since a hash absent from
// the fetched window is indistinguishable from one whose history was
// deliberately never fetched — indeterminate hashes are collapsed into a
// single info-severity stand-down finding instead of individual warnings.
//
// Covers:
//   1. extractCommitHashesFromEvidence() extracts one or more commit: hashes
//      from an evidence block and rejects anything that doesn't match
//      /^[0-9a-f]{7,40}$/ (too short, non-hex, uppercase).
//   2. buildReachableHashIndex()/isHashReachable() prefix-match a short
//      evidence hash against the bucketed set of full reachable hashes.
//   3. resolveSelfRepoId() resolves the repo id whose docs/REPO_MAP.md path:
//      matches the validated root, and returns null when no entry matches.
//   4. checkCommitReachable(): a merged Active-tasks entry citing a hash NOT
//      reachable from HEAD or any local branch fires commit_unreachable at
//      WARNING severity, naming the task and hash; the same condition on a
//      Recently-completed entry fires INFO severity; a hash reachable from
//      HEAD fires no finding; a hash reachable from a local branch but NOT
//      HEAD fires an INFO finding (T-455, "held on a local branch") even in
//      the Active tasks section; a non-terminal status is skipped; a task
//      whose Repo:/Repos: names a different repo (per docs/REPO_MAP.md) is
//      skipped; the check degrades silently (no finding, no crash) when git
//      is unavailable (non-git dir).
//   5. Reachability is computed with exactly THREE batched subprocess calls —
//      git rev-list HEAD, git rev-list --branches, and (T-565) the
//      git rev-parse --is-shallow-repository shallow-clone detection call —
//      regardless of how many evidence hashes are checked (verified via an
//      execSync call-count spy).
//   6. Full-stack: `node scripts/mavp-validator.js <fixtureRoot>` against a
//      real fixture repo — Active-tasks unreachable-from-any-ref hash -> exit
//      1 (usable_but_drifting) with a commit_unreachable WARNING finding;
//      Recently-completed-only unreachable-from-any-ref hash -> exit 0
//      (healthy) with the finding still surfaced as INFO (never flips the
//      exit code); Active-tasks hash held on a local branch (not HEAD) ->
//      exit 0 (healthy) with the finding surfaced as INFO.
//   8. extractCommitEntriesFromEvidence() (T-489) pairs each extracted hash
//      with its parenthesized cross-repo annotation, or null when absent.
//   9. checkCommitReachable() hub-aware annotation skip (T-489): a hash
//      annotated with a KNOWN other repo-map id is skipped entirely (even
//      with no record-level Repo: field at all); a hash annotated with the
//      SELF repo id is still checked locally; a hash annotated with an
//      unknown/unregistered repo id is NOT silently skipped — it still gets
//      the normal local check; unannotated-hash behavior is unchanged.
//  10. checkCommitReachable() archived-section aggregation threshold
//      (T-489): at/below ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD, Recently-
//      completed unreachable findings stay individual; above it, they
//      collapse into one aggregate info finding naming the count. The
//      Active tasks section is never aggregated, regardless of count.
//  11. (T-565) checkCommitReachable() against a REAL shallow clone (built via
//      `git clone --depth 1 file://<src>` — the file:// protocol is
//      load-bearing, since a plain local-path clone silently ignores --depth
//      — verified by asserting `git rev-parse --is-shallow-repository`
//      prints exactly "true"): an evidence hash outside the fetched window
//      produces NO warning-severity finding, collapsed instead into exactly
//      ONE info-severity stand-down finding naming the affected task; an
//      evidence hash INSIDE the fetched window (the clone's HEAD) produces
//      no finding of any kind, in the same run.
//  12. (T-565) a shallow clone with ZERO indeterminate evidence hashes emits
//      no commit_unreachable finding at all — nothing stood down, so no
//      advisory.
//  13. (T-565) full-stack `node scripts/mavp-validator.js <shallowFixture>`
//      against a real shallow clone with an out-of-window evidence hash
//      exits 0 (healthy) — the stand-down finding never affects the exit
//      code.
//  14. (T-565) isShallowRepository() classifies shallow ONLY on an exact
//      "true" match (via the execSync-spy pattern): non-"true" output (e.g.
//      "false", wrong case) and a thrown error both fall through to false
//      (non-shallow / existing behavior).
//  15. (T-565) the stand-down message caps the ENUMERATED task ids at
//      ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD (reusing the existing
//      archived-section aggregation cap) and summarizes the remainder as
//      "(+N more)", while still stating the TRUE total indeterminate count
//      in full — otherwise a shallow clone of a repo's whole history (what
//      CI actually does) enumerates every indeterminate task in one
//      unreadable line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');
const cp = require('node:child_process');

const {
  checkCommitReachable,
  extractCommitHashesFromEvidence,
  extractCommitEntriesFromEvidence,
  ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD,
  buildReachableHashIndex,
  isHashReachable,
  resolveSelfRepoId,
  getSeverityForCheck,
} = require('./mavp-validator.js');
const { getCommitHashesReachableFromHead, isShallowRepository } = require('./mavp-operator-lib.js');

const VALIDATOR_SCRIPT = path.join(__dirname, 'mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't448-commit-reachable-'));

function git(root, cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build a fixture git repo at TMP_DIR/name with two commits. Returns the
 * root, the full HEAD hash (reachable), and a plausible-looking 40-char hex
 * "orphan" hash guaranteed to never appear in this repo's history (never
 * committed anywhere) — no need to reason about object-database existence,
 * only about reachability from HEAD, which the orphan hash never has.
 */
function makeGitFixture(name) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  fs.writeFileSync(path.join(root, 'file2.md'), 'second\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "second commit"');

  const headHash = git(root, 'rev-parse HEAD').trim();
  // 40 hex chars, never committed in any repo used by this test.
  const orphanHash = 'ba5eba11' + 'deadc0de'.repeat(4);
  return { root, headHash, orphanHash: orphanHash.slice(0, 40) };
}

function taskBlock({ taskId, status, repo, evidenceLine }) {
  const repoLine = repo ? `- **Repo:** ${repo}\n` : '';
  return `### ${taskId} — Fixture task\n\n- **Status:** ${status}\n${repoLine}- **Verification type:** runtime\n- **Evidence:** ${evidenceLine}\n`;
}

// ---------------------------------------------------------------------------
// Test 1: extractCommitHashesFromEvidence() — extraction + hex validation.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    extractCommitHashesFromEvidence('commit: abc1234'),
    ['abc1234'],
    'Test 1a FAIL: expected single 7-char hash extracted'
  );

  assert.deepStrictEqual(
    extractCommitHashesFromEvidence('commit: abc1234def (repo-a)\ncommit: 1234567abc (repo-b)'),
    ['abc1234def', '1234567abc'],
    'Test 1b FAIL: expected both cross-repo commit: hashes extracted in order'
  );

  assert.deepStrictEqual(
    extractCommitHashesFromEvidence('commit: ab12'),
    [],
    'Test 1c FAIL: a hash shorter than 7 hex chars must be rejected'
  );

  assert.deepStrictEqual(
    extractCommitHashesFromEvidence('commit: ABCDEF1'),
    [],
    'Test 1d FAIL: uppercase hex must be rejected — pattern is /^[0-9a-f]{7,40}$/ (lowercase only)'
  );

  assert.deepStrictEqual(
    extractCommitHashesFromEvidence('commit: not-a-hash-at-all'),
    [],
    'Test 1e FAIL: non-hex content must be rejected'
  );

  assert.deepStrictEqual(extractCommitHashesFromEvidence(null), [], 'Test 1f FAIL: null evidence -> []');
  assert.deepStrictEqual(extractCommitHashesFromEvidence(''), [], 'Test 1g FAIL: empty evidence -> []');

  console.log('Test 1 passed: extractCommitHashesFromEvidence() extracts and hex-validates commit: hashes');
}

// ---------------------------------------------------------------------------
// Test 2: buildReachableHashIndex() / isHashReachable() prefix matching.
// ---------------------------------------------------------------------------
{
  const fullHashes = ['abc1234def5678900000000000000000000000', 'ffeeddccbbaa99887766554433221100ffeedd0'];
  const index = buildReachableHashIndex(fullHashes);

  assert.ok(isHashReachable('abc1234', index), 'Test 2a FAIL: 7-char prefix of a reachable hash should match');
  assert.ok(isHashReachable('abc1234def5678900000000000000000000000', index), 'Test 2b FAIL: full hash should match itself');
  assert.ok(!isHashReachable('0000000', index), 'Test 2c FAIL: a prefix with no matching bucket should not be reachable');
  assert.ok(!isHashReachable('abc9999', index), 'Test 2d FAIL: a prefix sharing no full hash should not be reachable');

  console.log('Test 2 passed: buildReachableHashIndex()/isHashReachable() prefix-match short evidence hashes correctly');
}

// ---------------------------------------------------------------------------
// Test 3: resolveSelfRepoId() resolves the repo map entry whose path matches
// root, and returns null when no entry matches (or the map is empty).
// ---------------------------------------------------------------------------
{
  const root = '/tmp/some/fixture/root';
  const repoMap = {
    'this-repo': { path: root },
    'other-repo': { path: '/tmp/some/other/root' },
  };

  assert.strictEqual(resolveSelfRepoId(root, repoMap), 'this-repo', 'Test 3a FAIL: expected "this-repo" to resolve as self');
  assert.strictEqual(resolveSelfRepoId('/tmp/unmatched', repoMap), null, 'Test 3b FAIL: no matching entry -> null');
  assert.strictEqual(resolveSelfRepoId(root, {}), null, 'Test 3c FAIL: empty repo map -> null');
  assert.strictEqual(resolveSelfRepoId(root, null), null, 'Test 3d FAIL: null repo map -> null (no throw)');

  console.log('Test 3 passed: resolveSelfRepoId() resolves the self repo id via docs/REPO_MAP.md path matching');
}

// ---------------------------------------------------------------------------
// Test 4: checkCommitReachable() direct unit tests against a real git fixture.
// ---------------------------------------------------------------------------
{
  const { root, headHash, orphanHash } = makeGitFixture('unit-fixture');
  const repoMap = { 'this-repo': { path: root }, 'other-repo': { path: '/tmp/does-not-matter' } };

  // 4a: Active tasks — reachable hash -> no finding.
  {
    const activeRecords = [
      {
        taskId: 'T-800',
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId: 'T-800', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${headHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 0, `Test 4a FAIL: expected no findings for a reachable hash, got: ${JSON.stringify(findings)}`);
  }
  console.log('Test 4a passed: a reachable HEAD hash produces no commit_unreachable finding');

  // 4b: Active tasks — unreachable hash -> WARNING finding naming task + hash.
  {
    const activeRecords = [
      {
        taskId: 'T-801',
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId: 'T-801', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 4b FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
    const finding = findings[0];
    assert.strictEqual(finding.checkName, 'commit_unreachable', 'Test 4b FAIL: checkName mismatch');
    assert.strictEqual(finding.severity, 'warning', 'Test 4b FAIL: expected WARNING severity for Active tasks');
    assert.strictEqual(finding.taskId, 'T-801', 'Test 4b FAIL: taskId mismatch');
    assert.ok(finding.message.includes('T-801') && finding.message.includes(orphanHash), 'Test 4b FAIL: message should name the task and hash');
  }
  console.log('Test 4b passed: an unreachable hash on an Active-tasks entry fires commit_unreachable at WARNING severity, naming task + hash');

  // 4c: Recently completed tasks — same unreachable hash -> INFO finding.
  {
    const recentlyCompletedRecords = [
      {
        taskId: 'T-802',
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId: 'T-802', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords: [], recentlyCompletedRecords, root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 4c FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(findings[0].severity, 'info', 'Test 4c FAIL: expected INFO severity for Recently completed tasks');
    assert.strictEqual(findings[0].taskId, 'T-802', 'Test 4c FAIL: taskId mismatch');
  }
  console.log('Test 4c passed: the same condition on a Recently-completed entry fires commit_unreachable at INFO severity');

  // 4d: non-terminal status (e.g. in_progress) is skipped even with an unreachable hash.
  {
    const activeRecords = [
      {
        taskId: 'T-803',
        status: 'in_progress',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId: 'T-803', status: 'in_progress', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 0, `Test 4d FAIL: expected no findings for a non-terminal status, got: ${JSON.stringify(findings)}`);
  }
  console.log('Test 4d passed: a non-terminal status (in_progress) is skipped regardless of hash reachability');

  // 4e: cross-repo task (Repo: names a DIFFERENT repo than root) is skipped.
  {
    const activeRecords = [
      {
        taskId: 'T-804',
        status: 'merged',
        repo: 'other-repo',
        rawBlock: taskBlock({ taskId: 'T-804', status: 'merged', repo: 'other-repo', evidenceLine: `commit: ${orphanHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 0, `Test 4e FAIL: expected cross-repo task to be skipped, got: ${JSON.stringify(findings)}`);
  }
  console.log('Test 4e passed: a task whose Repo: names a different repo than the validated root is skipped');

  // 4f: getSeverityForCheck default for commit_unreachable is warning (the worse of the two cases).
  assert.strictEqual(getSeverityForCheck('commit_unreachable'), 'warning', 'Test 4f FAIL: default severity for commit_unreachable should be warning');
  console.log('Test 4f passed: getSeverityForCheck("commit_unreachable") defaults to warning');

  // 4g (T-455): a hash held on a local branch but NOT on HEAD -> INFO finding
  // stating it's held on a local branch, even when the task is in the Active
  // tasks section (which would otherwise be WARNING for the no-local-ref tier).
  {
    const currentBranch = git(root, 'rev-parse --abbrev-ref HEAD').trim();
    git(root, 'checkout -q -b feature-branch-t455');
    fs.writeFileSync(path.join(root, 'branch-only.md'), 'branch-only content\n', 'utf8');
    git(root, 'add -A');
    git(root, 'commit -q -m "branch-only commit"');
    const branchHash = git(root, 'rev-parse HEAD').trim();
    git(root, `checkout -q ${currentBranch}`);

    const activeRecords = [
      {
        taskId: 'T-806',
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId: 'T-806', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${branchHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 4g FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
    const finding = findings[0];
    assert.strictEqual(finding.checkName, 'commit_unreachable', 'Test 4g FAIL: checkName mismatch');
    assert.strictEqual(finding.severity, 'info', 'Test 4g FAIL: expected INFO severity for a hash held on a local branch, even in the Active tasks section');
    assert.ok(finding.message.includes('local branch'), `Test 4g FAIL: expected message to mention "held on a local branch": ${finding.message}`);
    assert.ok(finding.message.includes('T-806') && finding.message.includes(branchHash), 'Test 4g FAIL: message should name the task and hash');
  }
  console.log('Test 4g passed: a hash held on a local branch (not HEAD) fires commit_unreachable at INFO severity even in the Active tasks section');
}

// ---------------------------------------------------------------------------
// Test 5: degrades silently (no finding, no crash) when git is unavailable
// (a plain, non-git directory).
// ---------------------------------------------------------------------------
{
  const nonGitRoot = path.join(TMP_DIR, 'non-git-root');
  fs.mkdirSync(nonGitRoot, { recursive: true });

  const activeRecords = [
    {
      taskId: 'T-805',
      status: 'merged',
      repo: null,
      rawBlock: taskBlock({ taskId: 'T-805', status: 'merged', repo: null, evidenceLine: 'commit: deadbeef123456' }),
    },
  ];

  let findings;
  assert.doesNotThrow(() => {
    findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root: nonGitRoot });
  }, 'Test 5 FAIL: checkCommitReachable must not throw when git is unavailable');
  assert.deepStrictEqual(findings, [], 'Test 5 FAIL: expected no findings when git is unavailable');

  // getCommitHashesReachableFromHead() itself also degrades to null.
  assert.strictEqual(getCommitHashesReachableFromHead(nonGitRoot), null, 'Test 5 FAIL: expected null from getCommitHashesReachableFromHead() on a non-git dir');

  console.log('Test 5 passed: checkCommitReachable() degrades silently (no finding, no crash) when git is unavailable');
}

// ---------------------------------------------------------------------------
// Test 6: reachability is computed with exactly THREE batched subprocess
// calls — git rev-list HEAD, git rev-list --branches, and (T-565) the
// git rev-parse --is-shallow-repository shallow-clone detection call —
// regardless of how many evidence hashes are checked. (Pre-T-565 this
// asserted exactly 2 calls; the third call is the mandated new shallow
// check, added once per checkCommitReachable() invocation, never once per
// hash — batching is still preserved, just over one more command.)
// ---------------------------------------------------------------------------
{
  const { root, headHash, orphanHash } = makeGitFixture('spy-fixture');
  const repoMap = { 'this-repo': { path: root } };

  const activeRecords = [
    { taskId: 'T-810', status: 'merged', repo: 'this-repo', rawBlock: taskBlock({ taskId: 'T-810', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${headHash}` }) },
    { taskId: 'T-811', status: 'merged', repo: 'this-repo', rawBlock: taskBlock({ taskId: 'T-811', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }) },
  ];
  const recentlyCompletedRecords = [
    { taskId: 'T-812', status: 'merged', repo: 'this-repo', rawBlock: taskBlock({ taskId: 'T-812', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }) },
  ];

  const originalExecSync = cp.execSync;
  let callCount = 0;
  cp.execSync = (...args) => {
    callCount += 1;
    return originalExecSync(...args);
  };

  let findings;
  try {
    findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords, root, repoMap });
  } finally {
    cp.execSync = originalExecSync;
  }

  assert.strictEqual(callCount, 3, `Test 6 FAIL: expected exactly 3 subprocess calls (batched git rev-list HEAD + git rev-list --branches + is-shallow-repository), got ${callCount}`);
  assert.strictEqual(findings.length, 2, `Test 6 FAIL: expected 2 findings (T-811 warning + T-812 info) — this fixture is a plain (non-shallow) git init, so behavior is byte-identical to pre-T-565, got: ${JSON.stringify(findings)}`);

  console.log('Test 6 passed: reachability is computed with exactly three batched subprocess calls (HEAD + --branches + is-shallow-repository), and a non-shallow fixture still produces the pre-T-565 finding set unchanged');
}

// ---------------------------------------------------------------------------
// Test 7: full-stack — `node scripts/mavp-validator.js <fixtureRoot>` against
// a real fixture repo.
// ---------------------------------------------------------------------------
function writeFullStackFixture(root, { evidenceStatus, sectionHeading }) {
  const { orphanHash } = { orphanHash: 'ba5eba11' + 'deadc0de'.repeat(4) };
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'REPO_MAP.md'),
    `# Repo Map\n\n## this-repo\n\n- **label:** This Repo\n- **path:** ${root}\n`,
    'utf8'
  );
  // T-575: BACKLOG.md must carry a matching archived T-900 block. Archival
  // MOVES a merged task's block into `## Wave N — Archived...` within
  // BACKLOG.md rather than deleting it, so "merged in TASK_STATUS.md, absent
  // from BACKLOG.md entirely" is a state the real tooling cannot produce —
  // and T-575's missing_backlog_record_anywhere check flags it. Status /
  // title / verification type / repo all mirror the TASK_STATUS block so no
  // status_mismatch, title_mismatch or verification_type_mismatch finding is
  // introduced; this fixture's subject is commit reachability only.
  fs.writeFileSync(
    root + '/BACKLOG.md',
    `# BACKLOG\n\n## Active Wave\n\n## Wave 1 — Archived\n\n### T-900 — Fixture full-stack task\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n`,
    'utf8'
  );

  const block = `### T-900 — Fixture full-stack task\n\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n- **Evidence:** commit: ${orphanHash}\n`;

  let taskStatus = '# TASK_STATUS\n\n## Active tasks\n\n';
  if (sectionHeading === 'Active tasks') {
    taskStatus += block + '\n## Recently completed tasks\n\n';
  } else {
    taskStatus += '\n## Recently completed tasks\n\n' + block;
  }
  fs.writeFileSync(root + '/TASK_STATUS.md', taskStatus, 'utf8');
  return orphanHash;
}

{
  const root = path.join(TMP_DIR, 'e2e-active-warning');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  const orphanHash = writeFullStackFixture(root, { sectionHeading: 'Active tasks' });
  git(root, 'add -A');
  git(root, 'commit -q -m "seed fixture artifacts"');

  const result = spawnSync(process.execPath, [VALIDATOR_SCRIPT, root], { cwd: root, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(result.status, 1, `Test 7a FAIL: expected exit 1 (usable_but_drifting), got ${result.status}. Output:\n${output}`);
  assert.ok(output.includes('commit_unreachable'), `Test 7a FAIL: expected "commit_unreachable" in output:\n${output}`);
  assert.ok(output.includes('T-900'), `Test 7a FAIL: expected "T-900" in output:\n${output}`);
  assert.ok(/## Warnings/.test(output) && output.indexOf('commit_unreachable') > output.indexOf('## Warnings'), `Test 7a FAIL: expected commit_unreachable to be listed under "## Warnings":\n${output}`);

  console.log('Test 7a passed: full-stack validator run against an Active-tasks unreachable hash exits 1 with a commit_unreachable WARNING finding');
}

{
  const root = path.join(TMP_DIR, 'e2e-recently-completed-info');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  writeFullStackFixture(root, { sectionHeading: 'Recently completed tasks' });
  git(root, 'add -A');
  git(root, 'commit -q -m "seed fixture artifacts"');

  const result = spawnSync(process.execPath, [VALIDATOR_SCRIPT, root], { cwd: root, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(result.status, 0, `Test 7b FAIL: expected exit 0 (healthy) — info findings must never flip the exit code, got ${result.status}. Output:\n${output}`);
  assert.ok(output.includes('commit_unreachable'), `Test 7b FAIL: expected "commit_unreachable" still surfaced (as info) in output:\n${output}`);
  assert.ok(/healthy/i.test(output), `Test 7b FAIL: expected overall result to be Healthy:\n${output}`);

  console.log('Test 7b passed: full-stack validator run against a Recently-completed-only unreachable hash exits 0 (healthy) with commit_unreachable surfaced as INFO');
}

{
  const root = path.join(TMP_DIR, 'e2e-active-held-on-branch');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  const mainBranch = git(root, 'rev-parse --abbrev-ref HEAD').trim();
  git(root, 'checkout -q -b feature-branch-t455');
  fs.writeFileSync(path.join(root, 'branch-only.md'), 'branch-only content\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "branch-only commit"');
  const branchHash = git(root, 'rev-parse HEAD').trim();
  git(root, `checkout -q ${mainBranch}`);

  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'REPO_MAP.md'),
    `# Repo Map\n\n## this-repo\n\n- **label:** This Repo\n- **path:** ${root}\n`,
    'utf8'
  );
  // T-575: as in writeFullStackFixture() above — BACKLOG.md must carry a
  // matching archived T-901 block, because a merged TASK_STATUS record with
  // no BACKLOG record anywhere is unreachable via real archival and now fires
  // missing_backlog_record_anywhere.
  fs.writeFileSync(
    root + '/BACKLOG.md',
    `# BACKLOG\n\n## Active Wave\n\n## Wave 1 — Archived\n\n### T-901 — Fixture held-on-branch task\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n`,
    'utf8'
  );
  const block = `### T-901 — Fixture held-on-branch task\n\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n- **Evidence:** commit: ${branchHash}\n`;
  fs.writeFileSync(root + '/TASK_STATUS.md', `# TASK_STATUS\n\n## Active tasks\n\n${block}\n## Recently completed tasks\n\n`, 'utf8');

  git(root, 'add -A');
  git(root, 'commit -q -m "seed fixture artifacts"');

  const result = spawnSync(process.execPath, [VALIDATOR_SCRIPT, root], { cwd: root, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(result.status, 0, `Test 7c FAIL: expected exit 0 (healthy) — a held-on-branch info finding must never flip the exit code, got ${result.status}. Output:\n${output}`);
  assert.ok(output.includes('commit_unreachable'), `Test 7c FAIL: expected "commit_unreachable" in output:\n${output}`);
  assert.ok(output.includes('T-901'), `Test 7c FAIL: expected "T-901" in output:\n${output}`);
  assert.ok(/healthy/i.test(output), `Test 7c FAIL: expected overall result to be Healthy:\n${output}`);

  console.log('Test 7c passed: full-stack validator run against an Active-tasks hash held on a local branch (not HEAD) exits 0 (healthy) with commit_unreachable surfaced as INFO');
}

// ---------------------------------------------------------------------------
// Test 8 (T-489): extractCommitEntriesFromEvidence() — hash + annotation pairs.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    extractCommitEntriesFromEvidence('commit: abc1234'),
    [{ hash: 'abc1234', repoAnnotation: null }],
    'Test 8a FAIL: unannotated hash should have repoAnnotation: null'
  );

  assert.deepStrictEqual(
    extractCommitEntriesFromEvidence('commit: abc1234def (repo-a)\ncommit: 1234567abc (repo-b)'),
    [
      { hash: 'abc1234def', repoAnnotation: 'repo-a' },
      { hash: '1234567abc', repoAnnotation: 'repo-b' },
    ],
    'Test 8b FAIL: expected both hashes with their annotations, in order'
  );

  assert.deepStrictEqual(
    extractCommitEntriesFromEvidence('commit: ab12'),
    [],
    'Test 8c FAIL: a hash shorter than 7 hex chars must still be rejected'
  );

  assert.deepStrictEqual(extractCommitEntriesFromEvidence(null), [], 'Test 8d FAIL: null evidence -> []');
  assert.deepStrictEqual(extractCommitEntriesFromEvidence(''), [], 'Test 8e FAIL: empty evidence -> []');

  console.log('Test 8 passed: extractCommitEntriesFromEvidence() pairs each hash with its parenthesized cross-repo annotation (or null)');
}

// ---------------------------------------------------------------------------
// Test 9 (T-489): hub-aware annotation skip in checkCommitReachable().
// ---------------------------------------------------------------------------
{
  const { root, orphanHash } = makeGitFixture('t489-annotation-fixture');
  const repoMap = { 'this-repo': { path: root }, 'other-repo': { path: '/tmp/does-not-matter' } };

  // 9a: annotation names a KNOWN OTHER repo-map id -> no finding, even though
  // the record itself has no Repo: field at all (the archived-entry case
  // T-489 was filed against).
  {
    const activeRecords = [
      {
        taskId: 'T-920',
        status: 'merged',
        repo: null,
        rawBlock: taskBlock({ taskId: 'T-920', status: 'merged', repo: null, evidenceLine: `commit: ${orphanHash} (other-repo)` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 0, `Test 9a FAIL: expected no findings for a known-other-repo annotation, got: ${JSON.stringify(findings)}`);
  }
  console.log('Test 9a passed: a hash annotated with a known OTHER repo-map id produces no local unreachable finding');

  // 9b: annotation names the SELF repo -> still checked locally (fires,
  // since orphanHash is genuinely unreachable in this fixture).
  {
    const activeRecords = [
      {
        taskId: 'T-921',
        status: 'merged',
        repo: null,
        rawBlock: taskBlock({ taskId: 'T-921', status: 'merged', repo: null, evidenceLine: `commit: ${orphanHash} (this-repo)` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 9b FAIL: expected the self-repo annotation to still be checked locally, got: ${JSON.stringify(findings)}`);
    assert.strictEqual(findings[0].severity, 'warning', 'Test 9b FAIL: expected WARNING severity (Active tasks, no-local-ref tier)');
    assert.strictEqual(findings[0].taskId, 'T-921', 'Test 9b FAIL: taskId mismatch');
  }
  console.log('Test 9b passed: a hash annotated with the SELF repo id is still checked against local history');

  // 9c: annotation names an id NOT present in the repo map at all -> NOT
  // silently skipped. Decision (T-489): treat identically to an unannotated
  // hash — fall through to the normal local check, which still fires
  // commit_unreachable when the hash is genuinely unreachable. Rationale:
  // trusting an unrecognized annotation as "definitely elsewhere" would hide
  // real footguns behind a typo'd or unregistered repo name; verifying
  // locally by default is the safe failure mode, and the resulting finding
  // is the "not silently skipped" signal itself.
  {
    const activeRecords = [
      {
        taskId: 'T-922',
        status: 'merged',
        repo: null,
        rawBlock: taskBlock({ taskId: 'T-922', status: 'merged', repo: null, evidenceLine: `commit: ${orphanHash} (unregistered-repo)` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 9c FAIL: expected an unregistered-repo annotation to still be checked locally (not silently skipped), got: ${JSON.stringify(findings)}`);
    assert.strictEqual(findings[0].taskId, 'T-922', 'Test 9c FAIL: taskId mismatch');
  }
  console.log('Test 9c passed: a hash annotated with an unknown/unregistered repo id is NOT silently skipped — it is still checked locally, so a genuine footgun still fires');

  // 9d: unannotated hash behavior is unchanged (regression guard against 4b).
  {
    const activeRecords = [
      {
        taskId: 'T-923',
        status: 'merged',
        repo: null,
        rawBlock: taskBlock({ taskId: 'T-923', status: 'merged', repo: null, evidenceLine: `commit: ${orphanHash}` }),
      },
    ];
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 9d FAIL: expected unannotated-hash behavior unchanged, got: ${JSON.stringify(findings)}`);
  }
  console.log('Test 9d passed: an unannotated hash is checked locally exactly as before (no behavior change)');
}

// ---------------------------------------------------------------------------
// Test 10 (T-489): archived-section (Recently completed) aggregation
// threshold — below collapses to nothing extra (individual findings),
// above collapses to one aggregate info finding naming the count.
// ---------------------------------------------------------------------------
{
  const { root, orphanHash } = makeGitFixture('t489-aggregate-fixture');
  const repoMap = { 'this-repo': { path: root } };

  const makeRecentlyCompletedRecords = (count) =>
    Array.from({ length: count }, (_, i) => {
      const taskId = `T-${950 + i}`;
      return {
        taskId,
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId, status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }),
      };
    });

  // 10a: at or below the threshold -> individual info findings, one per task.
  {
    const recentlyCompletedRecords = makeRecentlyCompletedRecords(ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD);
    const findings = checkCommitReachable({ activeRecords: [], recentlyCompletedRecords, root, repoMap });
    assert.strictEqual(
      findings.length,
      ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD,
      `Test 10a FAIL: expected ${ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD} individual findings at the threshold, got ${findings.length}`
    );
    assert.ok(findings.every((f) => f.severity === 'info'), 'Test 10a FAIL: all archived findings should be info severity');
    assert.ok(findings.every((f) => f.taskId !== 'AGGREGATE'), 'Test 10a FAIL: at the threshold, findings should still be individual (not aggregated)');
  }
  console.log(`Test 10a passed: exactly ${ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD} archived-section unreachable findings stay individual (threshold not exceeded)`);

  // 10b: above the threshold -> collapsed into ONE aggregate info finding
  // naming the count.
  {
    const count = ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD + 3;
    const recentlyCompletedRecords = makeRecentlyCompletedRecords(count);
    const findings = checkCommitReachable({ activeRecords: [], recentlyCompletedRecords, root, repoMap });
    assert.strictEqual(findings.length, 1, `Test 10b FAIL: expected exactly 1 aggregate finding above threshold, got ${findings.length}: ${JSON.stringify(findings)}`);
    assert.strictEqual(findings[0].severity, 'info', 'Test 10b FAIL: aggregate finding must be info severity');
    assert.ok(findings[0].message.includes(String(count)), `Test 10b FAIL: expected the aggregate message to name the count (${count}): ${findings[0].message}`);
    assert.strictEqual(findings[0].checkName, 'commit_unreachable', 'Test 10b FAIL: aggregate should keep checkName commit_unreachable');
  }
  console.log('Test 10b passed: archived-section unreachable findings above the threshold collapse into a single aggregate info finding naming the count');

  // 10c: aggregation never applies to the Active tasks section — even a
  // large number of Active-tasks unreachable findings stay individual
  // (warning severity), since only the archived section should be capped.
  {
    const count = ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD + 3;
    const activeRecords = Array.from({ length: count }, (_, i) => {
      const taskId = `T-${970 + i}`;
      return {
        taskId,
        status: 'merged',
        repo: 'this-repo',
        rawBlock: taskBlock({ taskId, status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${orphanHash}` }),
      };
    });
    const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root, repoMap });
    assert.strictEqual(findings.length, count, `Test 10c FAIL: expected Active tasks findings to stay individual regardless of count, got ${findings.length}`);
    assert.ok(findings.every((f) => f.severity === 'warning'), 'Test 10c FAIL: Active tasks findings should stay warning severity');
  }
  console.log('Test 10c passed: aggregation never applies to the Active tasks section, regardless of how many findings accumulate');
}

// ---------------------------------------------------------------------------
// T-565 shallow-clone fixture helper.
//
// FIXTURE TRAP — verified directly (twice): `git clone --depth 1
// <plain-local-path>` SILENTLY IGNORES `--depth`. Git itself prints
// "warning: --depth is ignored in local clones; use file:// instead", the
// clone reports is-shallow-repository = false, and ALL commits are present.
// Only `git clone --depth 1 file://<path>` produces a genuinely shallow
// clone (is-shallow-repository = true, only the tip commit present). A
// fixture written the obvious way (plain path) would pass vacuously while
// testing nothing — hence the file:// protocol below, plus the exact-"true"
// assertion that makes a future accidental rewrite fail loudly by name.
//
// Builds a 2-commit source repo, clones it with --depth 1 via file://, and
// returns both roots plus the two commit hashes: outOfWindowHash (the first/
// older commit — absent from the depth-1 clone's fetched history) and
// inWindowHash (the second/tip commit — the shallow clone's own HEAD,
// genuinely reachable).
// ---------------------------------------------------------------------------
function makeShallowFixture(name) {
  const srcRoot = path.join(TMP_DIR, `${name}-src`);
  fs.mkdirSync(srcRoot, { recursive: true });
  git(srcRoot, 'init -q');
  git(srcRoot, 'config user.email demo@example.invalid');
  git(srcRoot, 'config user.name "Test Fixture"');

  fs.writeFileSync(path.join(srcRoot, 'README.md'), '# fixture\n', 'utf8');
  git(srcRoot, 'add -A');
  git(srcRoot, 'commit -q -m "initial commit"');
  const outOfWindowHash = git(srcRoot, 'rev-parse HEAD').trim();

  fs.writeFileSync(path.join(srcRoot, 'file2.md'), 'second\n', 'utf8');
  git(srcRoot, 'add -A');
  git(srcRoot, 'commit -q -m "second commit"');
  const inWindowHash = git(srcRoot, 'rev-parse HEAD').trim();

  const shallowRoot = path.join(TMP_DIR, `${name}-shallow`);
  execSync(`git clone -q --depth 1 file://${srcRoot} ${shallowRoot}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const isShallowOutput = git(shallowRoot, 'rev-parse --is-shallow-repository').trim();
  assert.strictEqual(
    isShallowOutput,
    'true',
    `FIXTURE TRAP: expected the file:// clone at ${shallowRoot} to report "git rev-parse --is-shallow-repository" = "true", got "${isShallowOutput}". A plain local-path clone silently ignores --depth; this fixture MUST use the file:// protocol (verified directly: a plain-path clone here would report false and retain all commits).`
  );

  return { srcRoot, shallowRoot, outOfWindowHash, inWindowHash };
}

// ---------------------------------------------------------------------------
// Test 11 (T-565): shallow-clone stand-down — an out-of-window evidence hash
// produces NO warning finding (collapsed into one info stand-down advisory
// naming the task), while an in-window evidence hash (the clone's own HEAD)
// produces no finding at all, in the same run.
// ---------------------------------------------------------------------------
{
  const { shallowRoot, outOfWindowHash, inWindowHash } = makeShallowFixture('t565-mixed');
  const repoMap = { 'this-repo': { path: shallowRoot } };

  const activeRecords = [
    {
      taskId: 'T-960',
      status: 'merged',
      repo: 'this-repo',
      rawBlock: taskBlock({ taskId: 'T-960', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${outOfWindowHash}` }),
    },
    {
      taskId: 'T-961',
      status: 'merged',
      repo: 'this-repo',
      rawBlock: taskBlock({ taskId: 'T-961', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${inWindowHash}` }),
    },
  ];

  const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root: shallowRoot, repoMap });

  assert.strictEqual(
    findings.length,
    1,
    `Test 11a FAIL: expected exactly ONE finding in the shallow fixture (the stand-down advisory) — no per-task warning for the out-of-window hash (T-960), no finding at all for the in-window hash (T-961). Got: ${JSON.stringify(findings)}`
  );
  const [finding] = findings;
  assert.strictEqual(finding.checkName, 'commit_unreachable', 'Test 11a FAIL: checkName mismatch');
  assert.strictEqual(finding.severity, 'info', 'Test 11a FAIL: the stand-down finding must be info severity — it must never affect the exit code');
  assert.ok(!findings.some((f) => f.severity === 'warning'), 'Test 11a FAIL: no warning-severity commit_unreachable finding may be present in a shallow clone');
  assert.ok(finding.message.includes('T-960'), 'Test 11a FAIL: stand-down message should name the affected task (T-960)');
  assert.ok(!finding.message.includes('T-961'), 'Test 11a FAIL: the in-window task (T-961) is genuinely reachable and must not be named as indeterminate');
  assert.ok(/shallow/i.test(finding.message), 'Test 11a FAIL: stand-down message should state the repository is shallow');

  console.log('Test 11a passed: shallow-fixture out-of-window evidence hash produces NO warning-severity finding, collapsed into one info stand-down advisory naming the affected task; the in-window hash produces no finding of any kind');
}

// ---------------------------------------------------------------------------
// Test 12 (T-565): a shallow repo with ZERO indeterminate evidence hashes
// emits no commit_unreachable finding at all.
// ---------------------------------------------------------------------------
{
  const { shallowRoot, inWindowHash } = makeShallowFixture('t565-clean');
  const repoMap = { 'this-repo': { path: shallowRoot } };

  const activeRecords = [
    {
      taskId: 'T-962',
      status: 'merged',
      repo: 'this-repo',
      rawBlock: taskBlock({ taskId: 'T-962', status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${inWindowHash}` }),
    },
  ];

  const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root: shallowRoot, repoMap });
  assert.strictEqual(
    findings.length,
    0,
    `Test 12 FAIL: expected NO commit_unreachable finding when a shallow repo has zero indeterminate hashes (nothing stood down), got: ${JSON.stringify(findings)}`
  );

  console.log('Test 12 passed: a shallow repo with zero indeterminate evidence hashes emits no commit_unreachable finding at all');
}

// ---------------------------------------------------------------------------
// Test 13 (T-565): full-stack — `node scripts/mavp-validator.js <shallowRoot>`
// against a real shallow clone with an out-of-window evidence hash. Confirms
// the stand-down finding never affects the exit code end-to-end (not just at
// the checkCommitReachable() unit level).
// ---------------------------------------------------------------------------
{
  const { shallowRoot, outOfWindowHash } = makeShallowFixture('t565-e2e');

  fs.mkdirSync(path.join(shallowRoot, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(shallowRoot, 'docs', 'REPO_MAP.md'),
    `# Repo Map\n\n## this-repo\n\n- **label:** This Repo\n- **path:** ${shallowRoot}\n`,
    'utf8'
  );
  // T-575: as in the Test 7 fixtures above — BACKLOG.md must carry a matching
  // archived T-963 block, or missing_backlog_record_anywhere fires and this
  // test's "exit 0" assertion picks up an unrelated warning.
  fs.writeFileSync(
    shallowRoot + '/BACKLOG.md',
    `# BACKLOG\n\n## Active Wave\n\n## Wave 1 — Archived\n\n### T-963 — Fixture shallow-clone task\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n`,
    'utf8'
  );
  const block = `### T-963 — Fixture shallow-clone task\n\n- **Status:** merged\n- **Repo:** this-repo\n- **Verification type:** runtime\n- **Evidence:** commit: ${outOfWindowHash}\n`;
  fs.writeFileSync(shallowRoot + '/TASK_STATUS.md', `# TASK_STATUS\n\n## Active tasks\n\n${block}\n## Recently completed tasks\n\n`, 'utf8');

  const result = spawnSync(process.execPath, [VALIDATOR_SCRIPT, shallowRoot], { cwd: shallowRoot, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(result.status, 0, `Test 13 FAIL: expected exit 0 (healthy) — a shallow clone's out-of-window evidence hash must not affect the exit code, got ${result.status}. Output:\n${output}`);
  assert.ok(!/## Warnings/.test(output), `Test 13 FAIL: expected no "## Warnings" section (the stand-down finding is info severity, not warning):\n${output}`);
  assert.ok(output.includes('commit_unreachable'), `Test 13 FAIL: expected the stand-down advisory to still be surfaced (as info) in output:\n${output}`);
  assert.ok(output.includes('T-963'), `Test 13 FAIL: expected T-963 named in output:\n${output}`);
  assert.ok(/healthy/i.test(output), `Test 13 FAIL: expected overall result to be Healthy:\n${output}`);

  console.log('Test 13 passed: full-stack validator run against a shallow clone with an out-of-window evidence hash exits 0 (healthy) — commit_unreachable is stood down to INFO, never affecting the exit code');
}

// ---------------------------------------------------------------------------
// Test 14 (T-565): isShallowRepository() exact-match detection robustness —
// classifies shallow ONLY on an exact "true" match; any other output or a
// thrown error falls through to false (non-shallow / existing behavior).
// ---------------------------------------------------------------------------
{
  const originalExecSync = cp.execSync;

  cp.execSync = () => 'false\n';
  assert.strictEqual(isShallowRepository('/any/path'), false, 'Test 14a FAIL: "false" output must classify as NOT shallow');

  cp.execSync = () => 'true\n';
  assert.strictEqual(isShallowRepository('/any/path'), true, 'Test 14b FAIL: exact "true" output must classify as shallow');

  cp.execSync = () => 'True\n'; // wrong case — must NOT be treated as a match
  assert.strictEqual(isShallowRepository('/any/path'), false, 'Test 14c FAIL: non-exact-match output ("True") must NOT classify as shallow');

  cp.execSync = () => 'true extra garbage';
  assert.strictEqual(isShallowRepository('/any/path'), false, 'Test 14d FAIL: trailing garbage after "true" must NOT classify as shallow — exact match only');

  cp.execSync = () => {
    throw new Error('git: command not found');
  };
  assert.strictEqual(isShallowRepository('/any/path'), false, 'Test 14e FAIL: a thrown error must fall through to false (non-shallow / existing behavior)');

  cp.execSync = originalExecSync;

  console.log('Test 14 passed: isShallowRepository() classifies shallow ONLY on an exact "true" match; any other output or a thrown error falls through to false');
}

// ---------------------------------------------------------------------------
// Test 15 (T-565): the stand-down message caps the ENUMERATED task ids at
// ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD (reusing the existing archived-
// section aggregation cap rather than inventing a fresh magic number) while
// still stating the TRUE total count in full. A real shallow clone of a
// repo's whole history (exactly what CI does) can indeterminate hundreds of
// tasks at once; enumerating every one of them would recreate the "operator
// stops reading" failure mode this task exists to close.
// ---------------------------------------------------------------------------
{
  const { shallowRoot, outOfWindowHash } = makeShallowFixture('t565-cap');
  const repoMap = { 'this-repo': { path: shallowRoot } };

  const count = ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD + 6; // well past the cap
  const activeRecords = Array.from({ length: count }, (_, i) => {
    const taskId = `T-${980 + i}`;
    return {
      taskId,
      status: 'merged',
      repo: 'this-repo',
      rawBlock: taskBlock({ taskId, status: 'merged', repo: 'this-repo', evidenceLine: `commit: ${outOfWindowHash}` }),
    };
  });

  const findings = checkCommitReachable({ activeRecords, recentlyCompletedRecords: [], root: shallowRoot, repoMap });

  assert.strictEqual(
    findings.length,
    1,
    `Test 15 FAIL: expected exactly ONE stand-down finding regardless of how many tasks are indeterminate, got: ${JSON.stringify(findings)}`
  );
  const [finding] = findings;

  // The true total count must be stated in full — it is genuinely useful
  // (it tells the operator how much of history is out of window).
  assert.ok(
    finding.message.includes(String(count)),
    `Test 15 FAIL: expected the true total count (${count}) named in the message: ${finding.message}`
  );

  // Enumerated ids must be capped at ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD:
  // count how many of the generated task ids actually appear as substrings
  // of the message (this is the mutant killer — removing the cap would name
  // all ${count}, not just the threshold's worth).
  const namedCount = activeRecords.filter((r) => finding.message.includes(r.taskId)).length;
  assert.strictEqual(
    namedCount,
    ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD,
    `Test 15 FAIL: expected exactly ${ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD} task ids named (the cap), got ${namedCount}: ${finding.message}`
  );

  // The uncapped remainder must be summarized, not silently dropped.
  const remaining = count - ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD;
  assert.ok(
    finding.message.includes(`+${remaining} more`),
    `Test 15 FAIL: expected a "+${remaining} more" summary for the uncapped remainder: ${finding.message}`
  );

  console.log(
    `Test 15 passed: the stand-down message names at most ${ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD} task ids (the existing archived-aggregation cap) while still stating the true total count (${count}) and summarizing the remainder`
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-448/T-489/T-565 assertions passed.');
