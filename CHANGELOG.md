# Changelog

All notable changes to Mavericks are documented in this file, in a format
inspired by [Keep a Changelog](https://keepachangelog.com/). For how the
framework actually works, see [README.md](README.md) and the core process
docs in [`docs/core/`](docs/core/).

## [Unreleased]

## [0.38.2] — 2026-07-25

### Added

- **Behind-upstream source guard** in `mavp-install.js`: when the resolved
  framework source (`MAVERICKS_HOME` > `~/.mavericks` > legacy) is a git
  clone that is behind its own upstream, install / `--update` /
  `--hooks-only` now abort (exit 1, before any file write) with the exact
  remediation (`git -C <sourceRoot> pull`) instead of silently syncing a
  stale framework and stamping a stale `mavericks_version`. Uses a
  best-effort `git fetch` (4s timeout) then `rev-list --count
  HEAD..@{upstream}`; `--stale-source-ok` overrides, `--check` warns but
  continues, `--strip` skips. Silent no-op when the source is non-git, has
  no upstream, or the network is unavailable with a clean tracking ref.
  Complements the existing (T-444) stale-source guard — orthogonal
  mechanism. (T-477)

### Changed

- Release runbook (`docs/PUBLIC_RELEASE_STRATEGY.md`) now ends with an
  explicit `git -C ~/.mavericks pull` step so the adopter-facing source
  clone matches each freshly published release; `docs/core/BOOTSTRAP_GUIDE.md`
  documents the new gate and `--stale-source-ok` override. (T-478)

## [0.38.1] — 2026-07-24

### Fixed

- CI: `test-close-session-mode.js` Case 19 was environment-fragile — the
  git fixture relied on the ambient `init.defaultBranch`, so it passed
  locally (default `main`) but failed on CI runners defaulting to
  `master`. Fixtures now force `init.defaultBranch=main` explicitly. No
  production-code change (the `resolveRemoteTrackingRef()` behavior it
  exercises was already correct). (T-476)

### Changed

- Agent-spec consistency polish: read-only `git diff`/`git show` added to
  `security-reviewer`; a standard Escalation section added to
  `exa-researcher`; `technical-writer`'s floating protected bullet merged
  into Rules and its BACKLOG/TASK_STATUS guard given a protected block;
  `developer`'s description reworded to match the mandatory architect
  gate. (T-473)
- `architect` spec gains a Budget-awareness clause (converge and emit the
  decomposition block under budget pressure with a coverage note rather
  than dying silently), applied from a human-approved SKILL_PROPOSALS
  entry. (T-474)
- Worktree integration rule codified framework-wide in
  `docs/core/ORCHESTRATION_RULES.md`: record the on-branch hash produced
  by cherry-pick/merge as `commit:` evidence, never the sub-agent's
  worktree hash (they differ; using the worktree hash trips the validator's
  `commit_unreachable` check). (T-475)

## [0.38.0] — 2026-07-24

### Changed

- Validator internals consolidated (behavior-preserving; output byte-identical):
  a single `getProjectRoot()` helper replaces five copies of the
  `MAVERICKS_PROJECT_ROOT`-or-cwd idiom; `parseArtifacts()` reuses the
  existing `mergeFindings()` instead of a hand-rolled inline duplicate;
  and module/repo registry ID-extraction is deduplicated onto a single
  shared `extractHeadingIds()` + `META_HEADINGS` source in
  `mavp-operator-lib.js` (was four independently-maintained skip-sets).
  (T-460, T-461)
- Validator checks are now driven by a declarative `CHECKS` registry in
  `parseArtifacts()` instead of accreted per-feature `mergeFindings`
  call-sites and a drifted "Check N" comment scheme; each future check is
  a one-entry addition. Execution order and output are unchanged. (T-462)

### Fixed

- Agent-spec hardening from a full architect review of the 11 role specs
  (`docs/AGENT_SPEC_REVIEW.md`): the `developer` git allowlist no longer
  permits a pre-push bypass (`Bash(git -C *)` removed, `git diff`/`git log`
  wildcarded, `git merge --ff-only main` added, PreToolUse hook now blocks
  plain `git push`); `frontend-design` can commit its own work
  (git add/commit/status + npm run, commit-before-exit rule,
  BACKLOG/TASK_STATUS guard, Escalation section); the `qa` output contract
  enumerates all four legal outcomes and drops the "no partial results"
  convergence trap, plus read-only git for commit-evidence checks; and the
  architect-gate policy is reconciled across `ORCHESTRATION_RULES.md` and
  `ROLES.md` to match CLAUDE.md's mandatory-for-all-tasks language.
  (T-464, T-465, T-466, T-467, T-468)

### Added

- `.claude/rules/` added to `product-docs`' writable scope so
  RCA-codification rules-edit routings are executable. (T-469)
- `scripts/test-agent-spec-sync.js` — a mechanical guard asserting every
  `.claude/agents/*.md` frontmatter `model`/`maxTurns` matches
  `docs/AGENT_SPEC.md`, closing the drift class T-459 exposed. (T-470)

## [0.37.0] — 2026-07-24

### Changed

- Close-session deploy column now reflects actual deploy/push state
  instead of collapsing every status into "deployed". Respects
  `deploy_contours`: with contours 0/1 a merged task whose evidence
  commit is not reachable from the remote-tracking ref renders as
  "held / not pushed"; with contours ≥2, `deployed_dev` / `deployed_prod`
  render distinct labels and `merged` renders "not deployed" (fixes the
  fallthrough that previously showed deployed tasks as "not merged").
  Degrades to a status-only label when no remote is configured. (T-454)
- Validator `commit_unreachable` (Check 9) is now two-tier: a merged
  task's evidence hash held on a local branch but not on HEAD emits an
  info-severity "held on a local branch" finding that never affects the
  exit code (the normal state for pre-push / feature-branch workflows),
  while a hash reachable from no local ref preserves the original
  warning/info severities — killing the mass-warning noise floor without
  losing the pasted-worktree-hash footgun catch. (T-455)
- Validator `Blocked by:` resolution (Check 12) gains a hub-backlog
  fallback: when `<repo>/T-NNN` is not found in the target repo, the
  validating repo's own backlog is consulted before emitting
  `blocked_by_unresolvable`, accepted only when the local task's
  `Repo:`/`Repos:` field includes the referenced repo id. Makes the
  gate work for hub-model projects that track cross-repo tasks in one
  backlog; a no-op for single-repo projects. (T-456)
- PostToolUse validator hook stderr policy: full validator output now
  surfaces only on exit 2 (repair required); exit 1 (drifting) stays
  silent at edit time, keeping the "silent means no repair required"
  convention coherent and preventing persistent advisory warnings from
  acting as a de-facto per-edit block. The hook still always exits 0.
  (T-457)
- `security-reviewer` agent re-contracted to converge: one repo per
  invocation (multi-repo briefs report a blocker), a budget-awareness
  rule requiring a report with an explicit Coverage section instead of
  "no partial results", `maxTurns` raised 15 → 25, and an opus-escalation
  note for trust-boundary reviews. A new "Cross-repo security reviews"
  rule in `ORCHESTRATION_RULES.md` decomposes cross-repo reviews into
  per-repo spawns synthesized by the Main Agent. (T-458, T-459)

## [0.36.0] — 2026-07-24

### Added

- Self-install stale-source guard — `mavp-install.js` warns and skips the
  `PROCESS_STATE` version re-stamp when a self-install would stamp a
  version older than an available `~/.mavericks` / `MAVERICKS_HOME`
  source.
- `--set-status` / `--merge-task` evidence flags — `--commit <hash|HEAD>`
  and `--branch <name>` write commit evidence atomically, appending to
  (never clobbering) existing evidence; `HEAD` auto-resolves; a hash
  unreachable from the branch warns without blocking.
- Validator `commit_unreachable` advisory — flags merged-task evidence
  `commit:` hashes not reachable from HEAD, warning severity for Active
  tasks, info severity for Recently-completed.
- Repo-identity header — every mutating ritual command now prints
  `repo: <path> | wave: N | initiative: <...>` as its first line, so a
  wrong-repo run is obvious immediately.
- XS fast lane — `--quick-merge` now enforces XS thresholds (≤2 files,
  ≤10 changed lines, no new tracked files, no sensitive paths;
  binary/unresolvable commits refused) against the cited commit and
  supports batch registration; documented in
  `docs/core/ORCHESTRATION_RULES.md` as the sole sanctioned exception to
  the architect gate.

### Fixed

- `--close-session` wave-complete parity — interactive and
  non-interactive close now reach the same wave-complete decision; both
  announce "Wave N complete — archiving + incrementing" or name the
  tasks keeping the wave open; already-merged tasks auto-archive without
  a re-prompt.

### Changed

- Documented the session-close vs wave-close model in
  `docs/core/TASK_LIFECYCLE.md`.
- Hardened the developer role spec to require explicit per-criterion
  expected-vs-actual MATCH/MISMATCH evidence and a self-check
  distinguishing "passed a check" from "demonstrated the required
  behavior" — from a skill-reflection over real adopter trajectories.

## [0.35.0] — 2026-07-23

### Added

- `--park-wave [N] --reason "..."` and `--unpark-wave <N>` operator commands
  — relocate a wave's task blocks out of (and back into) the Active
  sections of BOTH `BACKLOG.md` and `TASK_STATUS.md`, so parked-wave tasks
  no longer bloat session-start, size budgets, or next-action routing.
  Round-trip restore is byte-identical.
- `--apply-decomposition` now supports multi-repo epics — an optional
  per-task `repo:` field in the decomposition block (rendered as
  `- **Repo:**` / `- **Repos:**`) and a `--repo <name>` batch default;
  `TASK_STATUS` stubs are now built from the shared library builder.
- Validator `duplicate_task_status_entry` check (warning severity) —
  detects a task duplicated across `TASK_STATUS.md` sections and
  duplicate section headings, catching incomplete-archival fallout that
  previous Active-only checks missed.
- `--check-sync` now reports a stale/naive managed `PostToolUse` hook in
  known projects and names `mavp-install.js --update <dir>` as the fix.
- Auto-sync (sync-status) now mirrors a renamed `BACKLOG.md` task heading
  title into `TASK_STATUS.md` (emitting "sync-status: retitled T-NNN"),
  clearing the persistent `title_mismatch` warning that status-only sync
  could never fix.
- `--check-sync` now warns when a `~/.mavericks` checkout's version lags
  the canonical repo, naming both versions and the path.

### Changed

- `artifact_size_budget` Active-section budgets now scale with active
  task count (`max(static default, per-task allowance × count)`), so a
  legitimate large epic wave no longer permanently trips the advisory;
  explicit `artifact_budgets` overrides still win. (info-severity, never
  blocking.)
- Templates (`BACKLOG_TEMPLATE.md`, `TASK_STATUS_TEMPLATE.md`)
  standardized to `- **Owner role:**` to match tooling/validator canon.

### Fixed

- `--close-session` mid-wave merge archival is now symmetric — merged
  tasks are archived out of BOTH `BACKLOG.md` (status set to merged +
  block moved out of Active Wave) and `TASK_STATUS.md`, eliminating the
  `missing_in_task_status` exit-2 and the sync-status
  skeleton-duplication loop. The validator now runs BEFORE
  `PROCESS_STATE` mutations, so an aborted (exit-2) close no longer
  leaves half-mutated state or double-bumps `wave_session` on re-run.
- Hooks now prefer a project's own `scripts/` (when
  `scripts/mavp-validator.js` is present) over the
  `MAVERICKS_HOME` > `~/.mavericks` > legacy resolution chain — a
  self-hosting mavericks checkout no longer runs its quality gates
  against a stale `~/.mavericks` mirror; adopter/direct-reference
  projects (no local validator) are unaffected.
