'use strict';
// T-637 — --close-session's shipped-but-unbooked advisory: derive-and-propose,
// never auto-apply.
//
// A task can be physically integrated on HEAD (the cherry-pick landed, its
// evidence commit is reachable) while still booked `qa_passed`. The terminal-
// status sweep is fail-closed, so the wave correctly stays open and prints
// "Wave N stays open — T-NNN still qa_passed" — but that line cannot tell the
// operator WHICH task merely owes its merge ritual versus which still needs
// real work. This file covers the advisory that adds exactly that distinction.
//
// Coverage:
//   1. findShippedUnbookedCandidates() — Active-tasks-section qa_passed
//      entries carrying a commit: hash are candidates; dev_done, no-commit
//      evidence, and Recently-completed entries are not.
//   2. Field-order and multi-line Evidence robustness (Evidence may precede
//      Status; a wrapped Evidence field is still read).
//   3. computeShippedUnbookedAdvisory() — reachable hash proposes, unreachable
//      hash does not.
//   4. BATCHING — exactly ONE `git rev-list` invocation per run regardless of
//      task/hash count (never a subprocess per hash).
//   5. Git unavailable — degrades silently (no proposal, no stand-down line,
//      no throw).
//   6. Shallow clone — stands down: no proposal, one stand-down line that
//      carries no ritual-command suggestion.
//   7. PROPOSE-ONLY at the unit level — a direct call leaves BACKLOG.md,
//      TASK_STATUS.md, PROCESS_STATE.json and PROCESS_STATE.md byte-identical.
//   8. End-to-end in a real git fixture — the firing case prints the proposal
//      line naming the task and the ritual command; the three non-firing cases
//      print no such line; the wave-stays-open announcement still prints
//      (complemented, not replaced); TASK_STATUS.md is byte-identical after
//      the run.
//   9. End-to-end in a real SHALLOW clone of that fixture — the proposal is
//      stood down even though the hash sits in the fetched window.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const cp = require('node:child_process');
const { execSync, spawnSync } = require('node:child_process');

const {
  findShippedUnbookedCandidates,
  computeShippedUnbookedAdvisory,
  formatShippedUnbookedProposal,
  SHIPPED_UNBOOKED_ADVISORY_STATUS,
  SHIPPED_UNBOOKED_STANDDOWN_LINE,
} = require('./mavp-operator-close-session.js');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't637-shipped-unbooked-'));

// A synthetic 40-char hash whose 7-char prefix is stable and unmistakable in
// assertion output. Built from repeated hex so no real repo can collide.
const FULL_A = 'a1b2c3d'.padEnd(40, '0');
const FULL_B = 'b2c3d4e'.padEnd(40, '0');
const FULL_C = 'c3d4e5f'.padEnd(40, '0');
const SHORT_A = FULL_A.slice(0, 7);
const SHORT_B = FULL_B.slice(0, 7);
const SHORT_C = FULL_C.slice(0, 7);
const UNREACHABLE_SHORT = 'deadbee';

// ---------------------------------------------------------------------------
// Test 1 — candidate selection: only Active-tasks qa_passed entries carrying a
// commit: hash. dev_done, missing commit: evidence, and an already-booked
// entry in Recently completed tasks must all be excluded.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-901 — Shipped but unbooked
- **Status:** qa_passed
- **Evidence:** commit: ${SHORT_A} branch: main
- **Notes:** —

### T-903 — Still in dev
- **Status:** dev_done
- **Evidence:** commit: ${SHORT_B} branch: main
- **Notes:** —

### T-904 — No commit evidence
- **Status:** qa_passed
- **Evidence:** artifact: docs/SOMETHING.md — no hash recorded
- **Notes:** —

### T-905 — Ready for QA, not reviewed yet
- **Status:** ready_for_qa
- **Evidence:** commit: ${SHORT_C} branch: main
- **Notes:** —

## Recently completed tasks

