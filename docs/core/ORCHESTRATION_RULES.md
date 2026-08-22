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
- `Verification type: artifact`, or a `runtime`/`unit` change trivial enough to be self-evidently correct on inspection — this line is no longer attestation-only: `--verification-type` below lets the Main Agent declare the actual value at registration time, and `visual`/`manual` are now mechanically refused rather than merely discouraged.

**Declaration flags** — `--quick-merge` accepts two flags, both **batch-wide** (apply to every item registered in the run, not per-item; the 3-line piped protocol arity is unchanged):
- `--verification-type <artifact|runtime|unit>` — defaults to `runtime` when omitted (unchanged from pre-flag behavior, so a flagless run stays byte-identical). `visual` and `manual` are mechanically REFUSED, not merely discouraged: both require human review by definition and must never ride a lane that registers straight to `merged`.
- `--owner <role>` — defaults to `developer` when omitted (unchanged from pre-flag behavior). Validated against the `owner_role:` enumeration in `docs/ARCHITECT_OUTPUT.md`, minus `main_agent` — the lane always cites a commit produced by a sub-agent, and the Main Agent is an orchestrator, never the author of the diff (see `CLAUDE.md` — "Orchestrator checklist").
- An invalid value for either flag refuses the ENTIRE run with exit 1 — naming the invalid value and the allowed set — before any input is collected or any file is written.
- **Mixed batches:** a single invocation stamps ONE verification type and ONE owner across every item it registers. If the items you're batching actually need different values, run the lane once per type/owner grouping instead — do not run one mixed batch and assume per-item values.

**What the lane skips** — no separate architect spawn or decomposition block; no full multi-field sub-agent brief; no QA-agent stage (the task is registered directly as `merged`, never passing through `planned` → `qa_passed`).

**What the lane keeps** — the developer sub-agent still makes the actual code edit (the Main Agent never edits code directly, XS lane or not); the validator and `.claude/hooks/pre-commit` gate still run on the commit exactly as they would for any other change; `commit: <hash>` evidence is still required in `TASK_STATUS.md` (this is the only path used by `--quick-merge` — see `buildTaskStatusEntry()` in `scripts/mavp-operator-quick-merge.js`).

**Batch support** — `--quick-merge` accepts N title+commit(+optional note) items in a single run (interactively, looped until an empty title, or piped as grouped lines of 3 per item). Every item is pre-flighted against the XS guard before any registration happens: if any single item fails, the whole batch is refused and zero items are written (no partial registration). On success, sequential `T-NNN` ids are assigned, `last_task_id` is bumped once to the highest, one `EXECUTION_LOG.md` line is appended per item, and the validator runs exactly once at the end. See "Declaration flags" above for the two flags (`--verification-type`, `--owner`) that apply across the whole batch, not per item.

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

A spawn can return without the completion token for two unrelated reasons, and the remedy differs by which one occurred — do not retry an identically-scoped brief until this is diagnosed. This triage procedure is scoped entirely to the token-absent case named above; a spawn that DOES end in the completion token (e.g. T-653, qa: `tool_uses` 26 against a 20 cap, clean completion — see `docs/TURN_BUDGET.md` "Session 4 evidence") was already correctly classified as `completed` regardless of where `tool_uses` sits relative to cap, and that classification is deliberately unchanged here — nothing below reopens it.

1. Compare the spawn's reported `tool_uses` (from its task-notification `<usage>` field) to the role's `maxTurns`, from `docs/AGENT_SPEC.md`'s per-role table.
2. **`tool_uses >= cap`** — this is a cap-hit, not misfortune, regardless of the overshoot amount: observed signatures include exactly-at-cap, cap+1, and cap+2 (T-521 — see `docs/TURN_BUDGET.md` "Session 3 evidence"), and the rule must catch all of them, not just the common cap+1 case. **One-sidedness caveat:** `tool_uses` only bounds turns from above — parallel tool calls issued within a single turn each add to `tool_uses` but count as one turn (the same over-count mechanism `docs/TURN_BUDGET.md` documents for read-heavy roles) — so, in the token-absent case this step governs, `tool_uses >= cap` makes a spawn a PROBABLE cap-hit, not a certain one; check the transcript tail before applying the no-identical-retry prescription below. This does not weaken that prescription once the cap-hit is confirmed: never retry the identical brief; it will hit the same wall. Before narrowing scope or re-spawning, check whether the brief misrouted another role's work onto this one (see "Role-scope check" below) — on a bounded role, a cap-hit is often the first observable symptom of misrouting, and the correct remedy there is re-routing the item to the right role, not more budget. Once misrouting is ruled out, remediate as scope: narrow the slice's scope, pre-load reconnaissance into the retry brief (see "Recon-preloading" below), or both. Cumulative multi-leg counts from a resumed spawn stay governed by the accumulation rule in `docs/TURN_BUDGET.md` — compare each leg's own allotment to the cap, never a raw cumulative total across resumes (e.g. a reported 180 against a 90-turn cap is two cap-hits, not one 180-turn observation).
3. **`tool_uses < cap`** — treat it as an infra failure (connection drop, policy error, process exit, watchdog stall), unrelated to this repo's turn-budget configuration; retrying the same brief as-is is the correct response here. This branch stays definitive regardless of the one-sidedness caveat in step 2: a turn can bundle multiple tool calls but never the reverse, so turns can never exceed `tool_uses` — `tool_uses < cap` conclusively means turns were also below cap, with no PROBABLE reading needed. When the count sits only a handful of calls below the cap, check the transcript tail before retrying identically — a spawn can burn several turns on tool-less text turns, so a near-cap-but-below count deserves a second look rather than an automatic identical retry.
4. Either branch: inspect the branch/worktree for already-committed work before integrating anything (GAP B below still applies).

