# Bootstrap guide

How to set up a new project with Mavericks.

## Step 1 — Run the installer

```bash
node ~/Documents/mavericks/scripts/mavp-install.js /path/to/your-project
```

This creates:
- `scripts/mavp-operator` — bash wrapper delegating to mavericks
- `scripts/mavp-operator-agent.js` — project-specific session summary
- `scripts/mavp-operator-close-session.js` — end-of-session ritual
- `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` — from templates
- `PROCESS_STATE.json` — machine-readable state

If mavericks is not at `~/Documents/mavericks`, set `MAVERICKS_HOME` before running.

## Step 2 — Edit PROCESS_STATE.json

Set the initiative name and confirm wave 1:

```json
{
  "initiative": "Your project description",
  "stage": "execution",
  "wave": 1,
  "next_action": null,
  "blocker": null,
  "stage_owner": "main_agent",
  "last_updated": "YYYY-MM-DD"
}
```

## Step 3 — Add your first tasks

Either edit `BACKLOG.md` and `TASK_STATUS.md` manually, or use the interactive tool:

```bash
cd /path/to/your-project
./scripts/mavp-operator --new-task
```

Fill in `docs/ARCHITECTURE.md` — Overview, Services, Deploy contours (mark the rest DRAFT)

## What gets installed

The installer creates or copies (skipping files that already exist):

| What | Where | Source |
|---|---|---|
| `scripts/mavp-operator` | bash wrapper → delegates to mavericks | generated |
| `scripts/mavp-operator-agent.js` | project-specific session summary | mavericks template |
| `scripts/mavp-operator-close-session.js` | end-of-session ritual | mavericks template |
| `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` | live state artifacts | mavericks templates |
| `PROCESS_STATE.json` | machine-readable state | default |
| `.claude/agents/*.md` | sub-agent definitions (developer, product-docs, technical-writer, qa, ux, frontend-design, …) | copied from mavericks |
| `.claude/skills/*/SKILL.md` | user-invocable skills (session-start, validate, frontend-design, …) | copied from mavericks |
| `.claude/rules/*.md` | Claude Code rules for this project | copied from mavericks |
| `docs/ARCHITECTURE.md` | architecture document template (fill in at project start) | copied from mavericks |
| `.claude/settings.local.json` | seeds `effortLevel: "high"`, `alwaysThinkingEnabled: true`, and `fallbackModel: ["claude-opus-4-8"]` (default-ceiling reasoning + opus safety net) | generated |
| `.claude/settings.json` | shared, committed project settings — seeds `permissions.defaultMode: "bypassPermissions"` | generated |

Core framework scripts (`mavp-operator-lib.js`, `mavp-operator-dashboard.js`, validator) are **not copied** — they are used directly from the mavericks installation via the bash wrapper.

**Reasoning defaults** — on a fresh install, `.claude/settings.local.json` is seeded with `effortLevel: "high"` and `alwaysThinkingEnabled: true`. This is a **default ceiling for ordinary work, not a floor for everything** — the Main Agent still varies effort per-invocation via `opts.effort`: mechanical slices (boilerplate, well-understood single-file edits, doc-only formatting) drop to `medium`, while heavy or exceptional slices (complex refactors, novel logic, high blast radius) escalate to `xhigh` or `max`. Valid values for the seeded session default are `low`, `medium`, `high`, and `xhigh`. On `--update`, each key is backfilled only if absent — an existing value (e.g. a project that deliberately set `effortLevel: "medium"`) is preserved and never overwritten. To override the seeded default, set your preferred value in `.claude/settings.local.json` before or after running the installer. For the full per-role/per-slice effort-selection policy, see `docs/AGENT_SPEC.md` — "Effort selection".

**Fallback model safety chain** — on a fresh install, `.claude/settings.local.json` is also seeded with `fallbackModel: ["claude-opus-4-8"]`. This is a session-level safety net: if the primary session model becomes unavailable, the session falls back to Opus rather than silently degrading to a weaker model. On `--update`, the key is backfilled only if absent — an existing `fallbackModel` chain (however the project has configured it) is preserved and never overwritten. This setting is independent of, and not a substitute for, the architect model spawn policy (Fable 5 primary, Opus 4.8 fallback) described in `docs/AGENT_SPEC.md` — that policy governs which model the architect sub-agent is spawned with, while `fallbackModel` governs what the session itself falls back to if its configured model is unavailable.