- `--close-session` now creates the session commit on validator exit 0
  or 1 (warnings), skipping only on exit 2 (repair required) with an
  explicit "session commit SKIPPED" message — previously a
  warnings-only validator run silently skipped the commit.

## [0.33.0] — 2026-07-19

### Added

- `--archive-merged` operator command — archive merged task blocks out of
  `BACKLOG.md`'s Active Wave and `TASK_STATUS.md`'s Active tasks mid-wave,
  without waiting for the end-of-session close-out.
- Opt-in session-transcript archive — a `--transcript-archive` installer
  flag (works with fresh install, `--update`, and `--hooks-only`) activates
  a managed `SessionStart` hook that sweeps Claude Code session transcripts
  into a gitignored `.mavp/transcripts/<session-id>.jsonl` before Claude
  Code's ~30-day cleanup removes them. Off by default, local-disk only.
- Retention pruning for the transcript archive — set the
  `MAVP_TRANSCRIPT_RETENTION_DAYS` environment variable to bound the
  archive's growth; the default remains unlimited.
- Decision records gain an optional `Session:` lineage field — an opaque
  Claude Code session id pointing at the deliberation behind a record. The
  record body stays self-sufficient; the pointer is explicitly never
  load-bearing.

### Changed

- The status-sync hook now auto-creates a missing `TASK_STATUS.md` entry
  for any new `BACKLOG.md` Active Wave task, completing the
  BACKLOG→TASK_STATUS mirror automatically (deprecated and superseded
  tasks are skipped).
