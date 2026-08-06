'use strict';
// T-634 — Guard against a NEW unpinned `git init` fixture invocation.
//
// Problem this guards against: T-632 fixed one fixture whose `git init`
// inherited the host machine's default initial-branch config. The failure
// was invisible on a machine whose git is patched to default `init` to
// `main` even with global/system config suppressed, and surfaced only as
// post-push CI red on a runner where upstream git defaults to `master`.
// T-634 swept every other unpinned fixture `git init` in the corpus (24
// sites across 9 files, verified by direct measurement against the tree at
// registration time — one figure in the originating brief's own summary
// line disagreed with its own itemized list; the itemized list is what was
// actually swept and is authoritative). Every fixture author after this
// sweep is one copy-paste away from reintroducing the same defect class —
// this guard exists so a NEW unpinned instance fails a test run instead of
// waiting for a CI runner with a different git default to notice.
//
// FILE SCOPE — every scripts/test-*.js file (the same glob
// discoverTestFiles() in run-tests.js uses for auto-discovery), which is
// exactly the fixture-author-reachable surface this defect class recurs in.
// scripts/mavp-operator-demo.js:227's bare, unpinned git-init call is
// DELIBERATELY OUT OF SCOPE and DELIBERATELY NOT PINNED: it is an
// adopter-facing demo script with no branch-name-dependent assertion
// anywhere downstream of it, and pinning it would raise the minimum git
// version an adopter's machine must have (`-b`/`--initial-branch` requires
// git >= 2.28) for zero behavioral benefit. Because the demo script's name
// does not start with "test-", it is out of this guard's glob by
// construction, not by an explicit exclusion list — the same "reachable by
// construction" argument the precedent guard (T-610,
// test-no-unbounded-block-matchers.js) makes for its own file-scope choice.
//
// Detection is a lightweight static text scan (same style as
// test-no-unbounded-block-matchers.js, mavp-manifest-guard.js,
// mavp-private-names-guard.js — none of these parse a JS AST). It looks for
// a quoted `'init'`/`"init"` array element sitting in the git-subcommand
// position of a flat string array (i.e., either the array's first element,
// or preceded only by `-c key=value` config-pair elements — the exact shape
// `git -c foo=bar init` takes when expressed as an argv array), then checks
// whether that SAME array literal also contains a pin: a short `-b` flag, a
// long `--initial-branch` flag, or the per-invocation `defaultBranch` config
// idiom (`-c init.defaultBranch=...`, already used at
// test-close-session-mode.js's line ~746/767 before this task). The
// git-subcommand-position check is what keeps this guard from false-
// positiving on `['commit', '-q', '-m', 'init']` (a commit MESSAGE that
// happens to be the literal text "init", not a `git init` invocation at
// all) — several fixtures in this corpus use exactly that commit message.
//
// Per the "Reserved shapes (bounded, not universal)" clause in
// .claude/rules/scripts.md, every offending (unpinned) example array this
// file's own self-tests construct is built by RUNTIME STRING CONCATENATION
// — split at the bracket boundary — so the literal contiguous substring
// `['init'` (or `["init"`) with no pin never sits in this file's own source
// text. Without that discipline, this guard's OWN Test 1 (which scans every
// scripts/test-*.js file, including itself) would self-match its own
// mutant-construction code and report a false finding against itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const SCRIPTS_DIR = __dirname;

const OPEN_BRACKET = '[';
const CLOSE_BRACKET = ']';

/**
 * Deliberately NOT stripping JS block comments before scanning (unlike the
 * precedent test-no-unbounded-block-matchers.js). A naive
 * `/\/\*[\s\S]*?\*\//g` block-comment stripper is unsafe on this guard's
 * FILE SCOPE: several real scripts/test-*.js fixtures contain a literal
 * `/*` substring INSIDE a template literal or string that is not a comment
 * at all (e.g. test-publish-build.js's `refs/tags/*` glob-pattern
 * assertion string) — measured directly against this corpus while building
 * this guard. Stripping on that naive pattern would swallow the real code
 * between that false comment-open and the next real comment-close token
 * anywhere later in the file, silently deleting genuine `git init` sites —
 * a false NEGATIVE, which is worse than the false positive the stripping
 * was meant to prevent. The detection shape below (a quoted `init` token
 * immediately bracket/comma-adjacent, in git-subcommand array position) is
 * narrow enough that ordinary prose does not produce it by accident — this
 * file's own header was the one place it did, and is worded to avoid it
 * (see above) rather than solved with a comment stripper that corrupts
 * other files' real code.
 */