Do not read a task-notification's `status: completed` field as evidence the sub-agent reached a verdict — it reflects only that the async wrapper process terminated, and is identical between a clean completion and a cap-hit. Only the completion token's presence, together with `tool_uses` versus the role's cap, distinguishes the two.

**Capped-resume recovery protocol:** on a cap-hit that ends mid-sentence with no verdict, prefer resuming the SAME agent over re-spawning fresh — a `qa` spawn briefed with seven verification items plus a diff review against a 20-turn cap hit exactly 20/20 with no verdict, and resuming it with further exploration forbidden and an explicit "NOT verified" gap list required produced a usable report cheaper than a re-spawn, because everything the capped run had already observed was preserved. Scope the resume brief as tightly as any initial brief (`docs/TURN_BUDGET.md` already requires this); the addition here is the mandatory honest-gap section, so a truncated run yields a partial verdict with declared coverage instead of silently lost work.

## Recon-preloading (brief-composition duty — retries and first spawns)

When re-spawning after a cap-hit, spend the Main Agent's own (cheap) calls before the spawn rather than the sub-agent's (expensive) ones: locate the relevant code or config and paste the excerpts directly into the retry brief, so the sub-agent's turn budget goes to reproduction and verification instead of first-pass discovery. This is a brief-composition duty, not optional color — a retry that only narrows scope still burns calls re-finding what the Main Agent already found while diagnosing the cap-hit.

This duty is not retry-only (T-557): whenever the Main Agent already holds the recon at first-spawn time — because composing the brief already required reading the relevant files, or because a prior sub-agent's report already surfaced them — pre-load it into the FIRST brief too, not only into a retry. Four recon-preloaded spawns confirm the pattern holds for both cases: two retries (security-reviewer, 9 and 13 tool_uses, per `docs/TURN_BUDGET.md`'s session-2 table) and two first spawns (16 and 22 tool_uses, recorded in `docs/TURN_BUDGET.md` "Session 3 evidence") all completed cleanly — versus the self-recon security-reviewer rows in the same document that repeatedly cap-hit without pre-loaded recon.

**Carve-out:** independent-discovery roles may deliberately self-recon instead of working from a Main-Agent-preloaded brief, on both first spawns and retries, when independence of discovery is itself the point of the pass — most notably **security-reviewer** full reviews and **qa**, where re-deriving findings from the artifact under review rather than from the Main Agent's own summary of it is part of what makes the resulting verdict trustworthy. Pre-loading recon for these two roles is permitted, never forbidden, but it is not mandatory the way it is for production-oriented roles (developer, product-docs, technical-writer, and the rest) whose job is to build or document, not to independently verify.

Pair this with the optional `Turn budget:` field in the sub-agent brief template (`CLAUDE.md` — "Sub-agent brief template"): fill it from `docs/AGENT_SPEC.md`'s per-role `maxTurns` table so the sub-agent can self-count against a known ceiling instead of an invisible one.

## Role-scope check (brief-composition duty — before adding any item to a brief)

Every item written into a sub-agent brief must fall within the target role's mandate as stated in its own spec file (`.claude/agents/<role>.md`), not the Main Agent's own guess at what the role "should" be able to handle. This is a brief-composition duty like the two above — checked before the spawn, not diagnosed after a cap-hit.

**The concrete test:** if answering a brief item requires inspecting components the slice did not touch, that item is an architecture question, not a verification question — spawn architect for it, not QA. `docs/AGENT_SPEC.md` states the architect role "covers both pre-task analysis (idea → T-NNN decomposition) and mid-project architecture questions" and "runs before or alongside tasks" — a structural, codebase-wide question fits squarely inside the second clause regardless of when in a project's life it comes up. QA's own mandate, per `.claude/agents/qa.md`, is narrower and slice-scoped: "Validate a completed slice against its acceptance criteria. You do not implement — you verify." Asking QA to determine whether other, untouched parts of the codebase depend on a structural property is not verifying the slice; it is reasoning about the system beyond it, which is out of scope for the role regardless of how the item is worded.

