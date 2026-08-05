'use strict';
// T-610 — Guard against a TENTH instance of the unbounded heading-anchored
// block matcher (see T-606/T-607/T-608/T-609). A task-heading-anchored
// regex whose non-greedy "any character" gap has no block-boundary concept
// (not terminated by a lookahead or a literal end-delimiter) can read past
// the end of the target block: when the target block lacks the field being
// matched, the access silently lands in a LATER block. Nine instances of
// this shape were independently hand-written across four scripts over
// three months, before the canonical bounded helpers
// (locateTaskBlock/extractBlockField/setBlockField/updateTaskField/
// parseAllTaskBlocks, all in mavp-operator-lib.js) existed to reach for
// instead. This test scans every scripts/mavp-operator-*.js file for a NEW
// instance of that shape.
//
// Detection is a lightweight static text scan (matching the style of this
// repo's other guard scripts — mavp-manifest-guard.js,
// mavp-private-names-guard.js, mavp-operator-doc-sync-check.js — none of
// which parse a JS AST), not a JS parser. It is scoped narrowly to the
// defect class this task exists to close: a task-heading marker (three
// literal `#` characters) followed, within a short preceding window, by the
// non-greedy dot-all gap, where that gap is not immediately bounded (after
// skipping any immediately-following closing parens, for a gap sitting
// inside one or more capture groups) by a lookahead assertion.
//
// FILE SCOPE — every scripts/mavp-operator-*.js file, i.e. every file the
// scripts/mavp-operator bash wrapper can dispatch to (it invokes
// `node "$SCRIPT_DIR/mavp-operator-<verb>.js"` for each flag it recognizes
// — see scripts/mavp-operator). A NEW mutating operator command is only
// reachable through the CLI at all if it lands as
// scripts/mavp-operator-<verb>.js, so this glob covers every future
// mutating script BY CONSTRUCTION, not by enumeration — a hardcoded
// four/five-file allowlist would let a fifth (or fifteenth) script escape
// coverage entirely, which defeats the point of the task. The one way a new
// mutating script escapes this guard is to NOT follow the
// mavp-operator-<verb>.js naming convention — but then scripts/mavp-operator
// can't dispatch to it either, so it isn't a reachable operator command in
// the first place; it would be dead code, not a covered-then-uncovered gap.
// scripts/mavp-validator.js and scripts/mavp-skill-reflect.js are
// deliberately OUTSIDE this glob and outside this task's scope — the
// validator's own section-aware parser is its own domain (per the brief).
// test-*.js fixture files are also outside this glob, by construction
// (their name doesn't start with "mavp-operator-") — several of them
// deliberately embed this exact shape for red-run assertions, and coexist
// with this guard rather than being flagged by it.
//
// Per the "Reserved shapes (bounded, not universal)" clause in
// .claude/rules/scripts.md, the detection pattern is constructed at RUNTIME
// (string concatenation) rather than written as one contiguous literal, so
// neither this file's own source nor the rules prose describing the shape
// in words ever self-match a broadened future scan.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const SCRIPTS_DIR = __dirname;

// Constructed at runtime so this file never contains the forbidden shape
// as one contiguous literal substring.
//
// TWO raw-text variants of the gap must both be checked, because a
// heading-anchored matcher necessarily interpolates a taskId (and often a
// field name) at runtime, which forces it into `new RegExp(\`...\`)`
// template-literal form rather than a plain `/.../ ` regex literal — and a
// template literal needs a DOUBLED backslash in its source text to produce
// a single backslash in the resulting regex source string. Every real
// historical instance of this defect (confirmed against the pre-T-608 code
// removed by commit 5786e68) used exactly this doubled-backslash raw form,
// e.g. `(###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Status:\\*\\*)\\s+\\S+`.
// The currently-bounded gaps in lib.js/close-session.js don't need
// interpolation (a fixed field name), so they use plain regex-literal
// syntax with single backslashes instead — both forms are live in the tree
// today and must both be handled.
const HEADING_MARKER = '#'.repeat(3); // "###"
const GAP_LITERAL = '[' + '\\s\\S]*?'; // regex-literal source form: [\s\S]*?
const GAP_TEMPLATE = '[' + '\\\\s\\\\S]*?'; // template-literal source form: [\\s\\S]*?
const GAP_VARIANTS = [GAP_LITERAL, GAP_TEMPLATE];
const LOOKAHEAD_OPEN = '(?' + '='; // a bounded gap's legitimate terminator
const HEADING_WINDOW = 300; // chars to look backward for a heading marker