**Shared permission-mode default** — on a fresh install, the installer creates a committed `.claude/settings.json` with `permissions.defaultMode: "bypassPermissions"`. This is the intended shipped default: a project-wide setting (checked into version control, unlike `settings.local.json` which is personal and gitignored) so every contributor starts with the same fully-autonomous baseline instead of hitting a per-tool approval prompt during agent-driven work. Claude Code's settings precedence is: managed settings > CLI flags > `.claude/settings.local.json` (personal) > `.claude/settings.json` (shared) > `~/.claude/settings.json` (user-global) — so a personal `settings.local.json` always wins over the shared default. **Factual note on what `bypassPermissions` means**: unlike `acceptEdits` (which only auto-accepts file edits), `bypassPermissions` suppresses the interactive approval prompt for *every* tool call — file edits, Bash commands (including destructive ones), and network access all proceed without a prompt. The single remaining human checkpoint under this mode is the mandatory pre-push results review enforced by `--close-session` (see the **Mandatory pre-push review** convention in the root `CLAUDE.md`) — there is no other approval gate between an agent's actions and their effect. To opt out, set your own `permissions.defaultMode` (e.g. `"default"`, `"plan"`, `"acceptEdits"`, or `"dontAsk"`) in your own `.claude/settings.local.json`; it overrides the committed value without touching the shared file, since `settings.local.json` always wins in the precedence order above. On `--update`, `permissions.defaultMode` is migrated as follows: if an existing `.claude/settings.json` has no `defaultMode` key, it is backfilled with `bypassPermissions`; if the existing value is the legacy `acceptEdits` default, it is migrated to `bypassPermissions` (the installer prints a console line noting the migration); any other value a project has deliberately set (`plan`, `default`, `dontAsk`, or an already-current `bypassPermissions`) is left untouched as the project's opt-out and is never overwritten. Existing projects that predate this feature pick it up automatically the next time `--update` is run.

When new agents or skills are added to mavericks, re-run the installer in an existing project to pull them in (only missing files are added, existing files are never overwritten).

## Step 4 — Verify setup

```bash
./scripts/mavp-operator --version     # should show the installed mavericks version
./scripts/mavp-operator --agent       # should show initiative + tasks
node scripts/mavp-validator.js  # should be healthy
```

Wait — `scripts/mavp-validator.js` runs from mavericks via the wrapper. Run via:
```bash
./scripts/mavp-operator --agent  # includes validator check silently
```

## Step 5 — Run the first cycle

1. Spawn a developer sub-agent with `.claude/agents/developer.md` as context + the task details
2. Review the output
3. Spawn a QA sub-agent with `.claude/agents/qa.md` as context if verification required
4. Accept → `merged`, or reject → `needs_fix`
5. Update artifacts, run `--close-session` at end of session

**Cross-repo slices** — when a developer agent must write to a target project (not mavericks itself), include `work_dir: [absolute path to target repo]` in the sub-agent brief. Without it, worktree isolation creates the worktree inside the mavericks installation.

## Step 6 — Scale

After one healthy cycle, parallelize narrow independent slices. Keep approval-sensitive and runtime-heavy work with the orchestrator.

## Pre-commit hook

The installer automatically sets up a git pre-commit hook that runs the parliamentary validator before every commit.

**What it does:**

| Validator exit code | Meaning | Commit behaviour |
|---|---|---|
| `0` — healthy | Artifacts in sync | Silent — commit proceeds |
| `1` — drifting | Minor drift detected | Warning printed, commit proceeds |
| `2` — repair required | Artifacts out of sync | **Commit blocked** with message: `COMMIT BLOCKED: artifact repair required. Run: node scripts/mavp-validator.js` |

**How it works:**

The hook lives at `.claude/hooks/pre-commit`. The installer runs:

```bash
git config core.hooksPath .claude/hooks/
```

This points git to the `.claude/hooks/` directory for all hooks in this repo.

