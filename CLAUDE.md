# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Mavericks is a reusable operating model for agent-driven development. Not a deliverable product — a framework adopted by other projects. Contains:
- Core process docs (`docs/core/`)
- Node.js operator tooling (`scripts/`)
- Project artifact templates (`templates/`)

## Session start

```bash
./scripts/mavp-operator --agent
```

The session-start brief reports the active permission mode via a `permission_mode` field (resolved from `.claude/settings.json` / `.claude/settings.local.json` precedence — see the **Shared permission-mode default** note in `docs/core/BOOTSTRAP_GUIDE.md`).

## Operational commands

```bash
./scripts/mavp-operator                  # operator dashboard — see docs/core/OPERATOR_DASHBOARD.md for panel reference
./scripts/mavp-operator --watch          # dashboard watch mode (r/s/q)
./scripts/mavp-operator --snapshot       # text snapshot for context
./scripts/mavp-operator --close-session  # end-of-session ritual — auto-detects mode: interactive (TTY) runs per-task prompts + wave-goal + git-push prompt; non-interactive (agent/headless) prints a git-push reminder instead of prompting; use --interactive to force interactive mode; use --push to auto-push after session commit on non-interactive wave-complete close (interactive mode unaffected — it already prompts); prints RENAME_SESSION: at the end; in CLI: `/rename <value>`; in VSCode: hover session in sidebar → rename
./scripts/mavp-operator --handoff [--notes "..."]  # capture mid-session context to HANDOFF.md for next session
./scripts/mavp-operator --new-task       # interactive task creation
./scripts/mavp-operator --quick-task     # quick task skeleton (title + problem only)
./scripts/mavp-operator --update-task    # interactive task status update
./scripts/mavp-operator --set-status T-xxx,T-yyy status [--from <current_status>]  # batch status update across BACKLOG + TASK_STATUS; optional --from guard: only transitions tasks whose current status equals <current_status>, skips others with a warning (validator runs once at the end — no transient state warnings)
./scripts/mavp-operator --rename-task T-xxx "New title"  # atomically rename task title in BACKLOG + TASK_STATUS
./scripts/mavp-operator --rescope-task T-NNN [--status <s>] [--owner <role>] [--title "..."]  # atomically re-scope or un-defer a task: moves its block between BACKLOG.md's Deferred Tasks <-> Active Wave sections (creating Deferred Tasks on demand if absent), applies status/owner/title changes, ensures a matching TASK_STATUS.md Active tasks entry when activating, preserves the task ID, fails fast on duplicate/missing ID; validator runs once at the end
./scripts/mavp-operator --update-status T-NNN <status>  # atomically set a single task's status in BACKLOG + TASK_STATUS (single-task predecessor of --set-status)
./scripts/mavp-operator --merge-task     # promote a qa_passed task to merged with evidence
./scripts/mavp-operator --quick-merge    # fast-track an XS change directly to merged (title + commit hash); use only for <=2 files, <=10 lines diff, no risk
./scripts/mavp-operator --sync-status    # sync TASK_STATUS.md Status lines from BACKLOG.md Active Wave
./scripts/mavp-operator --set-strategy-note "text"  # set wave strategy context note in PROCESS_STATE.json; persists until --close-session; empty string clears
./scripts/mavp-operator --validate       # run the validator via the operator wrapper (equivalent to node scripts/mavp-validator.js "$(pwd)")
./scripts/mavp-operator --check-sync     # compare agent/skill files in known projects against mavericks source
./scripts/mavp-operator --install <target-dir> [--yes]  # bootstrap Mavericks into a target project (operator wrapper for node scripts/mavp-install.js); non-TTY runs (e.g. agent Bash) auto-proceed creating missing files without prompting, `--yes`/`-y` does the same at a real TTY — `--strip` is unaffected and always refuses non-interactively since it's destructive
./scripts/mavp-operator --strip <target-dir> [--keep-artifacts]  # remove Mavericks files from a project (pre-publish cleanup); prints a git-recoverability manifest before any prompt, then two-stage confirm — plumbing [y/N], state artifacts (BACKLOG/TASK_STATUS/PROCESS_STATE/EXECUTION_LOG/SKILL_PROPOSALS) require typing "delete" if any state path is git-irrecoverable; --keep-artifacts skips the state group; requires an interactive TTY
./scripts/mavp-operator --apply-decomposition [FILE]  # apply architect decomposition block to BACKLOG + TASK_STATUS
./scripts/mavp-operator --arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]  # register a time-based post-merge recheck for task T-NNN; auto-assigns next RC-N id; copies task title for self-containment
./scripts/mavp-operator --ack-recheck RC-N [--rearm]  # acknowledge and remove a recheck; --rearm reschedules instead (sets due = today + interval; requires interval on the entry)
./scripts/mavp-operator --version        # framework version
./scripts/mavp-operator --help           # show all flags
node scripts/mavp-install.js <dir>       # bootstrap a new project (--check to preview, --update to re-sync; both also activate/refresh Claude Code hooks by default — --no-hooks to skip; --hooks-only activates/refreshes hooks only, no framework-file sync — the safe narrow command for the canonical self-install case)
node scripts/mavp-validator.js  # validate artifact sync
node --check scripts/<file>.js           # syntax-check a script without running it
```

