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

The session-start brief reports a *declared* permission mode via a `permission_mode` field — not a confirmed "active" mode, since the framework cannot independently verify it. `permission_mode_source` names where the value came from (`hook_payload` | `persisted_runtime` | `settings_file`); `permission_mode_verified` is `true` only when a same-session harness hook payload confirmed it (the `SessionStart` hook wired by `mavp-install.js`), and stays `false` on a harness whose payload omits the field — a designed-for outcome, not a defect. See the **Shared permission-mode default** note in `docs/core/BOOTSTRAP_GUIDE.md` (settings precedence, and a documented 2026-08 divergence from it) and DR-010 in `docs/core/DECISIONS.md`.

## Operational commands

Full contract per flag: `docs/core/OPERATOR_COMMANDS.md` (current state; pull one section with `grep -n -A 12 '^### --<flag>'`). Archive of the former command fence: `docs/archive/CLAUDE/2026-11-14-operational-commands.md`. Index of the commands used most (`./scripts/mavp-operator --help` lists every flag):

- `--agent` — session-start brief: slices, next_action, due rechecks, must_read, permission mode
- `--snapshot` — text snapshot of project state for context
- `--validate` — run the validator through the operator wrapper
- `--apply-decomposition` — apply the architect's decomposition block to BACKLOG + TASK_STATUS
- `--emit-bundle` — print a task's context prefetch bundle to stdout (read-only, Main-Agent brief input)
- `--set-status` — batch status update across BACKLOG + TASK_STATUS (`--from`, `--commit`, `--needs-fix-rounds`)
- `--integrate` — cherry-pick a commit or range into the project root; writes no state
- `--handoff` — capture mid-session context to HANDOFF.md for the next session
- `--set-wave-goal` — set the wave goal non-interactively (empty string clears)
- `--set-next-action` — sanctioned, gated write of PROCESS_STATE.json `next_action` (empty string clears)
- `--close-session` — end-of-session ritual: sweeps terminal tasks, session commit; never advances the wave
- `--close-wave` — the only wave-advance path; terminal: type the wave number; agent: `--operator-confirmed`
- `--check-archive` — read-only nothing-lost check for archive-not-delete (`--range A..B` or `--staged`)
- `--help` — the short list of every flag
- Caution: `--close-wave` needs the operator's verbatim in-session statement as `--operator-confirmed`, never a paraphrase or inference.
- Caution: `--prune-worktrees --yes` runs only with zero live sub-agents (repository-global exclusive resource); the default is a dry run.

Validator exit codes: `0` = healthy, `1` = drifting, `2` = repair required.

## Architecture

**Direct-reference model** — bootstrapped projects do NOT copy core scripts. Their `scripts/mavp-operator` bash wrapper delegates to this mavericks installation via `MAVERICKS_PROJECT_ROOT` env var. Only project-specific scripts (agent.js, close-session.js) live in the project.

**Core layer** (`docs/core/`) — task lifecycle, roles (incl. UX sub-agent), orchestration rules, QA handoff, bootstrap guide.

**Live state** — `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` / `PROCESS_STATE.json`. `PROCESS_STATE.md` is auto-generated from `PROCESS_STATE.json` — do not edit it manually. `EXECUTION_LOG.md` records agent spawning events and key decisions; update it when spawning sub-agents or closing a wave.

**Shared library** — `scripts/mavp-operator-lib.js` contains all parsing, rendering, and utility functions used by the operator scripts. Read it before adding new operator commands to avoid re-implementing existing helpers.

**Sub-agent role definitions** — `.claude/agents/` contains per-role behavior specs (developer, qa, ux, product-docs, technical-writer, security-reviewer, frontend-design, ui-designer, exa-researcher, architect, analyst). Read these before briefing a sub-agent.

**Skill reflection loop** — `docs/SKILL_OPTIMIZATION.md` defines the SkillOpt-inspired system that mines past task outcomes and proposes bounded edits to role specs. Run via `--reflect-skill <role>` at wave close. Proposals land in `SKILL_PROPOSALS/` and require human review before any spec change is applied.

**Rules files** — `.claude/rules/` contains six supplementary constraint files (backlog.md, docs.md, execution-log.md, process-state.md, publish-manifest.md, scripts.md) that extend the conventions in this file. They are path-scoped (loaded when a matching file is touched — see the Load map) and authoritative for their respective domains.