**How to disable it** (temporarily or permanently):

```bash
git config --unset core.hooksPath
```

To re-enable:

```bash
git config core.hooksPath .claude/hooks/
```

**Keeping the hook up to date:**

```bash
node ~/Documents/mavericks/scripts/mavp-install.js --update /path/to/your-project
```

This re-copies `.claude/hooks/pre-commit` from the mavericks source along with agents, skills, and rules.

## Deploy CI: skipping framework-only commits

When the framework is synced into an adopting project, the commit touches only framework-owned artifacts — no deployable application code. If your CI pipeline deploys on branch push, these framework-sync commits will trigger the full pipeline (e.g. terraform plan/apply) unnecessarily.

### What the installer provides

On both fresh bootstrap and `--update`, the installer emits a ready-to-use fragment at:

```
templates/deploy-ci-paths-ignore.fragment.yml
```

This file contains a `paths-ignore` list covering every framework-owned path:

```yaml
paths-ignore:
  - 'BACKLOG.md'
  - 'TASK_STATUS.md'
  - 'PROCESS_STATE.md'
  - 'PROCESS_STATE.json'
  - 'EXECUTION_LOG.md'
  - '.claude/**'
  - '.mavp/**'
  - 'SKILL_PROPOSALS/**'
  - 'scripts/mavp-operator'
  - 'scripts/mavp-operator-agent.js'
  - 'scripts/mavp-operator-close-session.js'
```

### How to wire it in

Open your deploy workflow (e.g. `.github/workflows/deploy.yml`) and add the `paths-ignore` block to the relevant `push:` or `pull_request:` trigger:

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - 'BACKLOG.md'
      - 'TASK_STATUS.md'
      - 'PROCESS_STATE.md'
      - 'PROCESS_STATE.json'
      - 'EXECUTION_LOG.md'
      - '.claude/**'
      - '.mavp/**'
      - 'SKILL_PROPOSALS/**'
      - 'scripts/mavp-operator'
      - 'scripts/mavp-operator-agent.js'
      - 'scripts/mavp-operator-close-session.js'
```

> **Important:** Do not add `paths-ignore` to jobs triggered by `workflow_dispatch` or `schedule` — those triggers ignore path filters entirely. Apply only to `push` and `pull_request` triggers.

The installer never edits your workflow file automatically — this is intentional to avoid clobbering custom CI configurations.

### Two-commit verification

After wiring in the `paths-ignore` block, verify it works correctly with two commits:

1. **Framework-only commit** — make a change to any path in the `paths-ignore` list (e.g. update `BACKLOG.md`). Push and confirm that the deploy CI workflow is **skipped** (GitHub shows "skipped" rather than "queued" or "running").

2. **Deployable-code commit** — make a change to a path NOT in the list (e.g. `src/index.ts` or `terraform/main.tf`). Push and confirm the deploy CI workflow **runs normally**.

To check coverage locally before pushing:

```bash
# Simulate a framework-only change set
git diff --name-only HEAD~1 HEAD

# All changed paths should match patterns in the fragment.
# If any changed path is NOT in the list, CI will still run — which is correct.
```

### Keeping the fragment up to date

If new framework-owned paths are added in a future mavericks release, re-run the installer with `--update`:

```bash
node ~/Documents/mavericks/scripts/mavp-install.js --update /path/to/your-project
```

This emits a fresh fragment only if one does not already exist. To pull in path additions to an existing file, compare your wired `paths-ignore` list against the latest `templates/deploy-ci-paths-ignore.fragment.yml` manually.

> **v1 scope:** This fragment covers GitHub Actions only. GitLab CI / CircleCI support is tracked separately.

## Common failure modes

| Symptom | Cause |
|---|---|
| Sub-agent output is vague or oversized | Task slice was too wide |
| `qa_passed` with no evidence | QA not actually checked |
| Artifacts out of sync | Forgot to mirror BACKLOG ↔ TASK_STATUS |
| New session can't resume | PROCESS_STATE.json not updated at session end (`--close-session` regenerates PROCESS_STATE.md automatically) |
| Wave never closes | `--close-session` not run, no git push |