### T-900 — Already booked
- **Status:** merged
- **Evidence:** commit: ${SHORT_C} branch: main
- **Notes:** —
`;

  const candidates = findShippedUnbookedCandidates(markdown);
  assert.deepStrictEqual(
    candidates.map(c => c.id),
    ['T-901'],
    `Test 1 FAIL: only the Active-tasks qa_passed entry with a commit: hash is a candidate, got ${JSON.stringify(candidates)}`
  );
  assert.deepStrictEqual(candidates[0].hashes, [SHORT_A], 'Test 1 FAIL: candidate must carry its extracted evidence hash');
  assert.strictEqual(SHIPPED_UNBOOKED_ADVISORY_STATUS, 'qa_passed', 'Test 1 FAIL: the advisory must fire on qa_passed only');

  console.log('Test 1 passed: only Active-tasks qa_passed entries carrying a commit: hash are candidates (dev_done / ready_for_qa / no-commit / already-booked excluded)');
}

// ---------------------------------------------------------------------------
// Test 2 — field-order and multi-line Evidence robustness: Evidence may sit
// BEFORE Status in a block, and a wrapped (multi-line) Evidence field must
// still be read in full. Both shapes occur in real TASK_STATUS.md history.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-910 — Evidence before status
- **Evidence:** commit: ${SHORT_A} branch: main
- **Status:** qa_passed
- **Notes:** —

### T-911 — Wrapped evidence
- **Status:** qa_passed
- **Evidence:** QA verified the runtime path end to end;
  the integration landed as
  commit: ${SHORT_B} branch: main
- **Notes:** —
`;

  const candidates = findShippedUnbookedCandidates(markdown);
  assert.deepStrictEqual(
    candidates.map(c => c.id).sort(),
    ['T-910', 'T-911'],
    `Test 2 FAIL: both the evidence-before-status and the wrapped-evidence block must be found, got ${JSON.stringify(candidates)}`
  );
  const wrapped = candidates.find(c => c.id === 'T-911');
  assert.deepStrictEqual(wrapped.hashes, [SHORT_B], 'Test 2 FAIL: a hash on a continuation line of Evidence must still be extracted');

  console.log('Test 2 passed: Evidence-before-Status ordering and a wrapped multi-line Evidence field are both read correctly');
}

// ---------------------------------------------------------------------------
// Test 3/4 — reachability decision + BATCHING. Three qa_passed candidates
// carrying four hashes between them; two hashes are reachable, two are not.
// Exactly ONE `git rev-list` invocation may happen for the whole run.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-921 — Reachable
- **Status:** qa_passed
- **Evidence:** commit: ${SHORT_A} branch: main
- **Notes:** —

### T-922 — Unreachable
- **Status:** qa_passed
- **Evidence:** commit: ${UNREACHABLE_SHORT} branch: main
- **Notes:** —

### T-923 — Two hashes, one reachable
- **Status:** qa_passed
- **Evidence:** commit: ${UNREACHABLE_SHORT} (other-repo) commit: ${SHORT_B} (self)
- **Notes:** —
`;

  const originalExecSync = cp.execSync;
  const calls = [];
  cp.execSync = (cmd) => {
    calls.push(String(cmd));
    if (/is-shallow-repository/.test(cmd)) return 'false\n';
    if (/rev-list/.test(cmd)) return `${FULL_A}\n${FULL_B}\n${FULL_C}\n`;
    throw new Error(`unexpected git invocation: ${cmd}`);
  };
  let result;
  try {
    result = computeShippedUnbookedAdvisory(markdown, '/fixture/root');
  } finally {
    cp.execSync = originalExecSync;
  }

  assert.strictEqual(result.standDown, null, 'Test 3 FAIL: a non-shallow repo must not stand down');
  assert.deepStrictEqual(
    result.proposals,
    [{ id: 'T-921', hash: SHORT_A }, { id: 'T-923', hash: SHORT_B }],
    `Test 3 FAIL: only candidates with a hash reachable from HEAD may be proposed, got ${JSON.stringify(result.proposals)}`
  );

  const revListCalls = calls.filter(c => /rev-list/.test(c));
  assert.strictEqual(
    revListCalls.length,
    1,
    `Test 4 FAIL: reachability must use exactly ONE batched rev-list call for the whole run (never a subprocess per hash) — got ${revListCalls.length}: ${JSON.stringify(revListCalls)}`
  );
  assert.ok(
    revListCalls[0].includes('HEAD'),
    `Test 4 FAIL: the batched call must enumerate HEAD's history, got ${revListCalls[0]}`
  );

  console.log('Test 3 passed: only a candidate whose evidence hash is reachable from HEAD is proposed; an unreachable hash proposes nothing');
  console.log('Test 4 passed: reachability for 3 candidates / 4 hashes used exactly ONE batched git rev-list invocation');
}

