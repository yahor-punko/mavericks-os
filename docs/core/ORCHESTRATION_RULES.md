# Orchestration rules

## Core rules

1. The main agent acts as orchestrator first.
2. Developer sub-agents receive narrow, self-contained slices.
3. Runtime-heavy inspection and approval-sensitive loops stay primarily with the orchestrator.
4. After `qa_passed`, the orchestrator performs acceptance and immediately drives the obvious follow-through (`merged`, git check, commit) instead of stopping at a summary.
5. When QA returns `needs_fix` and the fix scope is already clear, treat it as an automatic handoff back to implementation rather than asking whether work should continue.
6. Each meaningful slice should end with sanity-checks and a commit when appropriate.
7. Process truth should live in docs, not only in chat.
8. Approval-heavy actions (runtime exec, shell inspection, git checks, commits, host inspection) should stay with the orchestrator, not as “continue the sub-agent” loops.
9. For long-lived projects, the orchestrator must maintain restartability: a new chat should be able to resume from project docs and recent status snapshots without depending on deep conversational history.
10. When a slice completes or changes state materially, update durable artifacts before relying on chat summaries.
11. Before creating BACKLOG tasks, apply the pre-task gate: architect decomposition is **mandatory for every task**, with the sole sanctioned exception being the XS fast lane (`--quick-merge`, see below); `analyst` is spawned additionally when external-world research must be resolved before scoping. Neither role produces tasks — their briefs inform the Main Agent, who then registers tasks in BACKLOG.md. `CLAUDE.md` — "Orchestrator checklist — before touching any file" is the source of truth for this gate.

## Pre-task gate

Run before registering any task in BACKLOG.md. **Architect spawn is mandatory for all tasks, unconditionally** — not gated by feature complexity or scope — with the sole sanctioned exception of the XS fast lane (`--quick-merge`; see "XS fast lane (quick-merge)" below). `CLAUDE.md` — "Orchestrator checklist — before touching any file" is the source of truth for this rule; this section restates it for orchestration-rules readers.

**architect** (internal codebase analysis — reads the codebase, returns a design brief and task decomposition): spawn first, always, for every task not covered by the XS fast lane exception. Simple or well-understood tasks still go through the gate — the architect returns a minimal single-task decomposition quickly in that case. The following are **signals that the decomposition will be non-trivial**, useful for anticipating scope — they are not preconditions that determine whether architect is spawned:
- Feature touches 2+ services or repos
- Feature introduces new infrastructure (queue, database, scheduled job, serverless function, etc.)
- Feature changes an inter-service interface
- Feature requires choosing between architectural approaches

**analyst** (external world research — web research, returns a decision brief), spawned in addition to architect, before it, when:
- A technology choice, library/API selection, or external landscape research must be resolved before scoping can begin

Neither role produces BACKLOG tasks. Their briefs inform the Main Agent before task registration.

**Architect model spawn rule** — the Main Agent spawns architect with a per-invocation `model: fable` override (Fable 5, primary). If Fable is unavailable, it re-spawns with `model: opus` (latest Opus). Architect is never spawned below Opus (in particular, never `sonnet`). The Agent-tool `model` parameter accepts aliases only (`sonnet`/`opus`/`haiku`/`fable`), not full-ids — spawn overrides must use one of these aliases. See `docs/AGENT_SPEC.md` — "Model selection" (worker model-escalation table) and "Effort selection" (effort-selection table), the single source of truth for both policies.

## XS fast lane (quick-merge)

`--quick-merge` (`scripts/mavp-operator-quick-merge.js`) is the **sole sanctioned exception** to the mandatory pre-task architect gate above. It fast-tracks a genuinely trivial change directly to `merged` — title + commit hash, no BACKLOG `planned` stage, no architect spawn — but only after every cited commit passes a mechanical guard, and only under Main-Agent attestation of the conditions the guard cannot check.

