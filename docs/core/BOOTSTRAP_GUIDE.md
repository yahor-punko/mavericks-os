# Bootstrap guide

How to set up a new project with Mavericks.

## Step 1 — Run the installer

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" /path/to/your-project
```

This creates:
- `scripts/mavp-operator` — bash wrapper delegating to mavericks
- `scripts/mavp-operator-agent.js` — project-specific session summary
- `scripts/mavp-operator-close-session.js` — end-of-session ritual
- `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` — from templates
- `PROCESS_STATE.json` — machine-readable state

### Where the installer looks for mavericks

Generated wrappers and hooks resolve the mavericks install location in this order:

1. **Explicit `MAVERICKS_HOME` env var** — always wins if set.
2. **`$HOME/.mavericks`** — the canonical default location, used if that directory exists. This is where the public installer (`install.sh`) clones mavericks.
3. **`$HOME/Documents/mavericks`** — legacy fallback, used only if neither of the above resolves.

**Maintainer caveat:** if you develop the framework itself from a checkout at `~/Documents/mavericks` *and* a `~/.mavericks` directory also exists on the same machine (e.g. from installing mavericks into another project), the `~/.mavericks` copy will silently shadow your `Documents` checkout for every wrapper or hook that doesn't set `MAVERICKS_HOME` explicitly — because step 2 resolves before step 3 ever runs. Framework developers should set `MAVERICKS_HOME` explicitly in their shell profile to avoid running against the wrong checkout.

This first install is a one-time human-run command: an agent session opened before Mavericks is installed may lack shell/edit permission entirely, since the permissive default (`bypassPermissions`) is created *by* this install and can't exist before it runs.

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

**Non-interactive installs and `--yes`** — a fresh install normally asks `Create N file(s)...? [Y/n]` at a real interactive TTY. Two ways to skip that prompt: **no TTY** (run from an agent's Bash tool, piped, or in CI) — the installer detects this automatically, auto-proceeds as if answered `Y`, and prints a one-line `Non-interactive session — creating N file(s)...` notice instead of hanging; or **`--yes` / `-y`** — accepts the default answer even at a real TTY, for scripted or runbook installs. This is safe because a fresh install is additive: it only creates files that don't already exist. `--strip` is the opposite — it is destructive, so it does **not** get this treatment: at a non-TTY it prints the deletion manifest, deletes nothing, and exits 1, and `--yes` has no effect on it (strip always requires a real interactive confirmation — see `scripts/mavp-install.js`'s header comment for the full two-stage confirm flow, and the `--strip` line in the root `CLAUDE.md`).

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

The installer automatically sets up a git pre-commit hook that runs the validator before every commit.

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
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project
```

This re-copies `.claude/hooks/pre-commit` from the mavericks source along with agents, skills, and rules.

## Close-session commit contract

`--close-session` (`scripts/mavp-operator-close-session.js`, both interactive and non-interactive modes) creates a session commit — `chore: close session <date>` — as part of every close-session run, gated only by the validator's exit code:

| Validator exit code | Meaning | Session commit behaviour |
|---|---|---|
| `0` — healthy | Artifacts in sync | Commit proceeds |
| `1` — drifting | Minor drift / warnings only | Commit still proceeds |
| `2` — repair required | Artifacts out of sync | **Commit skipped** — prints `session commit SKIPPED — validator exit 2 (repair required); commit manually after repair` |

This mirrors the pre-commit hook's own gate (only exit 2 blocks), so the two mechanisms never disagree about what counts as "safe to commit."

**Staging scope.** The commit stages tracked files only, via `git add -u` — it never runs `git add -A` or `git add .`. Any newly-created untracked file is left out of the session commit; if you created new files this session, stage and commit them yourself (or verify they were staged by an earlier, more targeted `git add` during the task itself). This is deliberate: `--close-session` is an end-of-session ritual over already-tracked state artifacts and code, not a catch-all for stray untracked files.

If the commit is skipped (exit 2), fix the reported artifact drift, re-run `--close-session` (or commit manually), then proceed to the wave-close push once the session commit exists.

## Claude Code hooks activation

Separate from the git pre-commit hook above, mavericks manages three Claude Code hooks in `.claude/settings.local.json`: `SessionStart`, `PostCompact`, and `PostToolUse` (the hardened validator hook, composed with the doc-sync and manifest-guard fragments).

**Default-on activation.** Both a fresh install and `--update` activate all three hooks automatically — no manual JSON editing or template copying required:
- **Fresh install** seeds `.claude/settings.local.json` from scratch with all three hooks already wired in (see "What gets installed" above).
- **`--update`** merges hooks into an existing `.claude/settings.local.json` idempotently (`mergeManagedHooks()` in `scripts/mavp-install.js`): it replaces the command of the installer-managed `PostToolUse` entry with the freshly composed one — picking up new fragments (e.g. doc-sync, manifest-guard) and any validator-filename migrations — appends that entry if none is found, and adds `SessionStart`/`PostCompact` only if they are absent.

**Managed-entry identity and ownership.** The installer recognizes "its" `PostToolUse` entry by matching the command against known identity signals (current/legacy validator filename, the debounce token, or an explicit sentinel prefix every composed command carries). Any hook entry that does **not** match — for example, a custom Bash-matcher entry an operator wrote by hand — is left byte-identical, in its original position, on every `--update`. **Rule of thumb: never hand-edit the installer-managed `PostToolUse` entry** — its `command` is overwritten on the next `--update`. If you need additional behavior, add it as a **separate** `PostToolUse` hook entry; the installer only ever touches the one entry it recognizes as its own.

