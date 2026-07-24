# Changelog

All notable changes to Mavericks are documented in this file, in a format
inspired by [Keep a Changelog](https://keepachangelog.com/). For how the
framework actually works, see [README.md](README.md) and the core process
docs in [`docs/core/`](docs/core/).

## [Unreleased]

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