// ---------------------------------------------------------------------------
// Test 5 — git unavailable: degrade SILENTLY. No proposal, no stand-down
// line, no throw. --close-session is the ritual every adopter project runs;
// an exception here would break their wave close.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-931 — Candidate
- **Status:** qa_passed
- **Evidence:** commit: ${SHORT_A} branch: main
- **Notes:** —
`;

  const originalExecSync = cp.execSync;
  cp.execSync = () => { throw new Error('git: command not found'); };
  let result;
  try {
    result = computeShippedUnbookedAdvisory(markdown, '/fixture/root');
  } finally {
    cp.execSync = originalExecSync;
  }

  assert.deepStrictEqual(result, { proposals: [], standDown: null }, `Test 5 FAIL: git unavailable must degrade silently, got ${JSON.stringify(result)}`);

  console.log('Test 5 passed: git unavailable degrades silently — no proposal, no stand-down line, no throw');
}

// ---------------------------------------------------------------------------
// Test 6 — shallow clone: STAND DOWN. No proposal; exactly one stand-down
// line, and that line must carry no ritual-command suggestion (a stand-down
// can never read as a proposal).
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-941 — Candidate
- **Status:** qa_passed
- **Evidence:** commit: ${SHORT_A} branch: main
- **Notes:** —
`;

  const originalExecSync = cp.execSync;
  cp.execSync = (cmd) => {
    if (/is-shallow-repository/.test(cmd)) return 'true\n';
    if (/rev-list/.test(cmd)) return `${FULL_A}\n`;
    throw new Error(`unexpected git invocation: ${cmd}`);
  };
  let result;
  try {
    result = computeShippedUnbookedAdvisory(markdown, '/fixture/root');
  } finally {
    cp.execSync = originalExecSync;
  }

  assert.deepStrictEqual(result.proposals, [], 'Test 6 FAIL: a shallow clone must propose nothing');
  assert.strictEqual(result.standDown, SHIPPED_UNBOOKED_STANDDOWN_LINE, 'Test 6 FAIL: a shallow clone must stand down with the hoisted stand-down line');
  assert.ok(
    !SHIPPED_UNBOOKED_STANDDOWN_LINE.includes('--set-status'),
    'Test 6 FAIL: the stand-down line must never carry the ritual-command suggestion'
  );

  console.log('Test 6 passed: a shallow clone stands down — no proposal, one stand-down line, no ritual-command suggestion in it');
}

