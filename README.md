# Mavericks

An operating model for agent-driven development — structured handoffs, artifact-first state, and an operator dashboard for Claude Code workflows.

Mavericks is not a deliverable product you run in production. It's a reusable framework that other projects **adopt**: you bootstrap it into your own repository, and it gives your human operator and your main orchestrator agent a shared language and toolset for managing agent-driven work.

## What it is

- **Artifact-first truth** — state lives in `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md`/`PROCESS_STATE.json`, not in chat history
- **Explicit task lifecycle** — a defined state machine (see below) that every task moves through, with an artifact-sync validator catching drift
- **Role separation** — a main orchestrator agent plus specialized sub-agents (developer, QA, UX, security-reviewer, product-docs, technical-writer, architect, analyst, and more)
- **Artifact-sync validator** — detects drift between `BACKLOG.md` and `TASK_STATUS.md` before it causes confusion, and blocks commits when artifacts are out of sync
- **Operator dashboard** — a terminal UI showing workflow state, context usage, runtime actors, and open waits

## Why Mavericks

Mavericks wasn't designed on a whiteboard — it was extracted from running real agent-driven development across many repos at once. Everything here earned its place by keeping that work on track.

For a single operator directing a team of AI agents:

- **Never reconstruct where things stand.** Every session resumes from written state, not from re-reading a chat log — so your time goes to the decisions only you can make, not to status archaeology.
- **See — and diff — why the system did what it did.** State and decisions live in versioned artifacts, not in opaque model memory. Runs are auditable and repeatable instead of "trust the context window" — the process is inspectable even when the model isn't.
- **Drive several repos without holding it all in your head.** The full picture lives in the artifacts and a cross-repo task model, so nothing depends on you remembering it.
- **Capture the "why we built it this way" as you ship.** Architecture rationale is a normal step in finishing a task, not a cleanup job nobody gets to.
- **Delegate without babysitting.** An orchestrator plus specialized sub-agents — gated by an artifact-sync validator and QA / security / UX review — catch drift before it turns into rework.

## Before you clone

Mavericks ships with autonomous tool execution enabled by default (`permissions.defaultMode: "bypassPermissions"` in the committed `.claude/settings.json`). This means agents can read, write, and execute across your filesystem and shell without a per-action confirmation prompt once you start a session. This is deliberate — see **[`SECURITY.md`](SECURITY.md)** for exactly what it means and how to opt out before your first session.

## Quick start

### Requirements

- Node.js 18+
- Claude Code CLI (`claude`)
- git

### Step 1 — Get Mavericks onto your machine

Clone this repository somewhere on disk, e.g.:

```bash
git clone https://github.com/yahor-punko/mavericks-os.git <path-to-mavericks>
```

Everything below refers to that checkout as `<path-to-mavericks>`.

### Step 2 — Bootstrap a new project

From your own project's directory (or pointing at it):

```bash
node <path-to-mavericks>/scripts/mavp-install.js /path/to/your-project
```

Use `--check` first to preview what would happen without writing anything:

```bash
node <path-to-mavericks>/scripts/mavp-install.js --check /path/to/your-project
```

Runs non-interactively (no prompt) when invoked from an agent's Bash tool or piped/CI, or explicitly via `--yes` / `-y`; at a real terminal without either it still asks `Create N file(s)...? [Y/n]`.

If you ask an agent to install Mavericks from a session where shell access is denied, it can't — run the one command above yourself (terminal, or the `!` prefix in Claude Code). This one-time human step is deliberate: the person running the installer consents to the prompt-free `bypassPermissions` default it configures (see **[`SECURITY.md`](SECURITY.md)**). In prompting permission modes a single approval suffices instead. Later sessions inherit the configured permissions and the agent operates autonomously.

This creates, in `your-project/`:

- `scripts/mavp-operator` — a bash wrapper that delegates to this Mavericks installation
- `scripts/mavp-operator-agent.js` — project-specific session-start summary
- `scripts/mavp-operator-close-session.js` — end-of-session ritual
- `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md`, `PROCESS_STATE.json` — live state artifacts, from templates
- `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.claude/rules/*.md` — sub-agent specs, skills, and rules, copied from this repo
- `.claude/settings.json` / `.claude/settings.local.json` — shared and personal Claude Code settings (see **Before you clone** above)