function lineNumberAt(text, index) {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

/**
 * True when every comma-separated token in `prefixText` (the array's raw
 * text strictly BEFORE the 'init' element under test) is either the
 * literal `-c` flag or a `key=value`-shaped string literal — the only
 * things that may legally precede a git subcommand in an argv array, the
 * same way a leading `-c key=value` pair may precede a subcommand on a
 * real git command line. An empty prefix (init is the array's first
 * element) trivially qualifies.
 */
function prefixIsOnlyConfigPairs(prefixText) {
  const tokens = prefixText
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens.every((t) => t === "'-c'" || t === '"-c"' || t.includes('='));
}

/**
 * Scan `source` (already comment-stripped) for every quoted `init` array
 * element sitting in git-subcommand position, and report the ones whose
 * enclosing array literal contains no recognized initial-branch pin.
 *
 * @param {string} source - comment-stripped file text
 * @returns {Array<{line: number, snippet: string}>}
 */
function findUnpinnedGitInits(source) {
  const findings = [];
  // Matches a quoted `init` token: 'init' or "init".
  const initTokenRe = /(['"])init\1/g;
  let match;

  while ((match = initTokenRe.exec(source))) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;

    const before = source.slice(0, tokenStart);
    const beforeTrimmed = before.replace(/\s+$/, '');
    const precedingChar = beforeTrimmed[beforeTrimmed.length - 1];
    // Must sit as an array element: immediately preceded by '[' or ','.
    if (precedingChar !== OPEN_BRACKET && precedingChar !== ',') continue;

    const after = source.slice(tokenEnd);
    const afterTrimmed = after.replace(/^\s+/, '');
    const followingChar = afterTrimmed[0];
    // Must sit as an array element: immediately followed by ',' or ']'.
    if (followingChar !== ',' && followingChar !== CLOSE_BRACKET) continue;

    const openIdx = beforeTrimmed.lastIndexOf(OPEN_BRACKET);
    if (openIdx === -1) continue; // no enclosing array at all — not a git args array

    const prefixText = source.slice(openIdx + 1, tokenStart);
    if (!prefixIsOnlyConfigPairs(prefixText)) continue; // e.g. a commit message reading "init"

    const closeRelIdx = after.indexOf(CLOSE_BRACKET);
    if (closeRelIdx === -1) continue; // unterminated array — skip rather than misreport
    const arrayText = source.slice(openIdx, tokenEnd + closeRelIdx + 1);

    const hasShortPin = /(['"])-b\1/.test(arrayText);
    const hasLongPin = arrayText.includes('--initial-branch');
    const hasConfigPin = arrayText.includes('defaultBranch');
    if (hasShortPin || hasLongPin || hasConfigPin) continue;

    const line = lineNumberAt(source, tokenStart);
    const lineText = source.split('\n')[line - 1] || '';
    findings.push({ line, snippet: lineText.trim() });
  }

  return findings;
}

function scanFileForViolations(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return findUnpinnedGitInits(raw);
}

function listTestFixtureScripts() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => name.startsWith('test-') && name.endsWith('.js'))
    .sort()
    .map((name) => path.join(SCRIPTS_DIR, name));
}

function testCleanTreeHasZeroFindings() {
  const files = listTestFixtureScripts();
  assert.ok(files.length > 0, 'Test 1 FAIL: expected to find at least one scripts/test-*.js file to scan');

  const allFindings = [];
  for (const filePath of files) {
    const findings = scanFileForViolations(filePath);
    for (const f of findings) {
      allFindings.push(`${path.relative(SCRIPTS_DIR, filePath)}:${f.line}: ${f.snippet}`);
    }
  }

  assert.strictEqual(
    allFindings.length,
    0,
    `Test 1 FAIL: found ${allFindings.length} unpinned git-init fixture invocation(s):\n${allFindings.join('\n')}`
  );
  console.log(
    `Test 1 passed: zero unpinned git-init fixture invocations across ${files.length} scripts/test-*.js files`
  );
}

function testAllowClassesDoNotFalsePositive() {
  // Allow-class 1: short `-b` pin, built by concatenation so the
  // contiguous unpinned shape `['init'` never sits in this file's source.
  const shortPinArray = '[' + "'init', '-q', '-b', 'main'" + ']';
  const shortPinSource = "execFileSync('git', " + shortPinArray + ", { cwd: dir });";

  // Allow-class 2: long `--initial-branch` pin.
  const longPinArray = '[' + "'init', '-q', '--initial-branch=main'" + ']';
  const longPinSource = "execFileSync('git', " + longPinArray + ", { cwd: dir });";

  // Allow-class 3: per-invocation `defaultBranch` config idiom (the real
  // shape already used at test-close-session-mode.js before this task).
  const configPinArray = '[' + "'-c', 'init.defaultBranch=main', 'init', '-q'" + ']';
  const configPinSource = "execFileSync('git', " + configPinArray + ", { cwd: dir });";

  // Allow-class 4: NOT a git-init invocation at all — a commit MESSAGE that
  // happens to be the literal text "init". Several real fixtures in this
  // corpus use exactly this commit message; it must never be flagged.
  const commitMessageArray = '[' + "'commit', '-q', '-m', 'init'" + ']';
  const commitMessageSource = "execFileSync('git', " + commitMessageArray + ", { cwd: dir });";

  assert.strictEqual(
    findUnpinnedGitInits(shortPinSource).length,
    0,
    'Test 2a FAIL: a short -b pin must not be flagged'
  );
  assert.strictEqual(
    findUnpinnedGitInits(longPinSource).length,
    0,
    'Test 2b FAIL: a long --initial-branch pin must not be flagged'
  );
  assert.strictEqual(
    findUnpinnedGitInits(configPinSource).length,
    0,
    'Test 2c FAIL: a per-invocation defaultBranch config pin must not be flagged'
  );
  assert.strictEqual(
    findUnpinnedGitInits(commitMessageSource).length,
    0,
    'Test 2d FAIL: a commit message reading "init" must not be flagged as an unpinned git-init'
  );
  console.log(
    'Test 2 passed: documented allow-classes (short -b, long --initial-branch, defaultBranch config, ' +
      'and a commit-message false-positive control) do not false-positive'
  );
}

function testMutantIsCaught() {
  // Constructed by concatenation so the contiguous unpinned shape `['init'`
  // never sits in THIS file's own source text (see file header).
  const unpinnedArray = '[' + "'init', '-q'" + ']';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't634-guard-mutant-'));
  const mutantPath = path.join(tmpDir, 'test-fixture-mutant.js');

  const mutantSource =
    "'use strict';\n" +
    'function buildFixtureRepo(dir) {\n' +
    "  execFileSync('git', " +
    unpinnedArray +
    ', { cwd: dir });\n' +
    '}\n';

  fs.writeFileSync(mutantPath, mutantSource, 'utf8');
  let findings;
  try {
    findings = scanFileForViolations(mutantPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(
    findings.length,
    1,
    `Test 3 FAIL: expected exactly 1 finding in the synthetic unpinned mutant, got ${findings.length}`
  );
  assert.strictEqual(
    findings[0].line,
    3,
    `Test 3 FAIL: expected the finding on line 3, got line ${findings[0].line}`
  );
  console.log(`Test 3 passed: synthetic unpinned mutant caught at test-fixture-mutant.js:${findings[0].line}`);
}

function testBareRepoMutantIsCaught() {
  // A bare-repo init (no positional path, `--bare` flag present) with no
  // pin — the exact shape test-close-session-mode.js:745 and
  // test-publish-build.js:124 had before this task. Bare-ness must not
  // exempt a site from the guard (the brief calls bare-repo pins
  // "harmless and uniform").
  const unpinnedBareArray = '[' + "'init', '-q', '--bare'" + ']';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't634-guard-bare-mutant-'));
  const mutantPath = path.join(tmpDir, 'test-fixture-bare-mutant.js');

  const mutantSource =
    "'use strict';\n" +
    'function buildBareMirror(dir) {\n' +
    "  execFileSync('git', " +
    unpinnedBareArray +
    ', { cwd: dir });\n' +
    '}\n';

  fs.writeFileSync(mutantPath, mutantSource, 'utf8');
  let findings;
  try {
    findings = scanFileForViolations(mutantPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(
    findings.length,
    1,
    `Test 4 FAIL: expected exactly 1 finding in the synthetic unpinned bare-repo mutant, got ${findings.length}`
  );
  assert.strictEqual(
    findings[0].line,
    3,
    `Test 4 FAIL: expected the finding on line 3, got line ${findings[0].line}`
  );
  console.log(
    `Test 4 passed: synthetic unpinned bare-repo mutant caught at test-fixture-bare-mutant.js:${findings[0].line}`
  );
}

testCleanTreeHasZeroFindings();
testAllowClassesDoNotFalsePositive();
testMutantIsCaught();
testBareRepoMutantIsCaught();

console.log('\nAll T-634 fixture git-init branch-pin guard tests passed.');

module.exports = {
  scanFileForViolations,
  findUnpinnedGitInits,
  listTestFixtureScripts,
};
