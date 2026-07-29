'use strict';
// Regression test: T-511 — unify the private-names parser between
// mavp-publish-build.js and mavp-publish-scan.js. Before this task, each
// script carried its own copy of the split/trim/filter logic that decides
// what counts as a valid private name; a security reviewer explicitly
// declined to accept two copies of that logic as a permanent state, since a
// future drift between the copies would silently reopen the exact
// comma-only bypass this project already had to close once.
//
// This file asserts three things:
//   1. Exactly one function definition of the split/trim/filter logic exists
//      in the repo (grep-checked here, not just eyeballed).
//   2. mavp-publish-build.js's exported parsePrivateNamesList and
//      mavp-publish-scan.js's exported parsePrivateNamesList are the SAME
//      function reference (build.js imports rather than redefines it), and
//      produce identical output for every input including the degenerate
//      comma/whitespace forms.
//   3. require()-ing mavp-publish-scan.js as a module has NO side effects —
//      no scan runs, nothing is printed, nothing is written, no process
//      exit occurs. This is what makes (2) possible in the first place
//      (T-505 added module.exports + a require.main guard to the scanner).

const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(SCRIPTS_DIR, 'mavp-publish-build.js');
const SCAN_SCRIPT = path.join(SCRIPTS_DIR, 'mavp-publish-scan.js');

// ---------------------------------------------------------------------------
// Test 1: exactly one function definition of the shared parser exists.
// ---------------------------------------------------------------------------
{
  const grepResult = execFileSync(
    'grep',
    ['-rn', '--include=*.js', 'function parsePrivateNamesList', SCRIPTS_DIR],
    { encoding: 'utf8' }
  );
  const lines = grepResult
    .trim()
    .split('\n')
    .filter(Boolean)
    // Exclude this test file's own text (it necessarily mentions the
    // function name in comments/strings/assertions, which would otherwise
    // self-match and inflate the count it is trying to verify).
    .filter((line) => !line.startsWith(__filename + ':'));
  assert.strictEqual(
    lines.length,
    1,
    `Test 1 FAIL: expected exactly one "function parsePrivateNamesList" definition in scripts/, found ${lines.length}:\n${lines.join('\n')}`
  );
  assert.ok(
    lines[0].includes('mavp-publish-scan.js'),
    `Test 1 FAIL: expected the single definition to live in mavp-publish-scan.js, found: ${lines[0]}`
  );
  console.log(`Test 1 passed: exactly one parsePrivateNamesList definition exists, in mavp-publish-scan.js (${lines[0].trim()})`);
}

// ---------------------------------------------------------------------------
// Test 2: build.js imports (does not redefine) the scanner's helper, and
// both call sites agree on every input including the degenerate forms.
// ---------------------------------------------------------------------------
{
  const buildExports = require(BUILD_SCRIPT);
  const scanExports = require(SCAN_SCRIPT);

  assert.strictEqual(
    buildExports.parsePrivateNamesList,
    scanExports.parsePrivateNamesList,
    'Test 2 FAIL: mavp-publish-build.js and mavp-publish-scan.js must export the SAME function reference (build.js must import, not redefine)'
  );
  console.log('Test 2a passed: mavp-publish-build.js.parsePrivateNamesList === mavp-publish-scan.js.parsePrivateNamesList (same function reference)');

  const cases = [
    { label: 'omitted (null)', input: null, expected: [] },
    { label: 'omitted (undefined)', input: undefined, expected: [] },
    { label: 'empty string', input: '', expected: [] },
    { label: 'comma only', input: ',', expected: [] },
    { label: 'comma-space-comma', input: ', ,', expected: [] },
    { label: 'double-comma', input: ',,', expected: [] },
    { label: 'whitespace-only', input: '   ', expected: [] },
    { label: 'legitimate two-name value', input: 'alpha-name,beta-name', expected: ['alpha-name', 'beta-name'] },
    { label: 'legitimate value with surrounding whitespace', input: '  alpha-name , beta-name  ', expected: ['alpha-name', 'beta-name'] },
    { label: 'legitimate value with an embedded degenerate entry', input: 'alpha-name,,beta-name', expected: ['alpha-name', 'beta-name'] },
  ];

  for (const { label, input, expected } of cases) {
    const fromBuild = buildExports.parsePrivateNamesList(input);
    const fromScan = scanExports.parsePrivateNamesList(input);
    assert.deepStrictEqual(
      fromBuild,
      expected,
      `Test 2b FAIL (${label}): build.js call site returned ${JSON.stringify(fromBuild)}, expected ${JSON.stringify(expected)}`
    );
    assert.deepStrictEqual(
      fromScan,
      expected,
      `Test 2b FAIL (${label}): scan.js call site returned ${JSON.stringify(fromScan)}, expected ${JSON.stringify(expected)}`
    );
    assert.deepStrictEqual(
      fromBuild,
      fromScan,
      `Test 2b FAIL (${label}): build.js and scan.js call sites disagree — build=${JSON.stringify(fromBuild)} scan=${JSON.stringify(fromScan)}`
    );
  }
  console.log(`Test 2b passed: both call sites produce identical output across ${cases.length} inputs, including every degenerate comma/whitespace form`);
}

