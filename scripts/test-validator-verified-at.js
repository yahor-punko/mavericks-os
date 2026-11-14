'use strict';
// T-882 — validator check evidence_not_on_final_commit, fed by the optional
// `verified_at: <hash>` evidence token (docs/core/TASK_LIFECYCLE.md "Evidence
// format"; adopter item wpadopter-015).
//
// Containment, not equality: integration is by cherry-pick (a worktree hash
// never equals the on-branch hash) and in a parallel wave QA runs at a later
// HEAD than the task's own commit. So a record is clean when its commit C
// equals the verified hash V or is an ancestor of V, or when the trees at V and
// C differ only in the live-state files (a state-only booking commit).
//
// Every fixture is a real git repository whose init pins the initial branch;
// the artifacts are judged both by the exported function and by a full-stack
// `node scripts/mavp-validator.js <root> --json` run, so the exit code and the
// finding count come from the shipped pipeline, not only from the unit.
//
// Cases (expected values come from the contract, not from observed output):
//   1. commit == V                                  -> no finding, exit 0
//   2. commit is an ancestor of V                   -> no finding, exit 0
//   3. content commit made after V                  -> exactly one warning, exit 1
//   4. commit after V changing only TASK_STATUS.md  -> no finding
//   5. no verified_at token                         -> no finding
//   6. V well-formed but absent from the repository -> one info finding, exit 0
//   7. case-3 shape at status dev_done              -> no finding
//   8. case-3 shape under Recently completed tasks  -> no finding
//   9. case-3 shape in a depth-1 clone              -> no finding
//  10. commit annotated with a known other repo id  -> skipped
//  11. token grammar (extractVerifiedAtHashes)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const { checkEvidenceNotOnFinalCommit, extractVerifiedAtHashes } = require('./mavp-validator.js');

const VALIDATOR_SCRIPT = path.join(__dirname, 'mavp-validator.js');
const CHECK = 'evidence_not_on_final_commit';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't882-verified-at-'));