- Task registration in the state artifacts is documented as a
  Main-Agent-only responsibility, never delegated to sub-agent briefs.

### Fixed

- The status-sync PostToolUse hook is silent on no-ops — it only emits
  output for real errors and actual mutations, restoring the
  "silent means success" hook contract and eliminating alarm fatigue from
  routine no-op runs.

## [0.32.2] — 2026-07-15

### Added

- Cross-repo `Blocked by: <repo>/T-NNN` merge gate — the validator resolves
  the referenced repo through the repo-map registry and blocks (or warns on)
  a merge until the blocker task reaches `merged`, as a cross-repo
  complement to the existing same-repo `Depends on:` field.
- Repo-map registry (`docs/REPO_MAP.md`) — per-project registry of repo id,
  label, path, domain, and deploy metadata, used to resolve cross-repo
  references.
- RCA-to-codification (`docs/core/RCA_CODIFICATION.md`) — every root-cause
  analysis now routes each root cause to exactly one durable fix mechanism
  (rule edit, role-spec proposal, memory entry, armed recheck, or
  mechanical enforcement change), tracked by a follow-up task.
- Decision records (`docs/core/DECISIONS.md`) gain greppable lineage fields
  (`Informed by:` / `Supersedes:` / `Tasks:`) for tracing a decision through
  the tasks and log entries that acted on it.