**Bootstrap** — `node scripts/mavp-install.js <target-dir>` seeds a new project with the bash wrapper, project-specific scripts, and artifact templates, and activates the Claude Code hooks (`SessionStart`, `PostCompact`, `PostToolUse`) in `.claude/settings.local.json` by default. Use `--check` to preview, `--update` to re-sync agents/rules/hooks — idempotent, and it only ever replaces the installer-managed hook entries, never operator-authored ones. Pass `--no-hooks` to `--update` to skip the hooks merge for that run. See `docs/core/BOOTSTRAP_GUIDE.md` — "Claude Code hooks activation" for the managed-entry ownership rule and the canonical self-activation step. VSCode projects whose sub-agent spawns silently stall should check the **VSCode Agent permissions** convention below (a conditional diagnostic, not a required setup step).

**Pre-commit hook** — `.claude/hooks/pre-commit` runs the validator on every `git commit`. Exit code 2 blocks the commit. It fires via `git config core.hooksPath .claude/hooks/`, set automatically by `mavp-install.js` (see `docs/core/BOOTSTRAP_GUIDE.md`); while `core.hooksPath` is set this way, git ignores `.git/hooks` entirely. An optional adopter-owned `.claude/hooks/pre-commit.local` is run by a stanza at the end of the hook (non-zero exit blocks the commit; install and `--update` never touch it or `.claude/rules/project-*.md` — see `docs/core/BOOTSTRAP_GUIDE.md` — "Project checks"). Liveness check: `git config core.hooksPath`.

## Key conventions