Validator exit codes: `0` = healthy, `1` = drifting, `2` = repair required.

## Architecture

**Direct-reference model** — bootstrapped projects do NOT copy core scripts. Their `scripts/mavp-operator` bash wrapper delegates to this mavericks installation via `MAVERICKS_PROJECT_ROOT` env var. Only project-specific scripts (agent.js, close-session.js) live in the project.

**Core layer** (`docs/core/`) — task lifecycle, roles (incl. UX sub-agent), orchestration rules, QA handoff, bootstrap guide.

**Live state** — `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` / `PROCESS_STATE.json`. `PROCESS_STATE.md` is auto-generated from `PROCESS_STATE.json` — do not edit it manually. `EXECUTION_LOG.md` records agent spawning events and key decisions; update it when spawning sub-agents or closing a wave.

**Shared library** — `scripts/mavp-operator-lib.js` contains all parsing, rendering, and utility functions used by the operator scripts. Read it before adding new operator commands to avoid re-implementing existing helpers.

**Sub-agent role definitions** — `.claude/agents/` contains per-role behavior specs (developer, qa, ux, product-docs, technical-writer, security-reviewer, frontend-design, ui-designer, exa-researcher, architect, analyst). Read these before briefing a sub-agent.

**Skill reflection loop** — `docs/SKILL_OPTIMIZATION.md` defines the SkillOpt-inspired system that mines past task outcomes and proposes bounded edits to role specs. Run via `--reflect-skill <role>` at wave close. Proposals land in `SKILL_PROPOSALS/` and require human review before any spec change is applied.

**Rules files** — `.claude/rules/` contains three supplementary constraint files (backlog.md, docs.md, scripts.md) that extend the conventions in this file. They are authoritative for their respective domains.

**Bootstrap** — `node scripts/mavp-install.js <target-dir>` seeds a new project with the bash wrapper, project-specific scripts, and artifact templates, and activates the Claude Code hooks (`SessionStart`, `PostCompact`, `PostToolUse`) in `.claude/settings.local.json` by default. Use `--check` to preview, `--update` to re-sync agents/rules/hooks — idempotent, and it only ever replaces the installer-managed hook entries, never operator-authored ones. Pass `--no-hooks` to `--update` to skip the hooks merge for that run. See `docs/core/BOOTSTRAP_GUIDE.md` — "Claude Code hooks activation" for the managed-entry ownership rule and the canonical self-activation step. VSCode projects must also add `Agent(*)` to `permissions.allow` in `.claude/settings.local.json` — see the **VSCode Agent permissions** convention below.

**Pre-commit hook** — `.claude/hooks/pre-commit` runs the validator on every `git commit`. Exit code 2 blocks the commit. To install: copy or symlink to `.git/hooks/pre-commit`.

## Key conventions