// ---------------------------------------------------------------------------
// Test 3: requiring mavp-publish-scan.js as a module has NO side effects —
// no scan runs, nothing is printed, nothing is written, no process exit. Run
// in a subprocess so this test can observe the require() in isolation without
// its own console output already being on the page.
// ---------------------------------------------------------------------------
{
  const probeScript = `
    const path = require(${JSON.stringify('path')});
    const scanScript = ${JSON.stringify(SCAN_SCRIPT)};
    // Requiring must not print anything, must not throw, must not exit
    // early — if it did, the marker below would never print.
    const scanExports = require(scanScript);
    if (typeof scanExports.parsePrivateNamesList !== 'function') {
      throw new Error('parsePrivateNamesList export missing after require');
    }
    if (typeof scanExports.resolvePrivateNames !== 'function') {
      throw new Error('resolvePrivateNames export missing after require');
    }
    console.log('REQUIRE-COMPLETED-NO-SIDE-EFFECTS');
  `;
  const result = execFileSyncCapture(probeScript);

  assert.strictEqual(
    result.status,
    0,
    `Test 3 FAIL: expected the require()-only probe to exit 0, got ${result.status}. stderr:\n${result.stderr}`
  );
  assert.strictEqual(
    result.stdout.trim(),
    'REQUIRE-COMPLETED-NO-SIDE-EFFECTS',
    `Test 3 FAIL: expected ONLY the marker on stdout (nothing printed by require() itself), got stdout:\n${JSON.stringify(result.stdout)}`
  );
  assert.strictEqual(
    result.stderr,
    '',
    `Test 3 FAIL: expected empty stderr (require() must not print anything), got:\n${JSON.stringify(result.stderr)}`
  );
  console.log('Test 3 passed: require()-ing mavp-publish-scan.js as a module runs no scan, prints nothing, exits cleanly (no side effects)');
}

// ---------------------------------------------------------------------------
// T-510: a private-name entry made entirely of non-word characters (three
// asterisks, a lone dot, a bare hyphen) can never match the word-boundary
// (`\b`) anchored detection regex, so accepting it as a "name" silently
// disables detection for that entry while it still counts as a well-formed,
// non-empty list item. Tests 4-6 assert the parser refuses this case (rather
// than the count-based mandatory-flag gate silently accepting it), the
// regex builder independently agrees, and an end-to-end scan run never
// reaches a clean/GREEN exit on a mixed list containing such an entry.
//
// Punctuation-only tokens below are assembled via concatenation rather than
// written as contiguous literals, per this wave's shipped-file discipline —
// not because these characters match any detection category (they don't),
// but so no token in this file could ever be mistaken for one that does.
// ---------------------------------------------------------------------------

