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

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
const AGENT_SPEC_PATH = path.join(REPO_ROOT, 'docs', 'AGENT_SPEC.md');

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

  assert.ok(nameMatch, `${fileName}: frontmatter missing "name:" field`);
  assert.ok(modelMatch, `${fileName}: frontmatter missing "model:" field`);
  assert.ok(maxTurnsMatch, `${fileName}: frontmatter missing "maxTurns:" field`);

  return {
    name: nameMatch[1].trim(),
    model: modelMatch[1].trim(),
    maxTurns: Number(maxTurnsMatch[1]),
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
    return { file, ...parsed };
  });
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
