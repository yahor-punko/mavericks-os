# Changelog

All notable changes to Mavericks are documented in this file, in a format
inspired by [Keep a Changelog](https://keepachangelog.com/). For how the
framework actually works, see [README.md](README.md) and the core process
docs in [`docs/core/`](docs/core/).

## [Unreleased]

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
