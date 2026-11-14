'use strict';
// mavp-corpus-guard: always-run
// Corpus-wide guard: run-tests.js appends this to every --filter run (.claude/rules/scripts.md).
// mavp-declared-in: .claude/rules/docs.md :: Layer-0 ceiling
// T-890 — ceiling guard for the session-start load. Measures the repository's own
// tree through computeReport() (scripts/mavp-context-report.js) and fails when the
// always-loaded set (CLAUDE.md + its @ imports + unscoped rules) or the
// session-start static load grows past the pinned ceilings below.
//
// Each ceiling is the value measured at this task's base commit plus 5 percent
// headroom, rounded up: always_loaded_chars 25579 -> 26858, and
// session_start_static_chars 33738 -> 35425. Raising a constant needs a stated
// reason in the commit message (.claude/rules/docs.md, Layer-0 ceiling).
//
// MAVP_CONTEXT_CEILING_ROOT points the guard at another tree (used to demonstrate
// the guard can fail, against a scratch copy); unset, it measures this checkout.

const path = require('node:path');
const assert = require('node:assert');
const { computeReport } = require('./mavp-context-report.js');

const ALWAYS_LOADED_CEILING_CHARS = 26858;
const SESSION_START_STATIC_CEILING_CHARS = 35425;

const root = process.env.MAVP_CONTEXT_CEILING_ROOT
  ? path.resolve(process.env.MAVP_CONTEXT_CEILING_ROOT)
  : path.resolve(__dirname, '..');

const report = computeReport(root, null);

const advice =
  'Place new text in a path-scoped rule (.claude/rules/*.md with paths: frontmatter), a skill ' +
  '(.claude/skills/) or a doc under docs/ instead of CLAUDE.md, its @ imports or an unscoped rule; ' +
  "see CLAUDE.md's Load map for where each kind of text belongs. Raising a ceiling constant in " +
  'scripts/test-context-ceiling.js needs a stated reason in the commit message.';

assert.ok(
  report.always_loaded_chars <= ALWAYS_LOADED_CEILING_CHARS,
  `Layer-0 ceiling exceeded: always_loaded_chars is ${report.always_loaded_chars}, ` +
    `ceiling ${ALWAYS_LOADED_CEILING_CHARS} (over by ${report.always_loaded_chars - ALWAYS_LOADED_CEILING_CHARS}). ${advice}`
);
assert.ok(
  report.session_start_static_chars <= SESSION_START_STATIC_CEILING_CHARS,
  `Session-start ceiling exceeded: session_start_static_chars is ${report.session_start_static_chars}, ` +
    `ceiling ${SESSION_START_STATIC_CEILING_CHARS} (over by ${report.session_start_static_chars - SESSION_START_STATIC_CEILING_CHARS}). ${advice}`
);

console.log(
  `test-context-ceiling passed: always_loaded_chars ${report.always_loaded_chars}/${ALWAYS_LOADED_CEILING_CHARS}, ` +
    `session_start_static_chars ${report.session_start_static_chars}/${SESSION_START_STATIC_CEILING_CHARS}`
);