Core framework scripts (the operator library, dashboard, validator) are **not copied** into your project — the generated `scripts/mavp-operator` wrapper runs them directly from this Mavericks checkout.

By default the wrapper looks for Mavericks at `$HOME/Documents/mavericks`. If you cloned it somewhere else, set `MAVERICKS_HOME` to that path (e.g. in your shell profile or before invoking the wrapper):

```bash
export MAVERICKS_HOME=<path-to-mavericks>
```

The wrapper also exports `MAVERICKS_PROJECT_ROOT` automatically when it runs, pointing framework scripts at *your* project's artifacts rather than the Mavericks checkout itself — you don't need to set this one yourself.

For the full step-by-step, including editing `PROCESS_STATE.json`, adding your first tasks, and setting up the pre-commit validator hook, see **[`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md)**.

### Step 3 — Run operator commands (from your bootstrapped project)

```bash
./scripts/mavp-operator --agent          # session-start JSON summary
./scripts/mavp-operator                  # operator dashboard
./scripts/mavp-operator --watch          # dashboard with auto-refresh (r refresh, s snapshot, q quit)
./scripts/mavp-operator --snapshot       # text snapshot for agent context
./scripts/mavp-operator --close-session  # end-of-session ritual (results review + optional git push)
./scripts/mavp-operator --new-task       # interactive task creation
./scripts/mavp-operator --version        # framework version
./scripts/mavp-operator --help           # show all flags
```

## Project artifacts

| File | Purpose |
|---|---|
| `BACKLOG.md` | All tasks — status, owner, dependencies, acceptance criteria |
| `TASK_STATUS.md` | Active tasks detail + recently completed |
| `PROCESS_STATE.md` | Current initiative, stage, blockers, next handoff (auto-generated from `PROCESS_STATE.json`) |
| `PROCESS_STATE.json` | Machine-readable state overlay for operator tools |

## Task lifecycle

```
planned → in_progress → dev_done → [ux_review →] ready_for_qa → qa_passed → merged → [runtime_verified] → [deployed_dev →] [deployed_prod]
```

With UX review (task sets `requires_ux: true`):

```
dev_done → ux_review → ux_passed → ready_for_qa → ...
                     ↘ ux_needs_fix → developer
```

With security review (task sets `requires_security_review: true`):

```
dev_done → security_review → security_passed → ready_for_qa → ...
                            ↘ security_needs_fix → developer
```

Deploy statuses (`deployed_dev`, `deployed_prod`) are optional — projects without an explicit deploy pipeline stay on `merged` as their final state. See **[`docs/core/TASK_LIFECYCLE.md`](docs/core/TASK_LIFECYCLE.md)** for the full state machine, verification types, and evidence rules.

## Roles

Every sub-agent role has a spec in [`.claude/agents/`](.claude/agents/) — pass the relevant file to the sub-agent as context when spawning it. The main orchestrator agent (plans, coordinates, accepts/rejects sub-agent work, drives momentum) does not have its own spec file — it *is* the session you're running, on Opus 4.8.

| Role | Responsibility | Model | Prompt |
|---|---|---|---|
| **Developer** | Narrow, self-contained implementation slices | Sonnet (→ Opus for complex slices) | [`.claude/agents/developer.md`](.claude/agents/developer.md) |
| **QA** | Functional validation against acceptance criteria — `qa_passed` or `needs_fix` | Sonnet (→ Opus for complex slices) | [`.claude/agents/qa.md`](.claude/agents/qa.md) |
| **UX** | Flows, microcopy, feedback states, accessibility — `ux_passed` or `ux_needs_fix` (optional per task) | Sonnet (→ Opus for complex slices) | [`.claude/agents/ux.md`](.claude/agents/ux.md) |
| **Security reviewer** | Security review for new inputs/outputs, auth flows, integrations — `security_passed` or `security_needs_fix` (optional per task) | Sonnet (→ Opus for a full, non-checklist review) | [`.claude/agents/security-reviewer.md`](.claude/agents/security-reviewer.md) |
| **Product/docs** | Backlog clarity, process docs, artifact sync | Sonnet (→ Opus for complex slices) | [`.claude/agents/product-docs.md`](.claude/agents/product-docs.md) |
| **Technical writer** | User-facing docs — README, getting-started guides, API reference, changelog | Sonnet (→ Opus for complex slices) | [`.claude/agents/technical-writer.md`](.claude/agents/technical-writer.md) |
| **Architect** | Pre-task design brief and task decomposition (mandatory gate before any sub-agent is spawned) | Fable 5 (primary) → Opus 4.8 (fallback) | [`.claude/agents/architect.md`](.claude/agents/architect.md) |
| **Analyst** | External technology and landscape research, ahead of architect review | Sonnet (→ Opus for complex slices) | [`.claude/agents/analyst.md`](.claude/agents/analyst.md) |
| **Frontend design** | Visual/interaction design for frontend surfaces | Sonnet (→ Opus for complex slices) | [`.claude/agents/frontend-design.md`](.claude/agents/frontend-design.md) |
| **UI designer** | UI component and layout design | Sonnet (→ Opus for complex slices) | [`.claude/agents/ui-designer.md`](.claude/agents/ui-designer.md) |
| **Exa researcher** | Web research via the Exa search tool | Sonnet (→ Opus for complex slices) | [`.claude/agents/exa-researcher.md`](.claude/agents/exa-researcher.md) |

Model and effort selection policy (including the exact escalation signals) lives in [`docs/AGENT_SPEC.md`](docs/AGENT_SPEC.md) — "Model selection" — the single source of truth.

## Core docs

All in [`docs/core/`](docs/core/):

| Doc | What it covers |
|---|---|
| [`ROLES.md`](docs/core/ROLES.md) | Role definitions |
| [`TASK_LIFECYCLE.md`](docs/core/TASK_LIFECYCLE.md) | Full task state machine |
| [`ORCHESTRATION_RULES.md`](docs/core/ORCHESTRATION_RULES.md) | Main agent coordination rules |
| [`APPROVALS_AND_BLOCKERS.md`](docs/core/APPROVALS_AND_BLOCKERS.md) | Blocker format and silence rule |
| [`QA_HANDOFF.md`](docs/core/QA_HANDOFF.md) | QA handoff protocol |
| [`BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md) | Step-by-step new project setup |
| [`NEW_PROJECT_CHECKLIST.md`](docs/core/NEW_PROJECT_CHECKLIST.md) | Bootstrap checklist |
| [`OPERATOR_DASHBOARD.md`](docs/core/OPERATOR_DASHBOARD.md) | Operator dashboard panel reference |
| [`DOC_SYNC.md`](docs/core/DOC_SYNC.md) | Doc-sync advisory (post-merge doc-update reminders) |
| [`SECRET_LEAK_RESPONSE.md`](docs/core/SECRET_LEAK_RESPONSE.md) | Post-publish secret-leak response runbook |

## Validator

```bash
node scripts/mavp-validator.js
```

Exit codes: `0` healthy · `1` drifting · `2` repair required (blocks commit via the pre-commit hook)

Run after every `BACKLOG.md` or `TASK_STATUS.md` change. The pre-commit hook at `.claude/hooks/pre-commit` runs it automatically on every `git commit` once wired up (see `docs/core/BOOTSTRAP_GUIDE.md` — "Pre-commit hook").

## Security

Mavericks ships with `permissions.defaultMode: "bypassPermissions"` by default — see **[`SECURITY.md`](SECURITY.md)** for what that means and how to opt out, and for how to report a vulnerability.

## Contributing

See **[`CONTRIBUTING.md`](CONTRIBUTING.md)** for how work moves through this repository and how to propose a change as an external contributor. Participation is governed by the **[Contributor Covenant](CODE_OF_CONDUCT.md)**.

## License

Mavericks is licensed under the [MIT License](LICENSE). It vendors one third-party component (the `frontend-design` skill, Apache-2.0) — see **[`NOTICE`](NOTICE)** for the full attribution and carve-out.