- **Artifact-first truth** — state transitions must be in markdown artifacts before they are real.
- **Mirror rule** — every status change in `BACKLOG.md` must be mirrored in `TASK_STATUS.md` before the turn ends. `scripts/mavp-operator-sync-status.js` (run by the PostToolUse hook) mirrors exactly three things: the `- **Status:**` field, the task heading title (rewrites a stale TASK_STATUS heading to match BACKLOG's title, emitting `sync-status: retitled T-NNN`), and skeleton-entry creation for any BACKLOG Active Wave task missing from TASK_STATUS's Active tasks section — skipping `deprecated` tasks and any task carrying a real `Superseded by:` value. It never mirrors `Notes`, `Evidence`, or any other TASK_STATUS-owned field — those stay hand-edited. **Mirror-edit race** — because this hook rewrites TASK_STATUS.md immediately after a BACKLOG.md edit, an agent holding a stale read of TASK_STATUS.md can hit a "modified since read" error; edit BACKLOG.md first, re-read TASK_STATUS.md before touching its non-status fields, and prefer the atomic ritual commands (`--set-status` / `--update-status` / `--rename-task`) over hand-editing both files. See `docs/core/TASK_LIFECYCLE.md` — "Avoiding the mirror-edit race" for the full workflow note.
- **Run validator** after every `BACKLOG.md` or `TASK_STATUS.md` change.
- **PostToolUse hook — silent means no repair required** — a PostToolUse hook runs the validator after every Edit on `BACKLOG.md` or `TASK_STATUS.md`. The hook itself always exits 0. Full validator output is printed to stderr ONLY when the validator itself exits 2 (repair required) — exit 1 (drifting) stays silent at edit time (that advisory is already surfaced by `--agent`, `--snapshot`, `--close-session`, and the pre-commit hook, so it does not need per-edit stderr noise). So silence now covers BOTH validator exit 0 (healthy) and exit 1 (drifting) — continue immediately without pausing or waiting for output. Only when the hook prints the full validator report (validator exit 2) should the agent stop, read it, and handle the repair.
- **Main Agent owns transitions** — sub-agents do not approve their own work.
- **`next_action` is a routing directive, not a narrative log** — never embed a volatile fact asserting current state (a version number the repo currently sits at, commit counts, push state, external repo/mirror state) in it; a version literal naming the *target* of the directive's own action (e.g. "bump to 0.44.3") is not banned — reference the source of truth for state claims instead and put cross-session narrative in `HANDOFF.md` (the wave strategy note is cleared by every `--close-session`, so it is not a cross-session home — see the `next_action` entry below). See the `next_action` entry under "PROCESS_STATE.json fields" below for the full contract and the shipped `next_action_unverified` / `next_action_volatile_facts` signals (DR-009: this rule is validator-blocking, not advisory-only).
- **Wave versioning** — `PROCESS_STATE.json` has a `wave` field. It advances only via `--close-wave`, on the operator's confirmation that the wave's goal is met — never as a side effect of `--close-session`, and never because every task happens to be merged.
- **Version bump** — before any `git push` that carries ship-classified changes, bump `scripts/mavp-version.js` and `package.json` together if any file under `scripts/` changed (patch bump). New framework capabilities warrant a minor bump. Doc-only pushes need no bump. The trigger is the push, not the wave: advancing the wave with `--close-wave` neither requires nor performs a bump. Shippable-version bumps also add a matching `CHANGELOG.md` entry — see `docs/PUBLIC_RELEASE_STRATEGY.md` §5 (canonical release-notes source; GitHub Release bodies are derived copies). The bump trigger and the release-note trigger are separate: a doc-only push that changes `ship`-classified content still owes a `CHANGELOG.md` entry, written under `## [Unreleased]` when no bump accompanies it — see §5's per-push bullet.
- **Verification types** — each task declares one: `artifact` (validator/diff check), `runtime` (script executes without error), `unit` (the test suite serves as QA), `visual` (human review required; build passing is not enough), `manual` (human review of copy or flow). QA must match the declared type. Tasks with `artifact` or `unit` verification type do not require a QA agent pass — their built-in verification (validator run / test suite) serves as QA. For `runtime` and `unit` tasks, include `commit: <hash>` in the evidence block when merging — the validator will warn if it's absent. Tasks with `verification_type: runtime` may optionally advance to `runtime_verified` after merge to record confirmed live-environment behavior (informational only — not required by the validator).
- **`commit:` in evidence** — all tasks set to `merged` must have `commit: <hash>` in their evidence block in TASK_STATUS.md. The validator will block (exit code 2) on merged tasks without it. Format is exactly `commit: <hash>` — lowercase key, colon, space, then the hash. Do not write `Commit abc1234` (capitalized) or `commit abc1234` (no colon) — both will cause `merged_missing_commit_field`.
- **Wave closure** — a per-session contract, owed at the end of every session in which tasks reached `merged`, not only the session that finishes a wave: run the full test suite once, unfiltered, on main first — this is what catches a real failure before it reaches everyone else's CI, not a formality (`node scripts/run-tests.js`, enforced at push time by the canonical repo's pre-push hook; see `docs/core/ORCHESTRATION_RULES.md` — "Test-execution scope (worktree developers)") — then run `--close-session` then `git push`. The next task must not be registered until the push is complete **and** CI on the pushed commit is green — confirm with a `gh run` check against that commit before registering the next task. Canonical `main` sat CI-red across two consecutive pushes (2026-08-21) because this contract stopped at "push is complete"; do not reopen that gap. A state-only commit (e.g. `chore: close session`) is skipped by the CI workflow's path filter and so has **no run at all** — absence of a run is not evidence of a green run; if the pushed tip has no run, walk back to the newest pushed commit that does have one and judge that run instead. Where possible, push the session's content commits and the close-session commit together in a single `git push`: the triggered run then lands on the true tip (the union of changed files includes content, so the filter no longer skips it), which also removes the close-session-commit-lands-mid-run staleness race that caused the 2026-08-21 red at its origin. **Wave advance** is a separate act that this contract never performs: the wave counter moves only through `--close-wave`, under the **Wave advance confirmation** convention below, and only once the session's contract above has been met.

