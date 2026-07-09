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
11. Before creating BACKLOG tasks, apply the pre-task gate: spawn `architect` or `analyst` when the conditions below are met. Neither role produces tasks — their briefs inform the Main Agent, who then registers tasks in BACKLOG.md.

## Pre-task gate

Run before registering any task in BACKLOG.md.

**architect** (internal codebase analysis — reads the codebase, returns a design brief and task decomposition):
- Feature touches 2+ services or repos
- Feature introduces new infrastructure (queue, database, scheduled job, serverless function, etc.)
- Feature changes an inter-service interface
- Feature requires choosing between architectural approaches

**analyst** (external world research — web research, returns a decision brief):
- A technology choice, library/API selection, or external landscape research must be resolved before scoping can begin

Neither role produces BACKLOG tasks. Their briefs inform the Main Agent before task registration.

**Architect model spawn rule** — the Main Agent spawns architect with a per-invocation `model: fable` override (Fable 5, primary). If Fable is unavailable, it re-spawns with `model: opus` (Opus 4.8). Architect is never spawned below Opus (in particular, never `sonnet`). The Agent-tool `model` parameter accepts aliases only (`sonnet`/`opus`/`haiku`/`fable`), not full-ids — spawn overrides must use one of these aliases. See `docs/AGENT_SPEC.md` — "Model selection" (worker model-escalation table) and "Effort selection" (effort-selection table), the single source of truth for both policies.

## Cross-repo task pre-flight

When a task's `work_dir` points to a different repo, the following three-step sequence is mandatory.

1. **Main Agent** includes `Adjacent docs read:` in the sub-agent brief, listing each `<repo>/CLAUDE.md` the agent should read before starting work.
2. **Developer sub-agent** reads `<work_dir>/CLAUDE.md` as its first action and declares the result in the report — either the key findings from the file, or the appropriate flag below.
3. **Reporting the outcome is not optional — only the finding changes:**
   - File found and current → declare key findings from the doc.
   - File not found → include `MISSING_DOC: <path>/CLAUDE.md` in the report so the Main Agent can register a documentation task.
   - File found but appears stale relative to observed code or config → include `OUTDATED_DOC: <path>/CLAUDE.md — <what specifically is stale>` so the Main Agent can register an update task.

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

### GAP B — Orphaned work: recovery before integration

The developer-side mandatory exit check (developer.md lines 64-65) only fires if the agent survives to the end of its turn. Agents can abort mid-turn — the last message ending "Now update…" or similar — leaving code written but uncommitted inside the worktree.

**Before integrating any worktree, the Main Agent must:**
1. Inspect `git status` inside the worktree (or ask the next developer sub-agent to run it as its first action).
2. If uncommitted changes are present that belong to the task, finish and commit them before proceeding with integration. This may require re-spawning the developer sub-agent with an explicit "commit the existing changes" instruction.
3. Only after the worktree is clean (or all task-relevant work is committed) proceed with GAP-A integration above.

This is the recovery counterpart to the developer-side exit-check. When the exit check fires, it handles this automatically; when the agent aborts before it can fire, the Main Agent must perform recovery manually.

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