// ---------------------------------------------------------------------------
// Test 7 — PROPOSE-ONLY at the unit level: a direct call to the advisory path
// writes nothing. Every state artifact is hashed before and after the call.
// ---------------------------------------------------------------------------
{
  const dir = path.join(TMP_ROOT, 'propose-only');
  fs.mkdirSync(dir, { recursive: true });

  const artifacts = {
    'BACKLOG.md': '# BACKLOG\n\n## Active Wave\n\n### T-951 — Candidate\n- **Status:** qa_passed\n',
    'TASK_STATUS.md': `# TASK_STATUS\n\n## Active tasks\n\n### T-951 — Candidate\n- **Status:** qa_passed\n- **Evidence:** commit: ${SHORT_A} branch: main\n`,
    'PROCESS_STATE.json': '{\n  "wave": 80\n}\n',
    'PROCESS_STATE.md': '# PROCESS STATE\n\nwave: 80\n',
  };
  for (const [name, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  const snapshot = () => Object.keys(artifacts).map(n => `${n}:${fs.readFileSync(path.join(dir, n), 'utf8')}`).join(' ');

  const before = snapshot();
  const originalExecSync = cp.execSync;
  cp.execSync = (cmd) => {
    if (/is-shallow-repository/.test(cmd)) return 'false\n';
    if (/rev-list/.test(cmd)) return `${FULL_A}\n`;
    throw new Error(`unexpected git invocation: ${cmd}`);
  };
  let result;
  try {
    result = computeShippedUnbookedAdvisory(fs.readFileSync(path.join(dir, 'TASK_STATUS.md'), 'utf8'), dir);
  } finally {
    cp.execSync = originalExecSync;
  }
  const after = snapshot();

  assert.deepStrictEqual(result.proposals, [{ id: 'T-951', hash: SHORT_A }], 'Test 7 FAIL: the fixture must actually fire, otherwise the propose-only assertion is vacuous');
  assert.strictEqual(before, after, 'Test 7 FAIL: the advisory path must leave BACKLOG.md / TASK_STATUS.md / PROCESS_STATE.json / PROCESS_STATE.md byte-identical — propose-only');
  assert.ok(
    formatShippedUnbookedProposal(result.proposals[0]).includes('--set-status T-951 merged'),
    'Test 7 FAIL: the proposal line must name the merge ritual command for that task'
  );

  console.log('Test 7 passed: a firing advisory writes NOTHING — all four state artifacts byte-identical across the call (propose-only)');
}

// ---------------------------------------------------------------------------
// End-to-end fixture: a real git repo with one reachable-commit qa_passed task
// (fires) and three non-firing shapes (unreachable hash, dev_done, no commit:).
// ---------------------------------------------------------------------------

/**
 * `git init -q -b main` — the branch name is pinned deliberately (see
 * scripts/test-fixture-git-init-branch-guard.js): an unpinned init inherits
 * the machine's init.defaultBranch, which differs between this machine and CI.
 */
function buildGitFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init -q -b main .');
  git('config user.email dev@example.com');
  git('config user.name Dev');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git('add seed.txt');
  git('commit -q -m seed');
  const head = git('rev-parse --short HEAD').trim();

  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-901 — Shipped but unbooked
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** fixture-repo
- **Verification type:** runtime

### T-902 — Not yet integrated
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** fixture-repo
- **Verification type:** runtime

### T-903 — Still in dev
- **Status:** dev_done
- **Owner role:** developer
- **Repo:** fixture-repo
- **Verification type:** runtime

### T-904 — No commit evidence
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** fixture-repo
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-901 — Shipped but unbooked
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** commit: ${head} branch: main needs_fix_rounds: 0
- **Notes:** —

### T-902 — Not yet integrated
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** commit: ${UNREACHABLE_SHORT} branch: main
- **Notes:** —

### T-903 — Still in dev
- **Status:** dev_done
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** commit: ${head} branch: main
- **Notes:** —

### T-904 — No commit evidence
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** artifact: docs/SOMETHING.md — no hash recorded
- **Notes:** —

## Recently completed tasks
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-637 fixture',
    stage: 'execution',
    wave: 80,
    wave_session: 1,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 904,
    last_updated: '2026-08-13',
    deploy_contours: 0,
    wave_summary: 'Wave 79: prior.',
    rechecks: [],
  }, null, 2) + '\n', 'utf8');

  return head;
}