An incident this rule closes: a QA brief asked whether anything in the codebase depends on task-block field order, naming several parsers the slice under review never touched. The bounded role (20-turn cap) hit its cap mid-work with no completion token. The cap-hit was the symptom, not the defect — the defect was routing an architecture question into a verification brief in the first place; see "Cap-hit triage" above.

## Executed-check rule (brief-composition duty — before writing any named check into a durable artifact)

A check named in an acceptance criterion, sub-agent brief, or evidence field costs nothing to write and can cost a full round to disprove if it was never actually run. Ten incidents across two sessions share one shape: a factual claim about a component's behavior, asserted from reading rather than executing, shipped into BACKLOG.md, a brief, or TASK_STATUS evidence. T-558's named mutant had no capture group and was structurally unable to fail; T-561's registered killer (`GIT_CONFIG_GLOBAL=/dev/null`) provably does not reproduce the failure on macOS; T-570's harness command, run as literally written, would have passed while still inspecting the canonical repo, because both test files resolve their root via `path.resolve(__dirname, '..')` rather than `process.cwd()`; T-564's audience context from a brief leaked verbatim into shipped public prose. The same shape recurred from a different role in T-573 — a developer's structurally inert test and an unverified doc-comment claim, plus a QA root-cause attribution corrected only after the fact — so the class is role-agnostic; per-role duties for developer, QA, and architect live in `.claude/agents/*.md`, not here.

**The rule:** any executable check — command, named mutant, grep, or expected-output claim — and any cited path or section name written into an acceptance criterion, sub-agent brief, or evidence field must have been executed (or, for path/section citations, actually read) before being written, in the session where it is written. Reading a component's name, message text, or source is NOT execution.

**Observable form, not an invisible duty:** every named check in such an artifact must carry either its quoted observed output, or an explicit `UNEXECUTED — verify before relying` label. This makes compliance checkable from the artifact alone, by a reviewer who was not present. No mechanical enforcement exists for this rule — session transcripts are harness-owned with no format contract a hook or grep could parse against, and no automated check can distinguish a claim the author actually ran from one only read about. The rule works by converting that unobservable duty into an observable artifact property; stating the enforcement gap plainly is part of the rule, not a caveat to hide.

**Fixture vs. live reproduction:** an executed check discharges this duty only if its execution context can actually expose the failure it claims to guard against — a fixture verifies LOGIC, a live reproduction verifies FORM. T-565 satisfied six criteria and reddened five named mutants, yet only a real shallow clone exposed that its advisory printed a 471-item wall, a regression against the output it replaced that none of the six fixture-based criteria could have caught.

**Environment matrix:** for a `ship`-classified check, the environment class it ran in — the canonical private repo, or the mirror-shaped assembled publish tree, where live state artifacts are one-record `templates/` starters and internal-only paths are absent entirely — is part of the execution context, not a detail of it. Green in the first is not evidence about the second, so "I ran it" is an incomplete claim unless it names the class: two consecutive releases published a red mirror CI on exactly this gap while the private CI was green (0.39.0/T-570, 0.40.0/T-575). `scripts/check-assembled-suite.js` is the mechanical backstop — it runs the shipped suite inside an assembled tree and records a receipt `scripts/mavp-publish-build.js` refuses to publish without (`docs/PUBLIC_RELEASE_STRATEGY.md` §3a) — but it closes only the omission case, so a criterion or brief asserting behavior about shipped content still has to say which environment class its quoted output came from.

Complementary to the behavioral-assertion rule in `docs/ARCHITECT_OUTPUT.md` (the `acceptance_criteria:` field, which requires a behavioral outcome rather than a structural-only check like exit code or shape): that rule governs what a criterion must assert; this rule governs whether the named check was ever run. See also "Recon-preloading" above — both are brief-composition duties that spend the Main Agent's own time before a spawn rather than the sub-agent's after.

## Worktree integration — Main Agent

When a developer sub-agent returns control after working in a harness git-worktree, the Main Agent must integrate that work using the commit reference — not by inspecting or copying files from the worktree directory. Two distinct failure modes require separate recovery procedures.