// Keep the fixtures independent of the host's global git configuration
// (signing, hooks, default branch): the home-level config is replaced by an
// empty file for every git call and for the validator subprocess.
const EMPTY_CONFIG = path.join(TMP_DIR, 'empty-gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '', 'utf8');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

let fixtureCounter = 0;

// Base commit: README, placeholder BACKLOG.md / TASK_STATUS.md and the repo
// map are all committed up front, so a later commit that touches only
// TASK_STATUS.md is a genuine state-only commit.
function makeRepo(name) {
  fixtureCounter += 1;
  const root = path.join(TMP_DIR, `${String(fixtureCounter).padStart(2, '0')}-${name}`);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Test Fixture']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n', 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n', 'utf8');
  writeRepoMap(root);
  commitAll(root, 'base');
  return root;
}

function writeRepoMap(root) {
  fs.writeFileSync(
    path.join(root, 'docs', 'REPO_MAP.md'),
    `# Repo Map\n\n## this-repo\n\n- **label:** This Repo\n- **path:** ${root}\n\n## other-repo\n\n- **label:** Other Repo\n- **path:** ${path.join(TMP_DIR, 'elsewhere')}\n`,
    'utf8'
  );
}

function contentCommit(root, file, text) {
  fs.writeFileSync(path.join(root, file), text, 'utf8');
  return commitAll(root, `content ${file}`);
}

function stateOnlyCommit(root) {
  fs.appendFileSync(path.join(root, 'TASK_STATUS.md'), '\n<!-- state-only booking edit -->\n');
  const hash = commitAll(root, 'state-only booking');
  const names = git(root, ['show', '--name-only', '--pretty=format:', hash]).split('\n').filter(Boolean);
  assert.deepStrictEqual(names, ['TASK_STATUS.md'], 'FIXTURE: the state-only commit must change only TASK_STATUS.md');
  return hash;
}

const TERMINAL = new Set(['merged', 'deployed_dev', 'deployed_prod']);

function taskBlock(status, evidence) {
  return `### T-901 — Fixture verified-at task\n\n- **Status:** ${status}\n- **Repo:** this-repo\n- **Verification type:** runtime\n- **Evidence:** ${evidence}\n`;
}

// Writes BACKLOG.md and TASK_STATUS.md (uncommitted; the validator reads the
// working tree) and returns the TASK_STATUS record shape the unit call takes.
function writeArtifacts(root, { status = 'merged', section = 'Active tasks', evidence }) {
  const backlogBlock = `### T-901 — Fixture verified-at task\n- **Status:** ${status}\n- **Repo:** this-repo\n- **Verification type:** runtime\n`;
  const archived = TERMINAL.has(status);
  const backlog = archived
    ? `# BACKLOG\n\n## Active Wave\n\n## Wave 1 — Archived\n\n${backlogBlock}`
    : `# BACKLOG\n\n## Active Wave\n\n${backlogBlock}`;
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');

  const block = taskBlock(status, evidence);
  const taskStatus =
    section === 'Active tasks'
      ? `# TASK_STATUS\n\n## Active tasks\n\n${block}\n## Recently completed tasks\n\n`
      : `# TASK_STATUS\n\n## Active tasks\n\n## Recently completed tasks\n\n${block}`;
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');
  return { taskId: 'T-901', status, repo: 'this-repo', rawBlock: block };
}

function runFullStack(root) {
  const result = spawnSync(process.execPath, [VALIDATOR_SCRIPT, root, '--json'], { cwd: root, encoding: 'utf8', env: GIT_ENV });
  let findings = null;
  try {
    findings = JSON.parse(result.stdout).comparison.findings.filter((f) => f.checkName === CHECK);
  } catch (error) {
    assert.fail(`validator output was not parseable JSON (exit ${result.status}): ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, findings };
}

// Judge one scenario through both the exported function and the full-stack run.
function judge(root, { status = 'merged', section = 'Active tasks', evidence }) {
  const record = writeArtifacts(root, { status, section, evidence });
  const activeRecords = section === 'Active tasks' ? [record] : [];
  const unit = checkEvidenceNotOnFinalCommit({ activeRecords, root, repoMap: undefined });
  const full = runFullStack(root);
  return { unit, full };
}

const evidenceOf = (commit, verified) => `commit: ${commit} verified_at: ${verified}`;

// ---------------------------------------------------------------------------
// Case 1: the task's commit equals V -> no finding.
// ---------------------------------------------------------------------------
{
  const root = makeRepo('equal');
  const c = contentCommit(root, 'src.txt', 'one\n');
  const { unit, full } = judge(root, { evidence: evidenceOf(c, c) });
  assert.deepStrictEqual(unit, [], `Case 1 FAIL: expected no finding when commit == V, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 1 FAIL: full-stack run reported a finding');
  assert.strictEqual(full.code, 0, `Case 1 FAIL: expected exit 0, got ${full.code}`);
  console.log('Case 1 passed: commit equal to V yields no finding (exit 0)');
}

// ---------------------------------------------------------------------------
// Case 2: the task's commit is an ancestor of V (an unrelated content commit
// made after it, V taken there) -> no finding.
// ---------------------------------------------------------------------------
{
  const root = makeRepo('ancestor');
  const c = contentCommit(root, 'src.txt', 'one\n');
  const v = contentCommit(root, 'other.txt', 'unrelated\n');
  const { unit, full } = judge(root, { evidence: evidenceOf(c, v) });
  assert.deepStrictEqual(unit, [], `Case 2 FAIL: expected no finding when commit is an ancestor of V, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 2 FAIL: full-stack run reported a finding');
  assert.strictEqual(full.code, 0, `Case 2 FAIL: expected exit 0, got ${full.code}`);
  console.log('Case 2 passed: commit that is an ancestor of V yields no finding (exit 0)');
}

// ---------------------------------------------------------------------------
// Case 3: a content commit made after V -> exactly one warning, exit 1.
// ---------------------------------------------------------------------------
function buildContentAfterV(name) {
  const root = makeRepo(name);
  const v = contentCommit(root, 'src.txt', 'verified\n');
  const c = contentCommit(root, 'src.txt', 'changed after the final pass\n');
  return { root, v, c };
}
{
  const { root, v, c } = buildContentAfterV('content-after-v');
  const { unit, full } = judge(root, { evidence: evidenceOf(c, v) });
  assert.strictEqual(unit.length, 1, `Case 3 FAIL: expected exactly one finding from the unit call, got ${JSON.stringify(unit)}`);
  assert.strictEqual(unit[0].checkName, CHECK);
  assert.strictEqual(unit[0].severity, 'warning', 'Case 3 FAIL: expected warning severity');
  assert.strictEqual(unit[0].taskId, 'T-901', 'Case 3 FAIL: finding must name the task');
  assert.ok(unit[0].message.includes(c), `Case 3 FAIL: message must name the commit ${c}: ${unit[0].message}`);
  assert.ok(unit[0].message.includes(v), `Case 3 FAIL: message must name V ${v}: ${unit[0].message}`);
  assert.ok(/final verification pass/i.test(unit[0].suggestedAction), 'Case 3 FAIL: suggestedAction must name repeating the final verification pass');
  assert.ok(/update the verified_at token/i.test(unit[0].suggestedAction), 'Case 3 FAIL: suggestedAction must say to update the token');
  assert.ok(/correct the commit entry/i.test(unit[0].suggestedAction), 'Case 3 FAIL: suggestedAction must offer correcting the commit entry');
  assert.strictEqual(full.findings.length, 1, `Case 3 FAIL: expected exactly one ${CHECK} in the full-stack run, got ${JSON.stringify(full.findings)}`);
  assert.strictEqual(full.code, 1, `Case 3 FAIL: expected validator exit code 1 (drifting), got ${full.code}`);
  console.log('Case 3 passed: content commit after V yields exactly one warning and validator exit 1');
}

// ---------------------------------------------------------------------------
// Case 4: a commit made after V that changes only TASK_STATUS.md -> no finding.
// ---------------------------------------------------------------------------
{
  const root = makeRepo('state-only');
  const v = contentCommit(root, 'src.txt', 'verified\n');
  const c = stateOnlyCommit(root);
  const { unit, full } = judge(root, { evidence: evidenceOf(c, v) });
  assert.deepStrictEqual(unit, [], `Case 4 FAIL: a state-only commit after V must not be flagged, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 4 FAIL: full-stack run reported a finding');
  assert.strictEqual(full.code, 0, `Case 4 FAIL: expected exit 0, got ${full.code}`);
  console.log('Case 4 passed: a commit after V changing only TASK_STATUS.md yields no finding');
}

// ---------------------------------------------------------------------------
// Case 5: no verified_at token -> never a finding.
// ---------------------------------------------------------------------------
{
  const { root, c } = buildContentAfterV('no-token');
  const { unit, full } = judge(root, { evidence: `commit: ${c}` });
  assert.deepStrictEqual(unit, [], `Case 5 FAIL: absence of the token must never be a finding, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 5 FAIL: full-stack run reported a finding');
  assert.strictEqual(full.code, 0, `Case 5 FAIL: expected exit 0, got ${full.code}`);
  console.log('Case 5 passed: no verified_at token yields no finding');
}

// ---------------------------------------------------------------------------
// Case 6: V is a well-formed hash absent from the repository -> one info
// finding, exit code unchanged (0).
// ---------------------------------------------------------------------------
{
  const root = makeRepo('absent-v');
  const c = contentCommit(root, 'src.txt', 'one\n');
  const absent = 'ba5eba11' + 'deadc0de'.repeat(4);
  const { unit, full } = judge(root, { evidence: evidenceOf(c, absent) });
  assert.strictEqual(unit.length, 1, `Case 6 FAIL: expected exactly one finding, got ${JSON.stringify(unit)}`);
  assert.strictEqual(unit[0].severity, 'info', 'Case 6 FAIL: an unresolvable V must be info severity');
  assert.ok(unit[0].message.includes(absent), 'Case 6 FAIL: message must name the unresolvable hash');
  assert.strictEqual(full.findings.length, 1, `Case 6 FAIL: expected one ${CHECK} in the full-stack run, got ${JSON.stringify(full.findings)}`);
  assert.strictEqual(full.findings[0].severity, 'info', 'Case 6 FAIL: full-stack severity must be info');
  assert.strictEqual(full.code, 0, `Case 6 FAIL: an info finding must leave the exit code at 0, got ${full.code}`);
  console.log('Case 6 passed: a well-formed V absent from the repository yields one info finding and exit 0');
}

// ---------------------------------------------------------------------------
// Case 7: the case-3 shape at status dev_done -> no finding (not qa_passed or
// terminal, so not judged).
// ---------------------------------------------------------------------------
{
  const { root, v, c } = buildContentAfterV('dev-done');
  const { unit, full } = judge(root, { status: 'dev_done', evidence: evidenceOf(c, v) });
  assert.deepStrictEqual(unit, [], `Case 7 FAIL: dev_done must not be judged, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 7 FAIL: full-stack run reported a finding at dev_done');
  console.log('Case 7 passed: the content-commit-after-V shape at dev_done yields no finding');
}

// ---------------------------------------------------------------------------
// Case 8: the case-3 shape under Recently completed tasks -> no finding (the
// check is fed Active tasks records only).
// ---------------------------------------------------------------------------
{
  const { root, v, c } = buildContentAfterV('recently-completed');
  const { unit, full } = judge(root, { section: 'Recently completed tasks', evidence: evidenceOf(c, v) });
  assert.deepStrictEqual(unit, [], `Case 8 FAIL: Recently completed records are never fed in, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 8 FAIL: full-stack run reported a finding for a Recently completed record');
  console.log('Case 8 passed: the case-3 shape under Recently completed tasks yields no finding');
}

// ---------------------------------------------------------------------------
// Case 9: the case-3 shape in a depth-1 clone -> no finding (stand-down). The
// file:// protocol is load-bearing: a plain local-path clone silently ignores
// --depth, so the shallow state is asserted rather than assumed.
// ---------------------------------------------------------------------------
{
  const { root: srcRoot, v, c } = buildContentAfterV('shallow-src');
  const shallowRoot = path.join(TMP_DIR, 'shallow-clone');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${srcRoot}`, shallowRoot], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.strictEqual(git(shallowRoot, ['rev-parse', '--is-shallow-repository']), 'true', 'FIXTURE TRAP: the clone must be genuinely shallow');
  writeRepoMap(shallowRoot);
  const { unit, full } = judge(shallowRoot, { evidence: evidenceOf(c, v) });
  assert.deepStrictEqual(unit, [], `Case 9 FAIL: a shallow clone must yield no finding, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 9 FAIL: full-stack run in the shallow clone reported a finding');
  console.log('Case 9 passed: the content-commit-after-V shape in a depth-1 clone yields no finding');
}

// ---------------------------------------------------------------------------
// Case 10: a commit entry annotated with a known other repo-map id is skipped.
// ---------------------------------------------------------------------------
{
  const { root, v, c } = buildContentAfterV('other-repo');
  const { unit, full } = judge(root, { evidence: `commit: ${c} (other-repo) verified_at: ${v}` });
  assert.deepStrictEqual(unit, [], `Case 10 FAIL: an entry annotated with a known other repo must be skipped, got ${JSON.stringify(unit)}`);
  assert.deepStrictEqual(full.findings, [], 'Case 10 FAIL: full-stack run reported a finding for a known-other-repo annotation');
  console.log('Case 10 passed: a commit annotated with a known other repo-map id is skipped');
}

// ---------------------------------------------------------------------------
// Case 11: token grammar.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(extractVerifiedAtHashes('commit: abc1234 verified_at: DEF5678'), ['def5678'], 'Case 11a FAIL: key and hex are case-insensitive, hash is lowercased');
  assert.deepStrictEqual(extractVerifiedAtHashes('line one\nnote: later\nVerified_At:   abcdef1234'), ['abcdef1234'], 'Case 11b FAIL: whole field, any position, any case of the key');
  assert.deepStrictEqual(extractVerifiedAtHashes('stale_verified: true stale_verified: abc1234'), [], 'Case 11c FAIL: stale_verified must never match');
  assert.deepStrictEqual(extractVerifiedAtHashes('verified_at: abc123'), [], 'Case 11d FAIL: a hash under 7 characters is not a token');
  assert.deepStrictEqual(extractVerifiedAtHashes(`verified_at: ${'a'.repeat(41)}`), [], 'Case 11e FAIL: a hash over 40 characters is not a token');
  assert.deepStrictEqual(extractVerifiedAtHashes(`verified_at: ${'a'.repeat(40)}`), ['a'.repeat(40)], 'Case 11f FAIL: a 40-character hash is a token');
  assert.deepStrictEqual(extractVerifiedAtHashes('verified_at: abc1234 verified_at: 1234567'), ['abc1234', '1234567'], 'Case 11g FAIL: every token is read');
  assert.deepStrictEqual(extractVerifiedAtHashes(null), [], 'Case 11h FAIL: null evidence');
  console.log('Case 11 passed: extractVerifiedAtHashes() grammar');
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('test-validator-verified-at: all cases passed');
