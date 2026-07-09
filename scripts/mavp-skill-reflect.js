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
  // Step 4: Train / holdout split (70/30, keyed on taskId for stability)
  // -----------------------------------------------------------------------
  const sortedByTaskId = [...scored].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const trainCount = Math.floor(sortedByTaskId.length * 0.7);
  const trainSet = sortedByTaskId.slice(0, trainCount);
  // const holdoutSet = sortedByTaskId.slice(trainCount); // reserved for v2

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
  // -----------------------------------------------------------------------
  const systemPrompt =
    'You are a skill document optimizer. You analyze agent performance trajectories and propose minimal, targeted improvements to agent skill specifications. You must respond with a JSON object only.';

  const optimizerPrompt = [
    `You are optimizing the skill document for the "${role}" agent role in the Mavericks framework.`,
    '',
    `## Current skill document (editable portions only — protected sections replaced with placeholders)`,
    stripped,
    '',
    `## Successful trajectories (score ≥ 0.7) — ${successBatch.length} examples`,
    JSON.stringify(successBatch, null, 2),
    '',
    `## Failure trajectories (score < 0.7) — ${failureBatch.length} examples`,
    JSON.stringify(failureBatch, null, 2),
    '',
    '## Instructions',
    'Propose at most 2 edit operations (add, delete, or replace) that would improve agent performance based on patterns in the failure trajectories while preserving what works in the successes.',
    '',
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

  // -----------------------------------------------------------------------
  // Step 12: Call optimizer model
  // -----------------------------------------------------------------------
  console.log(`[reflect] Calling optimizer model (claude-opus-4-8) for role: ${role}…`);

  let optimizerResult = null;
  let optimizerError = null;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2000,
      messages: [{ role: 'user', content: optimizerPrompt }],
      system: systemPrompt,
    });
    const rawJson = response.content[0].text;

    try {
      optimizerResult = JSON.parse(rawJson);
    } catch (parseErr) {
      // Try to extract JSON from the response if it has surrounding text
      const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          optimizerResult = JSON.parse(jsonMatch[0]);
        } catch {
          optimizerError = `JSON parse failed: ${parseErr.message}. Raw response: ${rawJson.slice(0, 200)}`;
        }
      } else {
        optimizerError = `JSON parse failed: ${parseErr.message}. Raw response: ${rawJson.slice(0, 200)}`;
      }
    }
  } catch (apiErr) {
    optimizerError = `API call failed: ${apiErr.message}`;
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
  proposalLines.push('');
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