**Mechanically enforced thresholds** (the guard inspects the commit's diff via git plumbing *before* any file is written; violating any one refuses the **entire** run — nothing is registered, and the refusal names the violated threshold and the measured value):
- `files_changed` — at most 2 files changed in the commit.
- `total_lines` — at most 10 total changed lines (additions + deletions combined).
- `new_files` — zero new tracked files (any file added by the commit refuses the run).
- `sensitive_path` — no touched path falls in the sensitive set: `scripts/mavp-validator.js`, `scripts/mavp-operator-close-session.js`, `scripts/mavp-operator-lib.js`, `scripts/mavp-operator-quick-merge.js`, `scripts/mavp-operator`, any path under `.claude/hooks/`, any path prefixed `scripts/mavp-publish-`.
- `unresolvable` — the commit hash must resolve via `git rev-parse --verify` and its diff must be computable; unresolvable commits are refused.
- `binary_file` — any binary file in the diff is refused (line counts aren't mechanically checkable).

**Main-Agent-attested conditions** (the Main Agent vouches for these before running `--quick-merge`; the guard does not and cannot check them):
- No new external attack surface (no new API endpoint, file parser, auth flow, or third-party integration).
- No new runtime config keys (env vars, feature flags, secrets references).
- No change to the task-state model, lifecycle semantics, or validator behavior.
- `Verification type: artifact`, or a `runtime`/`unit` change trivial enough to be self-evidently correct on inspection.

**What the lane skips** — no separate architect spawn or decomposition block; no full multi-field sub-agent brief; no QA-agent stage (the task is registered directly as `merged`, never passing through `planned` → `qa_passed`).

**What the lane keeps** — the developer sub-agent still makes the actual code edit (the Main Agent never edits code directly, XS lane or not); the validator and `.claude/hooks/pre-commit` gate still run on the commit exactly as they would for any other change; `commit: <hash>` evidence is still required in `TASK_STATUS.md` (this is the only path used by `--quick-merge` — see `buildTaskStatusEntry()` in `scripts/mavp-operator-quick-merge.js`).

**Batch support** — `--quick-merge` accepts N title+commit(+optional note) items in a single run (interactively, looped until an empty title, or piped as grouped lines of 3 per item). Every item is pre-flighted against the XS guard before any registration happens: if any single item fails, the whole batch is refused and zero items are written (no partial registration). On success, sequential `T-NNN` ids are assigned, `last_task_id` is bumped once to the highest, one `EXECUTION_LOG.md` line is appended per item, and the validator runs exactly once at the end.

Use `--quick-merge` only when a change is genuinely this small. Anything larger, riskier, or touching the conditions above goes through the normal pre-task gate and full task lifecycle.

## Cross-repo task pre-flight

When a task's `work_dir` points to a different repo, the following three-step sequence is mandatory.

1. **Main Agent** includes `Adjacent docs read:` in the sub-agent brief, listing each `<repo>/CLAUDE.md` the agent should read before starting work.
2. **Developer sub-agent** reads `<work_dir>/CLAUDE.md` as its first action and declares the result in the report — either the key findings from the file, or the appropriate flag below.
3. **Reporting the outcome is not optional — only the finding changes:**
   - File found and current → declare key findings from the doc.
   - File not found → include `MISSING_DOC: <path>/CLAUDE.md` in the report so the Main Agent can register a documentation task.
   - File found but appears stale relative to observed code or config → include `OUTDATED_DOC: <path>/CLAUDE.md — <what specifically is stale>` so the Main Agent can register an update task.

## Cross-repo security reviews

`.claude/agents/security-reviewer.md` scopes each spawn to exactly one repo per invocation (see its "Scope" section) — a chained multi-repo review is refused as a blocker, not attempted. When a security review must cover a trust boundary spanning more than one repo, the Main Agent — never a single sub-agent spawn — owns the decomposition:

1. **Decompose per repo.** Spawn one `security-reviewer` invocation per repo involved in the boundary, each with its own narrow `Repo:` / `work_dir:` brief.
2. **Inject the shared contract.** Each per-repo brief must include the relevant interface or trust-boundary contract (e.g. the request/response shape, auth handoff, or data contract crossing the boundary) so each reviewer can judge its side of the interface without needing the other repo's source.
3. **Synthesize the cross-boundary verdict.** The Main Agent — not any sub-agent — combines the per-repo findings and reasons about the boundary itself (e.g. does repo A's output satisfy repo B's trust assumptions), then issues the overall `security_passed` / `security_needs_fix` verdict for the cross-repo change.

This mirrors the "Cross-repo task pre-flight" sequence above but is specific to security review: never let a single sub-agent spawn attempt to chain analysis across repos on its own, even if the harness would technically allow it — the turn/token budget for a single review is sized for one repo (see `docs/AGENT_SPEC.md` — "Per-role maxTurns table"), and a chained multi-repo review is the failure mode that produces a truncated, zero-output non-report instead of a usable verdict.

## Sub-agent report completion check

Every sub-agent's final report must end with the completion token defined in `docs/AGENT_SPEC.md` — "Report completion token" (`MAVP_REPORT role=<role> task=<T-NNN|n/a> verdict=<done|blocked|needs_fix|pass|fail>`). This section defines the Main-Agent-side check that consumes it.

**The check costs one glance, not a new tool.** The Main Agent already reads every sub-agent report to decide the next status transition — the rule is simply "look at the literal last line before booking anything". No hook fires on this: sub-agent reports are in-band chat content, not a file a `PostToolUse` hook could observe, so mechanical enforcement is not possible here and this is not an oversight to be patched later — it is the stated limit of the contract (see `docs/AGENT_SPEC.md`).

**Procedure, before booking any status transition or accepting any review verdict:**
1. Check whether the report's literal last line is the token.
2. If present, book the transition/verdict it names as normal.
3. If absent, send exactly one follow-up message asking the sub-agent to restate its final report ending in the token — this recovers the same in-progress turn rather than re-spawning.
4. If the token is still absent after that single resume message, treat the task as **blocked** and do not book any transition. Do not retry a second time and do not accept the report as-is.

**Verdict-bearing roles never book a pass without the token.** For `qa`, `security-reviewer`, and `ux`, a `qa_passed` / `security_passed` / `ux_passed` transition may only be booked when the token's last line is present with `verdict=pass`. A report that reads like a pass in its narrative but is missing the token line must be treated as unresolved under step 3/4 above — never inferred from the report body. This directly closes the incident this contract exists for: a security review truncated down to one narration line must never be misread as a pass.

## Cap-hit triage

A spawn can return without the completion token for two unrelated reasons, and the remedy differs by which one occurred — do not retry an identically-scoped brief until this is diagnosed.

1. Compare the spawn's reported `tool_uses` (from its task-notification `<usage>` field) to the role's `maxTurns`, from `docs/AGENT_SPEC.md`'s per-role table.
2. **`tool_uses >= cap`** — this is a cap-hit, not misfortune, regardless of the overshoot amount: observed signatures include exactly-at-cap, cap+1, and cap+2 (T-521 — see `docs/TURN_BUDGET.md` "Session 3 evidence"), and the rule must catch all of them, not just the common cap+1 case. Never retry the identical brief; it will hit the same wall. Remediate first: narrow the slice's scope, pre-load reconnaissance into the retry brief (see "Recon-preloading" below), or both. Cumulative multi-leg counts from a resumed spawn stay governed by the accumulation rule in `docs/TURN_BUDGET.md` — compare each leg's own allotment to the cap, never a raw cumulative total across resumes (e.g. a reported 180 against a 90-turn cap is two cap-hits, not one 180-turn observation).
3. **`tool_uses < cap`** — treat it as an infra failure (connection drop, policy error, process exit, watchdog stall), unrelated to this repo's turn-budget configuration; retrying the same brief as-is is the correct response here. When the count sits only a handful of calls below the cap, check the transcript tail before retrying identically — a spawn can burn several turns on tool-less text turns, so a near-cap-but-below count deserves a second look rather than an automatic identical retry.
4. Either branch: inspect the branch/worktree for already-committed work before integrating anything (GAP B below still applies).

Do not read a task-notification's `status: completed` field as evidence the sub-agent reached a verdict — it reflects only that the async wrapper process terminated, and is identical between a clean completion and a cap-hit. Only the completion token's presence, together with `tool_uses` versus the role's cap, distinguishes the two.

## Recon-preloading (brief-composition duty — retries and first spawns)

When re-spawning after a cap-hit, spend the Main Agent's own (cheap) calls before the spawn rather than the sub-agent's (expensive) ones: locate the relevant code or config and paste the excerpts directly into the retry brief, so the sub-agent's turn budget goes to reproduction and verification instead of first-pass discovery. This is a brief-composition duty, not optional color — a retry that only narrows scope still burns calls re-finding what the Main Agent already found while diagnosing the cap-hit.

This duty is not retry-only (T-557): whenever the Main Agent already holds the recon at first-spawn time — because composing the brief already required reading the relevant files, or because a prior sub-agent's report already surfaced them — pre-load it into the FIRST brief too, not only into a retry. Four recon-preloaded spawns confirm the pattern holds for both cases: two retries (security-reviewer, 9 and 13 tool_uses, per `docs/TURN_BUDGET.md`'s session-2 table) and two first spawns (16 and 22 tool_uses, recorded in `docs/TURN_BUDGET.md` "Session 3 evidence") all completed cleanly — versus the self-recon security-reviewer rows in the same document that repeatedly cap-hit without pre-loaded recon.

**Carve-out:** independent-discovery roles may deliberately self-recon instead of working from a Main-Agent-preloaded brief, on both first spawns and retries, when independence of discovery is itself the point of the pass — most notably **security-reviewer** full reviews and **qa**, where re-deriving findings from the artifact under review rather than from the Main Agent's own summary of it is part of what makes the resulting verdict trustworthy. Pre-loading recon for these two roles is permitted, never forbidden, but it is not mandatory the way it is for production-oriented roles (developer, product-docs, technical-writer, and the rest) whose job is to build or document, not to independently verify.

Pair this with the optional `Turn budget:` field in the sub-agent brief template (`CLAUDE.md` — "Sub-agent brief template"): fill it from `docs/AGENT_SPEC.md`'s per-role `maxTurns` table so the sub-agent can self-count against a known ceiling instead of an invisible one.

## Worktree integration — Main Agent

When a developer sub-agent returns control after working in a harness git-worktree, the Main Agent must integrate that work using the commit reference — not by inspecting or copying files from the worktree directory. Two distinct failure modes require separate recovery procedures.

### GAP A — Stale base: integrate by commit, not by files

Harness worktrees are frequently branched from an older commit of main. The files on disk inside the worktree therefore reflect the state of main at branch-cut time, not today. If the Main Agent copies files out of the worktree instead of cherry-picking or merging the agent's commit, it silently reverts any sibling task that was merged to main after the worktree was created. This is the T-308/T-310 class of incident: T-308's worktree was branched before T-310 merged; copying T-308's files to main would have erased T-310's changes entirely.

**Correct procedure:**
1. Obtain the commit hash from the developer sub-agent's report (or from `git log` inside the worktree).
2. Verify the commit's parent relative to current main: `git log <commit>^ --oneline` — confirm the parent is a reachable ancestor of main's HEAD, and note how many commits behind it sits.
3. Integrate via `git cherry-pick <commit>` (single commit) or `git merge <branch>` (branch tip). Do NOT copy files out of the worktree manually — this destroys sibling-task work already on main.
4. Resolve any conflicts that arise from the base skew; the developer's intent is in the commit diff, not in the worktree file tree.

The developer.md "Worktree mechanics" section (lines 52-66) owns committing inside the worktree and confirming the correct branch. This section picks up strictly after control returns here.

**Evidence hash — record the on-branch hash, not the worktree hash.** `git cherry-pick` and `git merge` both create a NEW commit object on the target branch whose hash differs from the sub-agent's original worktree commit hash — even though the diff content is identical. When recording `commit: <hash>` in `TASK_STATUS.md` evidence, use the hash printed by the integration command itself (the `[<branch> <hash>]` line git prints on a successful cherry-pick or merge commit), never the hash from the sub-agent's report or from `git log` inside the worktree. Recording the worktree hash produces evidence that is unreachable from the target branch, which trips the validator's `commit_unreachable` check after the fact. Do not pipe the cherry-pick/merge output through a filter (e.g. `tail`) aggressive enough to discard that `[<branch> <hash>]` line — capture the full output, or re-resolve the hash with `git rev-parse HEAD` on the target branch immediately after integrating, before writing evidence.

### GAP B — Orphaned work: recovery before integration

The developer-side mandatory exit check (developer.md lines 64-65) only fires if the agent survives to the end of its turn. Agents can abort mid-turn — the last message ending "Now update…" or similar — leaving code written but uncommitted inside the worktree.

**Before integrating any worktree, the Main Agent must:**
1. Inspect `git status` inside the worktree (or ask the next developer sub-agent to run it as its first action).
2. If uncommitted changes are present that belong to the task, finish and commit them before proceeding with integration. This may require re-spawning the developer sub-agent with an explicit "commit the existing changes" instruction.
3. Only after the worktree is clean (or all task-relevant work is committed) proceed with GAP-A integration above.

This is the recovery counterpart to the developer-side exit-check. When the exit check fires, it handles this automatically; when the agent aborts before it can fire, the Main Agent must perform recovery manually.

### GAP C — Stale reads: ff-merge pre-authorization when the task must read current main

Harness-created sub-agent worktrees branch from the session's STARTING HEAD (e.g. the last close-session commit), not current main. This means commits the Main Agent cherry-picked or merged onto main earlier in the SAME session are absent from a freshly-spawned worktree — the worktree is stale not just at integration time (GAP A) but at read time, from the moment it is created. The root cause is harness/SDK worktree-creation behavior, not an in-repo bug.

This matters whenever a sub-agent's task requires it to READ current-main state rather than merely write new content — for example: current version numbers, files merged earlier in the session, or a manifest that references newly-added files. If the sub-agent instead reads its stale worktree, it will act on outdated information (an old version number, a missing file, an inaccurate manifest) without any indication that anything is wrong.

**Conditional rule:** when a task must read current-main state, the Main Agent's brief pre-authorizes the sub-agent to run `git merge --ff-only main` from the worktree root (equivalently `git -C <worktree> merge --ff-only main` when invoked from outside the worktree) as its FIRST step, before doing any other work. `--ff-only` is safe by construction: it aborts with no side effects unless the worktree tip is a strict ancestor of main's current HEAD — it never creates a merge commit and never produces a conflict.

Absent this explicit pre-authorization, sub-agents must not reconcile their worktree to main on their own initiative — merge/reconciliation onto main is Main-Agent-owned (see the developer sub-agent spec's worktree-mechanics section, `.claude/agents/developer.md`, which states this from the developer side). This subsection is the reciprocal, Main-Agent-side rule: it defines when the Main Agent should proactively authorize the one safe exception (a strict fast-forward that can only bring the worktree closer to main, never diverge it).

**Empirical grounding:** observed twice this initiative. In the Wave-44 T-330 session, four separate sub-agent spawns each saw framework version `0.23.1` instead of the already-merged `0.23.2`, because their worktrees had branched before that merge landed on main. In this session's T-338, the developer brief pre-authorized `git merge --ff-only main` because the task required bumping the version file — in that instance the merge was a no-op fast-forward (the worktree happened to already be current), but the pattern of pre-authorizing the read-side ff-merge is now proven and should be applied whenever a task's brief depends on current-main state.

## Wave architect review gate

Waves with 3 or more planned tasks require architect review before the first task starts.

**Procedure:**
1. Main Agent spawns the `architect` sub-agent with the full task list for the wave.
2. Architect returns a design brief and any recommended task decomposition changes.
3. Main Agent incorporates the brief, then sets `wave_status` to `"architect_reviewed"` in `PROCESS_STATE.json`.
4. Work on the first task may only begin after `wave_status` is `architect_reviewed`.

**`wave_status` values** (tracked in `PROCESS_STATE.json`):
- `planning` — default; wave is being scoped, tasks not yet started
- `architect_reviewed` — architect review complete; tasks may proceed
- `execution` — tasks actively in progress
- `closed` — all tasks merged; `--close-session` sets this value on wave completion

The Main Agent updates `wave_status` manually in `PROCESS_STATE.json` at each transition. The `--close-session` command sets `wave_status: "closed"` automatically on wave completion.

## Parallelization rule

Parallelize only when tasks are narrow and have no direct dependency conflicts.

## Selection rule after acceptance

Choose the next task in this order:
- unblockers first
- end-to-end value second
- quality/polish third
- docs/process last unless they unblock delivery