- Publish-manifest creation-time guard plus a blocking commit-time backstop,
  so new files are classified (ship/exclude) at creation and enforced again
  before commit.
- Session start now renders an `UPDATE_AVAILABLE` notice when a newer
  framework version has been published.

### Changed

- README documents the cross-repo `Blocked by` merge gate and the new
  core-docs entries introduced above.

## [0.29.1 and earlier] — Baseline

A one-time inventory of the capabilities already established before this
changelog began:

- **Task lifecycle and state artifacts** — `BACKLOG.md`, `TASK_STATUS.md`,
  and `PROCESS_STATE.json`/`PROCESS_STATE.md` track every task through a
  defined lifecycle, enforced by a validator gate. See
  [`docs/core/TASK_LIFECYCLE.md`](docs/core/TASK_LIFECYCLE.md).
- **Operator CLI** — `scripts/mavp-operator` provides the dashboard,
  session-start briefs, task registration/status commands, wave close-out,
  and framework install/update/strip operations.
- **Sub-agent role specs** — per-role behavior definitions in
  [`.claude/agents/`](.claude/agents/), with the operating-model rules for
  how roles hand off work in [`docs/core/ROLES.md`](docs/core/ROLES.md).
- **Bootstrap and direct-reference model** — new projects are seeded via
  `mavp-install.js`, and bootstrapped projects reference this installation
  directly rather than vendoring core scripts. See
  [`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md).
- **Claude Code hooks** — `SessionStart`, `PostCompact`, and `PostToolUse`
  hooks activated by the installer, covering validator checks and
  doc-sync advisories. See
  [`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md) —
  "Claude Code hooks activation".
- **Skill-reflection loop** — mines past task outcomes and proposes bounded
  edits to role specs for human review. See
  [`docs/SKILL_OPTIMIZATION.md`](docs/SKILL_OPTIMIZATION.md).

Tags v0.23.3–v0.29.1 predate this changelog and are not individually
annotated.
