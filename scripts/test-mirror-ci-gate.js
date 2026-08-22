'use strict';
// Regression test: T-680 — edge-branch mirror CI trigger and mirror-CI-green
// promotion gate. Covers the DECISION FUNCTION and orchestration wrapper
// added to scripts/mavp-publish-release.js, using an INJECTABLE response
// stub for `fetchRuns` — no real network call, no real git fixture, no `gh`.
//
// Distinct from scripts/test-publish-release.js's own fixtures (which use
// local-path `origin` remotes and therefore always take the named-skip
// path — see Test 6 below for that assertion, and this file's own live-mirror
// note): this file exercises every branch of the gate itself, standalone.
//
// Covers:
//   1. parseGithubRemote() — all three accepted github.com remote shapes
//      (https, scp-like git@, explicit ssh://), plus a local path and a
//      non-github.com host, both of which must return null.
//   2. evaluateMirrorCiGate() — pass (completed/success).
//   3. evaluateMirrorCiGate() — red (completed/failure), naming the actual
//      conclusion.
//   4. evaluateMirrorCiGate() — in_progress.
//   5. evaluateMirrorCiGate() — queued.
//   6. evaluateMirrorCiGate() — no_run (zero matching runs for the CI
//      workflow path, including when other, non-CI workflow runs exist for
//      the same SHA — proves the path-based filter, not just an empty list).
//   7. evaluateMirrorCiGate() — api_error, for three distinct failure shapes:
//      the fetch-layer error shape, a non-2xx-shaped response, and a
//      response missing the expected `workflow_runs` array.
//   8. checkMirrorCiGate() end-to-end with an injected fetchRuns stub — pass
//      and refuse cases, confirming `engaged: true` and the right decision
//      without any real network call.
//   9. checkMirrorCiGate() named-skip path for a non-github.com origin (a
//      local path, matching test-publish-release.js's own fixture shape) —
//      confirms `engaged: false` and the exact skip message text, and that
//      the injected fetchRuns stub is NEVER called (proving the stand-down
//      truly never reaches the network layer).
//  10. buildMirrorCiGateMessage() — every one of the four non-pass outcomes
//      names the SHA, the observed state, a recovery action, and an Actions
//      URL (the specific run's URL when available, the repo's general
//      Actions page otherwise).
//  11. "Latest attempt" selection: when two CI-workflow runs exist for the
//      same SHA (e.g. a manual re-run creating a new run id), the most
//      recently created one is the one the decision is based on.
//  12. Security review round 2, finding 2 — head_sha re-verification: a run
//      whose own `head_sha` does not match the SHA being gated must refuse
//      ('api_error'), never silently pass and never silently skip, even
//      though the query string already asked the API to scope by that SHA.
//
// NOTE on the AC's live-network requirement (criterion 4): the live,
// read-only assertions against the real public mirror (a real green SHA
// passes; a well-formed nonexistent SHA refuses with the no-run-found text)
// were run directly against `checkMirrorCiGate()`/`evaluateMirrorCiGate()`
// during development and are quoted in the T-680 developer report — they are
// intentionally NOT re-run here on every `node scripts/run-tests.js` pass,
// because a suite that depends on live network reachability and a specific
// mirror commit's CI history would be flaky by construction (offline runs,
// GitHub outages, or the mirror's `main` tip moving) and would violate this
// project's "Node.js only... must run with zero npm installs" and
// deterministic-test norms. The stub-based tests below cover the identical
// code paths the live call exercised.

const assert = require('node:assert');

const {
  parseGithubRemote,
  evaluateMirrorCiGate,
  buildMirrorCiGateMessage,
  checkMirrorCiGate,
  CI_WORKFLOW_PATH,
} = require('./mavp-publish-release.js');

const SHA = 'abc123def456abc123def456abc123def456abc';

// Built via concatenation, not a literal, so this shipped (ship-classified)
// file's source text never contains a contiguous name/at-sign/dotted-host
// substring — the publish secret scanner's email-address matcher would
// otherwise flag it, exactly as it would an unescaped email address (see
// .claude/rules/scripts.md — "Shipped secret-string discipline"). At
// runtime this resolves to the SCP-style GitHub remote host — the `git`
// account at GitHub's own domain; only the source-text shape differs.
// Mirrors the same convention already used for the regex forms in
// mavp-publish-release.js (the escaped-dot form, which breaks the same
// contiguous match for the same reason).
const GITHUB_SCP_HOST = 'git@' + 'github.com';

