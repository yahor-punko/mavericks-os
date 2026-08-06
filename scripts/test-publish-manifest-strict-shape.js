'use strict';
// Regression test: T-550 — shared strict manifest-shape loader for
// check-publish-manifest.js and mavp-publish-assemble.js.
//
// Both consumers used to accept ANY manifest that parsed as JSON, silently
// defaulting a malformed/absent `ship`/`reset` (and, for the checker,
// `exclude`/`preserve`) bucket to []/{} instead of refusing — the exact
// vacuous-GREEN class T-534 round 2 closed for the provenance verifier via
// validateManifestShape(), just reached from two different entry points
// that never called it. This test proves BOTH consumers now refuse through
// their own CLI (not merely that the shared function itself refuses — that
// is already exhaustively fuzzed by scripts/test-publish-verify-provenance.js's
// own Test 13/14/15) with a named defect on stderr and a non-zero exit,
// never a silent default and never an unhandled exception.
//
// Fixtures are minimal, git-free where possible: the shape refusal fires
// BEFORE either consumer ever calls `git` (the checker's tracked-file scan,
// the assembler's HEAD-tree extraction), so a malformed-manifest fixture
// needs only a scripts/ directory containing the script under test, its
// mavp-publish-verify-provenance.js dependency, and the manifest itself —
// no `git init` required. The one exception is the TOLERATED-shape control
// near the bottom, which exercises the real happy path end-to-end and
// therefore needs a real (tiny) git repo.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REAL_ROOT = path.resolve(__dirname, '..');
const CHECK_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'check-publish-manifest.js');
const ASSEMBLE_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-publish-assemble.js');
const VERIFY_PROVENANCE_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-publish-verify-provenance.js');

const tempDirs = [];
function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanupTempDirs);