- **Wave advance confirmation** — `--close-wave` is the only way the wave advances, and an agent passes `--operator-confirmed` ONLY when the operator has stated, in the current session, that the wave's goal is met and the wave should close. The flag's value is that statement verbatim — the operator's own words, never an agent paraphrase, a summary of what the agent concluded, or a stock phrase. Confirmation is never inferred from an empty Active tasks section, from `next_action`, from the wording of `wave_goal`, from every task being `merged`, or from a prior session's `HANDOFF.md`; the `--close-session` line that says all tasks are merged describes the task list and is not a confirmation. The `EXECUTION_LOG.md` entry for the close quotes the same statement (paste the `wave close:` line `--close-wave` prints, which carries it). When the operator has not said so, leave the wave open and, if the goal looks met, ask the operator whether wave N's goal is met and should close — wave-goal confirmation is a business question. This mirrors the **Mandatory pre-push review** posture: one human checkpoint in an otherwise autonomous default mode, with no code path and no habit that crosses it without the human; at a terminal the operator types the wave number themselves, which is the same checkpoint in person.
- **VSCode Agent permissions (conditional diagnostic)** — if a sub-agent spawn silently stalls or produces no output in the VSCode Claude Code extension (no dialog, no error message, no prompt — it just appears to hang or refuse), check whether `"Agent(*)"` is present in the `permissions.allow` array of `.claude/settings.local.json`. Some extension versions have been observed to silently auto-reject every Agent tool call without it. This is not a universal requirement: on 2026-08-15, `Agent(*)` was absent from both settings files and sub-agent spawns succeeded, so treat this as a cheap thing to check when a spawn misbehaves, not a mandatory setup step. Fix if it applies: add `"Agent(*)"` manually, or re-run `mavp-install --update` if the installer has been updated to include it.
- **Mandatory pre-push review** — the shipped framework default is `permissions.defaultMode: "bypassPermissions"` (see `docs/core/BOOTSTRAP_GUIDE.md` — "Shared permission-mode default"), which suppresses interactive prompts for every tool call. Under this mode, `--close-session` always prints the session-completed results table before any push happens, and `--close-session` never auto-pushes on its own: in non-interactive mode `--push` is ignored and a gate message is printed instead of pushing; in interactive mode the `[Y/n]` push prompt still requires an explicit human answer. Either way, a human must review the results table and personally trigger `git push` — this is the single human checkpoint in an otherwise fully autonomous default permission mode. Do not add any code path that pushes without this review step.
- **RCA-to-codification** — every root-cause analysis document must end in a mandatory Codification section that routes each root cause to exactly one of: a `.claude/rules` edit proposal, a role-spec proposal via `SKILL_PROPOSALS/`, a memory-index entry, an armed recheck, or a mechanical enforcement change (hook/validator/test, filed as a developer task); the Main Agent registers a follow-up task per accepted routing. The memory route is residual, not the default, and the same table governs durable lessons noticed outside any RCA — see `docs/core/RCA_CODIFICATION.md` — "The portability tie-break" and "Codification outside an RCA" (DR-013). See also `templates/RCA_TEMPLATE.md`.
- **Adopter feedback intake** — adopters file friction and proposals as structured items in a per-user inbox (`--feedback`); the framework side reads that inbox with `--intake`; an adopter retires a tagged workaround by hand from the read-only `--migrate` checklist. The intake is a queue, not a task register: nothing outside the Main Agent writes `BACKLOG.md` or `TASK_STATUS.md`, an item reaches the backlog only through the architect gate and `--apply-decomposition`, and `--intake --triage` records an answer on the item without registering anything. See `docs/core/FEEDBACK_INTAKE.md`.
- **Publish-manifest registration** — every new git-tracked file is classified in `scripts/publish-manifest.json` (ship/exclude) in the same task that creates it. Before spawning a `product-docs` or `technical-writer` task that names a new file at a known path, pre-register its entry per DR-017; run `node scripts/check-publish-manifest.js` before booking `dev_done` on a task that created files; never route a developer's registration through the `MANIFEST_REGISTRATION_NEEDED` token. Full procedure in `.claude/rules/publish-manifest.md`.

## Load map

| Touching | Loads |
|---|---|
| `BACKLOG.md`, `TASK_STATUS.md` | `.claude/rules/backlog.md` |
| `EXECUTION_LOG.md` | `.claude/rules/execution-log.md` |
| `PROCESS_STATE.json` | `.claude/rules/process-state.md` |
| `scripts/publish-manifest.json` | `.claude/rules/publish-manifest.md` |
| A flag's contract | the matching `### --<flag>` heading in `docs/core/OPERATOR_COMMANDS.md` |

A rule file loads only when a matching file is opened with Read, Write, Edit, cat or head, so after work done only through ritual commands, Read the rule file itself before hand-editing fields.

## Orchestrator checklist — before touching any file

The Main Agent is an orchestrator, not an implementer. Before writing code or editing docs directly:

**Before creating tasks — mandatory architect gate:**