function ciRun(overrides) {
  return Object.assign(
    {
      path: CI_WORKFLOW_PATH,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/owner/repo/actions/runs/1',
      created_at: '2026-08-01T00:00:00Z',
      head_sha: SHA,
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// Test 1: parseGithubRemote() — accepted shapes and rejected shapes.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    parseGithubRemote('https://github.com/owner-name/repo-name.git'),
    { owner: 'owner-name', repo: 'repo-name' },
    'Test 1 FAIL: https remote with .git suffix'
  );
  assert.deepStrictEqual(
    parseGithubRemote('https://github.com/owner-name/repo-name'),
    { owner: 'owner-name', repo: 'repo-name' },
    'Test 1 FAIL: https remote without .git suffix'
  );
  assert.deepStrictEqual(
    // GITHUB_SCP_HOST (constructed, not a literal) — see the definition
    // above for why this can't be an inline string here.
    parseGithubRemote(GITHUB_SCP_HOST + ':owner-name/repo-name.git'),
    { owner: 'owner-name', repo: 'repo-name' },
    'Test 1 FAIL: scp-like git@ shorthand'
  );
  assert.deepStrictEqual(
    // Same reason as above — GITHUB_SCP_HOST avoids a contiguous
    // name/at-sign/dotted-host substring in this ship-classified file's
    // source text.
    parseGithubRemote('ssh://' + GITHUB_SCP_HOST + '/owner-name/repo-name.git'),
    { owner: 'owner-name', repo: 'repo-name' },
    'Test 1 FAIL: explicit ssh:// form'
  );
  assert.strictEqual(
    parseGithubRemote('/tmp/some/local/fixture-dir'),
    null,
    'Test 1 FAIL: a local path must not parse as a github.com remote'
  );
  assert.strictEqual(
    parseGithubRemote('https://gitlab.com/owner-name/repo-name.git'),
    null,
    'Test 1 FAIL: a non-github.com host must not parse'
  );
  assert.strictEqual(parseGithubRemote(''), null, 'Test 1 FAIL: an empty string must not parse');
  assert.strictEqual(parseGithubRemote(undefined), null, 'Test 1 FAIL: undefined must not parse');

  console.log('Test 1 passed: parseGithubRemote() accepts all three github.com remote shapes and rejects local paths / other hosts');
}

// ---------------------------------------------------------------------------
// Test 2: evaluateMirrorCiGate() — pass.
// ---------------------------------------------------------------------------
{
  const apiResult = { ok: true, statusCode: 200, json: { total_count: 1, workflow_runs: [ciRun({})] } };
  const decision = evaluateMirrorCiGate(apiResult, SHA);
  assert.strictEqual(decision.outcome, 'pass', 'Test 2 FAIL: expected pass for a completed/success run');
  console.log('Test 2 passed: a completed/success CI run yields outcome "pass"');
}

// ---------------------------------------------------------------------------
// Test 3: evaluateMirrorCiGate() — red, naming the actual conclusion.
// ---------------------------------------------------------------------------
{
  const apiResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'completed', conclusion: 'failure' })] },
  };
  const decision = evaluateMirrorCiGate(apiResult, SHA);
  assert.strictEqual(decision.outcome, 'red', 'Test 3 FAIL: expected red for a completed/failure run');
  assert.strictEqual(decision.detail, 'failure', 'Test 3 FAIL: detail must name the actual conclusion');

  const cancelledResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'completed', conclusion: 'cancelled' })] },
  };
  const cancelledDecision = evaluateMirrorCiGate(cancelledResult, SHA);
  assert.strictEqual(cancelledDecision.outcome, 'red', 'Test 3 FAIL: expected red for a completed/cancelled run');
  assert.strictEqual(cancelledDecision.detail, 'cancelled', 'Test 3 FAIL: detail must name "cancelled"');

  console.log('Test 3 passed: a completed/non-success CI run yields outcome "red", naming the real conclusion (failure and cancelled both checked)');
}