**Opt-out: `--no-hooks`.** Pass `--no-hooks` to `--update` to skip the hooks merge for that run — everything else `--update` does still runs:

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project --no-hooks
```

**Narrow activation: `--hooks-only`.** Pass `--hooks-only <target-dir>` to sync ONLY the managed hooks (`PostToolUse` validator hook, `SessionStart`, `PostCompact`) into `.claude/settings.local.json`, plus the `.mavp-hook-ts` gitignore entry — no wrapper, no `.claude/{agents,skills,rules}` copy, no project-specific script sync:

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --hooks-only /path/to/your-project
```

Use this when a project already has its wrapper/agents/rules in place and only the hooks need activating or refreshing — this is the recommended command for the canonical self-activation case below.

**Canonical self-activation step.** `.claude/settings.local.json` is personal and gitignored, so it is never populated by cloning mavericks itself. To activate hooks locally on a mavericks checkout, run the installer's `--hooks-only` mode against the framework root:

```bash
cd "$HOME/.mavericks"   # or wherever your mavericks checkout lives
node scripts/mavp-install.js --hooks-only .
```

This is the recommended, narrowest command: it touches only `.claude/settings.local.json` (gitignored) and the `.mavp-hook-ts` gitignore entry, producing **no repo diff**, and turns on the hardened validator hook plus the doc-sync and manifest-guard fragments locally. Run it once after cloning, and again any time you want to pick up new fragment additions.

Running the broader `node scripts/mavp-install.js --update .` against the framework root is **also safe** (self-install detection makes `--update` skip the wrapper/`.claude/{agents,skills,rules}` sync when the target IS the mavericks framework's own root — see the installer's header comment and DR-003 in `docs/core/DECISIONS.md`), but it does more work than needed for hook activation alone; `--hooks-only` is the recommended command.

## Transcript archive

A DR's optional `Session:` field (see `docs/core/DECISIONS.md` — "Optional lineage fields") records the Claude Code session id a decision was deliberated in, so the deliberation can later be traced back to its full transcript. But Claude Code stores that transcript as a plain `.jsonl` file at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (`<cwd-slug>` is the project's absolute path with every `/` replaced by `-`) and deletes it after `cleanupPeriodDays` — 30 days by default — so an unqualified session id is provenance that self-destructs almost exactly when someone goes looking for it.

**`--transcript-archive` — opt-in, off by default.** Pass this flag to a fresh install, `--update`, or `--hooks-only` to activate a managed `SessionStart` hook that sweeps every transcript for the current project out of Claude's local storage into `<project>/.mavp/transcripts/<session-id>.jsonl` (`scripts/mavp-transcript-archive.js`) on every session start:

```bash
node scripts/mavp-install.js /path/to/your-project --transcript-archive        # fresh install
node scripts/mavp-install.js --update /path/to/your-project --transcript-archive     # existing project
node scripts/mavp-install.js --hooks-only /path/to/your-project --transcript-archive # narrow activation
```

Installing without the flag adds no such hook. Once activated, the entry is preserved and its command refreshed by every later `--update` — with or without the flag — so a project that opted in is never silently opted back out by a plain sync.

**Privacy — opt-in, gitignored, local-disk only.** A session transcript is the full raw conversation, not just the deliberation that ended up in the DR. The installer adds `.mavp/transcripts/` to the target project's `.gitignore` the moment this hook is activated, so archived transcripts are never git-tracked and never pushed anywhere. This is why the mechanism is opt-in rather than default-on: enabling it is a deliberate choice to retain that content locally for provenance purposes.

**Crash coverage.** Because the sweep runs on every `SessionStart` (not just at the end of a session), it also picks up transcripts from prior sessions that crashed, were force-quit, or were left open across a compaction — anything still sitting in Claude's storage gets archived before the ~30-day cleanup can remove it, not just the session that happens to be ending cleanly.

**Retention — opt-in, default unlimited.** By default the archive still grows unbounded — each sweep only ever adds files, it never deletes an archived transcript, even one whose source has since been cleaned up by Claude Code. Set the `MAVP_TRANSCRIPT_RETENTION_DAYS` environment variable to a positive number of days to bound it: every sweep run then also deletes any archived `.jsonl` file whose mtime is older than that many days.

```bash
export MAVP_TRANSCRIPT_RETENTION_DAYS=90   # prune archived transcripts older than 90 days
```

Leaving the variable unset (or setting it to `0`, a negative number, or a non-numeric value) keeps the default unlimited behavior — nothing is ever deleted. Pruning only ever touches archived copies under `<project>/.mavp/transcripts/`; it never touches the live source transcripts in Claude's own storage directory (`~/.claude/projects/<cwd-slug>/`).

**Disabling.** Remove the managed `SessionStart` entry from `.claude/settings.local.json` by hand — it's identifiable by the `: mavp-transcript-archive-hook;` sentinel prefix or by the `mavp-transcript-archive.js` filename in its command. A later `--update` run without `--transcript-archive` will not re-add it.

**Don't want the hook at all? Use Claude Code's own setting instead.** If you'd rather not add any mavericks-managed hook, Claude Code's `cleanupPeriodDays` user setting controls how long it keeps local transcripts before deleting them — raising it (or disabling cleanup) extends the natural window a `Session:` id stays resolvable, with no extra moving parts, at the cost of transcripts piling up in Claude's own storage location rather than the project.

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
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project
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
