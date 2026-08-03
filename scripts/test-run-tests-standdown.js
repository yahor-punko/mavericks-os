'use strict';
// Unit test: T-588 — run-tests.js must surface [SKIP]-tokened lines from
// PASSING tests (indented under the PASS line) plus a Stand-downs: summary
// in the final block, so a documented gate stand-down is visible in the
// aggregated (mirror) CI log instead of silently absent. All other passing-
// test output must stay suppressed, and FAIL-branch behavior is unchanged.
//
// This test copies the real run-tests.js plus a set of synthetic test
// fixtures into a scratch dir and runs the copy against ONLY those
// fixtures (run-tests.js discovers test-*.js files relative to its own
// __dirname, so isolating it into a scratch dir with a hand-picked fixture
// set keeps this test independent of the other ~76 real scripts/test-*.js
// files and their pass/fail state).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = __dirname;
const RUN_TESTS_SRC = path.join(REPO_ROOT, 'run-tests.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-run-tests-standdown-${process.pid}-${Date.now()}`
);

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanup);

const SKIP_LINE = '[SKIP] synthetic stand-down: not the canonical repo, gated check declined to run';

const FIXTURE_SKIP_PASS = `'use strict';
console.log('doing setup work');
console.log('${SKIP_LINE}');
console.log('done');
process.exit(0);
`;

const MARKERLESS_NOISE_LINE = 'this is ordinary chatty output that must never leak into the aggregate';

const FIXTURE_QUIET_PASS = `'use strict';
console.log('${MARKERLESS_NOISE_LINE}');
console.log('more chatter');
process.exit(0);
`;

const FIXTURE_FAIL = `'use strict';
console.log('failure diagnostic line one');
console.error('failure diagnostic line two (stderr)');
process.exit(1);
`;

// T-596 — a passing test whose stdout mentions the marker token MID-LINE, in
// prose, never starting a line with it. This is the exact shape T-588 itself
// tripped on: the old substring matcher (\`line.includes(SKIP_TOKEN)\`)
// matched this line and produced a false "Stand-downs: 1". The fixed
// line-initial matcher must NOT surface this line or count it. The literal
// token below is an intentional child-fixture string, not a description —
// it must actually contain the token to exercise the substring-vs-anchor
// distinction; only the PASS-line description strings (this comment, and
// the console.log at the end of the test block) describe the shape in words.
const MID_LINE_MENTION = 'this test never begins a line with the [SKIP] marker, only mentions it here';

const FIXTURE_MID_LINE_MENTION_PASS = `'use strict';
console.log('${MID_LINE_MENTION}');
process.exit(0);
`;

// T-596 — a passing test that emits the skip token as a genuine stand-down
// but INDENTED with leading whitespace, mirroring the real
// test-validator-cross-section-status.js emitter shape (two leading spaces).
// This must still be surfaced and counted — trimStart() before startsWith()
// is what protects this live emitter from a future strict-prefix tightening.
const INDENTED_SKIP_LINE = '  [SKIP] indented stand-down: mirrors the real cross-section-status emitter shape';

const FIXTURE_INDENTED_SKIP_PASS = `'use strict';
console.log('${INDENTED_SKIP_LINE}');
process.exit(0);
`;

// Builds a fresh scratch dir containing a copy of run-tests.js plus the
// synthetic fixtures above (or a subset selected via \`only\`), and returns
// the { dir } to run it from. \`runTestsSrc\` lets a mutant/reverted copy of
// run-tests.js be substituted for the manual red/green verification the
// developer runs outside this shipped test.
function buildScratch(name, { only = ['skip', 'quiet', 'fail'], runTestsSrc = RUN_TESTS_SRC } = {}) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(runTestsSrc, path.join(dir, 'run-tests.js'));
  if (only.includes('skip')) {
    fs.writeFileSync(path.join(dir, 'test-fixture-skip-pass.js'), FIXTURE_SKIP_PASS, 'utf8');
  }
  if (only.includes('quiet')) {
    fs.writeFileSync(path.join(dir, 'test-fixture-quiet-pass.js'), FIXTURE_QUIET_PASS, 'utf8');
  }
  if (only.includes('fail')) {
    fs.writeFileSync(path.join(dir, 'test-fixture-fail.js'), FIXTURE_FAIL, 'utf8');
  }
  if (only.includes('midline')) {
    fs.writeFileSync(path.join(dir, 'test-fixture-midline-pass.js'), FIXTURE_MID_LINE_MENTION_PASS, 'utf8');
  }
  if (only.includes('indented')) {
    fs.writeFileSync(path.join(dir, 'test-fixture-indented-skip-pass.js'), FIXTURE_INDENTED_SKIP_PASS, 'utf8');
  }
  return dir;
}