function runCloseSession(dir) {
  const r = spawnSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// Test 8 — end-to-end: the firing case prints one proposal line; each
// non-firing shape prints none; the wave-stays-open announcement still prints
// alongside it; TASK_STATUS.md is byte-identical after the run.
// ---------------------------------------------------------------------------
const E2E_DIR = path.join(TMP_ROOT, 'e2e');
const E2E_HEAD = buildGitFixture(E2E_DIR);
{
  const tsPath = path.join(E2E_DIR, 'TASK_STATUS.md');
  const before = fs.readFileSync(tsPath, 'utf8');

  const { status, out } = runCloseSession(E2E_DIR);

  assert.strictEqual(status, 0, `Test 8 FAIL: expected exit 0 from a non-interactive close, got ${status}. Output:\n${out}`);
  assert.ok(
    out.includes(`--set-status T-901 merged`),
    `Test 8 FAIL: expected the T-901 proposal to name the merge ritual command. Output:\n${out}`
  );
  assert.ok(
    out.includes(`T-901 is qa_passed but its evidence commit ${E2E_HEAD} is already reachable from HEAD`),
    `Test 8 FAIL: expected the proposal line to name the task, its status and its reachable evidence hash. Output:\n${out}`
  );
  for (const nonFiring of ['T-902', 'T-903', 'T-904']) {
    assert.ok(
      !out.includes(`--set-status ${nonFiring} merged`),
      `Test 8 FAIL: ${nonFiring} must NOT be proposed (unreachable hash / dev_done / no commit: evidence). Output:\n${out}`
    );
  }
  assert.ok(
    out.includes('Wave 80 stays open — T-901 still qa_passed'),
    `Test 8 FAIL: the advisory must COMPLEMENT the existing wave-stays-open announcement, not replace or suppress it. Output:\n${out}`
  );

  const after = fs.readFileSync(tsPath, 'utf8');
  assert.strictEqual(before, after, 'Test 8 FAIL: TASK_STATUS.md must be byte-identical after the run — the advisory books nothing itself');
  const backlogAfter = fs.readFileSync(path.join(E2E_DIR, 'BACKLOG.md'), 'utf8');
  assert.ok(
    /### T-901 — Shipped but unbooked\n- \*\*Status:\*\* qa_passed/.test(backlogAfter),
    'Test 8 FAIL: BACKLOG.md must still read qa_passed for T-901 — the advisory proposes, it never applies'
  );

  console.log('Test 8 passed: end-to-end, the reachable-commit qa_passed task is proposed for the merge ritual, the three non-firing shapes are not, the wave-stays-open line still prints, and both artifacts still read qa_passed');
}

// ---------------------------------------------------------------------------
// Test 9 — end-to-end in a real SHALLOW clone of the fixture: the evidence
// hash IS in the fetched window (it is the tip), yet the check stands down
// rather than proposing a booking off a deliberately truncated history.
// ---------------------------------------------------------------------------
{
  const shallowDir = path.join(TMP_ROOT, 'shallow');
  const clone = spawnSync('git', ['clone', '--depth', '1', '-q', `file://${E2E_DIR}`, shallowDir], { encoding: 'utf8' });
  const isShallow = clone.status === 0 &&
    execSync('git rev-parse --is-shallow-repository', { cwd: shallowDir, encoding: 'utf8' }).trim() === 'true';

  assert.ok(isShallow, `Test 9 FAIL: fixture setup could not produce a shallow clone (status ${clone.status}): ${clone.stderr || ''}`);

  // The fixture's state artifacts are deliberately untracked (Test 8 asserts
  // byte-identity, which a commit would confuse), so the clone carries only
  // the git history — copy the same artifacts in so the ONLY difference
  // between this run and Test 8's is the clone's shallowness.
  for (const name of ['BACKLOG.md', 'TASK_STATUS.md', 'PROCESS_STATE.json']) {
    fs.copyFileSync(path.join(E2E_DIR, name), path.join(shallowDir, name));
  }

  const cloneHead = execSync('git rev-parse --short HEAD', { cwd: shallowDir, encoding: 'utf8' }).trim();
  assert.strictEqual(cloneHead, E2E_HEAD, 'Test 9 FAIL: the shallow clone must carry the same tip the evidence names, so the stand-down is the ONLY reason nothing is proposed');

  const { status, out } = runCloseSession(shallowDir);
  assert.strictEqual(status, 0, `Test 9 FAIL: expected exit 0 in a shallow clone, got ${status}. Output:\n${out}`);
  assert.ok(
    !out.includes('--set-status T-901 merged'),
    `Test 9 FAIL: a shallow clone must propose nothing. Output:\n${out}`
  );
  assert.ok(
    out.includes(SHIPPED_UNBOOKED_STANDDOWN_LINE),
    `Test 9 FAIL: a shallow clone must print the stand-down line (stood down, not silently skipped). Output:\n${out}`
  );

  console.log('Test 9 passed: in a real shallow clone the check stands down — the stand-down line prints and no booking is proposed, even though the evidence hash sits at the fetched tip');
}

// ---------------------------------------------------------------------------
fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

console.log('\nAll T-637 shipped-but-unbooked advisory assertions passed.');