**Required integration path (T-567): `./scripts/mavp-operator --integrate <commit|base..tip> [--task T-NNN]`.** This is the required way to cherry-pick a sub-agent's worktree commit onto the primary checkout — it pins the actual git operation to the resolved project root regardless of the caller's `cwd`, so the hand-typed cwd-dependent cherry-pick class this section exists to prevent (three registered incidents in one session, 2026-07-29) cannot recur through this path. It is gated by `guardMutatingRoot()` (T-624/T-670) before any git subprocess runs, refuses when a pick or merge is already in progress, never auto-aborts on conflict, and writes no state artifact itself — it only prints the integrated hash(es) and, optionally, a `--set-status` suggestion. **This does not close the underlying vector.** A hand-typed raw `git cherry-pick`/`git merge` run directly against the shared main checkout instead of through `--integrate` remains possible, and nothing in this repo intercepts it before it runs — the same GAP-D-style fact as the shell-escape gap below: no `PreToolUse` hook exists anywhere tracked here to redirect a raw git command toward `--integrate`. Ownership of that residual raw-git vector is its own dedicated accepted-boundary row in `docs/core/GATE_LEDGER.md`'s "Accepted boundaries" section, anchored to T-567's own 2026-08-05 scope ruling — not the T-626 row, and not the deprecated T-626 task itself. The T-626 row covers a different vector entirely: the live-execution vector into the machine-shared framework-source clone (`~/.mavericks`), undetected between installs. T-567's 2026-08-05 wave-77 close-gate ruling separated the two explicitly — this task owning the VECTOR side (hand-typed integration git) and T-624/T-625/T-626 owning the TARGET side (the unattended live-dependency clone), with no `Root cause:` link in either direction. The residual raw-git vector's own row carries a standing reopen trigger, precisely so no gap fell between owners and no shadow task is owed here.

### GAP A — Stale base: integrate by commit, not by files

Harness worktrees are frequently branched from an older commit of main. The files on disk inside the worktree therefore reflect the state of main at branch-cut time, not today. If the Main Agent copies files out of the worktree instead of cherry-picking or merging the agent's commit, it silently reverts any sibling task that was merged to main after the worktree was created. This is the T-308/T-310 class of incident: T-308's worktree was branched before T-310 merged; copying T-308's files to main would have erased T-310's changes entirely.

**Correct procedure:**
1. Obtain the commit hash from the developer sub-agent's report (or from `git log` inside the worktree).
2. Verify the commit's parent relative to current main: `git log <commit>^ --oneline` — confirm the parent is a reachable ancestor of main's HEAD, and note how many commits behind it sits.
3. Integrate via `git cherry-pick <commit>` (single commit) or `git merge <branch>` (branch tip). Do NOT copy files out of the worktree manually — this destroys sibling-task work already on main.
4. Resolve any conflicts that arise from the base skew; the developer's intent is in the commit diff, not in the worktree file tree.

The developer.md "Worktree mechanics" section owns the start-of-run base-floor check, committing inside the worktree, and confirming the correct branch. This section picks up strictly after control returns here.

**Evidence hash — record the on-branch hash, not the worktree hash.** `git cherry-pick` and `git merge` both create a NEW commit object on the target branch whose hash differs from the sub-agent's original worktree commit hash — even though the diff content is identical. When recording `commit: <hash>` in `TASK_STATUS.md` evidence, use the hash printed by the integration command itself (the `[<branch> <hash>]` line git prints on a successful cherry-pick or merge commit), never the hash from the sub-agent's report or from `git log` inside the worktree. Recording the worktree hash produces evidence that is unreachable from the target branch, which trips the validator's `commit_unreachable` check after the fact. Do not pipe the cherry-pick/merge output through a filter (e.g. `tail`) aggressive enough to discard that `[<branch> <hash>]` line — capture the full output, or re-resolve the hash with `git rev-parse HEAD` on the target branch immediately after integrating, before writing evidence.

### GAP B — Orphaned work: recovery before integration

The developer-side mandatory exit check (developer.md — "Before returning control — mandatory exit check") only fires if the agent survives to the end of its turn. Agents can abort mid-turn — the last message ending "Now update…" or similar — leaving code written but uncommitted inside the worktree.

**Before integrating any worktree, the Main Agent must:**
1. Inspect `git status` inside the worktree (or ask the next developer sub-agent to run it as its first action).
2. If uncommitted changes are present that belong to the task, finish and commit them before proceeding with integration. This may require re-spawning the developer sub-agent with an explicit "commit the existing changes" instruction.
3. Only after the worktree is clean (or all task-relevant work is committed) proceed with GAP-A integration above.

This is the recovery counterpart to the developer-side exit-check. When the exit check fires, it handles this automatically; when the agent aborts before it can fire, the Main Agent must perform recovery manually.

### GAP C — Stale reads: ff-merge pre-authorization when the task must read current main

**The base commit is harness-chosen and untrusted.** The harness creates sub-agent worktrees and accepts no input constraining which commit it bases them on. The base is *commonly observed* to be the session's STARTING HEAD (e.g. the last close-session commit) rather than current main — but that is an observation, not a mechanism to rely on. Observed bases have also been arbitrarily stale, **sticky across separate runs**, and **not an ancestor of any live branch**: on 2026-08-05, in a branch-based service repo (call it repo A), a worktree came up on commit `2451645`, for which `git merge-base --is-ancestor 2451645 develop` returns false — and the same hash recurred as the base of a later, independent run. Two hypotheses would explain that — git refusing a busy target branch and the harness silently falling back to a leftover ref, or the harness never attempting to check out a caller's branch at all — and **neither is established**; do not write either into a brief or a doc as the mechanism. Treat the base as unknown until it has been measured (see GAP E for the measurement duty and the `Base floor:` field that carries it).