function runAggregate(dir) {
  try {
    const stdout = execFileSync(process.execPath, ['run-tests.js'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    // execFileSync throws when the child exits non-zero (expected here, since
    // one fixture is a failing test) — the aggregated stdout is still on the
    // error object.
    return { stdout: err.stdout || '', status: err.status };
  }
}

// --- Test 1: the [SKIP] line from a PASSING test IS surfaced in the
// aggregated log, indented under its PASS line, and rolled into the
// Stand-downs: summary with the file name and a count of 1. This is the
// mutant killed: the pre-T-588 runner only ever printed child stdout inside
// the FAIL branch, so a passing test's [SKIP] line never reached the
// aggregated log at all — `grep -c SKIP` on that log returned 0.
{
  const dir = buildScratch('t1-skip-surfaced', { only: ['skip'] });
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 0, `expected the lone-passing-test run to exit 0, got ${status}\n${stdout}`);
  assert.ok(
    stdout.includes(SKIP_LINE),
    `expected the aggregated output to contain the [SKIP] line from the passing test; got:\n${stdout}`
  );
  assert.ok(
    stdout.includes('PASS  test-fixture-skip-pass.js'),
    `expected a PASS line for the synthetic skip-emitting test; got:\n${stdout}`
  );
  assert.ok(
    /Stand-downs: 1 \(test-fixture-skip-pass\.js\)/.test(stdout),
    `expected "Stand-downs: 1 (test-fixture-skip-pass.js)" in the summary; got:\n${stdout}`
  );
  console.log('Test 1 passed: a skip-tokened line from a passing test is surfaced in the aggregated log, indented under its PASS line, and counted in the Stand-downs: summary (kills the FAIL-only-branch mutant — pre-T-588 this line never reached the aggregated log)');
}

// --- Test 2: a marker-less passing test contributes NOTHING beyond its own
// PASS line — its ordinary stdout noise must not leak into the aggregated
// log. This kills the surface-everything mutant (a runner that always prints
// passing-test stdout regardless of the token).
{
  const dir = buildScratch('t2-quiet-suppressed', { only: ['quiet'] });
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 0, `expected the lone-passing-test run to exit 0, got ${status}\n${stdout}`);
  assert.ok(
    stdout.includes('PASS  test-fixture-quiet-pass.js'),
    `expected a PASS line for the synthetic quiet test; got:\n${stdout}`
  );
  assert.ok(
    !stdout.includes(MARKERLESS_NOISE_LINE),
    `expected the marker-less test's ordinary stdout to stay suppressed; found it leaked into:\n${stdout}`
  );
  assert.ok(
    /Stand-downs: 0\b/.test(stdout),
    `expected "Stand-downs: 0" (no marker present) in the summary; got:\n${stdout}`
  );
  console.log('Test 2 passed: a marker-less passing test contributes nothing beyond its PASS line — no skip token means no surfaced output and Stand-downs: 0 (kills the surface-everything mutant)');
}

// --- Test 3: FAIL-branch behavior is unchanged — a failing test's full
// stdout+stderr is still printed in full (not filtered down to only [SKIP]
// lines), and it is not counted as a stand-down.
{
  const dir = buildScratch('t3-fail-unchanged', { only: ['fail'] });
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 1, `expected the lone-failing-test run to exit 1, got ${status}\n${stdout}`);
  assert.ok(
    stdout.includes('FAIL  test-fixture-fail.js'),
    `expected a FAIL line for the synthetic failing test; got:\n${stdout}`
  );
  assert.ok(
    stdout.includes('failure diagnostic line one') && stdout.includes('failure diagnostic line two (stderr)'),
    `expected the full stdout+stderr of the failing test to still be printed in full; got:\n${stdout}`
  );
  assert.ok(
    /Stand-downs: 0\b/.test(stdout),
    `expected "Stand-downs: 0" — a FAIL is not a stand-down; got:\n${stdout}`
  );
  console.log('Test 3 passed: FAIL-branch output is unchanged (full stdout+stderr still printed, not filtered to skip-tokened lines) and a failing test is never counted as a stand-down');
}

