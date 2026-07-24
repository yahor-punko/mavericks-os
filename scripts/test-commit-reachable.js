'use strict';
// Regression test: T-448 — Validator advisory: merged evidence commit hashes
// unreachable from HEAD.
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
//      reachable from HEAD fires commit_unreachable at WARNING severity,
//      naming the task and hash; the same condition on a Recently-completed
//      entry fires INFO severity; a reachable hash fires no finding; a
//      non-terminal status is skipped; a task whose Repo:/Repos: names a
//      different repo (per docs/REPO_MAP.md) is skipped; the check degrades
//      silently (no finding, no crash) when git is unavailable (non-git dir).
//   5. Reachability is computed with exactly ONE batched `git rev-list HEAD`
//      subprocess call, regardless of how many evidence hashes are checked
//      (verified via an execSync call-count spy).
//   6. Full-stack: `node scripts/mavp-validator.js <fixtureRoot>` against a
//      real fixture repo — Active-tasks unreachable hash -> exit 1
//      (usable_but_drifting) with a commit_unreachable WARNING finding;
//      Recently-completed-only unreachable hash -> exit 0 (healthy) with the
//      finding still surfaced as INFO (never flips the exit code).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');
const cp = require('node:child_process');

const {
  checkCommitReachable,
  extractCommitHashesFromEvidence,
  buildReachableHashIndex,
  isHashReachable,
  resolveSelfRepoId,
  getSeverityForCheck,
} = require('./mavp-validator.js');
const { getCommitHashesReachableFromHead } = require('./mavp-operator-lib.js');

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
// Test 6: reachability is computed with exactly ONE batched `git rev-list
// HEAD` subprocess call, regardless of how many evidence hashes are checked.
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

  assert.strictEqual(callCount, 1, `Test 6 FAIL: expected exactly 1 subprocess call (batched git rev-list HEAD), got ${callCount}`);
  assert.strictEqual(findings.length, 2, `Test 6 FAIL: expected 2 findings (T-811 warning + T-812 info), got: ${JSON.stringify(findings)}`);

  console.log('Test 6 passed: reachability is computed with exactly one batched git rev-list HEAD subprocess call');
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
  fs.writeFileSync(root + '/BACKLOG.md', `# BACKLOG\n\n## Active Wave\n\n`, 'utf8');

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

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-448 assertions passed.');
