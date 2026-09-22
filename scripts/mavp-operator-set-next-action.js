'use strict';
// T-750 — --set-next-action operator command gated by classifyNextAction.
//
// next_action has no sanctioned write path before this task: only
// --set-strategy-note and --handoff exist. Operators were forced to hand-edit
// PROCESS_STATE.json directly, violating the "auto-generated — do not edit
// manually" marker on PROCESS_STATE.md (which is generated FROM the JSON).
//
// DR-009 makes next_action_volatile_facts a FAILURE-severity validator check
// (exit 2, repair required). A write path that does not gate against it would
// let an operator book a value that blocks their very next commit — so this
// command runs classifyNextAction() BEFORE any write and refuses outright on
// volatile facts, naming them and naming the correct homes for narrative
// (--handoff --notes / --set-strategy-note). A value that does not begin
// with T-NNN is still written (with a non-blocking advisory) — the field's
// own contract permits standalone imperatives, and the validator does not
// block on next_action_unverified, only on next_action_volatile_facts.
const fs = require('fs');
const path = require('path');
const {
  printRepoIdentityHeader,
  guardMutatingRoot,
  classifyNextAction,
  generateProcessStateMd,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');

printRepoIdentityHeader(ROOT, { mutating: true });

const rootGuard = guardMutatingRoot(ROOT, '--set-next-action');
if (rootGuard.blocked) {
  process.exit(1);
}

const raw = process.argv[2];
if (raw === undefined) {
  console.log('Usage: --set-next-action "text" (empty string clears)');
  process.exit(1);
}

// Gate BEFORE any write. classifyNextAction() treats an empty/whitespace-only
// string as { directive: true, volatile_facts: [] } — clearing the field can
// never itself trip the volatile-fact refusal.
const classification = classifyNextAction(raw);

if (classification.volatile_facts.length > 0) {
  console.log(
    [
      `REFUSED: --set-next-action rejects a value containing volatile fact(s): ${classification.volatile_facts.join(', ')}`,
      '  next_action is a routing directive, not a narrative log — PROCESS_STATE.json is byte-unchanged.',
      '  Volatile state facts (version numbers asserted as current state, commit counts, push state)',
      '  already have a source of truth (scripts/mavp-version.js, git, GitHub) — reference it instead.',
      '  Cross-session narrative belongs in HANDOFF.md via --handoff --notes "...".',
      '  Intra-wave strategy context belongs in --set-strategy-note "...".',
    ].join('\n')
  );
  process.exit(1);
}

let current = {};
try {
  current = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
} catch {
  /* start fresh */
}

const trimmed = raw.trim();
const nextActionValue = trimmed.length === 0 ? null : raw;

const updated = {
  ...current,
  next_action: nextActionValue,
  last_updated: new Date().toISOString().slice(0, 10),
};

fs.writeFileSync(PROCESS_STATE_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');

// Keep PROCESS_STATE.md's auto-generated content truthful — a successful
// write here must not leave the generated file stale.
generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);

if (nextActionValue === null) {
  console.log('next_action cleared.');
} else {
  console.log(`next_action set: ${nextActionValue}`);
  if (!classification.directive) {
    console.log(
      'Advisory (next_action_unverified): value does not begin with T-NNN — informational only, the validator does not block on this.'
    );
  }
}