- **Artifact-first truth** — state transitions must be in markdown artifacts before they are real.
- **Mirror rule** — every status change in `BACKLOG.md` must be mirrored in `TASK_STATUS.md` before the turn ends.
- **Run validator** after every `BACKLOG.md` or `TASK_STATUS.md` change.
- **PostToolUse hook — silent means success** — a PostToolUse hook runs the validator after every Edit on `BACKLOG.md` or `TASK_STATUS.md`. When the hook exits with no stdout/stderr output and exit code 0, that is a success signal — continue immediately without pausing or waiting for output. Only when the hook produces non-empty output (an error or warning message) should the agent stop, read it, and handle the issue.
- **Doc-sync advisory** — after each TASK_STATUS.md edit the hook also runs `mavp-operator-doc-sync-check.js`, which inspects recently merged tasks and emits stderr advisories when source file changes may require a doc update. When the advisory names a candidate doc, spawn `product-docs` or `technical-writer` with that doc as the target. When it says "no obvious doc reference found", use judgment based on the task type. Repeat advisories for the same task may be ignored after first review. See `docs/core/DOC_SYNC.md` for full details. Bootstrapped projects get this automatically — the installer composes the doc-sync fragment into the managed `PostToolUse` hook on fresh install and on every `--update` (see `docs/core/BOOTSTRAP_GUIDE.md` — "Claude Code hooks activation"); `templates/doc-sync-hook.fragment.json` is the manual fallback for non-installer setups.
- **Main Agent owns transitions** — sub-agents do not approve their own work.
- **`next_action` is a routing directive, not a narrative log** — never embed volatile facts (version numbers, commit counts, push state, external repo/mirror state) in it; reference the source of truth instead and put cross-session narrative in `HANDOFF.md` or the wave strategy note. See the `next_action` entry under "PROCESS_STATE.json fields" below for the full contract and the shipped `next_action_unverified` / `next_action_volatile_facts` signals.
- **Wave versioning** — `PROCESS_STATE.json` has a `wave` field. Incremented automatically by `--close-session` on wave complete.
- **Version bump** — before closing a wave with `git push`, bump `scripts/mavp-version.js` if any file under `scripts/` changed (patch bump). New framework capabilities warrant a minor bump. Doc-only waves need no bump. Shippable-version bumps also add a matching `CHANGELOG.md` entry — see `docs/PUBLIC_RELEASE_STRATEGY.md` §5 (canonical release-notes source; GitHub Release bodies are derived copies).
- **UX review** — optional per task. Set `requires_ux: true` in backlog to activate `ux_review` stage.
- **Security review** — optional per task. Set `requires_security_review: true` in backlog to activate `security_review` stage between `dev_done` and `ready_for_qa`. Full review is required when a task adds or modifies external inputs or outputs: API endpoints, file parsers, auth flows, or third-party integrations. A lightweight self-checklist is sufficient for internal refactors that introduce no new attack surface.
- **Config check** — optional per task. Set `requires_config_check: true` on any task that adds or modifies runtime config keys (env vars, feature flags, secrets references, external service credentials). Tasks with this flag require a `config_check:` block in QA evidence before `qa_passed`. The `config_check:` block must list each config key confirmed present and correct in the target environment. The validator warns when a `qa_passed` or `merged` task has `requires_config_check: true` but no `config_check:` line in TASK_STATUS evidence.
- **Verification types** — each task declares one: `artifact` (validator/diff check), `runtime` (script executes without error), `visual` (human review required; build passing is not enough), `manual` (human review of copy or flow). QA must match the declared type. Tasks with `artifact` or `unit` verification type do not require a QA agent pass — their built-in verification (validator run / test suite) serves as QA. For `runtime` and `unit` tasks, include `commit: <hash>` in the evidence block when merging — the validator will warn if it's absent. Tasks with `verification_type: runtime` may optionally advance to `runtime_verified` after merge to record confirmed live-environment behavior (informational only — not required by the validator).
- **`exploration` task type** — use `- **Type:** exploration` for internal research tasks that produce a docs artifact (no deliverable code): data analysis, architectural assessments, simulations, any research whose output is a document. Required fields: `- **Output doc:** <path>` (the document to be created/updated), `- **Owner role:** main_agent`, `- **Verification type:** artifact`. The validator warns when an exploration task is missing the `Output doc:` field.
- **`commit:` in evidence** — all tasks set to `merged` must have `commit: <hash>` in their evidence block in TASK_STATUS.md. The validator will block (exit code 2) on merged tasks without it. Format is exactly `commit: <hash>` — lowercase key, colon, space, then the hash. Do not write `Commit abc1234` (capitalized) or `commit abc1234` (no colon) — both will cause `merged_missing_commit_field`.
- **`infra:` in evidence** — for infra-only tasks with no code commit (AWS SSM parameters, Terraform apply, config-only changes), use `infra: <verifiable-ref>` as an accepted alternative to `commit:`. The reference must be verifiable — the validator accepts: (a) an AWS ARN (`arn:aws:ssm:...`), (b) a git commit hash (7–40 hex chars, e.g. the runbook or CHANGELOG commit), (c) a Terraform state serial (`serial/N` or `serial:N`), or (d) an SSM parameter version (`@vN`). Free text without one of these patterns is rejected. If the task also lists `manual_changes:` evidence, the `manual_changes:` rule (a codifying commit is required before `merged`) still applies unless the change is purely infra with no config file edits.
- **`artifact:` in evidence** — for `verification_type: artifact` tasks that produce no code diff (exploration tasks, initiative audits, research documents), use `artifact: <description>` as an accepted alternative to `commit:`. The description is free text naming the produced artifact (e.g. `artifact: docs/AUDIT.md`). This field is only accepted when the task's `Verification type` is `artifact`; for all other verification types `commit:` or `infra:` is still required.
- **Cross-repo evidence format** — single-repo tasks use `commit: <hash>`. Multi-repo tasks (declared with `- **Repos:** repo-a, repo-b`) require one evidence line per repo containing both `commit:` and the repo name: `commit: <hash-a> (repo-a)` and `commit: <hash-b> (repo-b)`. The validator warns when a merged multi-repo task lacks per-repo commit evidence.
- **`branch:` in dev_done evidence** — projects with branch-based deploy contours should populate `branch: <name>` (e.g. `main`, `develop`, `both`) in dev_done evidence alongside `commit:`. The validator warns when a dev_done task has a `commit:` line but no `branch:` line.
- **`repo:` field** — tasks in `in_progress` or later should declare `- **Repo:** <name>` (or `- **Repos:** repo-a, repo-b` for cross-repo tasks) in BACKLOG.md. The validator warns when this field is missing for in-flight tasks. The `--agent` JSON includes `repo` for each active slice.
- **`stale_risk:` field** — set `- **Stale risk:** true` on tasks that touch cached data, ML models, or long-lived config. The validator warns when such a task is in `in_progress` or later without `stale_verified: true` in the evidence block.
- **Recheck mechanism** — `rechecks` in `PROCESS_STATE.json` stores time-based, post-merge follow-up reminders: e.g. "retrain this model 8 weeks after merge" or "re-audit this config next quarter". Use `--arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w]` to register a recheck; use `--ack-recheck RC-N` to dismiss it, or `--ack-recheck RC-N --rearm` to reschedule it by its interval. Due rechecks surface in: the `--agent` JSON `due_rechecks[]` field (present only when entries are due, each flagged `overdue` when past due); a session-start callout; a `--snapshot` line; the operator dashboard "Due Rechecks" panel; and a non-blocking `overdue_recheck` advisory in the validator (info severity only — never blocks). Distinct from `stale_risk:` (see next note): `stale_risk` is a binary flag on an IN-FLIGHT task that guards staleness verification BEFORE merge; `rechecks` schedule a future revisit AFTER the task is already merged and archived. They are complementary — `stale_risk` covers the in-flight window; a recheck covers the post-merge interval.
- **`Touches:` field** — optional. List file paths a task will modify: `- **Touches:** path/to/file.js, path/to/other.md`. The `--snapshot` command warns when two active tasks in the same wave declare the same file. Fill it at planning time when you know the files involved.
- **`Root cause:` field** — optional. Reference a task that closes the underlying structural cause: `- **Root cause:** T-NNN`. Use when a task is a symptom of a deeper structural problem already tracked by another task. Purely informational — the validator does not check this field.
- **`Superseded by:` field** — optional. Use `- **Superseded by:** T-NNN` when a task is absorbed by another task (T-NNN). The superseded task is treated as terminal — the validator skips all state-validation checks for it (no `missing_in_task_status`, no evidence warnings, no status-mismatch checks). Distinct from `Root cause:` (which marks structural cause, not absorption). A superseded task does not need to appear in TASK_STATUS.md.
- **`manual_changes:` in evidence** — optional field in `TASK_STATUS.md` evidence. List any operations performed outside version control (CLI commands, direct config edits, DB patches). If `manual_changes:` is non-empty, a corresponding code/config commit codifying those changes is required before `merged`.
- **`needs_fix_rounds:` in evidence** — optional field in `TASK_STATUS.md` evidence. Record how many `needs_fix` cycles the task went through before `qa_passed` (e.g. `needs_fix_rounds: 2`). Fill when a task enters `needs_fix` at least once. Omit (or leave `0`) for tasks that passed QA on the first attempt. This is the primary signal for the skill reflection system (`mavp-skill-reflect.js`) to detect developer friction; it takes priority over keyword heuristics.
- **`validator_blocked:` in evidence** — optional boolean field in `TASK_STATUS.md` evidence. Set to `true` when the validator (exit code 2) ever blocked a commit on this task; set to `false` or omit when the validator never blocked. Used by the skill reflection system as a quality signal alongside `needs_fix_rounds:`.
- **Module registry** — `docs/MODULES.md` declares module types (e.g. `web-panel`, `antispam`). Tasks may declare `- **Module:** <id>`. The `--agent` JSON includes `module` and `context_docs` for each active slice. The validator warns on unknown module IDs.
- **Repo map** — `docs/REPO_MAP.md` declares repo entries (id, label, path, domain, deploy_path, downstream, docs), following the same project-owns-instance pattern as `docs/MODULES.md` — the framework only defines the schema in `docs/REPO_MAP.md`; each project maintains its own registry, seeded from `templates/REPO_MAP_TEMPLATE.md` by `mavp-install.js`. `parseRepoMap()` in `scripts/mavp-operator-lib.js` reads the registry and returns an empty map when the file is absent. The validator warns with `unknown_repo_id` when a task's `Repo:`/`Repos:` value is not a known ID, and skips the check silently when there is no repo map (or it declares no real entries).
- **`Blocked by:` field** — optional cross-repo relation: `- **Blocked by:** <repo>/T-NNN` (comma-separated for multiple). Distinct from same-repo `Depends on:`. The validator resolves `<repo>` to a local path via `docs/REPO_MAP.md`'s `path` field, reads that repo's BACKLOG.md/TASK_STATUS.md for the blocker's status, and gates the merge: `blocked_by_open` at FAILURE severity (exit 2) when a `merged` or `qa_passed` task has a non-`merged` blocker, WARNING when the blocked task is `ready_for_qa`, and `blocked_by_unresolvable` at INFO severity when the repo id/path or the blocker task can't be resolved. `--agent` surfaces an additive `blocked_by: [{repo, taskId}, ...]` per active slice when declared.
- **Context prefetch bundle** — `--new-task`, `--quick-task`, and `--apply-decomposition` write a `.mavp/context/T-NNN.md` bundle at task registration (regenerated by `--update-task` and `--rescope-task`) containing the task block, its module's `context_docs`, its `Touches:` list, its repo-map entry, and its `Depends on:` / `Blocked by:` references. Built by `buildContextBundle()`/`writeContextBundle()` in `scripts/mavp-operator-lib.js`; degrades gracefully (omits a section) when the repo map or module registry is absent or has no matching entry. This is a **Main-Agent-only brief-composition input**, never a sub-agent read path: `.mavp/context/` is gitignored and does not exist inside worktree checkouts, so a brief must never instruct a worktree sub-agent to read that path. The Main Agent retrieves the bundle via `./scripts/mavp-operator --emit-bundle T-NNN` (read-only, prints to stdout) and injects the relevant content directly into the sub-agent brief text. `--agent` surfaces an additive `context_bundle` path per active slice only when the file exists on disk.
- **Must-read set** — `--agent` surfaces an additive `must_read` array at session start: files changed since the previous `--close-session` commit (found via git by matching the `chore: close session ...` marker) unioned with `context_docs` already resolved onto in-flight tasks. Computed by `computeMustRead()`/`getFilesChangedSincePreviousCloseSession()`/`findPreviousCloseSessionCommit()` in `scripts/mavp-operator-lib.js`; omitted entirely when empty, and degrades silently (no throw) when git is unavailable. Rendered by the `session-start` skill as a "Must read" list.
- **Artifact brevity lint** — two info-severity, never-blocking validator advisories keep state artifacts lean: `artifact_size_budget` fires when `CLAUDE.md` or `HANDOFF.md` (whole-file) or the `BACKLOG.md` Active Wave / `TASK_STATUS.md` Active tasks sections exceed a default line budget (archived wave sections are never counted); `state_in_claude_md` fires when `CLAUDE.md` contains task-state-shaped lines (`### T-NNN` headings or `- **Status:**` fields — task state belongs only in `BACKLOG.md`/`TASK_STATUS.md`). Both defaults are overridable per-field via an `artifact_budgets` object in `PROCESS_STATE.json` (e.g. `{"claude_md_max_lines": 400}`).
- **`Prod prerequisites:` field** — optional. List infra/env items required before prod deploy: `- **Prod prerequisites:** prod CI workflow, ECR repo, secrets rotation`. The `--agent` deploy_queue surfaces these as `prod_prerequisites: [...]` per task, and the `next_action` deploy summary notes how many tasks have prerequisites outstanding.
- **Wave closure** — after the last task in a wave reaches `merged`, run `--close-session` then `git push`. The next wave must not open until push is complete.
- **Parked waves** — if a wave must remain open while a new wave starts, record it in `parked_waves` with a one-line reason before opening the new wave (e.g., `["Wave 2 — blocked on external review"]`). Do not silently overlap waves.
- **VSCode Agent permissions** — VSCode projects using MavP sub-agents (developer, architect, qa, etc.) must add `"Agent(*)"` to the `permissions.allow` array in `.claude/settings.local.json`. Without it the VSCode Claude Code extension silently auto-rejects every Agent tool call — no dialog, no error message, no prompt is shown; the agent simply appears to hang or refuse. Diagnosis: if a sub-agent produces no output or stalls at the first tool call, check `.claude/settings.local.json` and confirm `"Agent(*)"` is present in `permissions.allow`. Fix: add it manually or re-run `mavp-install --update` if the installer has been updated to include it.
- **Mandatory pre-push review** — the shipped framework default is `permissions.defaultMode: "bypassPermissions"` (see `docs/core/BOOTSTRAP_GUIDE.md` — "Shared permission-mode default"), which suppresses interactive prompts for every tool call. Under this mode, `--close-session` always prints the session-completed results table before any push happens, and `--close-session` never auto-pushes on its own: in non-interactive mode `--push` is ignored and a gate message is printed instead of pushing; in interactive mode the `[Y/n]` push prompt still requires an explicit human answer. Either way, a human must review the results table and personally trigger `git push` — this is the single human checkpoint in an otherwise fully autonomous default permission mode. Do not add any code path that pushes without this review step.
- **Lineage linkage — `EXECUTION_LOG.md` entry convention** — every `EXECUTION_LOG.md` entry must carry inline `T-NNN` and `DR-NNN` references for any task or decision it touches, so grepping a single `DR-NNN` id surfaces the decision record, every log entry that acted on it, and every task citing it. Pairs with the optional `Informed by:` / `Supersedes:` / `Tasks:` fields on decision records — see `docs/core/DECISIONS.md`. No graph-rendering tooling; this is plain grep over text artifacts.
- **RCA-to-codification** — every root-cause analysis document must end in a mandatory Codification section that routes each root cause to exactly one of: a `.claude/rules` edit proposal, a role-spec proposal via `SKILL_PROPOSALS/`, a memory-index entry, an armed recheck, or a mechanical enforcement change (hook/validator/test, filed as a developer task); the Main Agent registers a follow-up task per accepted routing. See `docs/core/RCA_CODIFICATION.md` and `templates/RCA_TEMPLATE.md`.
- **Publish-manifest registration** — every new git-tracked file must be classified in `scripts/publish-manifest.json` (ship/exclude) in the same task that creates it; see `.claude/rules/docs.md` / `.claude/rules/scripts.md` for the full rule and the `MANIFEST_REGISTRATION_NEEDED` token scope-forbidden roles use. The Main Agent runs `node scripts/check-publish-manifest.js` before booking `dev_done` on any task that created new files. Per DR-002 (`docs/core/DECISIONS.md`), the Main Agent may apply registration **entries** directly (a state-adjacent classification ledger action) but all other manifest changes go through a developer task. Enforcement is no longer only manual (T-401): `scripts/mavp-manifest-guard.js` gives an advisory creation-time signal via PostToolUse (see `templates/manifest-guard-hook.fragment.json`), and `.claude/hooks/pre-commit` runs `node scripts/check-publish-manifest.js --if-canonical` as a blocking commit-time backstop — both gated to the canonical private repo (inert in the public mirror / adopter repos) via the "every `exclude` key is git-tracked" heuristic.