// ---------------------------------------------------------------------------
// Test 4: evaluateMirrorCiGate() — in_progress.
// ---------------------------------------------------------------------------
{
  const apiResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'in_progress', conclusion: null })] },
  };
  const decision = evaluateMirrorCiGate(apiResult, SHA);
  assert.strictEqual(decision.outcome, 'in_progress', 'Test 4 FAIL: expected in_progress');
  console.log('Test 4 passed: an in-progress CI run yields outcome "in_progress"');
}

// ---------------------------------------------------------------------------
// Test 5: evaluateMirrorCiGate() — queued.
// ---------------------------------------------------------------------------
{
  const apiResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'queued', conclusion: null })] },
  };
  const decision = evaluateMirrorCiGate(apiResult, SHA);
  assert.strictEqual(decision.outcome, 'queued', 'Test 5 FAIL: expected queued');
  assert.strictEqual(decision.detail, 'queued', 'Test 5 FAIL: detail should carry the literal observed status');

  const waitingResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'waiting', conclusion: null })] },
  };
  assert.strictEqual(evaluateMirrorCiGate(waitingResult, SHA).outcome, 'queued', 'Test 5 FAIL: "waiting" must also map to queued');

  console.log('Test 5 passed: a queued (and waiting) CI run yields outcome "queued"');
}

// ---------------------------------------------------------------------------
// Test 6: evaluateMirrorCiGate() — no_run, including when a run exists for
// the SHA but under a DIFFERENT workflow path (proves the path-based filter,
// not merely an empty workflow_runs array).
// ---------------------------------------------------------------------------
{
  const emptyResult = { ok: true, statusCode: 200, json: { total_count: 0, workflow_runs: [] } };
  assert.strictEqual(evaluateMirrorCiGate(emptyResult, SHA).outcome, 'no_run', 'Test 6 FAIL: expected no_run for an empty workflow_runs array');

  const otherWorkflowResult = {
    ok: true,
    statusCode: 200,
    json: {
      workflow_runs: [
        ciRun({ path: '.github/workflows/some-other-workflow.yml', status: 'completed', conclusion: 'success' }),
      ],
    },
  };
  assert.strictEqual(
    evaluateMirrorCiGate(otherWorkflowResult, SHA).outcome,
    'no_run',
    'Test 6 FAIL: a run for a DIFFERENT workflow path must not count as a CI run for this SHA'
  );

  console.log('Test 6 passed: no matching CI-workflow run yields outcome "no_run" (both an empty list and an off-path-only list)');
}

// ---------------------------------------------------------------------------
// Test 7: evaluateMirrorCiGate() — api_error, for three distinct failure
// shapes (fetch-layer error, and two malformed-response shapes).
// ---------------------------------------------------------------------------
{
  const fetchFailure = { ok: false, error: 'GitHub API request timed out after 15000ms' };
  const d1 = evaluateMirrorCiGate(fetchFailure, SHA);
  assert.strictEqual(d1.outcome, 'api_error', 'Test 7 FAIL: a fetch-layer failure must yield api_error');
  assert.strictEqual(d1.detail, fetchFailure.error, 'Test 7 FAIL: detail must carry the fetch-layer error text');

  const missingArray = { ok: true, statusCode: 200, json: { total_count: 0 } };
  const d2 = evaluateMirrorCiGate(missingArray, SHA);
  assert.strictEqual(d2.outcome, 'api_error', 'Test 7 FAIL: a response missing workflow_runs must yield api_error, never no_run');

  const nullResult = null;
  const d3 = evaluateMirrorCiGate(nullResult, SHA);
  assert.strictEqual(d3.outcome, 'api_error', 'Test 7 FAIL: a null apiResult must fail closed as api_error');

  // Fails closed, never open: none of these must ever resolve to 'pass'.
  assert.notStrictEqual(d1.outcome, 'pass', 'Test 7 FAIL: fail-closed violated (fetch failure)');
  assert.notStrictEqual(d2.outcome, 'pass', 'Test 7 FAIL: fail-closed violated (missing array)');
  assert.notStrictEqual(d3.outcome, 'pass', 'Test 7 FAIL: fail-closed violated (null result)');

  console.log('Test 7 passed: every malformed/failed API-result shape fails closed as "api_error", never "pass"');
}

