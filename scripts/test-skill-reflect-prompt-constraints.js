'use strict';
// T-703 — constraint-blindness disclosure in the reflect optimizer prompt,
// plus a conflict-check step in the human review gate.
//
// Background (live incident): the optimizer prompt is built from exactly
// two inputs — the protected-stripped role spec and the two scored
// minibatches. It never sees `.claude/rules/*.md`, `CLAUDE.md`, or
// `docs/core/ORCHESTRATION_RULES.md`. On a live adopter run it proposed,
// in good faith, a developer-spec edit reading in substance "run the full
// existing test suite" — a categorical violation of
// docs/core/ORCHESTRATION_RULES.md's "Test-execution scope (worktree
// developers)" the optimizer had simply never been shown.
//
// This test exercises the two new pure helpers in mavp-operator-lib.js —
// buildOptimizerPrompt() and renderConflictCheckChecklist() — with plain
// fixture objects only. Zero network, no SDK import: neither helper (nor
// this test) requires '@anthropic-ai/sdk', matching the offline-testable
// pattern already used by parseOptimizerResponse and
// splitTrajectoriesForReflect.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const lib = require('./mavp-operator-lib');
const { buildOptimizerPrompt, renderConflictCheckChecklist, parseOptimizerResponse } = lib;

assert.strictEqual(
  typeof buildOptimizerPrompt,
  'function',
  'buildOptimizerPrompt must be exported as a function from mavp-operator-lib.js'
);
assert.strictEqual(
  typeof renderConflictCheckChecklist,
  'function',
  'renderConflictCheckChecklist must be exported as a function from mavp-operator-lib.js'
);

// ---------------------------------------------------------------------------
// Assertion 0: mavp-operator-lib.js never REQUIRES the SDK package —
// buildOptimizerPrompt is a pure string builder, not a network call.
// (mavp-skill-reflect.js is the ONLY script permitted to require the SDK,
// and only lazily inside main() — see .claude/rules/scripts.md. The lib
// is allowed to mention the package name in a doc comment; it must never
// `require()` it.)
// ---------------------------------------------------------------------------
{
  const sdkPackageName = ['@anthropic-ai', 'sdk'].join('/');
  const libSrc = fs.readFileSync(path.join(__dirname, 'mavp-operator-lib.js'), 'utf8');

  assert.ok(
    !libSrc.includes(`require('${sdkPackageName}')`) && !libSrc.includes(`require("${sdkPackageName}")`),
    'Assertion 0 FAIL: mavp-operator-lib.js must not require() the SDK package — buildOptimizerPrompt must have no SDK dependency'
  );
}

// ---------------------------------------------------------------------------
// Fixture inputs — minimal shape buildOptimizerPrompt() needs.
// ---------------------------------------------------------------------------
const minimalSuccessBatch = [{ taskId: 'T-050', score: 1.0 }];
const minimalFailureBatch = [{ taskId: 'T-098', score: 0.1 }];

const prompt = buildOptimizerPrompt({
  role: 'developer',
  strippedSpec: '## Working practices\nSome editable spec text.',
  successBatch: minimalSuccessBatch,
  failureBatch: minimalFailureBatch,
  promptCaveat: null,
});

assert.strictEqual(typeof prompt, 'string', 'Assertion 1 FAIL: buildOptimizerPrompt must return a string');

// ---------------------------------------------------------------------------
// Assertion 2: the prompt discloses that the project's operating
// constraints — the rules directory, CLAUDE.md, and
// docs/core/ORCHESTRATION_RULES.md — were NOT provided.
// ---------------------------------------------------------------------------
assert.ok(
  /\.claude\/rules/.test(prompt),
  'Assertion 2a FAIL: prompt must name the project rules directory (.claude/rules)'
);
assert.ok(
  prompt.includes('CLAUDE.md'),
  'Assertion 2b FAIL: prompt must name CLAUDE.md'
);
assert.ok(
  prompt.includes('docs/core/ORCHESTRATION_RULES.md'),
  'Assertion 2c FAIL: prompt must name docs/core/ORCHESTRATION_RULES.md'
);
assert.ok(
  /NOT given/i.test(prompt) || /not been given/i.test(prompt) || /were NOT/i.test(prompt),
  'Assertion 2d FAIL: prompt must explicitly disclose these corpora were NOT provided'
);