## Orchestrator checklist — before touching any file

The Main Agent is an orchestrator, not an implementer. Before writing code or editing docs directly:

**Before creating tasks — mandatory architect gate:**

Architect decomposition is required before any sub-agent is spawned for any task, without exception. The Main Agent's role at this stage is context provider: pass the raw task description and relevant codebase context to the architect. The architect is the decomposition owner — it reads the codebase, reasons about fit, and returns a structured design brief with a machine-readable task decomposition block.

- Spawn **architect** first. Provide the raw feature idea or problem statement plus any relevant file paths or prior context. Do not pre-scope the work — let the architect determine the correct task boundaries.
- For simple or well-understood tasks the architect will return a minimal single-task decomposition quickly. The gate is still required.
- If the feature additionally requires a technology choice, library/API selection, or external landscape research, spawn **analyst** first for that research, then pass the analyst brief to the architect as additional context.
- Neither architect nor analyst produces BACKLOG tasks directly. Their briefs inform the Main Agent before item 1 below.
- **Architect model spawn rule** — spawn architect with `model: fable` (Fable 5, primary); if unavailable, re-spawn with `model: opus` (Opus 4.8); never spawn architect below Opus. Worker sub-agents run on the `sonnet` alias declared in their own spec frontmatter. See `docs/AGENT_SPEC.md` — "Model selection" (worker model-escalation table) and "Effort selection" (effort-selection table), the single source of truth for both policies.