/**
 * Strip JS block comments (/* ... *\/, including JSDoc) from `source`,
 * replacing each with an equal number of newlines so character offsets in
 * the stripped text still map to the same line numbers as the original
 * file. This exists specifically so a PROSE MENTION of the forbidden shape
 * inside a comment (e.g. mavp-operator-set-status.js's T-608 JSDoc, which
 * describes the shape in words with both markers present) is never
 * mistaken for a live regex construct — the reserved-shapes trap this guard
 * must not fall into. Single-line `//` comments are not stripped: no known
 * instance embeds the shape that way, and stripping them risks corrupting
 * string/regex literals that legitimately contain `//` (e.g. a URL).
 */
function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlineCount = (match.match(/\n/g) || []).length;
    return '\n'.repeat(newlineCount);
  });
}

function lineNumberAt(text, index) {
  let count = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

/**
 * Find every occurrence of every gap variant in `source`, as
 * {index, length} pairs sorted by position. A single position can only
 * ever match one variant (they have different raw text), so no dedup is
 * needed beyond the sort.
 */
function findAllGapOccurrences(source) {
  const occurrences = [];
  for (const gap of GAP_VARIANTS) {
    let searchFrom = 0;
    for (;;) {
      const index = source.indexOf(gap, searchFrom);
      if (index === -1) break;
      occurrences.push({ index, length: gap.length });
      searchFrom = index + gap.length;
    }
  }
  occurrences.sort((a, b) => a.index - b.index);
  return occurrences;
}

/**
 * Scan `source` (already comment-stripped) for the unbounded
 * heading-anchored matcher shape. Whole-file (not per-line) scanning is
 * deliberate: a template literal built across two concatenated lines would
 * put the heading marker and the gap on different source lines, and a
 * strictly per-line scan would miss it.
 *
 * @param {string} source - comment-stripped file text
 * @returns {Array<{line: number, snippet: string}>}
 */
function findUnboundedHeadingMatchers(source) {
  const findings = [];

  for (const { index: gapIndex, length: gapLength } of findAllGapOccurrences(source)) {
    // Bounded when (after skipping any immediately-following closing
    // parens, for a gap sitting inside one or more capture groups) the very
    // next thing is a lookahead assertion opener.
    let after = gapIndex + gapLength;
    while (source[after] === ')') after++;
    const bounded = source.slice(after, after + LOOKAHEAD_OPEN.length) === LOOKAHEAD_OPEN;
    if (bounded) continue;

    const windowStart = Math.max(0, gapIndex - HEADING_WINDOW);
    const precedingWindow = source.slice(windowStart, gapIndex);
    const headingAnchored = precedingWindow.includes(HEADING_MARKER);
    if (!headingAnchored) continue;

    const line = lineNumberAt(source, gapIndex);
    const lineText = source.split('\n')[line - 1] || '';
    findings.push({ line, snippet: lineText.trim() });
  }

  return findings;
}

function scanFileForViolations(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const stripped = stripBlockComments(raw);
  return findUnboundedHeadingMatchers(stripped);
}

function listMutatingOperatorScripts() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => name.startsWith('mavp-operator-') && name.endsWith('.js'))
    .sort()
    .map((name) => path.join(SCRIPTS_DIR, name));
}

function testCleanTreeHasZeroFindings() {
  const files = listMutatingOperatorScripts();
  assert.ok(files.length > 0, 'Test 1 FAIL: expected to find at least one mavp-operator-*.js file to scan');

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
    `Test 1 FAIL: found ${allFindings.length} unbounded heading-anchored matcher(s):\n${allFindings.join('\n')}`
  );
  console.log(
    `Test 1 passed: zero unbounded heading-anchored matchers across ${files.length} scripts/mavp-operator-*.js files`
  );
}