The consequence holds under either hypothesis: commits the Main Agent cherry-picked or merged onto main earlier in the SAME session can be absent from a freshly-spawned worktree — the worktree is stale not just at integration time (GAP A) but at read time, from the moment it is created. A non-ancestor base is the harder variant, because it can be missing history that no fast-forward will supply. The root cause is harness/SDK worktree-creation behavior, not an in-repo bug.

This matters whenever a sub-agent's task requires it to READ current-main state rather than merely write new content — for example: current version numbers, files merged earlier in the session, or a manifest that references newly-added files. If the sub-agent instead reads its stale worktree, it will act on outdated information (an old version number, a missing file, an inaccurate manifest) without any indication that anything is wrong.

**Conditional rule:** when a task must read current-main state, the Main Agent's brief pre-authorizes the sub-agent to run `git merge --ff-only main` from the worktree root (equivalently `git -C <worktree> merge --ff-only main` when invoked from outside the worktree) as its FIRST step, before doing any other work. `--ff-only` is safe by construction: it aborts with no side effects unless the worktree tip is a strict ancestor of main's current HEAD — it never creates a merge commit and never produces a conflict. That safety cuts both ways: on a non-ancestor base the ff-merge simply aborts and the worktree stays stale, so the pre-authorization alone does not guarantee a current read. Pair it with a `Base floor:` (GAP E) so the residual staleness becomes an explicit stop instead of a silent no-op — when both are set, the ff-merge runs first and the floor check second.

**Second trigger — same-session task registration:** the first trigger above is framed around the task's LOGIC (does the work itself need a current version number, a newly merged file, and so on), and that framing misses the case that actually bites: when the task's own BACKLOG/TASK_STATUS registration commit postdates the session's starting HEAD — true of nearly every task registered during the current session — set `Read current main:` regardless of whether the task's logic otherwise cares about main state. A worktree based on the pre-registration HEAD cannot see its own contract: `grep T-NNN BACKLOG.md TASK_STATUS.md` inside the worktree finds nothing, because the registration commit itself is the thing the ff-merge is needed to fetch. Committing the registration before dispatch is **necessary but not sufficient** — the harness-chosen base is not "current main at spawn time" (see above), so registering the task and then spawning without `Read current main:` still leaves a same-session task invisible to its own worktree. The `Base floor:` guard (GAP E) catches the resulting mismatch cheaply — a non-empty `git log --oneline HEAD..<floor>` before any edit — but the fix is to set the trigger up front, not to rely on catching it after the fact.