1. Is the task registered in `BACKLOG.md`?
2. Is the sub-agent type identified (developer / product-docs / technical-writer / qa / ux / security-reviewer / exa-researcher / architect / analyst)?
3. Is the sub-agent brief drafted (see template below)?

If all three are yes — spawn the sub-agent, then add T-XXX to `active_slices` in `PROCESS_STATE.json`.

**Direct action is allowed only for changes to state artifact files: `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.json`, `PROCESS_STATE.md`.** Any change to code, CSS, docs content, or scripts must go through a sub-agent — no exceptions, no "quick fix" shortcuts.

When a sub-agent completes: remove T-XXX from `active_slices`.

**Worktree integration** — when integrating developer work from a harness worktree, always integrate by the agent's commit (cherry-pick/merge), never by copying files; and inspect `git status` before integrating to recover any orphaned uncommitted work; when a task must read current main state, pre-authorize `git merge --ff-only main` in the brief. See `docs/core/ORCHESTRATION_RULES.md` — "Worktree integration — Main Agent".

## Sub-agent brief template

Use this when spawning any sub-agent. Include all fields.

```
Role: [developer | product-docs | technical-writer | qa | ux | security-reviewer | frontend-design | ui-designer | exa-researcher | architect | analyst]
Slice: T-XXX — [title from BACKLOG.md]
Goal: [one sentence — what this sub-agent must achieve]
work_dir: [absolute path to target repo]  # cross-repo only — OMIT for same-repo (mavericks) tasks; developer uses CWD (worktree root) by default
Adjacent docs read: [for cross-repo tasks: list each <repo>/CLAUDE.md you read before starting — found / not found. Omit for same-repo tasks.]
Module: [optional — module id from docs/MODULES.md, e.g. web-panel]
Repo: [optional — repo name(s) this task touches, e.g. example-service]
Stale risk: [true | false — set true if task touches cached data, ML models, or long-lived config]
Read current main: [optional — set when the task must READ current-main state (e.g. version numbers, files merged earlier this session); pre-authorizes `git merge --ff-only main` from the worktree root as the sub-agent's first step; harness worktrees branch from a stale base — see docs/core/ORCHESTRATION_RULES.md "Worktree integration — Main Agent". Omit otherwise.]
Model: [opus | sonnet]     # optional — only include when escalating a worker away from its sonnet default; see docs/AGENT_SPEC.md — Model selection
Effort: [medium | high | xhigh | max]   # optional — only include when deviating from the session default; see docs/AGENT_SPEC.md — Effort selection
Files to modify: [explicit list]
What NOT to change: [boundaries — other files, other tasks]
Definition of done: [acceptance criteria verbatim from BACKLOG.md]
Report back: changed files + line ranges, confirmation criteria met, any blockers
Before exiting: commit all changes with a meaningful message.
```