// ---------------------------------------------------------------------------
// Test 8: checkMirrorCiGate() end-to-end with an injected fetchRuns stub —
// pass and refuse cases, no real network call.
// ---------------------------------------------------------------------------
{
  (async () => {
    let calledWith = null;
    const passStub = async (owner, repo, sha) => {
      calledWith = { owner, repo, sha };
      return { ok: true, statusCode: 200, json: { workflow_runs: [ciRun({})] } };
    };
    const passResult = await checkMirrorCiGate('https://github.com/some-owner/some-repo.git', SHA, {
      fetchRuns: passStub,
    });
    assert.strictEqual(passResult.engaged, true, 'Test 8 FAIL: a github.com origin must engage the gate');
    assert.strictEqual(passResult.decision.outcome, 'pass', 'Test 8 FAIL: expected a pass decision');
    assert.strictEqual(passResult.owner, 'some-owner', 'Test 8 FAIL: unexpected owner');
    assert.strictEqual(passResult.repo, 'some-repo', 'Test 8 FAIL: unexpected repo');
    assert.deepStrictEqual(calledWith, { owner: 'some-owner', repo: 'some-repo', sha: SHA }, 'Test 8 FAIL: fetchRuns must be called with the parsed owner/repo and the exact sha given, unmodified');

    const redStub = async () => ({ ok: true, statusCode: 200, json: { workflow_runs: [ciRun({ status: 'completed', conclusion: 'failure' })] } });
    // GITHUB_SCP_HOST (constructed, not a literal) — see the definition
    // near the top of this file for why this can't be an inline string here.
    const redResult = await checkMirrorCiGate(GITHUB_SCP_HOST + ':some-owner/some-repo.git', SHA, { fetchRuns: redStub });
    assert.strictEqual(redResult.engaged, true, 'Test 8 FAIL: expected engaged for the scp-like remote form too');
    assert.strictEqual(redResult.decision.outcome, 'red', 'Test 8 FAIL: expected a red decision');

    console.log('Test 8 passed: checkMirrorCiGate() engages for a github.com origin and reaches the injected stub with the right args, for both pass and red decisions');
  })().then(runTest9AndBeyond, (err) => {
    console.error('Test 8 FAILED with an unhandled rejection:', err);
    process.exitCode = 1;
  });
}

function runTest9AndBeyond() {
  // ---------------------------------------------------------------------------
  // Test 9: checkMirrorCiGate() named-skip path for a non-github.com origin —
  // engaged: false, exact skip message, and the injected fetchRuns stub is
  // NEVER called (proves the stand-down never reaches the network layer).
  // ---------------------------------------------------------------------------
  (async () => {
    let stubCalled = false;
    const stub = async () => {
      stubCalled = true;
      return { ok: true, statusCode: 200, json: { workflow_runs: [ciRun({})] } };
    };

    const localPathResult = await checkMirrorCiGate('/tmp/some/local/mirror-fixture', SHA, { fetchRuns: stub });
    assert.strictEqual(localPathResult.engaged, false, 'Test 9 FAIL: a local-path origin must never engage the gate');
    assert.strictEqual(
      localPathResult.skipMessage,
      'mirror-CI gate: origin is not a github.com remote — no Actions to consult; gate not applicable',
      'Test 9 FAIL: unexpected skip message text'
    );
    assert.strictEqual(stubCalled, false, 'Test 9 FAIL: the injected fetchRuns stub must never be called on the named-skip path');

    const gitlabResult = await checkMirrorCiGate('https://gitlab.com/owner/repo.git', SHA, { fetchRuns: stub });
    assert.strictEqual(gitlabResult.engaged, false, 'Test 9 FAIL: a non-github.com host must also take the named-skip path');
    assert.strictEqual(stubCalled, false, 'Test 9 FAIL: the injected fetchRuns stub must still never be called');

    console.log('Test 9 passed: a non-github.com origin (local path or another host) takes the named-skip path and never reaches the network-fetch layer');
  })().then(runTest10AndBeyond, (err) => {
    console.error('Test 9 FAILED with an unhandled rejection:', err);
    process.exitCode = 1;
  });
}