Architect decomposition is required before any sub-agent is spawned for any task, with one sanctioned exception — the XS fast lane (`--quick-merge`); see `docs/core/ORCHESTRATION_RULES.md` — "XS fast lane (quick-merge)". The Main Agent's role at this stage is context provider: pass the raw task description and relevant codebase context to the architect. The architect is the decomposition owner — it reads the codebase, reasons about fit, and returns a structured design brief with a machine-readable task decomposition block. The Main Agent passes `initiative` and `wave_goal` verbatim into every architect brief. When the highest-value next step is an operator action rather than a task, `next_action` names the operator under its existing standalone-imperative form instead of manufacturing a sub-agent task.

- Spawn **architect** first. Provide the raw feature idea or problem statement plus any relevant file paths or prior context. Do not pre-scope the work — let the architect determine the correct task boundaries.
- For simple or well-understood tasks the architect will return a minimal single-task decomposition quickly. The gate is still required.
- If the feature additionally requires a technology choice, library/API selection, or external landscape research, spawn **analyst** first for that research, then pass the analyst brief to the architect as additional context.
- Neither architect nor analyst produces BACKLOG tasks directly. Their briefs inform the Main Agent before item 1 below.
- **Operator questions are business-only** — ask the operator only about priority, scope, risk, money and irreversible actions; route every technical doubt to the architect (analyst for library/API choices), never to the operator. See `docs/core/ORCHESTRATION_RULES.md` — "Operator questions — business only".
- **Fable-only spawn rule (architect, analyst, exa-researcher)** — spawn all three with `model: fable` on every spawn, plus `xhigh` effort on every spawn of the architect and analyst only (the exa-researcher's effort is not fixed and stays on the session default). After two consecutive loud spawn failures on `model: fable` (retry once first), stop and report a blocker; never re-spawn on another model. A report whose opening self-report line does not name the fable family is discarded and re-spawned once; a second miss is a blocker. Worker sub-agents other than these three run on the `sonnet` alias declared in their own spec frontmatter. Sub-agents only, never the orchestrator. See `docs/AGENT_SPEC.md` — "Model selection" and "Effort selection", and DR-016 and DR-018.

1. Is the task registered in `BACKLOG.md`?
2. Is the sub-agent type identified (developer / product-docs / technical-writer / qa / ux / security-reviewer / exa-researcher / architect / analyst)?
3. Is the sub-agent brief drafted (see template below — the `spawn-brief` skill)?

If all three are yes — spawn the sub-agent, then add T-XXX to `active_slices` in `PROCESS_STATE.json`.

Task registration in `BACKLOG.md`/`TASK_STATUS.md` is Main-Agent-only and must never appear in a sub-agent brief — briefs reference an already-registered T-NNN, they never ask a sub-agent to create or edit one.

**Direct action is allowed only for changes to state artifact files: `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.json`, `PROCESS_STATE.md`.** Any change to code, CSS, docs content, or scripts must go through a sub-agent — no exceptions, no "quick fix" shortcuts.

When a sub-agent completes: remove T-XXX from `active_slices`.

**Worktree integration** — when integrating developer work from a harness worktree, always integrate by the agent's commit (cherry-pick/merge), never by copying files; and inspect `git status` before integrating to recover any orphaned uncommitted work; when a task must read current main state, pre-authorize `git merge --ff-only main` in the brief; record the on-branch hash the cherry-pick/merge itself produces as `commit:` evidence, never the sub-agent's worktree hash. Before integrating any worktree wave, also run `git status --porcelain` on the shared main checkout and restore any unattributable modification with `git checkout HEAD -- <path>` (not a bare `git checkout <path>`, which restores from the index) — this is a Main-Agent-side backstop, not a closed interception gap. See `docs/core/ORCHESTRATION_RULES.md` — "Worktree integration — Main Agent".

## Sub-agent brief template

The brief template (every field and its rule) is the `spawn-brief` skill — invoke it before composing any sub-agent brief: `.claude/skills/spawn-brief/SKILL.md`. The section as it stood in this file before T-889 is archived verbatim at `docs/archive/CLAUDE/2026-11-14-sub-agent-brief-template.md`.

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

The field reference (every `PROCESS_STATE.json` key, including the `next_action` routing-directive contract) lives in `.claude/rules/process-state.md`, which loads when `PROCESS_STATE.json` is touched.