## Task lifecycle states

`planned` → `in_progress` → `dev_done` → [`ux_review` →] `ready_for_qa` → `qa_passed` → `merged` → [`runtime_verified`] → [`deployed_dev` →] [`deployed_prod`]

UX: `dev_done` → `ux_review` → `ux_passed` → `ready_for_qa` (or `ux_needs_fix` → developer)

Security: `dev_done` → `security_review` → `security_passed` → `ready_for_qa` (or `security_needs_fix` → developer)

Deploy statuses (`deployed_dev`, `deployed_prod`) are optional. Projects without explicit deploy contours stay on `merged` as their final state. The `--agent` JSON output surfaces a `deploy_queue` array listing tasks that are `merged` but not yet deployed.

**Runtime verification** — `runtime_verified` is optional. Use it on tasks with `verification_type: runtime` when you want to explicitly record that the behavior was confirmed in a live environment after merge. Tasks may remain at `merged` without proceeding to `runtime_verified`.

**`deprecated` status** — for tasks rejected permanently (as opposed to `deferred` which may return). Tasks with `deprecated` status skip `missing_in_backlog` and `missing_in_task_status` validator checks, require no evidence, and do not appear in active counts. Use `deferred` when a task is postponed; use `deprecated` when it will never be done.

## Backlog rules

