'use strict';
// Regression test: T-747 — docs_ref_not_found resolves the full cited path,
// consults the repo map, and groups findings per missing path.
//
// Before this fix, checkDocsRefs() (mavp-validator.js) matched with the
// unanchored /docs\/[A-Z_]+\.md/g pattern, stripping any repo-prefix off a
// citation like "sub-repo/docs/API_CONTRACT.md" down to just
// "docs/API_CONTRACT.md", then resolving THAT invented path at the project
// root — reporting a correctly-prefixed citation of a real sub-product doc
// as missing.
//
// Covers:
//   (a) a prefixed citation whose file exists at the fixture root (the full
//       path token is resolved exactly as written) -> zero findings; the
//       pre-T-747 suffix-only pattern would strip the prefix and report the
//       invented suffix-only path as missing (demonstrated as a red run by
//       reverting the pattern — see PR/task evidence).
//   (b) `docs/MISSING.md` (no prefix) -> one finding naming it verbatim.
//   (c) `other/docs/X.md` where the repo map declares `other` with a path
//       that does not exist locally -> zero findings (skipped, not
//       reported): another repo's file is not this ledger's claim to verify.
//   (d) the same missing path cited by two tasks -> exactly one finding
//       whose message names both task ids.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { checkDocsRefs } = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't747-docs-refs-'));

const ORIGINAL_ROOT = process.env.MAVERICKS_PROJECT_ROOT;

/** Run fn() with MAVERICKS_PROJECT_ROOT temporarily pointed at root. */
function withRoot(root, fn) {
  process.env.MAVERICKS_PROJECT_ROOT = root;
  try {
    return fn();
  } finally {
    if (ORIGINAL_ROOT === undefined) delete process.env.MAVERICKS_PROJECT_ROOT;
    else process.env.MAVERICKS_PROJECT_ROOT = ORIGINAL_ROOT;
  }
}

/** Build a minimal taskStatusRecords-shaped fixture record. */
function makeRecord(taskId, { status = 'merged', evidence = null, notes = null } = {}) {
  const lines = [`### ${taskId} — Fixture task`, `- **Status:** ${status}`];
  if (evidence != null) lines.push(`- **Evidence:** ${evidence}`);
  if (notes != null) lines.push(`- **Notes:** ${notes}`);
  return { taskId, status, rawBlock: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Test (a): a prefixed citation whose file exists at the fixture root ->
// zero findings. The full path token "sub-repo/docs/API_CONTRACT.md" is
// resolved exactly as written against the project root — no repo-map lookup
// needed for this case.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'case-a');
  fs.mkdirSync(path.join(root, 'sub-repo', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub-repo', 'docs', 'API_CONTRACT.md'), '# fixture\n', 'utf8');

  const records = [
    makeRecord('T-900', { evidence: 'commit: abc1234; see sub-repo/docs/API_CONTRACT.md for the contract' }),
  ];

  const findings = withRoot(root, () => checkDocsRefs(records));
  assert.deepStrictEqual(
    findings,
    [],
    'Test (a) FAIL: a prefixed citation whose file exists at the fixture root (resolved as written) should produce zero findings'
  );
  console.log('Test (a) passed: prefixed citation resolved at the project root exactly as written -> zero findings');
}

// ---------------------------------------------------------------------------
// Test (b): docs/MISSING.md -> one finding naming it verbatim.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'case-b');
  fs.mkdirSync(root, { recursive: true });

  const records = [
    makeRecord('T-901', { evidence: 'commit: def5678; see docs/MISSING.md for details' }),
  ];

  const findings = withRoot(root, () => checkDocsRefs(records));
  assert.strictEqual(findings.length, 1, 'Test (b) FAIL: expected exactly one finding for a missing plain docs path');
  assert.strictEqual(findings[0].checkName, 'docs_ref_not_found');
  assert.ok(
    findings[0].message.includes('docs/MISSING.md'),
    `Test (b) FAIL: expected finding message to name the token verbatim, got: ${findings[0].message}`
  );
  console.log('Test (b) passed: docs/MISSING.md produces one finding naming it verbatim');
}

// ---------------------------------------------------------------------------
// Test (c): other/docs/X.md where the repo map declares "other" with a path
// that does not exist locally -> zero findings (skipped, not reported).
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'case-c');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'REPO_MAP.md'),
    [
      '# Repo Map',
      '',
      '## other',
      '- **label:** Other',
      '- **path:** /nonexistent/path/does-not-exist-t747',
      '',
    ].join('\n'),
    'utf8'
  );

  const records = [
    makeRecord('T-902', { evidence: 'commit: aaa1111; see other/docs/X.md for its contract' }),
  ];

  const findings = withRoot(root, () => checkDocsRefs(records));
  assert.deepStrictEqual(
    findings,
    [],
    'Test (c) FAIL: a citation into a repo-map entry whose own path does not exist locally should be skipped, not reported'
  );
  console.log('Test (c) passed: other/docs/X.md with an unresolvable repo-map path -> zero findings (skipped)');
}

// ---------------------------------------------------------------------------
// Test (d): the same missing path cited by two tasks -> exactly one finding
// whose message contains both task ids.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'case-d');
  fs.mkdirSync(root, { recursive: true });

  const records = [
    makeRecord('T-903', { evidence: 'commit: bbb2222; see docs/SHARED_MISSING.md' }),
    makeRecord('T-904', { notes: 'also references docs/SHARED_MISSING.md' }),
  ];

  const findings = withRoot(root, () => checkDocsRefs(records));
  assert.strictEqual(
    findings.length,
    1,
    `Test (d) FAIL: expected exactly one grouped finding for a path cited by two tasks, got ${findings.length}`
  );
  assert.ok(findings[0].message.includes('T-903'), 'Test (d) FAIL: expected message to name T-903');
  assert.ok(findings[0].message.includes('T-904'), 'Test (d) FAIL: expected message to name T-904');
  console.log('Test (d) passed: the same missing path cited by two tasks produces exactly one finding naming both');
}

console.log('All test-docs-refs.js tests passed.');