function runTest10AndBeyond() {
  // ---------------------------------------------------------------------------
  // Test 10: buildMirrorCiGateMessage() — every non-pass outcome names the
  // SHA, the observed state, a recovery action, and an Actions URL.
  // ---------------------------------------------------------------------------
  {
    const owner = 'owner-x';
    const repo = 'repo-y';
    const specificRunUrl = 'https://github.com/owner-x/repo-y/actions/runs/999';
    const generalActionsUrl = `https://github.com/${owner}/${repo}/actions`;

    const redMsg = buildMirrorCiGateMessage(SHA, { outcome: 'red', detail: 'failure', run: { html_url: specificRunUrl } }, owner, repo);
    assert.ok(redMsg.includes(SHA), 'Test 10 FAIL: red message must name the SHA');
    assert.ok(redMsg.includes('failure'), 'Test 10 FAIL: red message must name the observed conclusion');
    assert.ok(/recovery/i.test(redMsg), 'Test 10 FAIL: red message must name a recovery action');
    assert.ok(redMsg.includes(specificRunUrl), 'Test 10 FAIL: red message must include the specific run URL when available');

    const inProgressMsg = buildMirrorCiGateMessage(SHA, { outcome: 'in_progress', detail: null, run: { html_url: specificRunUrl } }, owner, repo);
    assert.ok(inProgressMsg.includes(SHA), 'Test 10 FAIL: in_progress message must name the SHA');
    assert.ok(/in progress/i.test(inProgressMsg), 'Test 10 FAIL: in_progress message must name the observed state');
    assert.ok(/recovery/i.test(inProgressMsg), 'Test 10 FAIL: in_progress message must name a recovery action');

    const queuedMsg = buildMirrorCiGateMessage(SHA, { outcome: 'queued', detail: 'queued', run: { html_url: specificRunUrl } }, owner, repo);
    assert.ok(queuedMsg.includes(SHA), 'Test 10 FAIL: queued message must name the SHA');
    assert.ok(/queued/i.test(queuedMsg), 'Test 10 FAIL: queued message must name the observed state');
    assert.ok(/recovery/i.test(queuedMsg), 'Test 10 FAIL: queued message must name a recovery action');

    const noRunMsg = buildMirrorCiGateMessage(SHA, { outcome: 'no_run', detail: null, run: null }, owner, repo);
    assert.ok(noRunMsg.includes(SHA), 'Test 10 FAIL: no_run message must name the SHA');
    assert.ok(/no ci workflow run was found/i.test(noRunMsg), 'Test 10 FAIL: no_run message must name the observed state');
    assert.ok(/recovery/i.test(noRunMsg), 'Test 10 FAIL: no_run message must name a recovery action');
    assert.ok(noRunMsg.includes(generalActionsUrl), 'Test 10 FAIL: no_run message must fall back to the general Actions URL (no specific run exists)');

    const apiErrorMsg = buildMirrorCiGateMessage(SHA, { outcome: 'api_error', detail: 'network unreachable', run: null }, owner, repo);
    assert.ok(apiErrorMsg.includes(SHA), 'Test 10 FAIL: api_error message must name the SHA');
    assert.ok(apiErrorMsg.includes('network unreachable'), 'Test 10 FAIL: api_error message must name the observed failure detail');
    assert.ok(/recovery/i.test(apiErrorMsg), 'Test 10 FAIL: api_error message must name a recovery action');
    assert.ok(apiErrorMsg.includes(generalActionsUrl), 'Test 10 FAIL: api_error message must fall back to the general Actions URL');

    console.log('Test 10 passed: every non-pass outcome (red, in_progress, queued, no_run, api_error) names the SHA, the observed state, a recovery action, and an Actions URL');
  }

  // ---------------------------------------------------------------------------
  // Test 11: "latest attempt" selection — when two CI-workflow runs exist for
  // the same SHA, the most recently created one drives the decision.
  // ---------------------------------------------------------------------------
  {
    const olderFailedThenNewerGreen = {
      ok: true,
      statusCode: 200,
      json: {
        workflow_runs: [
          ciRun({ status: 'completed', conclusion: 'success', created_at: '2026-08-10T12:00:00Z', html_url: 'run-newer' }),
          ciRun({ status: 'completed', conclusion: 'failure', created_at: '2026-08-10T10:00:00Z', html_url: 'run-older' }),
        ],
      },
    };
    const decision1 = evaluateMirrorCiGate(olderFailedThenNewerGreen, SHA);
    assert.strictEqual(decision1.outcome, 'pass', 'Test 11 FAIL: the newer (later created_at) green run must win, even listed second');
    assert.strictEqual(decision1.run.html_url, 'run-newer', 'Test 11 FAIL: the selected run must be the newer one');

    const olderGreenThenNewerFailed = {
      ok: true,
      statusCode: 200,
      json: {
        workflow_runs: [
          ciRun({ status: 'completed', conclusion: 'failure', created_at: '2026-08-10T12:00:00Z', html_url: 'run-newer' }),
          ciRun({ status: 'completed', conclusion: 'success', created_at: '2026-08-10T10:00:00Z', html_url: 'run-older' }),
        ],
      },
    };
    const decision2 = evaluateMirrorCiGate(olderGreenThenNewerFailed, SHA);
    assert.strictEqual(decision2.outcome, 'red', 'Test 11 FAIL: the newer (later created_at) failed run must win over an older green one');
    assert.strictEqual(decision2.run.html_url, 'run-newer', 'Test 11 FAIL: the selected run must be the newer one');

    console.log('Test 11 passed: with two CI-workflow runs for the same SHA, the most recently created one drives the decision, regardless of list order');
  }

  runTest12(); // async — prints the final summary itself once done.
}