- Every status change in `BACKLOG.md` must mirror in `TASK_STATUS.md` and vice versa.
- Never mark `merged` without QA evidence in `TASK_STATUS.md`.
- Task IDs are sequential integers (`T-NNN`). Never reuse a retired ID.
- Use `--new-task` to add tasks — prevents drift from first write.

## PROCESS_STATE.json fields

```json
{
  "initiative": "...",
  "stage": "execution",
  "wave": 1,
  "wave_status": "planning",
  "wave_goal": null,
  "parked_waves": [],
  "active_slices": ["T-001", "T-002"],
  "next_action": "T-001 → developer → ...",
  "blocker": null,
  "stage_owner": "main_agent",
  "last_task_id": 2,
  "last_updated": "YYYY-MM-DD",
  "deploy_contours": 0,
  "wave_summary": "one-sentence summary written by --close-session at wave end",
  "rechecks": []
}
```

`wave_status` — tracks architect review gate and wave lifecycle. Values: `planning` (default, wave being scoped) | `architect_reviewed` (architect review complete, tasks may proceed) | `execution` (tasks actively in progress) | `closed` (all tasks merged; set automatically by `--close-session`). Waves with ≥3 planned tasks require architect review before the first task starts — Main Agent sets this to `architect_reviewed` after review.

