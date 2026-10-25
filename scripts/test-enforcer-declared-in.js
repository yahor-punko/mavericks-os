'use strict';
// mavp-corpus-guard: always-run
// mavp-declared-in: .claude/rules/scripts.md :: Declared-invariant header
// Corpus-wide guard (T-827): run-tests.js appends this to every --filter run (.claude/rules/scripts.md).
//
// Every marked corpus guard and every script the pre-commit / pre-push hooks
// invoke must carry, within its first 40 lines, a declared-in header line
// naming the layer-0/1 file and bold lead where its rule is declared, so a rule
// enforced mechanically is never declared only in the enforcer. The subject
// set is derived at run time from both sources (never hand-listed), and each
// source must be non-empty so an emptied scan can never pass vacuously.
//
// The marker and the header key are built by runtime concatenation wherever
// this file scans for them, so the scanner never matches itself through a
// literal anywhere below its own header.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_LINES = 40;
const MARKER = '// mavp-corpus' + '-guard: always-run';
const KEY = '// mavp-declared' + '-in:';
const ANCHOR_SEP = ' :: ';
const ALLOWED_PATH = /^(?:CLAUDE\.md|\.claude\/rules\/[^/]+\.md|\.claude\/agents\/[^/]+\.md)$/;

function firstLines(text) {
  return text.split('\n', SCAN_LINES);
}

function markedCorpusGuards(scriptsDir) {
  return fs.readdirSync(scriptsDir)
    .filter((n) => /^test-.*\.js$/.test(n))
    .filter((n) => firstLines(fs.readFileSync(path.join(scriptsDir, n), 'utf8')).some((l) => l.trim() === MARKER))
    .map((n) => path.join(scriptsDir, n));
}

function hookInvokedScripts(root) {
  const found = new Set();
  for (const hook of ['pre-commit', 'pre-push']) {
    const file = path.join(root, '.claude', 'hooks', hook);
    if (!fs.existsSync(file)) continue;
    // Whole-line comments are skipped: a script merely named in prose is not
    // one the hook invokes (the pre-push header names run-tests.js that way).
    const text = fs.readFileSync(file, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const m of text.matchAll(/([A-Za-z0-9_-]+)\.js\b/g)) {
      const candidate = path.join(root, 'scripts', m[1] + '.js');
      if (fs.existsSync(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

// Returns an array of failure messages for one subject file (empty = ok).
function checkSubject(subjectPath, root) {
  const name = path.basename(subjectPath);
  const lines = firstLines(fs.readFileSync(subjectPath, 'utf8')).map((l) => l.trim());
  const declared = lines.filter((l) => l.startsWith(KEY));
  if (declared.length === 0) {
    return [`${name}: no declared-in header line within its first ${SCAN_LINES} lines`];
  }
  const errors = [];
  for (const line of declared) {
    const rest = line.slice(KEY.length).trim();
    const at = rest.indexOf(ANCHOR_SEP);
    if (at < 0) {
      errors.push(`${name}: malformed declared-in line (expected "<path>${ANCHOR_SEP}<anchor>"): ${line}`);
      continue;
    }
    const cited = rest.slice(0, at).trim();
    const anchor = rest.slice(at + ANCHOR_SEP.length).trim();
    if (!ALLOWED_PATH.test(cited)) {
      errors.push(`${name}: declared-in path "${cited}" is not allowed (must be CLAUDE.md, a .claude/rules/*.md or a .claude/agents/*.md file)`);
      continue;
    }
    const abs = path.join(root, cited);
    if (!fs.existsSync(abs)) {
      errors.push(`${name}: declared-in path "${cited}" does not exist`);
      continue;
    }
    if (anchor === '' || !fs.readFileSync(abs, 'utf8').includes(anchor)) {
      errors.push(`${name}: anchor "${anchor}" is absent from ${cited}`);
    }
  }
  return errors;
}

// ---- live tree ----
const guards = markedCorpusGuards(__dirname);
const hookScripts = hookInvokedScripts(ROOT);
assert.ok(guards.length > 0, 'marked corpus guard set is empty — marker scan is broken');
assert.ok(hookScripts.length > 0, 'hook-invoked script set is empty — hook token scan is broken');

const subjects = [...new Set([...guards, ...hookScripts])];
const failures = [];
for (const s of subjects) failures.push(...checkSubject(s, ROOT));
assert.deepStrictEqual(failures, [], 'declared-in failures:\n  ' + failures.join('\n  '));

// ---- scratch-fixture failure cases (copies of a real subject) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-in-'));
try {
  const realSubject = path.join(__dirname, 'mavp-validator.js');
  const original = fs.readFileSync(realSubject, 'utf8');
  const headerLine = original.split('\n', SCAN_LINES).find((l) => l.trim().startsWith(KEY));
  assert.ok(headerLine, 'mavp-validator.js must carry its declared-in header');

  const scratch = (label, text) => {
    const p = path.join(tmp, label + '.js');
    fs.writeFileSync(p, text);
    return p;
  };

  // (1) header line removed -> fails naming the file
  const missing = checkSubject(scratch('missing-line', original.replace(headerLine + '\n', '')), ROOT);
  assert.strictEqual(missing.length, 1, 'removed header must yield one failure');
  assert.ok(missing[0].includes('missing-line.js'), 'failure must name the file: ' + missing[0]);

  // (2) anchor absent from the cited file -> names file, path and anchor
  const absentAnchor = checkSubject(
    scratch('absent-anchor', `${KEY} CLAUDE.md${ANCHOR_SEP}No such bold lead anywhere\n` + original), ROOT);
  assert.strictEqual(absentAnchor.length, 1);
  assert.ok(absentAnchor[0].includes('absent-anchor.js') && absentAnchor[0].includes('CLAUDE.md') &&
    absentAnchor[0].includes('No such bold lead anywhere'), 'failure must name file, path and anchor: ' + absentAnchor[0]);

  // (3) disallowed path -> names the disallowed path
  const badPath = checkSubject(
    scratch('bad-path', `${KEY} docs/core/ORCHESTRATION_RULES.md${ANCHOR_SEP}Wave closure\n`), ROOT);
  assert.strictEqual(badPath.length, 1);
  assert.ok(badPath[0].includes('bad-path.js') && badPath[0].includes('docs/core/ORCHESTRATION_RULES.md') &&
    badPath[0].includes('not allowed'), 'failure must name the disallowed path: ' + badPath[0]);

  // (4) a header past line 40 does not count
  const late = checkSubject(scratch('late-line', '\n'.repeat(SCAN_LINES) + `${KEY} CLAUDE.md${ANCHOR_SEP}Wave closure\n`), ROOT);
  assert.strictEqual(late.length, 1, 'a header beyond the first 40 lines must not count');
  console.log(missing[0]);
  console.log(absentAnchor[0]);
  console.log(badPath[0]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`test-enforcer-declared-in passed: ${guards.length} marked corpus guards + ${hookScripts.length} hook-invoked scripts (${subjects.length} subjects) all declare an existing anchor`);