// --- Test 4: mixed run — skip + quiet + fail together — the aggregated log
// contains the skip line exactly once, no quiet noise, the fail diagnostic
// in full, and a summary reporting 1 stand-down alongside the pass/fail
// counts.
{
  const dir = buildScratch('t4-mixed');
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 1, `expected the mixed run (one failing fixture) to exit 1, got ${status}\n${stdout}`);
  assert.ok(stdout.includes(SKIP_LINE), `expected the [SKIP] line in the mixed run; got:\n${stdout}`);
  assert.ok(!stdout.includes(MARKERLESS_NOISE_LINE), `expected quiet-test noise suppressed in the mixed run; got:\n${stdout}`);
  assert.ok(stdout.includes('failure diagnostic line one'), `expected the failing test's diagnostic in the mixed run; got:\n${stdout}`);
  assert.ok(/Summary: 2 passed, 1 failed \(of 3 total\)/.test(stdout), `expected the summary counts to reflect 2 passed/1 failed; got:\n${stdout}`);
  assert.ok(/Stand-downs: 1 \(test-fixture-skip-pass\.js\)/.test(stdout), `expected exactly 1 stand-down named in the mixed run; got:\n${stdout}`);
  console.log('Test 4 passed: a mixed pass/pass-with-skip/fail run surfaces the skip-tokened line once, suppresses quiet-test noise, prints the fail diagnostic in full, and reports Stand-downs: 1 alongside the correct pass/fail counts');
}

// --- Test 5 (T-596): a passing test whose stdout mentions the skip token
// MID-LINE in prose (never starting a line with it) must NOT be surfaced and
// must NOT be counted as a stand-down. This is the live reproduction of
// T-588's own false positive: the pre-fix `line.includes(SKIP_TOKEN)`
// matcher matched this exact shape and reported "Stand-downs: 1" for a line
// that was never an actual stand-down emission.
{
  const dir = buildScratch('t5-midline-not-surfaced', { only: ['midline'] });
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 0, `expected the lone-passing-test run to exit 0, got ${status}\n${stdout}`);
  assert.ok(
    stdout.includes('PASS  test-fixture-midline-pass.js'),
    `expected a PASS line for the synthetic mid-line-mention test; got:\n${stdout}`
  );
  assert.ok(
    !stdout.includes(MID_LINE_MENTION),
    `expected the mid-line mention of the token to stay suppressed (not surfaced under the PASS line); found it leaked into:\n${stdout}`
  );
  assert.ok(
    /Stand-downs: 0\b/.test(stdout),
    `expected "Stand-downs: 0" — a mid-line mention is not a line-initial stand-down; got:\n${stdout}`
  );
  console.log('Test 5 passed: a passing test that mentions the skip token mid-line in prose is neither surfaced nor counted as a stand-down (this is the live reproduction of T-588\'s own false "Stand-downs: 1" — kills the unanchored-substring-match regression)');
}

// --- Test 6 (T-596): an INDENTED skip-token emission (leading whitespace
// then the token, mirroring the real test-validator-cross-section-status.js
// emitter) IS surfaced and counted. This permanently protects that live
// emitter shape from a future strict-prefix (bare startsWith) tightening.
{
  const dir = buildScratch('t6-indented-surfaced', { only: ['indented'] });
  const { stdout, status } = runAggregate(dir);
  assert.strictEqual(status, 0, `expected the lone-passing-test run to exit 0, got ${status}\n${stdout}`);
  assert.ok(
    stdout.includes('PASS  test-fixture-indented-skip-pass.js'),
    `expected a PASS line for the synthetic indented-skip test; got:\n${stdout}`
  );
  assert.ok(
    stdout.includes(INDENTED_SKIP_LINE.trimStart()),
    `expected the indented skip line's content to be surfaced under the PASS line; got:\n${stdout}`
  );
  assert.ok(
    /Stand-downs: 1 \(test-fixture-indented-skip-pass\.js\)/.test(stdout),
    `expected "Stand-downs: 1 (test-fixture-indented-skip-pass.js)" in the summary; got:\n${stdout}`
  );
  console.log('Test 6 passed: an indented skip-token emission (leading whitespace then the token, mirroring the real cross-section-status emitter) is still surfaced and counted (protects that live emitter shape from a future strict-prefix tightening)');
}

console.log('All test-run-tests-standdown.js tests passed.');
