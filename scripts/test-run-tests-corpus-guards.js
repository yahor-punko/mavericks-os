'use strict';
// Unit test: T-813 — run-tests.js must append every corpus-wide guard test
// (a scripts/test-*.js file carrying the guard marker comment as a whole
// trimmed line within its first 40 lines) to any non-empty --filter run, so a
// filtered run still executes the repo-wide guards.
//
// Built on the scratch-dir pattern of test-run-tests-standdown.js: the real
// run-tests.js is copied beside hand-written synthetic fixtures in a scratch
// dir and run there (it discovers test files relative to its own __dirname),
// so this test is independent of the real scripts/test-*.js files. No git
// init happens anywhere in this test — the scratch dirs are plain directories
// and the copied runner finds no receipt helper beside it.
//
// The marker literal is built by runtime concatenation below, so this file
// never carries it as contiguous text and can never mark itself as a guard.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUN_TESTS_SRC = path.join(__dirname, 'run-tests.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-run-tests-corpus-guards-${process.pid}-${Date.now()}`
);

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanup);

// Runtime-built marker (see header).
const MARKER = '// mavp-corpus-' + 'guard: always-run';

const PASS_BODY = `'use strict';\nprocess.exit(0);\n`;
const FAIL_BODY = `'use strict';\nconsole.log('guard violation detected');\nprocess.exit(1);\n`;

function marked(body) {
  // Marker on line 2, right after the strict-mode line.
  const [first, ...rest] = body.split('\n');
  return [first, MARKER, ...rest].join('\n');
}