// Builds a scratch scripts/ directory carrying only what's needed to run
// the requested consumer(s) — always the verify-provenance dependency,
// plus the consumer script(s) under test.
function makeScriptsFixture(prefix, { forChecker = false, forAssembler = false } = {}) {
  const root = mkTempDir(prefix);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(VERIFY_PROVENANCE_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-publish-verify-provenance.js'));
  if (forChecker) fs.copyFileSync(CHECK_SCRIPT_SRC, path.join(root, 'scripts', 'check-publish-manifest.js'));
  if (forAssembler) fs.copyFileSync(ASSEMBLE_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-publish-assemble.js'));
  return root;
}

function writeManifest(root, manifestValue) {
  const raw = JSON.stringify(manifestValue, null, 2);
  fs.writeFileSync(path.join(root, 'scripts', 'publish-manifest.json'), raw, 'utf8');
}

function runChecker(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-publish-manifest.js')], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runAssembler(root, outDir) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'mavp-publish-assemble.js'), outDir], {
    cwd: root,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Malformed-shape case table — one refusal per distinct violation, run
// through BOTH consumers' own CLI. Includes both T-550 amendments (the
// bare-"." segment rejection, and the reset-starter-must-live-under-
// templates/ rule) alongside a representative slice of the base contract.
// ---------------------------------------------------------------------------
const MALFORMED_CASES = [
  { label: 'ship missing', manifest: { reset: {} }, expectSubstr: 'ship' },
  { label: 'ship empty array', manifest: { ship: [], reset: {} }, expectSubstr: 'empty array' },
  { label: 'ship entry traversal', manifest: { ship: ['a/../../etc/passwd'], reset: {} }, expectSubstr: 'not a valid relative path' },
  // T-550 amendment (a) — bare "." segment, distinct from ".." traversal.
  { label: 'ship entry bare-dot segment', manifest: { ship: ['a/./b.txt'], reset: {} }, expectSubstr: 'not a valid relative path' },
  { label: 'reset missing', manifest: { ship: ['a.txt'] }, expectSubstr: '`reset` is missing' },
  { label: 'reset not a plain object (array)', manifest: { ship: ['a.txt'], reset: [] }, expectSubstr: 'not a plain (non-array) object' },
  // T-550 amendment (b) — reset starter must live under templates/.
  {
    label: 'reset starter not under templates/',
    manifest: { ship: ['a.txt'], reset: { 'dest.md': 'starters/dest.md' } },
    expectSubstr: 'not under templates/',
  },
];

for (const { label, manifest, expectSubstr } of MALFORMED_CASES) {
  // --- checker ---
  {
    const root = makeScriptsFixture('mavp-t550-checker-', { forChecker: true });
    writeManifest(root, manifest);
    const result = runChecker(root);
    assert.notStrictEqual(
      result.status,
      0,
      `checker (${label}) FAIL: expected non-zero exit, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes(expectSubstr),
      `checker (${label}) FAIL: expected stderr to include "${expectSubstr}", got:\n${result.stderr}`
    );
  }
  // --- assembler ---
  {
    const root = makeScriptsFixture('mavp-t550-assemble-', { forAssembler: true });
    writeManifest(root, manifest);
    const outParent = mkTempDir('mavp-t550-assemble-out-parent-');
    const outDir = path.join(outParent, 'out');
    const result = runAssembler(root, outDir);
    assert.notStrictEqual(
      result.status,
      0,
      `assembler (${label}) FAIL: expected non-zero exit, got ${result.status}\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes(expectSubstr),
      `assembler (${label}) FAIL: expected stderr to include "${expectSubstr}", got:\n${result.stderr}`
    );
    assert.ok(
      !fs.existsSync(outDir),
      `assembler (${label}) FAIL: expected no output directory on a shape refusal (refusal must happen before any assembly), found one at ${outDir}`
    );
  }
}
console.log(
  `Passed: ${MALFORMED_CASES.length} malformed-shape cases each refuse through BOTH consumers' own CLI, naming the defect (not defaulting, not throwing an unhandled exception).`
);

// ---------------------------------------------------------------------------
// Checker-only: `exclude`/`preserve` shape refusal — buckets the assembler
// never reads, so these are exercised against the checker alone.
// ---------------------------------------------------------------------------
const CHECKER_ONLY_CASES = [
  { label: 'exclude not a plain object (array)', manifest: { ship: ['a.txt'], reset: {}, exclude: [] }, expectSubstr: '`exclude` is present but not a plain' },
  { label: 'exclude not a plain object (string)', manifest: { ship: ['a.txt'], reset: {}, exclude: 'nope' }, expectSubstr: '`exclude` is present but not a plain' },
  { label: 'preserve not a plain object (array)', manifest: { ship: ['a.txt'], reset: {}, preserve: [] }, expectSubstr: '`preserve` is present but not a plain' },
];
for (const { label, manifest, expectSubstr } of CHECKER_ONLY_CASES) {
  const root = makeScriptsFixture('mavp-t550-checker-only-', { forChecker: true });
  writeManifest(root, manifest);
  const result = runChecker(root);
  assert.notStrictEqual(
    result.status,
    0,
    `checker (${label}) FAIL: expected non-zero exit, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    result.stderr.includes(expectSubstr),
    `checker (${label}) FAIL: expected stderr to include "${expectSubstr}", got:\n${result.stderr}`
  );
}
console.log(`Passed: ${CHECKER_ONLY_CASES.length} checker-only exclude/preserve shape refusal cases.`);

// ---------------------------------------------------------------------------
// TOLERATED-shape control (the false-refusal boundary, from the CONSUMER's
// own CLI, not just the shared function in isolation): an explicitly empty
// `reset: {}`, an unknown top-level key, and a reset starter genuinely
// under templates/ must all pass end-to-end through BOTH consumers. Needs
// a real (tiny) git repo since this exercises the actual happy path.
// ---------------------------------------------------------------------------
{
  const root = makeScriptsFixture('mavp-t550-tolerated-', { forChecker: true, forAssembler: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: root });

  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n', 'utf8');
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'templates', 'STARTER.md'), 'starter content\n', 'utf8');

  writeManifest(root, {
    ship: [
      'a.txt',
      'templates/STARTER.md',
      'scripts/publish-manifest.json',
      'scripts/check-publish-manifest.js',
      'scripts/mavp-publish-assemble.js',
      'scripts/mavp-publish-verify-provenance.js',
    ],
    reset: { 'LIVE.md': 'templates/STARTER.md' },
    exclude: {},
    preserve: {},
    reset_reasons: { 'LIVE.md': 'unknown top-level key — must be tolerated, not refused' },
  });

  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });

  const checkerResult = runChecker(root);
  assert.strictEqual(
    checkerResult.status,
    0,
    `TOLERATED control FAIL: checker expected exit 0 on a deliberately-tolerated shape, got ${checkerResult.status}\n${checkerResult.stdout}\n${checkerResult.stderr}`
  );

  const outParent = mkTempDir('mavp-t550-tolerated-out-parent-');
  const outDir = path.join(outParent, 'out');
  const assemblerResult = runAssembler(root, outDir);
  assert.strictEqual(
    assemblerResult.status,
    0,
    `TOLERATED control FAIL: assembler expected exit 0 on a deliberately-tolerated shape, got ${assemblerResult.status}\n${assemblerResult.stdout}\n${assemblerResult.stderr}`
  );
  assert.ok(fs.existsSync(path.join(outDir, 'a.txt')), 'TOLERATED control FAIL: expected a.txt in assembled output');
  assert.strictEqual(
    fs.readFileSync(path.join(outDir, 'LIVE.md'), 'utf8'),
    'starter content\n',
    'TOLERATED control FAIL: expected the reset destination to be populated from its templates/ starter'
  );

  console.log(
    'Passed: the false-refusal boundary (explicit empty-equivalent bucket, unknown top-level key, a genuinely templates/-rooted starter) is preserved end-to-end through BOTH consumers\' own CLI.'
  );
}

// ---------------------------------------------------------------------------
// PINNED CONTROL — this repo's own real, committed scripts/publish-manifest.json
// still passes both consumers unchanged (behaviour-neutral for the real
// manifest, run against the REAL scripts/ directory, not a fixture copy).
//
// T-570: this control's original unconditional exit-0 assertion only holds
// in the canonical (private) repo — a mirror/adopter tracked set never
// contains the manifest's exclude-keyed paths, so the unflagged claim
// always failed there for reasons that are not bugs (same class as
// scripts/test-publish-overlay.js Tests 4/35/39, whose loud-skip shape
// this follows rather than inventing a new one). Gate BOTH consumer
// halves — checker AND assembler — on the exported `isCanonicalRepo()`
// (no new heuristic); leaving the assembler half ungated would keep the
// same silent-degradation class latent for an adopter who later deletes a
// shipped file.
//
// `isCanonicalRepo()` only answers a binary "are ALL exclude keys
// tracked?", which shares a blind spot with `--if-canonical`: a MIXED
// repo (SOME but not all exclude keys tracked) would read as
// non-canonical and silently skip — exactly the state that most needs to
// fail loudly, since it means this IS the canonical repo with a stale
// manifest. Count the tracked-exclude ratio directly so the three states
// (all / none / mixed) are distinguished rather than collapsed to two.
// ---------------------------------------------------------------------------
{
  const { isCanonicalRepo } = require(CHECK_SCRIPT_SRC);
  const manifest = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'scripts', 'publish-manifest.json'), 'utf8'));
  const trackedOutput = execFileSync('git', ['ls-files'], { cwd: REAL_ROOT, encoding: 'utf8' });
  const trackedList = trackedOutput.split('\n').filter(Boolean);
  const trackedSet = new Set(trackedList);

  const excludeKeys = manifest.exclude && typeof manifest.exclude === 'object' ? Object.keys(manifest.exclude) : [];
  const trackedExcludeCount = excludeKeys.filter((k) => trackedSet.has(k)).length;
  const totalExcludeCount = excludeKeys.length;
  const ratio = `${trackedExcludeCount}/${totalExcludeCount}`;
  const isCanonical = isCanonicalRepo(manifest, trackedList); // true iff ALL exclude keys tracked
  const isMixed = trackedExcludeCount > 0 && trackedExcludeCount < totalExcludeCount;

  if (isMixed) {
    assert.fail(
      `PINNED CONTROL FAIL: ${ratio} exclude keys are git-tracked — a MIXED state means this IS the canonical repo with stale manifest entries (canonical-with-stale-manifest), not a legitimate mirror/adopter checkout (which tracks 0 by construction, since exclude paths never ship). Fix the manifest before this control can run.`
    );
  } else if (!isCanonical) {
    console.log(
      `[SKIP] PINNED CONTROL SKIPPED: ${ratio} exclude keys are git-tracked — this repo's own real manifest exit-0 claim only holds in the canonical (private) repo (test-publish-overlay.js Tests 4/35/39 gate the identical claim the same way).`
    );
  } else {
    const checkerResult = spawnSync(process.execPath, [CHECK_SCRIPT_SRC], { cwd: REAL_ROOT, encoding: 'utf8' });
    assert.strictEqual(
      checkerResult.status,
      0,
      `PINNED CONTROL FAIL: check-publish-manifest.js exited ${checkerResult.status} on this repo's own real manifest:\n${checkerResult.stdout}\n${checkerResult.stderr}`
    );

    const outParent = mkTempDir('mavp-t550-real-assemble-out-parent-');
    const outDir = path.join(outParent, 'out');
    const assemblerResult = spawnSync(process.execPath, [ASSEMBLE_SCRIPT_SRC, outDir], { cwd: REAL_ROOT, encoding: 'utf8' });
    assert.strictEqual(
      assemblerResult.status,
      0,
      `PINNED CONTROL FAIL: mavp-publish-assemble.js exited ${assemblerResult.status} on this repo's own real manifest:\n${assemblerResult.stdout}\n${assemblerResult.stderr}`
    );

    console.log("Passed (pinned control): this repo's own real committed scripts/publish-manifest.json passes both consumers unchanged.");
  }
}

console.log('\nAll T-550 shared strict manifest-shape loader assertions passed.');
