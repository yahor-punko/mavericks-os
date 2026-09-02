'use strict';
// Regression test: T-470 — mechanical guard for agent-frontmatter vs
// docs/AGENT_SPEC.md drift.
//
// No script under scripts/ previously read agent frontmatter, so agreement
// between each .claude/agents/*.md `model:`/`maxTurns:` and AGENT_SPEC.md's
// per-role policy tables was manually maintained (T-459 showed this drift
// class occurs and lagged undetected). This test:
//   1. Parses every .claude/agents/*.md frontmatter `model:` and `maxTurns:`.
//   2. Parses AGENT_SPEC.md's worker/architect model defaults and its
//      per-role maxTurns table.
//   3. Asserts each spec's values match the corresponding AGENT_SPEC.md
//      entry, failing loudly (naming role, field, spec value vs table
//      value) on any mismatch or missing counterpart in either direction.
//
// T-728: a report-only role (its deny-tools list denies BOTH Edit and
// Write — the report is its sole deliverable) needs a spec-embedded
// "## Budget awareness" section so a self-counting agent has a real number
// to converge against, instead of a brief-only "Turn budget:" line that no
// hook or script can force to be present. This test additionally:
//   4. Derives the report-only roster mechanically from each spec's
//      frontmatter `deny-tools:` line (both "Edit" and "Write" present).
//   5. Asserts every roster member's body text has a "## Budget awareness"
//      section.
//   6. Asserts that section states the role's turn budget in the chosen
//      machine-readable form — a backticked `maxTurns: N` literal — and
//      that N equals the spec's own frontmatter maxTurns.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
const AGENT_SPEC_PATH = path.join(REPO_ROOT, 'docs', 'AGENT_SPEC.md');
const CLAUDE_MD_PATH = path.join(REPO_ROOT, 'CLAUDE.md');

const TEMPLATE_HEADING = '## Sub-agent brief template';
const COMPLETION_TOKEN_MARKER = 'MAVP_REPORT';

// ---------------------------------------------------------------------------
// Parse the "Sub-agent brief template" fenced block from a given doc, extract
// its field-name set (line-initial "Name:" prefixes), and check its
// "Before exiting" line references the completion-token marker.
//
// T-623: docs/AGENT_SPEC.md's copy of the brief template had silently
// drifted from CLAUDE.md's — missing five fields (Adjacent docs read, Read
// current main, Model, Effort, Turn budget) and a degraded "Before exiting"
// line with no completion-token wording. Nothing previously asserted the two
// templates stay in field-name parity; this guards that going forward.
// Wording differences between the two copies are expected and NOT a
// failure — only the field-name set and the completion-token marker are
// checked.
// ---------------------------------------------------------------------------

