#!/usr/bin/env node
'use strict';

/**
 * mavp-skill-reflect.js — SkillOpt-inspired skill reflection loop (v1, human-gated)
 *
 * Usage: node scripts/mavp-skill-reflect.js <role>
 *
 * Exit codes:
 *   0 — proposal written (or skipped with a reason)
 *   1 — unrecoverable error (bad role arg, file read failure, missing API key)
 *
 * See docs/SKILL_OPTIMIZATION.md for the full specification.
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Resolve repo root (supports MAVERICKS_PROJECT_ROOT override, same as lib)
// ---------------------------------------------------------------------------
const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Lazy-import lib helpers (keeps the dependency explicit)
// ---------------------------------------------------------------------------
const lib = require('./mavp-operator-lib');
const {
  extractTrajectories,
  writeTrajectories,
  scoreTrajectory,
  splitTrajectoriesForReflect,
  parseOptimizerResponse,
  renderFailureContrastDisclosure,
  buildOptimizerPrompt,
  renderConflictCheckChecklist,
} = lib;

// ---------------------------------------------------------------------------
// CLI argument
// ---------------------------------------------------------------------------
const role = process.argv[2];

if (!role || !/^[a-z][a-z0-9-]*$/.test(role)) {
  console.error('Usage: node scripts/mavp-skill-reflect.js <role>');
  console.error('  <role> must be a lowercase slug matching a .claude/agents/<role>.md file.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const TRAJECTORIES_DIR = path.join(ROOT, '.mavp', 'trajectories');
const TRAJECTORIES_FILE = path.join(TRAJECTORIES_DIR, `${role}.jsonl`);
const SKILL_PROPOSALS_DIR = path.join(ROOT, 'SKILL_PROPOSALS');
const AGENT_SPEC_FILE = path.join(ROOT, '.claude', 'agents', `${role}.md`);
const today = new Date().toISOString().slice(0, 10);
const PROPOSAL_FILE = path.join(SKILL_PROPOSALS_DIR, `${role}-${today}.md`);

// ---------------------------------------------------------------------------
// Main async entry point
// ---------------------------------------------------------------------------
async function main() {
  // -----------------------------------------------------------------------
  // Step 1: Load / refresh trajectories
  // -----------------------------------------------------------------------
  // Always re-extract from TASK_STATUS so the file stays current
  console.log(`[reflect] Extracting trajectories for role: ${role}`);
  const freshTrajectories = extractTrajectories(role);
  writeTrajectories(role, freshTrajectories);
  console.log(`[reflect] Wrote ${freshTrajectories.length} ${freshTrajectories.length === 1 ? 'trajectory' : 'trajectories'} to ${TRAJECTORIES_FILE}`);

  // -----------------------------------------------------------------------
  // Step 2: Score each trajectory
  // -----------------------------------------------------------------------
  const scored = freshTrajectories.map((t) => ({
    ...t,
    score: scoreTrajectory(t),
  }));

  // -----------------------------------------------------------------------
  // Step 3: Minimum-N gate (≥ 8 scored trajectories)
  // -----------------------------------------------------------------------
  const N = scored.length;
  if (N < 8) {
    console.log(`\nError: insufficient trajectories for role "${role}".`);
    console.log(`Found: ${N} scored ${N === 1 ? 'trajectory' : 'trajectories'}. Minimum required: 8.`);
    console.log(`Run more tasks assigned to this role and re-run --reflect-skill.`);
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Step 4: Train / holdout split (T-699)
  //
  // Deterministic and taskId-keyed, but NOT a taskId-order prefix slice:
  // every trajectory scoring below 0.7 goes to train unconditionally (a
  // failure is the scarce contrast signal the failure minibatch below
  // consumes, so none may be withheld in the holdout — which no v1 code
  // path reads), and a trajectory at or above 0.7 goes to holdout only when
  // its numeric taskId modulo 10 is 7, 8, or 9. Modulo on the numeric id
  // makes a task's bucket a pure function of its own id — reproducible
  // across runs on the same input, and stable as the corpus grows, unlike
  // the previous localeCompare-sort + floor(n * 0.7) slice this replaces.
  // A score change from evidence enrichment (e.g. a task moving success ->
  // failure) can legitimately move that task holdout -> train — that is by
  // design, since a newly recognized failure must reach the optimizer. See
  // splitTrajectoriesForReflect() in mavp-operator-lib.js for the full rule
  // set and the corpus-measured defects this split fixes.
  // -----------------------------------------------------------------------
  const split = splitTrajectoriesForReflect(scored);
  const trainSet = split.trainSet;
  // const holdoutSet = split.holdoutSet; // reserved for v2
  const trainCount = trainSet.length;

  // -----------------------------------------------------------------------
  // Step 5: All-success / all-failure guard (applied on training set)
  // -----------------------------------------------------------------------
  const allSuccess = trainSet.every((t) => t.score >= 0.9);
  const allFailure = trainSet.every((t) => t.score <= 0.1);

  if (allSuccess || allFailure) {
    const label = allSuccess ? '≥0.9' : '≤0.1';
    console.log(`\nWarning: insufficient contrast signal for role "${role}".`);
    console.log(`All training trajectories score [${label}]. Cannot identify improvable patterns.`);
    console.log(`No proposal generated.`);
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Step 6: Check for ANTHROPIC_API_KEY (needed for the optimizer call below)
  // -----------------------------------------------------------------------
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    console.error('Set it before running this script:');
    console.error('  export ANTHROPIC_API_KEY=<your-key>');
    console.error('  node scripts/mavp-skill-reflect.js ' + role);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 7: Check SDK availability
  // -----------------------------------------------------------------------
  // @anthropic-ai/sdk is an OPTIONAL dependency (see package.json —
  // optionalDependencies) used only by this reflection feature. Core
  // operator tooling never requires this module, so the require stays
  // lazy here (inside main(), guarded by try/catch) rather than at
  // module load time — that way `npm install --omit=optional` still
  // yields a fully working core.
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    console.error('Error: reflection requires @anthropic-ai/sdk, which is not installed.');
    console.error('@anthropic-ai/sdk is an optional dependency used only by --reflect-skill.');
    console.error('Install it with:');
    console.error('  npm install');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 8: Check agent spec file exists
  // -----------------------------------------------------------------------
  if (!fs.existsSync(AGENT_SPEC_FILE)) {
    console.error(`Error: agent spec not found at ${AGENT_SPEC_FILE}`);
    console.error(`Available roles are listed in .claude/agents/`);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 9: Build success and failure minibatches (from training set only)
  // -----------------------------------------------------------------------
  const successBatch = trainSet
    .filter((t) => t.score >= 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const failureBatch = trainSet
    .filter((t) => t.score < 0.7)
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  // -----------------------------------------------------------------------
  // Step 9b: Empty-failure-batch guard
  // If no training trajectory scores below 0.70, there is no contrast signal
  // for the optimizer — exit cleanly without making an API call.
  // -----------------------------------------------------------------------
  if (failureBatch.length === 0) {
    console.log(`\nNo failure contrast: all ${trainCount} training trajectories score ≥ 0.70. Enrich evidence with needs_fix_rounds: to create contrast signal.`);
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Step 9c: Failure-batch contrast disclosure (T-700)
  //
  // Disclose, never block: a failure batch below the contrast floor
  // (docs/SKILL_OPTIMIZATION.md §12.2) is a healthy, common outcome on a
  // well-run project — it must not disable the reflection feature. It DOES
  // need to be visible to the Section 9 human reviewer and to the optimizer
  // model itself, since an undisclosed 1-vs-many contrast is exactly the
  // incident this task closes. Exit code and proposal-writing are
  // unaffected either way.
  // -----------------------------------------------------------------------
  const contrastDisclosure = renderFailureContrastDisclosure(successBatch, failureBatch);
  if (contrastDisclosure.warning) {
    console.log(`\n${contrastDisclosure.warning}`);
  }

  // -----------------------------------------------------------------------
  // Step 10: Load current spec and strip protected sections
  // -----------------------------------------------------------------------
  let specText;
  try {
    specText = fs.readFileSync(AGENT_SPEC_FILE, 'utf8');
  } catch (err) {
    console.error(`Error: could not read agent spec at ${AGENT_SPEC_FILE}: ${err.message}`);
    process.exit(1);
  }

  const stripped = specText.replace(
    /<!--\s*protected\s*-->[\s\S]*?<!--\s*\/protected\s*-->/gi,
    '[PROTECTED SECTION — NOT EDITABLE]'
  );

  // -----------------------------------------------------------------------
  // Step 11: Build optimizer prompt
  //
  // buildOptimizerPrompt() (T-703) discloses to the model that this
  // project's own operating rules (.claude/rules/*.md, CLAUDE.md) and the
  // framework's docs/core/ORCHESTRATION_RULES.md were NOT provided, and
  // prohibits it from proposing edits that mandate process-level behavior
  // (test-execution scope, git operations, push/commit rituals, task
  // registration/status, permissions) — see the function's doc comment in
  // mavp-operator-lib.js for the incident that motivated it. The JSON
  // response-format block inside it is unchanged from the pre-T-703
  // version.
  // -----------------------------------------------------------------------
  const systemPrompt =
    'You are a skill document optimizer. You analyze agent performance trajectories and propose minimal, targeted improvements to agent skill specifications. You must respond with a JSON object only.';

  const optimizerPrompt = buildOptimizerPrompt({
    role,
    strippedSpec: stripped,
    successBatch,
    failureBatch,
    promptCaveat: contrastDisclosure.promptCaveat,
  });

  // -----------------------------------------------------------------------
  // Step 12: Call optimizer model
  // -----------------------------------------------------------------------
  console.log(`[reflect] Calling optimizer model (claude-opus-5) for role: ${role}…`);

  let optimizerResult = null;
  let optimizerError = null;
  let response;

  try {
    const client = new Anthropic();
    // This is a direct Anthropic Messages API call, not a Claude Code
    // Agent-tool spawn — the Messages API `model` param does not accept
    // aliases (`opus`/`sonnet`/etc.), so a full model-id is required here,
    // unlike the alias-only rule for `.claude/agents/*` frontmatter and
    // Agent-tool spawn overrides (see docs/AGENT_SPEC.md — "Why aliases,
    // not full-ids"). Keep this pinned to the current Opus generation.
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: optimizerPrompt }],
      system: systemPrompt,
    });
  } catch (apiErr) {
    optimizerError = `API call failed: ${apiErr.message}`;
  }

  if (response && !optimizerError) {
    const parsed = parseOptimizerResponse(response);
    optimizerResult = parsed.result;
    optimizerError = parsed.error;
  }

  // -----------------------------------------------------------------------
  // Step 13: Enforce lr budget (max 2 edit operations)
  // -----------------------------------------------------------------------
  let edits = [];
  let overallRationale = '';

  if (optimizerResult && !optimizerError) {
    overallRationale = optimizerResult.rationale || '';
    edits = Array.isArray(optimizerResult.edits) ? optimizerResult.edits.slice(0, 2) : [];
  }

  // -----------------------------------------------------------------------
  // Step 14: Compute score stats for proposal metadata
  // -----------------------------------------------------------------------
  const trainScores = trainSet.map((t) => t.score);
  const minScore = Math.min(...trainScores);
  const maxScore = Math.max(...trainScores);

  // -----------------------------------------------------------------------
  // Step 15: Write proposal file (SKILL_PROPOSALS/<role>-<YYYY-MM-DD>.md)
  // -----------------------------------------------------------------------
  fs.mkdirSync(SKILL_PROPOSALS_DIR, { recursive: true });

  const proposalLines = [];
  proposalLines.push(`# Skill Proposal: ${role} — ${today}`);
  proposalLines.push('');
  proposalLines.push('## Metadata');
  proposalLines.push(`- Role: ${role}`);
  proposalLines.push(`- Trajectories used: ${trainCount} / ${N}`);
  proposalLines.push(`- Score range: ${minScore.toFixed(1)}–${maxScore.toFixed(1)}`);
  proposalLines.push(`- Generated: ${today}`);
  contrastDisclosure.metadataLines.forEach((line) => proposalLines.push(line));
  proposalLines.push('');
  if (contrastDisclosure.warning) {
    proposalLines.push(`> ${contrastDisclosure.warning}`);
    proposalLines.push('');
  }
  proposalLines.push('## Proposed edits (lr budget: 2)');
  proposalLines.push('');

  if (optimizerError) {
    proposalLines.push('> **Optimizer error:** ' + optimizerError);
    proposalLines.push('');
    proposalLines.push('No edits were generated due to optimizer error. Review manually.');
  } else if (edits.length === 0) {
    proposalLines.push('> **No edits proposed.** The optimizer found no actionable improvement patterns.');
    if (overallRationale) {
      proposalLines.push('');
      proposalLines.push(`**Optimizer rationale:** ${overallRationale}`);
    }
  } else {
    if (overallRationale) {
      proposalLines.push(`**Overall rationale:** ${overallRationale}`);
      proposalLines.push('');
    }

    edits.forEach((edit, idx) => {
      const op = edit.op || 'replace';
      const targetSection = edit.targetSection || 'unknown section';
      const editRationale = edit.rationale || '';
      const before = edit.before || '';
      const after = edit.after || '';

      proposalLines.push(`### Edit ${idx + 1} — ${op}`);
      proposalLines.push(`**Target section:** ${targetSection}`);
      proposalLines.push(`**Rationale:** ${editRationale}`);
      proposalLines.push('');
      proposalLines.push('**Before:**');
      proposalLines.push('```');
      proposalLines.push(op === 'add' ? '(none)' : before || '(none)');
      proposalLines.push('```');
      proposalLines.push('');
      proposalLines.push('**After:**');
      proposalLines.push('```');
      proposalLines.push(op === 'delete' ? '(none)' : after || '(none)');
      proposalLines.push('```');
      proposalLines.push('');
      proposalLines.push('---');
      proposalLines.push('');
    });
  }

  proposalLines.push('## Reviewer notes');
  proposalLines.push('(fill in before applying)');
  proposalLines.push('');
  // Conflict-check step (T-703) — sourced from the single lib helper so
  // this proposal-embedded copy and docs/SKILL_OPTIMIZATION.md §8/§9
  // cannot drift apart.
  renderConflictCheckChecklist().forEach((line) => proposalLines.push(line));
  proposalLines.push('## Decision');
  proposalLines.push('- [ ] Accept all');
  proposalLines.push('- [ ] Accept with modifications (describe below)');
  proposalLines.push('- [ ] Reject');
  proposalLines.push('');

  fs.writeFileSync(PROPOSAL_FILE, proposalLines.join('\n'), 'utf8');

  // -----------------------------------------------------------------------
  // Step 16: Print summary
  // -----------------------------------------------------------------------
  console.log('');
  console.log(`[reflect] Done.`);
  console.log(`  Role:           ${role}`);
  console.log(`  Trajectories:   ${N} total, ${trainCount} train, ${N - trainCount} holdout`);
  console.log(`  Score range:    ${minScore.toFixed(2)}–${maxScore.toFixed(2)} (training set)`);
  console.log(`  Edits proposed: ${edits.length}`);
  if (optimizerError) {
    console.log(`  Optimizer error: ${optimizerError}`);
  }
  console.log(`  Proposal written to: ${PROPOSAL_FILE}`);
  console.log('');
  console.log('Next step: review SKILL_PROPOSALS/' + path.basename(PROPOSAL_FILE));
  console.log('See docs/SKILL_OPTIMIZATION.md Section 9 for the human review process.');
}

main().catch((err) => {
  console.error('Unexpected error in mavp-skill-reflect.js:', err.message);
  process.exit(1);
});
