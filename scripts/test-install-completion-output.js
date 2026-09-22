'use strict';
// Regression test: T-754 — installer completion output names restart then
// /session-start.
//
// Problem this guards against: a fresh install's completion message pointed
// at ONBOARDING.md by filename and never named the /session-start command
// that actually delivers it, and never said the editor must be restarted
// before that command is discoverable at all. A non-technical adopter
// stopped exactly here in a real install. This test pins the fixed wording
// contract so a future edit cannot silently regress it:
//
//   (a) fresh install prints a numbered two-step instruction after the
//       "Mavericks is installed" line: step 1 tells the reader to restart
//       their editor, step 2 tells them to type /session-start, and the
//       restart line appears strictly before the /session-start line.
//   (b) the filename ONBOARDING.md never appears anywhere in fresh-install
//       stdout.
//   (c) no "wait" wording and no seconds-count wording appears anywhere in
//       fresh-install stdout.
//   (d) the first sentence of each numbered step contains no backticked
//       token other than /session-start.
//   (e) `--update` on the same directory does NOT print the restart step
//       (and does not mention /session-start either — an existing adopter
//       re-syncing already has a working .claude/ tree).
//
// Runs the real mavp-install.js from this checkout's own scripts/ dir
// (FRAMEWORK_DIR resolves to __dirname inside mavp-install.js, so no
// MAVERICKS_HOME pinning is needed for that). Passes --stale-source-ok on
// every invocation per the hermetic test-env pinning convention in
// .claude/rules/scripts.md — this test is not exercising the
// behind-upstream guard, so its outcome must not depend on live git
// topology. Every invocation targets a tmp-dir fixture; the real mavericks
// tree is never modified. Plain node, no npm deps. Exit 0 = pass.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function runInstaller(args, cwd) {
  return execFileSync('node', [INSTALL_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function firstSentence(line) {
  // Strip the leading step number ("1. " / "2. ") before hunting for the
  // sentence-ending period, so "2." itself is never mistaken for it.
  const body = line.replace(/^\s*\d+\.\s*/, '');
  const idx = body.indexOf('.');
  return idx === -1 ? body : body.slice(0, idx + 1);
}

function backtickedTokens(text) {
  const matches = text.match(/`([^`]+)`/g) || [];
  return matches.map(m => m.slice(1, -1));
}

// Matches the literal /session-start command written as its own token in
// prose (preceded by start-of-string/whitespace/"(", followed by
// end-of-string/whitespace/sentence punctuation) — but NOT the substring
// "/session-start" that appears inside a file path like
// ".claude/skills/session-start/SKILL.md" (there it is preceded by "skills"
// with no whitespace, and followed by another "/").
const SESSION_START_COMMAND_RE = /(?:^|[\s(])\/session-start(?=[\s.,:!?)]|$)/;

function main() {
  const targetDir = makeScratchDir('mavp-t754-fresh-');
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: targetDir });

  const freshOutputRaw = runInstaller(['.', '--yes', '--stale-source-ok'], targetDir);
  const freshOutputFull = stripAnsi(freshOutputRaw);
  const fullLines = freshOutputFull.split('\n');

  // Scope every assertion below to the completion message itself — the block
  // printed after the "Mavericks is installed" banner. Everything above that
  // line is the per-file installation log (e.g. "ONBOARDING.md (from
  // template)"), which is untouched by this task and legitimately still
  // names files it created.
  const bannerIdx = fullLines.findIndex(l => l.includes('Mavericks is installed in this project'));
  assert.ok(bannerIdx !== -1, 'FAIL: fresh-install stdout does not contain the "Mavericks is installed" banner line');
  const freshLines = fullLines.slice(bannerIdx);
  const freshOutput = freshLines.join('\n');

  // (b) ONBOARDING.md filename absent entirely from the completion message.
  assert.ok(
    !freshOutput.includes('ONBOARDING.md'),
    'FAIL: completion message still names ONBOARDING.md — the reader should never be told to open it by hand'
  );

  // (a) numbered two-step instruction with correct ordering.
  const restartLineIdx = freshLines.findIndex(l => /restart/i.test(l));
  const sessionStartLineIdx = freshLines.findIndex(l => SESSION_START_COMMAND_RE.test(l));
  assert.ok(restartLineIdx !== -1, 'FAIL: fresh-install stdout does not mention restarting the editor');
  assert.ok(sessionStartLineIdx !== -1, 'FAIL: fresh-install stdout does not mention /session-start');
  assert.ok(
    restartLineIdx < sessionStartLineIdx,
    `FAIL: restart line (index ${restartLineIdx}) must appear strictly before the /session-start line (index ${sessionStartLineIdx})`
  );

  const restartLine = freshLines[restartLineIdx];
  const sessionStartLine = freshLines[sessionStartLineIdx];
  assert.ok(/^1\./.test(restartLine.trim()), `FAIL: restart line is not step 1: "${restartLine}"`);
  assert.ok(/^2\./.test(sessionStartLine.trim()), `FAIL: /session-start line is not step 2: "${sessionStartLine}"`);

  // Editor named explicitly (Claude Code or VS Code) — the reader is told
  // WHAT to restart, not left to guess.
  assert.ok(
    /claude code/i.test(restartLine) && /vs code/i.test(restartLine),
    `FAIL: restart step must name both Claude Code and VS Code: "${restartLine}"`
  );

  // (c) no "wait" wording, no seconds-count wording, anywhere in the output.
  assert.ok(!/\bwait/i.test(freshOutput), 'FAIL: fresh-install stdout contains "wait" wording');
  assert.ok(
    !/\d+\s*seconds?\b/i.test(freshOutput),
    'FAIL: fresh-install stdout contains a seconds-count'
  );

  // (d) first sentence of each step: no backticked token other than /session-start.
  for (const line of [restartLine, sessionStartLine]) {
    const sentence = firstSentence(line);
    const tokens = backtickedTokens(sentence);
    for (const token of tokens) {
      assert.strictEqual(
        token,
        '/session-start',
        `FAIL: first sentence "${sentence}" has a backticked token other than /session-start: "${token}"`
      );
    }
  }
  // The /session-start step's first sentence must actually contain the command.
  assert.ok(
    SESSION_START_COMMAND_RE.test(firstSentence(sessionStartLine)),
    `FAIL: first sentence of step 2 does not contain /session-start: "${firstSentence(sessionStartLine)}"`
  );

  console.log('Assertion 1 passed: fresh install prints restart (step 1) before /session-start (step 2), ONBOARDING.md absent, no wait/seconds wording, no stray backticked tokens');

  // (e) --update does not print the restart step or mention /session-start.
  const updateOutputRaw = runInstaller(['.', '--update', '--stale-source-ok'], targetDir);
  const updateOutput = stripAnsi(updateOutputRaw);
  assert.ok(
    !/restart your editor/i.test(updateOutput),
    'FAIL: --update stdout prints the restart step — an existing adopter should not see it'
  );
  assert.ok(
    !SESSION_START_COMMAND_RE.test(updateOutput),
    'FAIL: --update stdout mentions /session-start as a command — an existing adopter should not see it'
  );

  console.log('Assertion 2 passed: --update prints neither the restart step nor /session-start');

  fs.rmSync(targetDir, { recursive: true, force: true });

  console.log('\nAll test-install-completion-output.js assertions passed.');
}

main();