Absent this explicit pre-authorization, sub-agents must not reconcile their worktree to main on their own initiative — merge/reconciliation onto main is Main-Agent-owned (see the developer sub-agent spec's worktree-mechanics section, `.claude/agents/developer.md`, which states this from the developer side). This subsection is the reciprocal, Main-Agent-side rule: it defines when the Main Agent should proactively authorize the one safe exception (a strict fast-forward that can only bring the worktree closer to main, never diverge it).

**Empirical grounding:** observed twice this initiative. In the Wave-44 T-330 session, four separate sub-agent spawns each saw framework version `0.23.1` instead of the already-merged `0.23.2`, because their worktrees had branched before that merge landed on main. In this session's T-338, the developer brief pre-authorized `git merge --ff-only main` because the task required bumping the version file — in that instance the merge was a no-op fast-forward (the worktree happened to already be current), but the pattern of pre-authorizing the read-side ff-merge is now proven and should be applied whenever a task's brief depends on current-main state.

### GAP D — Worktree escape: a mutating command reaches the shared main checkout

A worktree developer's shell command can carry an absolute path or a `cd` into the shared main checkout instead of staying inside its own worktree — the T-602 incident: a `sed` invocation prefixed with an absolute `cd` edited main's copy of the target file. The developer-side rule (`.claude/agents/developer.md` — "Worktree mechanics", "Committing from a worktree — critical rules") generalizes the prior git-only absolute-path prohibition to any mutating command and adds a mandatory post-edit self-verification step, so the agent that made the mistake is also the agent best placed to catch it immediately, before it reports back. In the T-602 case the agent's own diff-based self-check caught the escape, restored the file, and redid the edit correctly, and the Main Agent independently confirmed the restoration.

**This is not a closed gap.** Nothing in this repo intercepts a worktree sub-agent's shell command before it runs — `.claude/hooks/` contains only `pre-commit`, no `PreToolUse` hook exists anywhere tracked in this repo, and hooks are activated through a gitignored settings file that is absent from worktree checkouts. Whether a hook defined in the main project's settings would even fire for a worktree sub-agent's Bash calls is harness-internal behavior nobody here has a way to execute a check against, so no such mechanism is claimed. What follows is the Main-Agent-side backstop that relies on the mistake surfacing in `git status` on main, not a fix for the interception gap itself. A `sed`, `mv`, `cp`, or shell redirect that a self-check fails to catch — or a worktree agent that skips the self-check — can still corrupt or silently revert a file on main with no cherry-pick ever carrying evidence of it, and the offending agent's own report would still read as clean, because its worktree remains untouched.

**Main-Agent-side backstop — before integrating any worktree wave:**
1. Run `git status --porcelain` on the shared main checkout, before cherry-picking or merging any sub-agent's commit.
2. Treat any modification not attributable to a main-direct agent (product-docs, architect) or to the Main Agent's own state-artifact edits (`BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.json`/`.md`) as a worktree-escape signal. Investigate which worktree/agent produced it before proceeding.
3. Restore the affected path with `git checkout HEAD -- <path>` — not a bare `git checkout <path>`. After a `git add`, a bare `git checkout <path>` restores from the INDEX, not from HEAD, which can silently keep the escaped edit staged instead of reverting it; `git checkout HEAD -- <path>` is the form that actually reverts to the last committed state on main.
4. Only after main is confirmed clean (or the escaped edit has been restored) proceed with GAP-A integration above.

### GAP E — Untrusted placement: isolation is spawning-repo-scoped, and the base must be measured

GAP C covers *which commit* a worktree is based on. This subsection covers *which repository it lands in* — the second half of the same class: the harness owns worktree placement and accepts no input constraining it.

**Isolation root derives from the parent session's repo.** The Agent tool exposes no input by which a target repo (or a base commit, or a branch) could be communicated to the isolation machinery. The brief's `work_dir:` field is *text inside the prompt* — the machinery never reads it. So the worktree is always created under the repo the session was started in, whatever repo the task targets.

**Cross-repo tasks therefore get NO isolation for the target repo.** Observed 2026-08-05: a task whose `work_dir:` targeted service repo B was given a worktree under a *different* service repo's tree (`<other-repo>/.claude/worktrees/agent-<id>`). The target repo B had zero `worktree-agent-*` refs and no `.claude/worktrees` directory at all — no worktree was ever created there. **This is a documented scoping fact, not a defect to be fixed**: `.claude/agents/developer.md` — "Worktree mechanics" already instructs a cross-repo developer to treat `work_dir` as the root for all reads *and writes*, i.e. to edit the target repo's real, unisolated checkout. Cross-repo isolation buys the target repo nothing and never did. Plan dispatch accordingly — a cross-repo developer is editing a live checkout, so give it the serialization and pre-flight care owed to a main-direct agent (see "Cross-repo task pre-flight" above), not the latitude of an isolated one.

**The reported workaround is more dangerous than the disease.** Spawning *without* isolation, so that the parent session can prepare a branch first, puts a developer directly on the shared checkout — the same escape surface as GAP D and the T-602 incident, minus the worktree that made the escape detectable in the first place. It is acceptable only for strictly serial, single-agent work where no sibling sub-agent and no Main-Agent state edit can be in flight at the same time. Never in a parallel wave.

**Main-Agent pre-spawn duties:**
1. **Capture the base floor.** Resolve the target repo's base-branch head (`git -C <target-repo> rev-parse --short <base-branch>`) and put it in the brief's `Base floor: <hash>` field. This is what converts an assumed base into a measured one: the developer's mandatory start-of-run check, `git log --oneline HEAD..<floor>`, collapses both failure modes into an immediate stop — non-empty output means the worktree lacks required history (stale base), `fatal: Invalid revision range` means the worktree is not in the target repo at all (wrong repo). Required for cross-repo spawns and for branch-based target repos; recommended otherwise. When absent, the developer proceeds exactly as before — no existing brief flow breaks.
2. **Inspect worktree hygiene in branch-based target repos before dispatch.** Run `git worktree list` (and `git branch --list 'worktree-agent-*'`) in that repo. Leftover agent worktrees and refs accumulate without bound — this repo carries 120 `git worktree list` entries against 119 `worktree-agent-*` branch refs, and `git worktree prune --dry-run -v` prints nothing because every stale directory still physically exists. Each leftover ref is a candidate base for the sticky non-ancestor failure in GAP C, and a busy base branch is one of the two unresolved hypotheses for it.
3. **Read the floor-check output in the report before integrating.** The developer is required to quote the command and its exact output, empty case included. If the report does not contain it, treat the check as not run: re-run it yourself against the returned commit before cherry-picking, or re-spawn.

**This does not close the harness-level gap.** Nothing here constrains where the harness puts a worktree or which commit it bases it on, and nothing of ours can fire inside a worktree to enforce the preflight — no PreToolUse interception is available there (see GAP D). The protocol is gated by discipline, not by mechanism. Its one compensating control is the observable-form contract: because the developer must quote the check's output, compliance is verifiable from the artifact instead of assumed. `T-622` is the paired debt task that retires this workaround if and when the Agent tool exposes placement controls or fail-fast semantics.

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

There is no `closed` value. The close and the wave-counter advance are one atomic write inside `--close-session` — persisting `closed` would stamp the freshly OPENED wave as closed, which is worse than not persisting anything. `wave_summary` is the artifact that records what the closed wave accomplished.

The Main Agent updates `wave_status` manually in `PROCESS_STATE.json` at each transition (`planning` → `architect_reviewed` → `execution`). On wave completion, `--close-session` resets `wave_status` to `"planning"` for the newly opened wave (T-653) — otherwise the ending wave's gate state would carry forward verbatim onto the new wave, letting it falsely read as already past its own architect-review gate.

## Parallelization rule

Parallelize only when tasks are narrow and have no direct dependency conflicts.

## Test-execution scope (worktree developers)

Worktree developer briefs MUST name a targeted test scope via `node scripts/run-tests.js --filter <fragment>` — never instruct a worktree developer to run the full suite. The full suite runs exactly once, on main, as a single Main-Agent integration step: after every sibling task's commit has been cherry-picked/merged in and before the wave closes. That single run is the backstop that makes targeted-only dispatch complete coverage rather than a workaround — no task's coverage is actually skipped, it is deferred to the one place a full run is cheap.

**Never do either of these:**
- **Never instruct parallel worktree agents to each run the full suite.** A large suite is effectively serial work competing for the same CPU cores regardless of how many agents invoke it, so N-way parallel full-suite runs do not run N times faster — they run roughly N times slower per agent while all N compete. Measured (Wave 72): five developer agents each instructed to run the full 76-file suite measured ~20 minutes wall-clock with 12 concurrent `run-tests.js` invocations observed, and four of the five agents were damaged by the wait: T-576 hit its 140-turn cap and was truncated mid-sentence; T-581 stalled three separate times (61, 73, 81 tool uses), each time by backgrounding `run-tests.js` and idling on its own command; T-578 stalled at 67 tool uses and separately killed its own test process while trying to work out which of five identically-shaped sibling `run-tests.js` processes was its own; only T-588 was unaffected. The Main Agent's own sequential full-suite runs on main during the same wave exceeded 600 seconds each and had to be backgrounded twice.
- **Never background `run-tests.js` and idle-wait on it.** A turn that ends on a passive wait has no later turn coming to observe the outcome — this is the mechanism behind the T-581/T-578 stalls above (see the developer sub-agent spec's "Never end a turn passively waiting on a background task" rule, `.claude/agents/developer.md`).

**How to select the targeted filter.** A rule that says "run targeted tests" without saying how to choose them will be followed badly. Compose the scope from three parts:

1. **Own test files** — the test file(s) the task itself adds or edits, filtered by basename (e.g. `--filter test-foo`).
2. **Grep-derived coverage** — `grep -l` over `scripts/test-*.js` for the changed source files' basenames and their exported symbols; run every file that hits.
3. **The brief's `Test scope:` field** — a Main-Agent-seeded baseline (see `CLAUDE.md` — "Sub-agent brief template") that the developer extends via (1) and (2) above and reports back as a delta from what the Main Agent seeded.

**Caveat — shared-library edits can outgrow a clean targeted set.** For `mavp-operator-lib.js`-class edits (a shared module many test files exercise), the grep-derived set from step 2 can be large. Beyond roughly ten files, run them serially and say so in the report, rather than silently backgrounding the batch or claiming full coverage — breadth past that point is exactly what the Main Agent's post-integration full-suite run exists to close.

This is division of labor with a backstop, not a shortcut: per-worktree coverage is intentionally partial, and it stays complete overall only because the Main Agent runs the full suite once on main, after every sibling task's commit is integrated and before the wave closes.

## Repository-global exclusive resources (parallel worktree dispatch)

Linked git worktrees share one underlying repository. Most of that shared state is per-worktree in effect (see the counterexamples below), but a bounded set of resources is genuinely **global across every linked worktree AND exclusive-use** — only one agent can hold or act on the resource at a time, and a second agent's use displaces or blocks the first rather than merely queuing behind it. Cost of misuse here is not wasted time (that is the T-594 class, below) but corruption or starvation: lost work, a stuck checkout, or a wedged lock file.

**Bounded enumerated instance list** (same shape as the reserved-shapes precedent in `.claude/rules/scripts.md` — "Reserved shapes (bounded, not universal)"; each instance labeled by its evidence status):

- **The stash stack** — OBSERVED (wave 76 field incident plus executed fixture, 2026-08-05): a wave-76 brief instructed three parallel worktree developers to `git stash` for red runs; two agents popped each other's WIP (both self-caught and recovered). The fixture confirms the mechanism: a stash created in worktree A is listed and poppable from worktree B — the stash stack is one list shared by every linked worktree, not scoped per-worktree.
- **Branch-checkout exclusivity** — OBSERVED (field report 2026-08-05 plus fixture): checking out a branch that is already checked out in another linked worktree fails with git's already-used-by-worktree error. This is the class's second observed instance — a branch can be checked out in only one linked worktree at a time, repository-wide.
- **Shared ref/lock surfaces** such as `packed-refs.lock` and `config.lock` — REASONED, NOT OBSERVED: these lock files are written to the shared `.git` directory (or the common dir a linked worktree shares), not to any per-worktree private area, so two concurrent operations that both need the lock will contend or fail; no incident has surfaced this in practice, but the mechanism is the same shared-single-file shape as the two observed instances above.
- **The shared main checkout's index, between the Main Agent and any non-worktree-isolated agent** — OBSERVED (2026-08-15, this task's own file): not every agent gets a worktree — `product-docs` and `architect` edit the shared main checkout directly, alongside the Main Agent, so those participants share ONE checkout and therefore ONE index. A file staged (`git add`) by one and not yet committed can be silently swallowed into the other's commit, with no error and no conflict, by any command that commits the index as a whole rather than by pathspec: `git cherry-pick --continue`, `git rebase --continue`, `git merge --continue`, `git commit` with no pathspec, and `git commit -a` all share this property. Live incident: this task's own `.claude/agents/developer.md` edit was staged via `git add` in the shared checkout, then swallowed whole into the Main Agent's concurrent `git cherry-pick --continue` for an unrelated task (T-624), landing correctly-worded but misattributed to that task's commit message rather than this one's.

**Per-worktree counterexamples** (teaching the boundary in the other direction — these are NOT shared-and-exclusive, and do not need the treatment above, but only BETWEEN LINKED WORKTREES): the **index**, **HEAD**, `refs/worktree/*`, and `refs/bisect/*` are each private to their own worktree. Editing the index or moving HEAD in one worktree has no effect on a sibling worktree's index or HEAD, and per-worktree refs (`refs/worktree/*`, `refs/bisect/*`) exist precisely so that worktree-scoped state does not collide the way the stash stack and branch-checkout lock do. This counterexample does NOT extend to the Main Agent and any non-worktree-isolated agent (`product-docs`, `architect`) — those share the main checkout's single index and single HEAD, which is exactly the fourth enumerated instance above, not a counterexample to it.

**Brief-composition duty.** Before instructing parallel worktree agents to use any named resource, classify it: is it global-and-exclusive (the list above), or per-worktree (the counterexamples above)? If global-and-exclusive, do not instruct parallel agents to use it concurrently — instead serialize the operation, substitute a per-worktree alternative (e.g. worktree-local reversion instead of `git stash`, or a per-branch naming scheme instead of a shared branch name), or move the operation to the Main-Agent integration step where it runs once, singly, on main. **Additionally, whenever a non-worktree-isolated agent (`product-docs`, `architect`) is live in the shared main checkout, the Main Agent must not run any index-committing command (`git cherry-pick --continue`, `git rebase --continue`, `git merge --continue`, or a pathspec-less `git commit` / `git commit -a`) until that agent's own staged work has been committed or is confirmed absent** — staging discipline by the non-worktree agent alone is insufficient, since the hazard does not require the Main Agent to have staged anything itself; the Main Agent's own commit command is what does the swallowing.

**Relationship to T-594 and T-595.** T-594 ("Worktree developers must not run the full suite") is the class's first instance, but for the **non-exclusive contention** variant: the full test suite is a shared resource whose concurrent use degrades performance (cost is time), not one whose concurrent use corrupts or starves (cost is exclusivity itself). T-595's deferred sibling-run-disambiguation machinery does not cover either variant addressed here — it targets identifying which worktree owns a given `run-tests.js` process, a diagnostic aid for the non-exclusive T-594 class, not a serialization mechanism for a global-and-exclusive resource.

**Armed escalation trigger.** If a recurrence of this class (a global-and-exclusive resource collision — stash-pop, branch-checkout contention, or a lock-file contention incident) occurs after this rule has governed at least one parallel wave, activate a PreToolUse interceptor as a developer task — mechanical enforcement replaces the documentation-only defense once the documented rule has been shown, in practice, not to be enough.

## Selection rule after acceptance

Choose the next task in this order:
- unblockers first
- end-to-end value second
- quality/polish third
- docs/process last unless they unblock delivery