function extractTemplateFence(fullText, fileLabel) {
  const headingIdx = fullText.indexOf(TEMPLATE_HEADING);
  assert.ok(
    headingIdx !== -1,
    `${fileLabel}: no "${TEMPLATE_HEADING}" heading found`
  );
  const afterHeading = fullText.slice(headingIdx);
  const fenceMatch = afterHeading.match(/```\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(
    fenceMatch,
    `${fileLabel}: no fenced code block found after "${TEMPLATE_HEADING}" heading`
  );
  return fenceMatch[1];
}

function extractTemplateFieldNames(fenceBlock) {
  const fieldNames = [];
  const lines = fenceBlock.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_ ]*?):\s/);
    if (m) {
      fieldNames.push(m[1].trim());
    }
  }
  return fieldNames;
}

function findBeforeExitingLine(fenceBlock) {
  const lines = fenceBlock.split(/\r?\n/);
  return lines.find((line) => /^Before exiting:\s/.test(line));
}

function checkTemplateParity(claudeMdText, agentSpecText) {
  const failures = [];

  const claudeFence = extractTemplateFence(claudeMdText, 'CLAUDE.md');
  const specFence = extractTemplateFence(agentSpecText, 'docs/AGENT_SPEC.md');

  const claudeFields = new Set(extractTemplateFieldNames(claudeFence));
  const specFields = new Set(extractTemplateFieldNames(specFence));

  assert.ok(
    claudeFields.size > 0,
    'CLAUDE.md: parsed zero field names from the brief template fence'
  );
  assert.ok(
    specFields.size > 0,
    'docs/AGENT_SPEC.md: parsed zero field names from the brief template fence'
  );

  const missingFromSpec = [...claudeFields].filter((f) => !specFields.has(f));
  const missingFromClaude = [...specFields].filter((f) => !claudeFields.has(f));

  for (const field of missingFromSpec) {
    failures.push(
      `[template-parity] field "${field}" is present in CLAUDE.md's brief ` +
        `template but missing from docs/AGENT_SPEC.md's`
    );
  }
  for (const field of missingFromClaude) {
    failures.push(
      `[template-parity] field "${field}" is present in docs/AGENT_SPEC.md's ` +
        `brief template but missing from CLAUDE.md's`
    );
  }

  const claudeBeforeExiting = findBeforeExitingLine(claudeFence);
  const specBeforeExiting = findBeforeExitingLine(specFence);

  assert.ok(
    claudeBeforeExiting,
    'CLAUDE.md: brief template has no "Before exiting:" line'
  );
  assert.ok(
    specBeforeExiting,
    'docs/AGENT_SPEC.md: brief template has no "Before exiting:" line'
  );

  if (!claudeBeforeExiting.includes(COMPLETION_TOKEN_MARKER)) {
    failures.push(
      `[template-parity] CLAUDE.md's "Before exiting" line does not reference ` +
        `the completion-token marker ("${COMPLETION_TOKEN_MARKER}")`
    );
  }
  if (!specBeforeExiting.includes(COMPLETION_TOKEN_MARKER)) {
    failures.push(
      `[template-parity] docs/AGENT_SPEC.md's "Before exiting" line does not ` +
        `reference the completion-token marker ("${COMPLETION_TOKEN_MARKER}")`
    );
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Parse .claude/agents/*.md frontmatter
// ---------------------------------------------------------------------------

function parseFrontmatter(fileText, fileName) {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${fileName}: no YAML frontmatter block found`);
  const block = match[1];

  const nameMatch = block.match(/^name:\s*(\S+)\s*$/m);
  const modelMatch = block.match(/^model:\s*(\S+)\s*$/m);
  const maxTurnsMatch = block.match(/^maxTurns:\s*(\d+)\s*$/m);
  const denyToolsMatch = block.match(/^deny-tools:\s*(.+)\s*$/m);

  assert.ok(nameMatch, `${fileName}: frontmatter missing "name:" field`);
  assert.ok(modelMatch, `${fileName}: frontmatter missing "model:" field`);
  assert.ok(maxTurnsMatch, `${fileName}: frontmatter missing "maxTurns:" field`);

  const denyTools = denyToolsMatch
    ? denyToolsMatch[1].trim().split(/\s+/)
    : [];

  return {
    name: nameMatch[1].trim(),
    model: modelMatch[1].trim(),
    maxTurns: Number(maxTurnsMatch[1]),
    denyTools,
  };
}

function loadAgentSpecs() {
  const files = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((file) => {
    const fullPath = path.join(AGENTS_DIR, file);
    const text = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseFrontmatter(text, file);
    return { file, text, ...parsed };
  });
}

// ---------------------------------------------------------------------------
// T-728: report-only roster + "## Budget awareness" section checks
// ---------------------------------------------------------------------------

const BUDGET_HEADING = '## Budget awareness';

// A report-only role is one whose deny-tools list denies BOTH Edit and
// Write — its report is its sole deliverable (e.g. ui-designer keeps Write
// allowed and is correctly excluded; developer/product-docs/technical-writer
// /frontend-design keep Edit+Write allowed and are correctly excluded).
function isReportOnlyRole(spec) {
  return spec.denyTools.includes('Edit') && spec.denyTools.includes('Write');
}

// Extract the "## Budget awareness" section body (everything up to the next
// "## " heading or end of file), or null when the heading is absent.
function extractBudgetAwarenessSection(fileText) {
  const headingIdx = fileText.indexOf(BUDGET_HEADING);
  if (headingIdx === -1) return null;
  const afterHeading = fileText.slice(headingIdx + BUDGET_HEADING.length);
  const nextHeadingMatch = afterHeading.match(/\n## /);
  return nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
}

// Parse the chosen machine-readable number form: a backticked `maxTurns: N`
// literal inside the section body.
function parseBudgetSectionMaxTurns(sectionBody) {
  const m = sectionBody.match(/`maxTurns:\s*(\d+)`/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// T-733: architect "Model self-report" section extraction
// ---------------------------------------------------------------------------

const MODEL_SELF_REPORT_HEADING_ARCHITECT = '## Model self-report';
const MODEL_SELF_REPORT_HEADING_SPEC = '### Model self-report';
const MODEL_SELF_REPORT_PHRASE_RE = /`(Model self-report:[^`]+)`/;

// Extract the body of a named heading's section (everything up to the next
// heading matching boundaryRe, or end of file), or null when the heading is
// absent. Generalizes extractBudgetAwarenessSection() to an arbitrary
// heading string and boundary pattern, since AGENT_SPEC.md nests its
// "Model self-report" copy one level deeper (### under ## Model selection)
// than the architect spec's own (## top-level).
function extractSectionByHeading(fileText, heading, boundaryRe) {
  const headingIdx = fileText.indexOf(heading);
  if (headingIdx === -1) return null;
  const afterHeading = fileText.slice(headingIdx + heading.length);
  const boundaryMatch = afterHeading.match(boundaryRe);
  return boundaryMatch ? afterHeading.slice(0, boundaryMatch.index) : afterHeading;
}

// ---------------------------------------------------------------------------
// Parse docs/AGENT_SPEC.md per-role model + maxTurns policy
// ---------------------------------------------------------------------------

function parseSpecModelByRole(specText) {
  const modelByRole = {};

  // "All worker roles (developer, qa, ux, ...) declare `model: sonnet` ..."
  const workerMatch = specText.match(
    /All worker roles \(([^)]+)\) declare `model:\s*([^`]+)`/
  );
  assert.ok(
    workerMatch,
    'AGENT_SPEC.md: could not find the "All worker roles (...) declare `model: ...`" sentence'
  );
  const workerRoles = workerMatch[1].split(',').map((r) => r.trim());
  const workerModel = workerMatch[2].trim();
  for (const role of workerRoles) {
    modelByRole[role] = workerModel;
  }

  // "The architect's frontmatter default is `model: opus` ..."
  const architectMatch = specText.match(
    /architect'?s frontmatter default is `model:\s*([^`]+)`/i
  );
  assert.ok(
    architectMatch,
    'AGENT_SPEC.md: could not find the architect frontmatter default model sentence'
  );
  modelByRole.architect = architectMatch[1].trim();

  return modelByRole;
}

function parseSpecMaxTurnsByRole(specText) {
  const tableHeadingMatch = specText.match(
    /#### Per-role maxTurns table\s*\n([\s\S]*?)(\n####|\n###|\n## |$)/
  );
  assert.ok(
    tableHeadingMatch,
    'AGENT_SPEC.md: could not find the "Per-role maxTurns table" section'
  );
  const tableBlock = tableHeadingMatch[1];

  const maxTurnsByRole = {};
  const rowRe = /^\|\s*([A-Za-z0-9_-]+)\s*\|\s*(\d+)\s*\|/gm;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tableBlock)) !== null) {
    const role = rowMatch[1].trim();
    const maxTurns = Number(rowMatch[2]);
    maxTurnsByRole[role] = maxTurns;
  }
  assert.ok(
    Object.keys(maxTurnsByRole).length > 0,
    'AGENT_SPEC.md: parsed zero rows from the "Per-role maxTurns table"'
  );

  return maxTurnsByRole;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  const specText = fs.readFileSync(AGENT_SPEC_PATH, 'utf8');
  const specModelByRole = parseSpecModelByRole(specText);
  const specMaxTurnsByRole = parseSpecMaxTurnsByRole(specText);

  const agentSpecs = loadAgentSpecs();
  assert.ok(agentSpecs.length > 0, 'No .claude/agents/*.md files found');

  const failures = [];

  const claudeMdText = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  failures.push(...checkTemplateParity(claudeMdText, specText));

  for (const spec of agentSpecs) {
    const role = spec.name;

    // model check
    if (!(role in specModelByRole)) {
      failures.push(
        `[${role}] model: frontmatter declares "${spec.model}" but AGENT_SPEC.md ` +
          `has no matching role entry in its worker/architect model policy`
      );
    } else if (specModelByRole[role] !== spec.model) {
      failures.push(
        `[${role}] model: frontmatter (${spec.file}) declares "${spec.model}" ` +
          `but AGENT_SPEC.md's model policy declares "${specModelByRole[role]}"`
      );
    }

    // maxTurns check
    if (!(role in specMaxTurnsByRole)) {
      failures.push(
        `[${role}] maxTurns: frontmatter declares ${spec.maxTurns} but AGENT_SPEC.md's ` +
          `"Per-role maxTurns table" has no matching row`
      );
    } else if (specMaxTurnsByRole[role] !== spec.maxTurns) {
      failures.push(
        `[${role}] maxTurns: frontmatter (${spec.file}) declares ${spec.maxTurns} ` +
          `but AGENT_SPEC.md's "Per-role maxTurns table" declares ${specMaxTurnsByRole[role]}`
      );
    }
  }

  // Reverse direction: every AGENT_SPEC.md role must have a matching spec file.
  const specRoleNames = new Set(agentSpecs.map((s) => s.name));
  for (const role of Object.keys(specMaxTurnsByRole)) {
    if (!specRoleNames.has(role)) {
      failures.push(
        `[${role}] AGENT_SPEC.md's "Per-role maxTurns table" lists this role but ` +
          `no .claude/agents/${role}.md frontmatter was found`
      );
    }
  }
  for (const role of Object.keys(specModelByRole)) {
    if (!specRoleNames.has(role)) {
      failures.push(
        `[${role}] AGENT_SPEC.md's model policy lists this role but no ` +
          `.claude/agents/${role}.md frontmatter was found`
      );
    }
  }

  // ---------------------------------------------------------------------
  // T-728: report-only roster Budget-awareness checks
  // ---------------------------------------------------------------------

  const reportOnlyRoster = agentSpecs.filter(isReportOnlyRole).map((s) => s.name).sort();
  const EXPECTED_REPORT_ONLY_ROSTER = [
    'analyst',
    'architect',
    'exa-researcher',
    'qa',
    'security-reviewer',
    'ux',
  ].sort();
  assert.deepStrictEqual(
    reportOnlyRoster,
    EXPECTED_REPORT_ONLY_ROSTER,
    `[roster] deny-Edit+Write roster derived from frontmatter (${reportOnlyRoster.join(', ')}) ` +
      `does not match the expected report-only roster (${EXPECTED_REPORT_ONLY_ROSTER.join(', ')})`
  );

  for (const spec of agentSpecs) {
    if (!isReportOnlyRole(spec)) continue;

    const sectionBody = extractBudgetAwarenessSection(spec.text);
    if (sectionBody === null) {
      failures.push(
        `[${spec.name}] budget-awareness: ${spec.file} has no "${BUDGET_HEADING}" section ` +
          `(required — deny-tools denies both Edit and Write, so this role's report is its sole deliverable)`
      );
      continue;
    }

    const bodyMaxTurns = parseBudgetSectionMaxTurns(sectionBody);
    if (bodyMaxTurns === null) {
      failures.push(
        `[${spec.name}] budget-awareness: ${spec.file}'s "${BUDGET_HEADING}" section has no ` +
          'backticked `maxTurns: N` literal'
      );
    } else if (bodyMaxTurns !== spec.maxTurns) {
      failures.push(
        `[${spec.name}] budget-awareness: ${spec.file}'s "${BUDGET_HEADING}" section states ` +
          `maxTurns: ${bodyMaxTurns} but frontmatter maxTurns is ${spec.maxTurns}`
      );
    }
  }

  // ---------------------------------------------------------------------
  // T-733: architect "Model self-report" section + phrase-parity check
  // ---------------------------------------------------------------------

  const architectSpec = agentSpecs.find((s) => s.name === 'architect');
  assert.ok(
    architectSpec,
    'No .claude/agents/architect.md frontmatter found (name: architect)'
  );

  const architectModelSelfReportSection = extractSectionByHeading(
    architectSpec.text,
    MODEL_SELF_REPORT_HEADING_ARCHITECT,
    /\n## /
  );

  if (architectModelSelfReportSection === null) {
    failures.push(
      `[architect] model-self-report: ${architectSpec.file} has no ` +
        `"${MODEL_SELF_REPORT_HEADING_ARCHITECT}" section (required — see ` +
        'docs/AGENT_SPEC.md "Model self-report")'
    );
  } else {
    const specModelSelfReportSection = extractSectionByHeading(
      specText,
      MODEL_SELF_REPORT_HEADING_SPEC,
      /\n### |\n## /
    );
    assert.ok(
      specModelSelfReportSection !== null,
      `AGENT_SPEC.md: no "${MODEL_SELF_REPORT_HEADING_SPEC}" section found`
    );

    const architectPhraseMatch = architectModelSelfReportSection.match(
      MODEL_SELF_REPORT_PHRASE_RE
    );
    const specPhraseMatch = specModelSelfReportSection.match(
      MODEL_SELF_REPORT_PHRASE_RE
    );

    if (!architectPhraseMatch) {
      failures.push(
        `[architect] model-self-report: ${architectSpec.file}'s ` +
          `"${MODEL_SELF_REPORT_HEADING_ARCHITECT}" section has no backticked ` +
          '`Model self-report: <model-name>` literal'
      );
    } else if (!specPhraseMatch) {
      failures.push(
        'AGENT_SPEC.md: model-self-report: ' +
          `"${MODEL_SELF_REPORT_HEADING_SPEC}" section has no backticked ` +
          '`Model self-report: <model-name>` literal'
      );
    } else if (architectPhraseMatch[1].trim() !== specPhraseMatch[1].trim()) {
      failures.push(
        `[architect] model-self-report: ${architectSpec.file} states ` +
          `"${architectPhraseMatch[1].trim()}" but AGENT_SPEC.md's ` +
          `"${MODEL_SELF_REPORT_HEADING_SPEC}" section states ` +
          `"${specPhraseMatch[1].trim()}"`
      );
    }
  }

  if (failures.length > 0) {
    console.error('test-agent-spec-sync FAILED — agent frontmatter drifted from AGENT_SPEC.md:');
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exitCode = 1;
    throw new assert.AssertionError({
      message: `${failures.length} agent-spec drift mismatch(es) found (see stderr above)`,
    });
  }

  console.log(
    `test-agent-spec-sync passed: ${agentSpecs.length} agent spec(s) match ` +
      `AGENT_SPEC.md's model and maxTurns policy (roles: ${agentSpecs
        .map((s) => s.name)
        .join(', ')})`
  );
}

main();