// ---------------------------------------------------------------------------
// Assertion 3: the prompt prohibits edits that mandate process-level
// behavior, naming each of the five required categories, and directs
// process-shaped remedies into rationale text only (not an edit
// operation).
// ---------------------------------------------------------------------------
assert.ok(
  /test-execution scope/i.test(prompt),
  'Assertion 3a FAIL: prompt must name test-execution scope as a prohibited edit category'
);
assert.ok(
  /git operations/i.test(prompt),
  'Assertion 3b FAIL: prompt must name git operations as a prohibited edit category'
);
assert.ok(
  /push\/commit rituals/i.test(prompt) || (/push/i.test(prompt) && /commit rituals/i.test(prompt)),
  'Assertion 3c FAIL: prompt must name push/commit rituals as a prohibited edit category'
);
assert.ok(
  /task registration or status/i.test(prompt),
  'Assertion 3d FAIL: prompt must name task registration or status transitions as a prohibited edit category'
);
assert.ok(
  /permissions/i.test(prompt),
  'Assertion 3e FAIL: prompt must name permissions as a prohibited edit category'
);
assert.ok(
  /rationale text only/i.test(prompt),
  'Assertion 3f FAIL: prompt must direct process-shaped remedies into rationale text only, not an edit operation'
);
assert.ok(
  /do not propose/i.test(prompt) || /must not/i.test(prompt),
  'Assertion 3g FAIL: prompt must contain an explicit prohibition, not just a description'
);

// ---------------------------------------------------------------------------
// Assertion 4 (the trap): a NEGATIVE assertion that no prompt text claims
// the constraints WERE provided — guards against a future edit that
// contradicts itself (e.g. an accidental "see the attached rules" line
// with no attachment).
// ---------------------------------------------------------------------------
assert.ok(
  !/you (have been|were) given (the |)(full |)(constraints|rules|orchestration)/i.test(prompt),
  'Assertion 4 FAIL: prompt must NOT contain any claim that the constraints corpora were provided'
);
assert.ok(
  !/these are all the rules/i.test(prompt),
  'Assertion 4 FAIL: prompt must NOT claim exhaustiveness of any rules it does show'
);
assert.ok(
  !/attached (are|is) (the |)(rules|constraints)/i.test(prompt),
  'Assertion 4 FAIL: prompt must NOT claim rules/constraints were attached'
);

// ---------------------------------------------------------------------------
// Assertion 5: the prompt still contains the current role, spec, and
// batch content — the disclosure is additive, it does not replace the
// existing prompt content.
// ---------------------------------------------------------------------------
assert.ok(prompt.includes('developer'), 'Assertion 5a FAIL: prompt must still name the role');
assert.ok(prompt.includes('Some editable spec text.'), 'Assertion 5b FAIL: prompt must still include the stripped spec text');
assert.ok(prompt.includes('T-050'), 'Assertion 5c FAIL: prompt must still include success-batch content');
assert.ok(prompt.includes('T-098'), 'Assertion 5d FAIL: prompt must still include failure-batch content');

// ---------------------------------------------------------------------------
// Assertion 6: promptCaveat threading is preserved — when provided, it
// still appears in the built prompt (same behavior as the pre-T-703
// inline version).
// ---------------------------------------------------------------------------
{
  const promptWithCaveat = buildOptimizerPrompt({
    role: 'developer',
    strippedSpec: 'SPEC',
    successBatch: minimalSuccessBatch,
    failureBatch: minimalFailureBatch,
    promptCaveat: 'Caution: unique caveat marker XYZQ123.',
  });
  assert.ok(
    promptWithCaveat.includes('Caution: unique caveat marker XYZQ123.'),
    'Assertion 6 FAIL: promptCaveat must still be threaded into the built prompt when provided'
  );
}