`wave_goal` — optional string. One-line definition of done for the current wave. Set at wave open or via `--close-session` prompt. Displayed in `--agent` digest and `--snapshot`. Default: null.

`wave_summary` — written automatically by `--close-session` at the end of each wave; one sentence describing what the wave accomplished.

`rechecks` — optional array of time-based post-merge follow-up entries. Absent or empty means no rechecks and changes no existing behavior. Each entry is self-contained so it survives task archival: `id` (e.g. `"RC-1"`, sequential, assigned at arm time), `task` (e.g. `"T-123"`), `title` (task title copied in at arm time), `due` (absolute date `"YYYY-MM-DD"` when the recheck comes due), `interval` (optional, e.g. `"8w"`; supports weeks `w` and days `d`; used by `--ack-recheck --rearm`), `armed_at` (`"YYYY-MM-DD"` when the recheck was created), `note` (optional free text). Managed via `--arm-recheck` and `--ack-recheck`. See the **Recheck mechanism** convention below.

`parked_waves` — list of waves that remain open while a new wave proceeds; each entry is a string with the wave number and a one-line reason (e.g., `"Wave 2 — blocked on external review"`).

`active_slices` — derived automatically by `--agent` from TASK_STATUS.md: only tasks with in-flight statuses (`in_progress`, `dev_done`, `ux_review`, `ux_passed`, `security_review`, `security_passed`, `ready_for_qa`, `qa_in_progress`) are included. The JSON field is informational only; `planned` and `merged` tasks are excluded from the output.

`next_action` — a **routing directive only**, not a narrative log. Write it as either `T-NNN → role → short imperative action` (e.g. `"T-001 → developer → implement the parser"`) or, when no task is active, one short standalone imperative (e.g. `"Open next wave"`). It must NEVER embed volatile facts that have no invalidation trigger once written — framework/tool version numbers, unpushed-commit counts, ahead/behind push state, or external repo/mirror version state. Those facts already have a source of truth (`scripts/mavp-version.js`, `git`, GitHub) — reference the source, don't copy the value into `next_action`. Multi-fact cross-session narrative (what changed, why, what to check next session) belongs in `HANDOFF.md` (via `--handoff --notes "..."`) or in the wave strategy note (via `--set-strategy-note "..."`), not in `next_action`. Two shipped signals guard this shape: `classifyNextAction()` (in `scripts/mavp-operator-lib.js`) classifies the string, and `--agent` surfaces the result as additive fields `next_action_unverified` (true when `next_action` is non-empty and does not begin with `T-NNN`) and `next_action_volatile_facts` (an array of the matched volatile substrings, e.g. version numbers or commit-count phrases). The validator emits the same check as an info-severity finding named `next_action_volatile_facts` — it is advisory only and never blocks (never causes exit 1 or exit 2).

`deploy_contours` — integer. Controls deploy pipeline visibility in `--agent` output. `0` = no deploy pipeline; `merged` is the final state; `deploy_queue` is always empty and deploy warnings are suppressed. `1` = single contour, auto-deploy-on-merge; `merged` = already deployed; `deploy_queue` is always empty and no `deploy_pending` state is set. `2` = dev + prod contours (default behavior when field is absent); `merged` tasks appear in `deploy_queue` as `deploy_pending: true`. Set to `0` for projects like mavericks itself where there is no separate deploy pipeline; set to `1` for projects where merge triggers an automatic deploy.

`last_task_id` — integer, the highest T-NNN assigned so far. Increment before registering a new task to avoid ID collisions. The validator checks for duplicate task IDs.

**PROCESS_STATE.json is informational** — it is human-maintained and not validated for consistency with BACKLOG.md or TASK_STATUS.md. Do not use `next_action` or `active_slices` as authoritative truth; always verify against BACKLOG.md and TASK_STATUS.md directly.
