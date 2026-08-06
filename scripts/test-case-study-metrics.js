'use strict';
// Regression test: T-387/T-390 — scripts/case-study/metrics.js must
// reproduce the control-repository measurement method behind the case
// study against a KNOWN fixture repo with a known commit-date split and
// known artifact contents. Deterministic — no wall-clock dependence
// (snapshot_date is passed in explicitly, never computed via Date.now()).
//
// Uses NEUTRAL fixture tokens (svc-a / svc-b / svc-c / svc-widgts) with a
// runtime --repo-prefix/--alias pair — never a private repo name (T-390).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { computeMetrics, DEFAULT_CUTOFF } = require('./case-study/metrics.js');

const CUTOFF = '2026-01-01';
const SNAPSHOT_DATE = '2026-01-10';
const REPO_PREFIX = 'svc-';
const ALIASES = [{ from: 'svc-widgts', to: 'svc-widgets' }];

function makeScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-case-study-metrics-'));
}

function git(repoPath, args, env) {
  execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: { ...process.env, ...env } });
}

function commitAt(repoPath, isoDate, message) {
  const dateEnv = { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  git(repoPath, ['commit', '--allow-empty', '-m', message], dateEnv);
}

const scratch = makeScratchDir();

try {
  git(scratch, ['init', '--quiet', '-b', 'main']);
  git(scratch, ['config', 'user.name', 'Fixture Bot']);
  git(scratch, ['config', 'user.email', 'demo@example.invalid']);

  // 3 commits BEFORE cutoff (2026-01-01) -> commits_baseline: 3
  commitAt(scratch, '2025-12-01T00:00:00+00:00', 'seed commit 1');
  commitAt(scratch, '2025-12-02T00:00:00+00:00', 'seed commit 2');
  commitAt(scratch, '2025-12-03T00:00:00+00:00', 'seed commit 3');

  // 5 commits ON/AFTER cutoff -> commits_mavp: 5; 2 of these are
  // "close session" checkpoints -> checkpoints: 2. The first mavp commit
  // is deliberately NOT a checkpoint and sits exactly at the cutoff
  // instant: `git log --since=<cutoff>` (used for checkpoint counting,
  // see metrics.js) treats `--since` as strictly-after, so a commit
  // dated exactly at the cutoff boundary is excluded from that count even
  // though it correctly counts toward commits_mavp via the date-string
  // split. Keeping the checkpoint commits comfortably inside the range
  // avoids re-testing that boundary quirk here.
  commitAt(scratch, '2026-01-01T00:00:00+00:00', 'regular work commit A');
  commitAt(scratch, '2026-01-02T00:00:00+00:00', 'chore: close session 2026-01-02');
  commitAt(scratch, '2026-01-03T00:00:00+00:00', 'regular work commit B');
  commitAt(scratch, '2026-01-04T00:00:00+00:00', 'chore: close session 2026-01-04');
  commitAt(scratch, '2026-01-05T00:00:00+00:00', 'regular work commit C');

  // BACKLOG.md fixture: 2 merged, 1 deployed_prod, 1 deferred, and 4 tasks
  // bearing the SINGULAR `**Repo:**` field (independent of status, matching
  // real usage where any in-flight or completed task may carry a
  // repo-target field): T-001/T-002 name a single repo each, T-003/T-004
  // name two repos each (comma and `+` separator respectively). Target
  // refs used are svc-a, svc-b, svc-c, plus one svc-widgts alias occurrence
  // that must normalize to svc-widgets — four distinct canonical tokens
  // (svc-a, svc-b, svc-c, svc-widgets) spread across the four fields, so
  // `distinct_target_repos` collapses to 4 while `repo_field_tasks` counts
  // all 4 lines and `multi_repo_tasks` counts only the two multi-repo
  // lines (T-003, T-004).
  const backlog = `# BACKLOG (fixture)

## Active Wave

### T-001 — Task one
- **Status:** merged
- **Repo:** svc-a

### T-002 — Task two
- **Status:** merged
- **Repo:** svc-b

### T-003 — Task three
- **Status:** deployed_prod
- **Repo:** svc-a, svc-c

### T-004 — Task four
- **Status:** deferred
- **Repo:** svc-b + svc-widgts

### T-005 — Task five
- **Status:** planned

### T-006 — Task six
- **Status:** in_progress
`;
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), backlog, 'utf8');

  // PROCESS_STATE.json fixture: wave 7
  fs.writeFileSync(
    path.join(scratch, 'PROCESS_STATE.json'),
    JSON.stringify({ wave: 7 }, null, 2),
    'utf8'
  );

  const result = computeMetrics({
    repoPath: scratch,
    cutoffDate: CUTOFF,
    snapshotDate: SNAPSHOT_DATE,
    repoPrefix: REPO_PREFIX,
    aliases: ALIASES,
  });

  const expected = {
    snapshot_date: SNAPSHOT_DATE,
    commits_baseline: 3,
    commits_mavp: 5,
    merged: 2,
    deployed_prod: 1,
    deferred: 1,
    waves: 7,
    checkpoints: 2,
    repo_field_tasks: 4,
    distinct_target_repos: 4,
    multi_repo_tasks: 2,
  };

  assert.deepStrictEqual(result, expected, `FAIL: computeMetrics output mismatch.\nGot: ${JSON.stringify(result, null, 2)}\nExpected: ${JSON.stringify(expected, null, 2)}`);
  console.log('Assertion 1 passed: computeMetrics matches known fixture exactly.');

  // Sanity: keys are EXACTLY the documented set (no extra, no missing —
  // e.g. no `repositories` or `aws_lambda_functions`, which are not
  // computable from repo state alone).
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(result).sort();
  assert.deepStrictEqual(actualKeys, expectedKeys, 'FAIL: computeMetrics emitted unexpected key set');
  console.log('Assertion 2 passed: output has exactly the documented key set.');

  // computeMetrics never falls back to Date.now() — omitting snapshotDate
  // must throw rather than silently produce a non-deterministic value.
  assert.throws(
    () => computeMetrics({ repoPath: scratch, cutoffDate: CUTOFF, repoPrefix: REPO_PREFIX }),
    /snapshotDate is required/,
    'FAIL: computeMetrics should throw when snapshotDate is omitted'
  );
  console.log('Assertion 3 passed: computeMetrics throws without snapshotDate (no Date.now() fallback).');

  // computeMetrics never bakes in a private repo-name default — omitting
  // repoPrefix must throw rather than silently falling back to one.
  assert.throws(
    () => computeMetrics({ repoPath: scratch, cutoffDate: CUTOFF, snapshotDate: SNAPSHOT_DATE }),
    /repoPrefix is required/,
    'FAIL: computeMetrics should throw when repoPrefix is omitted'
  );
  console.log('Assertion 4 passed: computeMetrics throws without repoPrefix (no hardcoded private-name fallback).');

  // Default cutoff constant matches the documented Mavericks-adoption date.
  assert.strictEqual(DEFAULT_CUTOFF, '2026-04-17', 'FAIL: DEFAULT_CUTOFF drifted from documented adoption date');
  console.log('Assertion 5 passed: DEFAULT_CUTOFF is the documented 2026-04-17 adoption date.');

  console.log('\nAll T-387/T-390 case-study-metrics assertions passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
