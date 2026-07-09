# Contributing to Mavericks

Mavericks is a reusable operating model for agent-driven development — a framework other projects adopt, not a deliverable product in its own right. Contributions are welcome, but because the framework governs its own development process, changes to it should go through that same process where practical. This document describes how work actually flows through this repository and how to propose a change as an external contributor.

## Before you start

Read [`CLAUDE.md`](CLAUDE.md) first — it is the single source of truth for how this repository operates. The sections most relevant to contributors:

- **Architecture** — the direct-reference model, core layer (`docs/core/`), the shared library (`scripts/mavp-operator-lib.js`), and sub-agent role definitions (`.claude/agents/`).
- **Key conventions** — artifact-first truth, the mirror rule, evidence formats, and the various optional fields tasks can declare.
- **Orchestrator checklist** — the sequence a change must pass through before any file is touched.

Also skim `docs/core/`:

- [`TASK_LIFECYCLE.md`](docs/core/TASK_LIFECYCLE.md) — the full task state machine, verification types, and evidence rules.
- [`ROLES.md`](docs/core/ROLES.md) — what each sub-agent role is responsible for.
- [`ORCHESTRATION_RULES.md`](docs/core/ORCHESTRATION_RULES.md) — the pre-task architect/analyst gate and worktree-integration rules the Main Agent follows.
- [`BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md) — how a new project adopts Mavericks.

## How work moves through this repository

Mavericks tracks all work as tasks in `BACKLOG.md`, mirrored in `TASK_STATUS.md`, with lightweight machine state in `PROCESS_STATE.json`. This is the "artifact-first truth" convention: a change is not considered real until it is reflected in these files, not just in a chat transcript or a commit message.

### 1. The architect gate

Before any task is registered, work of sufficient scope passes an architect review. In an internally-run session this is a sub-agent step (`architect`, optionally preceded by `analyst` for external research). As an external contributor opening a pull request, you do not need to run this gate yourself, but you should expect a maintainer to apply the same reasoning when reviewing your proposal: does the change touch multiple areas of the framework, introduce new infrastructure, or require choosing between competing approaches? If so, expect the maintainer to ask clarifying questions or request a design discussion before merging, mirroring the internal architect step.

### 2. Task lifecycle

Once scoped, a task moves through a defined set of states:

```
planned → in_progress → dev_done → [ux_review →] [security_review →] ready_for_qa → qa_passed → merged
```

- **`planned`** — registered in `BACKLOG.md` but not started.
- **`in_progress`** — active implementation.
- **`dev_done`** — implementation complete, awaiting review.
- **`ux_review`** / **`security_review`** — optional stages, only entered when a task is flagged `requires_ux: true` or `requires_security_review: true`.
- **`ready_for_qa`** → **`qa_passed`** — verification against the task's declared `Verification type` (`artifact`, `runtime`, `visual`, or `manual`). See `docs/core/TASK_LIFECYCLE.md` for what each type requires.
- **`merged`** — the task is complete and requires a `commit:` (or `infra:` / `artifact:` where applicable) reference in its `TASK_STATUS.md` evidence block.

Every status change in `BACKLOG.md` must be mirrored in `TASK_STATUS.md` in the same turn — this is the mirror rule. A Node.js validator (`scripts/mavp-validator.js`) checks this and other artifact-sync invariants; it runs automatically via a pre-commit hook (`.claude/hooks/pre-commit`) and is safe to run manually:

```bash
node scripts/mavp-validator.js
```

Exit codes: `0` healthy, `1` drifting (warning only), `2` repair required (blocks the commit).

### 3. Sub-agent roles

Internally, work is delegated to specialized sub-agents rather than implemented directly by the orchestrating agent. Each role has a spec in `.claude/agents/`:

| Role | Responsibility |
|---|---|
| **developer** | narrow, self-contained implementation slices |
| **qa** | functional validation — returns `qa_passed` or `needs_fix` |
| **ux** | flow, microcopy, and feedback-state review (optional per task) |
| **security-reviewer** | security review (optional per task) |
| **product-docs** | backlog clarity, process docs, artifact sync |
| **technical-writer** | user-facing docs (README, guides, API reference, CHANGELOG) |
| **architect** | pre-task design brief and decomposition |
| **analyst** | external technology/landscape research |

You don't need to role-play these as an external contributor, but a pull request that bundles unrelated concerns (e.g. a process-doc change and a code change) will likely be asked to split, matching the boundary these roles enforce internally.

## Proposing a change (pull request flow)

1. **Open an issue first for anything non-trivial.** Describe the problem, not just the fix — this mirrors how a task's "Problem statement" is captured in `BACKLOG.md` before work starts.
2. **Fork and branch.** Use a descriptive branch name.
3. **Keep the change scoped.** One logical change per pull request — the same "narrow, self-contained slice" principle that governs internal developer sub-agent tasks.
4. **Run the validator before opening the PR** if your change touches `BACKLOG.md`, `TASK_STATUS.md`, or scripts under `scripts/`:
   ```bash
   node scripts/mavp-validator.js
   ```
5. **Respect the ownership boundaries documented in the sub-agent specs.** In particular:
   - User-facing docs (`README.md`, `CHANGELOG.md`, getting-started guides, API reference) belong to the technical-writer scope.
   - Process docs (`docs/core/`), `BACKLOG.md`, `TASK_STATUS.md` templates, and internal operating-model artifacts belong to the product-docs scope.
   - Scripts, configuration, and code belong to the developer scope.
   If your pull request needs to touch both a process doc and code, consider splitting it into two PRs — this mirrors how the Main Agent splits such work into two sub-agent tasks internally.
6. **Describe the verification you performed.** State what you ran and what you observed — e.g. "ran `node scripts/mavp-validator.js`, exit code 0" or "manually walked through the bootstrap steps in a scratch directory." This maps to the `verification_type` an internal task would declare (`artifact`, `runtime`, `visual`, or `manual`).
7. **Do not edit `BACKLOG.md` or `TASK_STATUS.md` to mark your own PR as `merged`.** Those files track this repository's internal task state and are maintained by the maintainers; your PR description is sufficient for external contributions.

## Reporting bugs

Open a GitHub issue with:
- What you expected to happen and what actually happened.
- The output of `./scripts/mavp-operator --version`.
- Steps to reproduce, including any relevant `BACKLOG.md`/`TASK_STATUS.md` state if the issue involves the validator or operator tooling.

## Reporting security issues

Do not open a public issue for security vulnerabilities. See [`SECURITY.md`](SECURITY.md) for the reporting process, and note that `SECURITY.md` also documents an important default (`permissions.defaultMode: "bypassPermissions"`) you should be aware of before running Claude Code sessions against a clone of this repository.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.