function testAllowClassesDoNotFalsePositive() {
  // Allow-class 1a: a CAPTURED gap bounded by a lookahead (the real shape at
  // mavp-operator-lib.js and mavp-operator-close-session.js's Evidence
  // extraction — the heading marker sits inside the lookahead, AFTER the
  // gap, which must not matter since the gap is already bounded).
  const boundedByLookaheadCaptured =
    'block.match(/[-*]\\s+\\*\\*Evidence:\\*\\*\\s+(' +
    GAP_LITERAL +
    ')' +
    LOOKAHEAD_OPEN +
    '\\n[-*]\\s+\\*\\*|\\n' +
    HEADING_MARKER +
    '|\\s*$)/i);';

  // Allow-class 1b: an UNCAPTURED gap bounded by a lookahead, no heading
  // marker at all (the real shape at mavp-operator-close-session.js's
  // HANDOFF.md section parsing).
  const boundedByLookaheadUncaptured =
    '/^## Last update\\n' + GAP_LITERAL + LOOKAHEAD_OPEN + '\\n##|$)/m';

  // Allow-class 2: a JSDoc comment describing the shape in prose (the real
  // text at mavp-operator-set-status.js:111-119, planted by T-608).
  const proseComment =
    '/**\n' +
    ' * unbounded `' +
    GAP_LITERAL +
    '` matchers that did not stop at the next\n' +
    ' * `' +
    HEADING_MARKER +
    ' T-` heading.\n' +
    ' */\n' +
    'function readCurrentStatus() {}\n';

  assert.strictEqual(
    findUnboundedHeadingMatchers(stripBlockComments(boundedByLookaheadCaptured)).length,
    0,
    'Test 2a FAIL: a captured gap bounded by a lookahead must not be flagged'
  );
  assert.strictEqual(
    findUnboundedHeadingMatchers(stripBlockComments(boundedByLookaheadUncaptured)).length,
    0,
    'Test 2b FAIL: an uncaptured gap bounded by a lookahead must not be flagged'
  );
  assert.strictEqual(
    findUnboundedHeadingMatchers(stripBlockComments(proseComment)).length,
    0,
    'Test 2c FAIL: a JSDoc comment describing the shape in prose must not be flagged'
  );
  console.log(
    'Test 2 passed: documented allow-classes (captured lookahead-bounded gap, uncaptured lookahead-bounded gap, prose comment) do not false-positive'
  );
}

function testMutantIsCaught() {
  // Regex-literal form (single-backslash raw text) — a contrived but valid
  // construction (fixed literal task ID, no interpolation).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't610-guard-mutant-'));
  const mutantPath = path.join(tmpDir, 'mavp-operator-fixture.js');

  const mutantSource =
    "'use strict';\n" +
    'function readField(markdown) {\n' +
    '  const re = /(' +
    HEADING_MARKER +
    '\\s+T-XXX\\s+—' +
    GAP_LITERAL +
    '- \\*\\*Status:\\*\\*)\\s+\\S+/m;\n' +
    '  return re.exec(markdown);\n' +
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
    `Test 3 FAIL: expected exactly 1 finding in the synthetic mutant, got ${findings.length}`
  );
  assert.strictEqual(
    findings[0].line,
    3,
    `Test 3 FAIL: expected the finding on line 3, got line ${findings[0].line}`
  );
  console.log(`Test 3 passed: regex-literal-form synthetic mutant caught at mavp-operator-fixture.js:${findings[0].line}`);
}

function testTemplateLiteralMutantIsCaught() {
  // Template-literal form (doubled-backslash raw text) — the shape every
  // REAL historical instance actually took, since interpolating a taskId
  // forces `new RegExp(\`...\`)` construction. Pinned against the exact
  // pre-T-608 line removed by commit 5786e68.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't610-guard-template-mutant-'));
  const mutantPath = path.join(tmpDir, 'mavp-operator-fixture2.js');

  const mutantSource =
    "'use strict';\n" +
    'function updateTaskStatusField(markdown, taskId, newStatus) {\n' +
    "  const escaped = taskId.replace('-', '\\\\-');\n" +
    '  const blockPattern = new RegExp(\n' +
    '    `(' +
    HEADING_MARKER +
    '\\\\s+${escaped}\\\\s+—' +
    GAP_TEMPLATE +
    '- \\\\*\\\\*Status:\\\\*\\\\*)\\\\s+\\\\S+`,\n' +
    "    'm'\n" +
    '  );\n' +
    '  return markdown;\n' +
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
    `Test 4 FAIL: expected exactly 1 finding in the template-literal-form mutant, got ${findings.length}`
  );
  assert.strictEqual(
    findings[0].line,
    5,
    `Test 4 FAIL: expected the finding on line 5, got line ${findings[0].line}`
  );
  console.log(`Test 4 passed: template-literal-form synthetic mutant caught at mavp-operator-fixture2.js:${findings[0].line}`);
}

testCleanTreeHasZeroFindings();
testAllowClassesDoNotFalsePositive();
testMutantIsCaught();
testTemplateLiteralMutantIsCaught();

console.log('\nAll T-610 unbounded-block-matcher guard tests passed.');

module.exports = {
  scanFileForViolations,
  findUnboundedHeadingMatchers,
  stripBlockComments,
  listMutatingOperatorScripts,
};