// ---------------------------------------------------------------------------
// Assertion 7 (criterion 2): the JSON response-format block is
// byte-identical to the pre-T-703 inline version — no change to the
// format contract parseOptimizerResponse() parses, and no change to
// parseOptimizerResponse() itself.
// ---------------------------------------------------------------------------
{
  const expectedFormatBlock = [
    'Respond with ONLY a JSON object in this exact format:',
    '{',
    '  "rationale": "one sentence explaining the key failure pattern observed",',
    '  "edits": [',
    '    {',
    '      "op": "add" | "delete" | "replace",',
    '      "targetSection": "section heading or \'end of file\'",',
    '      "rationale": "one sentence",',
    '      "before": "exact text to replace or delete (empty string for add)",',
    '      "after": "new text (empty string for delete)"',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  assert.ok(
    prompt.includes(expectedFormatBlock),
    'Assertion 7 FAIL: the JSON response-format block must be byte-identical to the pre-T-703 contract'
  );

  // parseOptimizerResponse() must still parse a response shaped exactly
  // like this format block describes — a live end-to-end contract check,
  // not just a source-text comparison.
  const fixtureResponse = {
    content: [{ type: 'text', text: JSON.stringify({ rationale: 'r', edits: [] }) }],
    stop_reason: 'end_turn',
  };
  const { result, error } = parseOptimizerResponse(fixtureResponse);
  assert.strictEqual(error, null, 'Assertion 7b FAIL: parseOptimizerResponse must still parse cleanly');
  assert.deepStrictEqual(
    result,
    { rationale: 'r', edits: [] },
    'Assertion 7c FAIL: parseOptimizerResponse output shape must be unchanged'
  );
}

// ---------------------------------------------------------------------------
// Assertion 8 (criterion 3): renderConflictCheckChecklist() names this
// project's rules directory, CLAUDE.md, and the framework's
// docs/core/ORCHESTRATION_RULES.md, phrased so it is correct in adopter
// repos ("this project's" / "the framework's" — never a private
// project-specific name).
// ---------------------------------------------------------------------------
{
  const checklist = renderConflictCheckChecklist();

  assert.ok(Array.isArray(checklist), 'Assertion 8a FAIL: renderConflictCheckChecklist must return an array');
  assert.ok(checklist.length > 0, 'Assertion 8b FAIL: renderConflictCheckChecklist must return non-empty content');

  const checklistText = checklist.join('\n');

  assert.ok(
    /\.claude\/rules/.test(checklistText),
    'Assertion 8c FAIL: checklist must name the project rules directory (.claude/rules)'
  );
  assert.ok(
    checklistText.includes('CLAUDE.md'),
    'Assertion 8d FAIL: checklist must name CLAUDE.md'
  );
  assert.ok(
    checklistText.includes('docs/core/ORCHESTRATION_RULES.md'),
    'Assertion 8e FAIL: checklist must name docs/core/ORCHESTRATION_RULES.md'
  );
  assert.ok(
    /this project's/i.test(checklistText),
    'Assertion 8f FAIL: checklist must be phrased corpus-agnostically ("this project\'s ...")'
  );
  assert.ok(
    /the framework's/i.test(checklistText),
    'Assertion 8g FAIL: checklist must be phrased corpus-agnostically ("the framework\'s ...")'
  );

  // Checkbox block: at least three distinct checkbox lines, one per
  // named corpus.
  const checkboxLines = checklist.filter((l) => /^-\s*\[ \]/.test(l));
  assert.strictEqual(
    checkboxLines.length,
    3,
    `Assertion 8h FAIL: checklist must contain exactly 3 checkbox lines (one per corpus), got ${checkboxLines.length}`
  );
}

// ---------------------------------------------------------------------------
// Assertion 9: mavp-skill-reflect.js actually wires both helpers in — the
// optimizer prompt is built via buildOptimizerPrompt() (not hand-inlined
// again), and every generated proposal embeds
// renderConflictCheckChecklist() output (source assertions, mirroring the
// wiring-check pattern used by test-skill-reflect-contrast-disclosure.js).
// ---------------------------------------------------------------------------
{
  const reflectSrc = fs.readFileSync(path.join(__dirname, 'mavp-skill-reflect.js'), 'utf8');

  assert.ok(
    reflectSrc.includes('buildOptimizerPrompt('),
    'Assertion 9a FAIL: mavp-skill-reflect.js must call buildOptimizerPrompt(...) to construct the optimizer prompt'
  );
  assert.ok(
    reflectSrc.includes('renderConflictCheckChecklist('),
    'Assertion 9b FAIL: mavp-skill-reflect.js must call renderConflictCheckChecklist(...) when writing every proposal'
  );
  // The checklist call must sit ahead of proposal-file writeFileSync, i.e.
  // wired into the file before it is written — not dead code.
  const checklistCallIdx = reflectSrc.indexOf('renderConflictCheckChecklist(');
  const writeIdx = reflectSrc.indexOf('fs.writeFileSync(PROPOSAL_FILE');
  assert.ok(
    checklistCallIdx > -1 && writeIdx > -1 && checklistCallIdx < writeIdx,
    'Assertion 9c FAIL: renderConflictCheckChecklist() must be called before the proposal file is written'
  );
}

console.log('All T-703 assertions passed.');