const threeAsterisks = ['*', '*', '*'].join('');
const loneDot = ['.'].join('');
const bareHyphen = ['-'].join('');
// A fake trailing-hyphen "prefix family" name, matching the shape of this
// project's real private-names list (see docs/PUBLIC_RELEASE_STRATEGY.md) —
// letters followed by a single trailing hyphen. Assembled at runtime purely
// out of caution; it is a placeholder, not a real private name.
const fakePrefixName = ['gamma', '-'].join('');
const fakeOrdinaryName = ['delta', 'name'].join('-');

// ---------------------------------------------------------------------------
// Test 4: parsePrivateNamesList refuses punctuation-only entries — both in
// isolation and mixed with legitimate names — while leaving ordinary names
// (letters, digits, hyphens, the trailing-hyphen prefix form) completely
// unaffected. Both call sites (build.js's imported reference and scan.js's
// own definition) must throw identically.
// ---------------------------------------------------------------------------
{
  const buildExports = require(BUILD_SCRIPT);
  const scanExports = require(SCAN_SCRIPT);

  const punctuationOnlyInputs = [
    { label: 'three asterisks alone', input: threeAsterisks },
    { label: 'lone dot alone', input: loneDot },
    { label: 'bare hyphen alone', input: bareHyphen },
    { label: 'legitimate name + three-asterisks entry (mixed)', input: `${fakeOrdinaryName},${threeAsterisks}` },
    { label: 'legitimate name + lone-dot entry (mixed)', input: `${fakeOrdinaryName},${loneDot}` },
    { label: 'legitimate name + bare-hyphen entry (mixed)', input: `${fakeOrdinaryName},${bareHyphen}` },
  ];

  for (const { label, input } of punctuationOnlyInputs) {
    assert.throws(
      () => buildExports.parsePrivateNamesList(input),
      /punctuation-only/,
      `Test 4a FAIL (${label}): build.js call site was expected to throw refusing the punctuation-only entry, for input ${JSON.stringify(input)}`
    );
    assert.throws(
      () => scanExports.parsePrivateNamesList(input),
      /punctuation-only/,
      `Test 4a FAIL (${label}): scan.js call site was expected to throw refusing the punctuation-only entry, for input ${JSON.stringify(input)}`
    );
  }
  console.log(`Test 4a passed: both call sites throw refusing ${punctuationOnlyInputs.length} punctuation-only inputs (isolated and mixed with a legitimate name)`);

  const ordinaryCases = [
    { label: 'plain hyphenated name', input: fakeOrdinaryName, expected: [fakeOrdinaryName] },
    { label: 'trailing-hyphen prefix form', input: fakePrefixName, expected: [fakePrefixName] },
    { label: 'digits-only name', input: '12345', expected: ['12345'] },
    {
      label: 'two ordinary names including the trailing-hyphen prefix form',
      input: `${fakeOrdinaryName},${fakePrefixName}`,
      expected: [fakeOrdinaryName, fakePrefixName],
    },
  ];
  for (const { label, input, expected } of ordinaryCases) {
    const fromBuild = buildExports.parsePrivateNamesList(input);
    const fromScan = scanExports.parsePrivateNamesList(input);
    assert.deepStrictEqual(
      fromBuild,
      expected,
      `Test 4b FAIL (${label}): expected ordinary name(s) to parse through unaffected, build.js returned ${JSON.stringify(fromBuild)}`
    );
    assert.deepStrictEqual(
      fromScan,
      expected,
      `Test 4b FAIL (${label}): expected ordinary name(s) to parse through unaffected, scan.js returned ${JSON.stringify(fromScan)}`
    );
  }
  console.log(`Test 4b passed: ordinary names (plain, trailing-hyphen prefix, digits-only, mixed) all pass through unaffected, at both call sites`);
}