// fixtures: { basename: content }; returns scratch dir with runner copied in.
let counter = 0;
function buildScratch(fixtures) {
  const dir = path.join(SCRATCH_ROOT, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(RUN_TESTS_SRC, path.join(dir, 'run-tests.js'));
  for (const [name, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function run(dir, args) {
  try {
    const stdout = execFileSync(process.execPath, ['run-tests.js', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', status: err.status };
  }
}

const lines = (out) => out.split('\n');
const passLines = (out) => lines(out).filter((l) => l.startsWith('PASS  '));
const failLines = (out) => lines(out).filter((l) => l.startsWith('FAIL  '));

const BASE = {
  'test-fixture-alpha.js': PASS_BODY,
  'test-fixture-beta.js': PASS_BODY,
  'test-fixture-guard-ok.js': marked(PASS_BODY),
  'test-fixture-guard-bad.js': marked(FAIL_BODY),
};

// --- [a] filtered run appends both guards; failing guard fails the run.
{
  const r = run(buildScratch(BASE), ['--filter', 'alpha']);
  assert.strictEqual(r.status, 1, 'failing guard must make the filtered run exit 1:\n' + r.stdout);
  assert.ok(
    r.stdout.includes('Running 1 test file(s) (filter: "alpha") + 2 corpus-wide guard file(s)...'),
    'header must name 1 matched file and 2 guards:\n' + r.stdout
  );
  assert.ok(
    r.stdout.includes('Corpus-wide guards (always run with --filter): test-fixture-guard-bad.js, test-fixture-guard-ok.js'),
    'guards line must name both guards, sorted:\n' + r.stdout
  );
  assert.ok(r.stdout.includes('Summary: 2 passed, 1 failed (of 3 total)'), 'summary counts guards:\n' + r.stdout);
  assert.ok(failLines(r.stdout).some((l) => l.includes('test-fixture-guard-bad.js')), 'FAIL line names the bad guard');
  // Matched files first, then guards appended after.
  const order = lines(r.stdout).filter((l) => /^(PASS|FAIL)  /.test(l)).map((l) => l.split(/\s+/)[1]);
  assert.deepStrictEqual(order, ['test-fixture-alpha.js', 'test-fixture-guard-bad.js', 'test-fixture-guard-ok.js']);
  assert.ok(r.stdout.includes('Suite receipt: not written'), 'receipt line still emitted');
  console.log('PASS  [a] --filter appends all marked guards; failing guard exits 1; order and counts correct');
}

// --- [b] same, no failing guard.
{
  const fx = { ...BASE };
  delete fx['test-fixture-guard-bad.js'];
  const r = run(buildScratch(fx), ['--filter', 'alpha']);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes('Summary: 2 passed, 0 failed (of 2 total)'), r.stdout);
  assert.ok(r.stdout.includes('+ 1 corpus-wide guard file(s)'), r.stdout);
  console.log('PASS  [b] passing guard keeps the filtered run green and counted');
}

// --- [c] filter that matches a guard itself: no duplicate, other guard still runs.
{
  const r = run(buildScratch(BASE), ['--filter', 'guard-ok']);
  const okPass = passLines(r.stdout).filter((l) => l.includes('test-fixture-guard-ok.js'));
  assert.strictEqual(okPass.length, 1, 'matched guard must run exactly once:\n' + r.stdout);
  assert.ok(r.stdout.includes('(of 2 total)'), 'guard-bad still runs:\n' + r.stdout);
  assert.ok(r.stdout.includes('+ 1 corpus-wide guard file(s)'), r.stdout);
  assert.ok(r.stdout.includes('Corpus-wide guards (always run with --filter): test-fixture-guard-bad.js'), r.stdout);
  assert.strictEqual(r.status, 1, r.stdout);
  console.log('PASS  [c] a guard matched by the filter is not duplicated; unmatched guard still appended');
}

// --- [d] empty match: existing no-match path fires before any guard runs.
{
  const r = run(buildScratch(BASE), ['--filter', 'nomatch']);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.ok(r.stdout.includes('No test files matched filter "nomatch".'), r.stdout);
  assert.strictEqual(passLines(r.stdout).length + failLines(r.stdout).length, 0, 'no guard may run:\n' + r.stdout);
  console.log('PASS  [d] empty filter match exits 1 before any guard runs');
}

// --- [e] unfiltered: every file runs once, no guard text in the header.
{
  const r = run(buildScratch(BASE), []);
  assert.strictEqual(passLines(r.stdout).length + failLines(r.stdout).length, 4, r.stdout);
  assert.ok(r.stdout.includes('Running 4 test file(s)...'), r.stdout);
  assert.ok(!r.stdout.includes('corpus-wide guard'), 'unfiltered header must not mention guards:\n' + r.stdout);
  assert.ok(r.stdout.includes('(of 4 total)'), r.stdout);
  console.log('PASS  [e] unfiltered run executes each file once with no guard text');
}

// --- [f] marker only counts as a whole trimmed line within the first 40 lines.
{
  const filler = (n) => Array.from({ length: n }, (_, i) => `// filler ${i + 1}`).join('\n');
  // Marker on line 41 (40 lines precede it): outside the scan window.
  const late = `${filler(40)}\n${MARKER}\n${FAIL_BODY}`;
  // Marker mid-line inside prose.
  const prose = `'use strict';\n// note: the ${MARKER} comment is described here in prose only\n${FAIL_BODY}`;
  // Marker with trailing text on the same line is not a whole-line match.
  const trailing = `'use strict';\n${MARKER} (trailing words)\n${FAIL_BODY}`;
  const r = run(
    buildScratch({
      'test-fixture-alpha.js': PASS_BODY,
      'test-fixture-late-marker.js': late,
      'test-fixture-prose-marker.js': prose,
      'test-fixture-trailing-marker.js': trailing,
    }),
    ['--filter', 'alpha']
  );
  assert.strictEqual(r.status, 0, 'non-guards must not run:\n' + r.stdout);
  assert.ok(r.stdout.includes('Running 1 test file(s) (filter: "alpha")...'), r.stdout);
  assert.ok(!r.stdout.includes('corpus-wide guard'), r.stdout);
  assert.ok(r.stdout.includes('(of 1 total)'), r.stdout);

  // Boundary: marker on line 40 (inside the window) and an indented marker both count.
  const onLine40 = `${filler(39)}\n${MARKER}\n${PASS_BODY}`;
  const indented = `'use strict';\n    ${MARKER}   \n${PASS_BODY}`;
  const r2 = run(
    buildScratch({
      'test-fixture-alpha.js': PASS_BODY,
      'test-fixture-line40.js': onLine40,
      'test-fixture-indented.js': indented,
    }),
    ['--filter', 'alpha']
  );
  assert.strictEqual(r2.status, 0, r2.stdout);
  assert.ok(r2.stdout.includes('+ 2 corpus-wide guard file(s)'), 'line-40 and indented markers must count:\n' + r2.stdout);
  assert.ok(r2.stdout.includes('(of 3 total)'), r2.stdout);
  console.log('PASS  [f] marker honoured only as whole trimmed line in first 40 lines (line 41 / prose / trailing text ignored; line 40 / indented honoured)');
}

// --- [g] tree with no marked files: filtered output has no guard additions.
{
  const r = run(
    buildScratch({ 'test-fixture-alpha.js': PASS_BODY, 'test-fixture-beta.js': PASS_BODY }),
    ['--filter', 'alpha']
  );
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(r.stdout.startsWith('Running 1 test file(s) (filter: "alpha")...\n\n'), 'header must be exactly the legacy format:\n' + r.stdout);
  assert.ok(!r.stdout.includes('Corpus-wide guards'), r.stdout);
  console.log('PASS  [g] no marked files: filtered header is the legacy format with no guards line');
}