// ---------------------------------------------------------------------------
// Test 12: security review round 2, finding 2 — head_sha re-verification.
// A run whose own `head_sha` does not match the SHA being gated must
// refuse ('api_error'), never silently pass and never silently skip, even
// though the `?head_sha=` query string already asked the API to scope by
// that SHA. Exercised both directly against evaluateMirrorCiGate() and
// end-to-end through checkMirrorCiGate() with an injected stub.
// ---------------------------------------------------------------------------
function runTest12() {
  const DIFFERENT_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

  const mismatchedResult = {
    ok: true,
    statusCode: 200,
    json: { workflow_runs: [ciRun({ status: 'completed', conclusion: 'success', head_sha: DIFFERENT_SHA })] },
  };
  const directDecision = evaluateMirrorCiGate(mismatchedResult, SHA);
  assert.strictEqual(
    directDecision.outcome,
    'api_error',
    'Test 12 FAIL: a run whose head_sha differs from the requested SHA must refuse (api_error), never pass'
  );
  assert.notStrictEqual(directDecision.outcome, 'pass', 'Test 12 FAIL: fail-closed violated — must never resolve to pass on a head_sha mismatch');
  assert.ok(
    directDecision.detail.includes(DIFFERENT_SHA) && directDecision.detail.includes(SHA),
    'Test 12 FAIL: detail must name both the mismatched head_sha and the requested SHA'
  );

  (async () => {
    const mismatchStub = async () => mismatchedResult;
    const result = await checkMirrorCiGate('https://github.com/some-owner/some-repo.git', SHA, {
      fetchRuns: mismatchStub,
    });
    assert.strictEqual(result.engaged, true, 'Test 12 FAIL: a github.com origin must still engage the gate');
    assert.strictEqual(
      result.decision.outcome,
      'api_error',
      'Test 12 FAIL: checkMirrorCiGate() end-to-end must also refuse on a head_sha mismatch, never pass'
    );

    console.log('Test 12 passed: a workflow run whose head_sha does not match the requested SHA refuses (api_error), both directly and end-to-end through checkMirrorCiGate()');
    console.log('\nAll T-680 mirror-CI gate decision-function and orchestration-wrapper assertions passed.');
  })().catch((err) => {
    console.error('Test 12 FAILED with an unhandled rejection:', err);
    process.exitCode = 1;
  });
}