// ---------------------------------------------------------------------------
// Test 5: buildPrivateNameRegexes applies the SAME predicate as the parser —
// even if called directly with a punctuation-only entry (bypassing
// parsePrivateNamesList entirely), it never builds a regex for that entry.
// This is defense in depth: the two call sites cannot disagree by
// construction, not merely by convention, because both consult
// isUsablePrivateName.
// ---------------------------------------------------------------------------
{
  const scanExports = require(SCAN_SCRIPT);

  const regexesForPunctuationOnly = scanExports.buildPrivateNameRegexes([threeAsterisks, loneDot, bareHyphen]);
  assert.strictEqual(
    regexesForPunctuationOnly.length,
    0,
    `Test 5a FAIL: buildPrivateNameRegexes() was expected to produce zero regexes for an all-punctuation-only input, got ${regexesForPunctuationOnly.length}`
  );
  console.log('Test 5a passed: buildPrivateNameRegexes() builds zero regexes for punctuation-only names, called directly');

  const regexesForMixed = scanExports.buildPrivateNameRegexes([fakeOrdinaryName, threeAsterisks, fakePrefixName]);
  assert.strictEqual(
    regexesForMixed.length,
    2,
    `Test 5b FAIL: buildPrivateNameRegexes() was expected to build exactly 2 regexes (skipping the punctuation-only entry) for a mixed input, got ${regexesForMixed.length}`
  );
  assert.strictEqual(
    scanExports.isUsablePrivateName(fakeOrdinaryName),
    true,
    'Test 5c FAIL: isUsablePrivateName() expected true for an ordinary name'
  );
  assert.strictEqual(
    scanExports.isUsablePrivateName(fakePrefixName),
    true,
    'Test 5c FAIL: isUsablePrivateName() expected true for the trailing-hyphen prefix form'
  );
  assert.strictEqual(
    scanExports.isUsablePrivateName(threeAsterisks),
    false,
    'Test 5c FAIL: isUsablePrivateName() expected false for a punctuation-only name'
  );
  console.log('Test 5b/5c passed: buildPrivateNameRegexes() and isUsablePrivateName() agree with the parser predicate on mixed input');
}

// ---------------------------------------------------------------------------
// Test 6: end-to-end proof the AC's exact phrasing holds — a fixture file
// containing a punctuation-only "name" token is either reported or the name
// is refused at parse time, NEVER silently scanned to a clean/GREEN exit.
// This project chose REFUSE (fail closed) over silent-drop, so this test
// runs the real CLI (mavp-publish-scan.js) as a subprocess against a real
// fixture directory with a mixed --private-names value and asserts the run
// exits non-zero with an explanatory error — not a clean "zero findings" 0.
// ---------------------------------------------------------------------------
{
  const os = require('node:os');
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t510-fixture-'));
  try {
    // An entirely unremarkable fixture file — the point of this test is that
    // the punctuation-only entry in --private-names is what must stop the
    // run, regardless of what the scanned tree actually contains.
    fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), 'nothing interesting here\n');

    const mixedPrivateNames = `${fakeOrdinaryName},${threeAsterisks}`;
    const result = spawnSync(
      process.execPath,
      [SCAN_SCRIPT, fixtureDir, '--private-names', mixedPrivateNames],
      { encoding: 'utf8' }
    );

    assert.notStrictEqual(
      result.status,
      0,
      `Test 6 FAIL: expected the scan to REFUSE (non-zero exit) on a mixed --private-names value containing a punctuation-only entry, ` +
        `got exit ${result.status} — a zero exit here would mean the run went silently GREEN despite the unusable entry. ` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(
      result.stderr,
      /punctuation-only/,
      `Test 6 FAIL: expected stderr to explain the refusal, got:\n${result.stderr}`
    );
    console.log(
      `Test 6 passed: end-to-end scan run on a mixed --private-names value refuses (exit ${result.status}, not 0) instead of silently scanning to GREEN`
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function execFileSyncCapture(code) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, ['-e', code], { cwd: REPO_ROOT, encoding: 'utf8' });
}

console.log('\nAll T-510/T-511 assertions passed.');
