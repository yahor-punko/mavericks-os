# Task lifecycle

## States

- `planned`
- `in_progress`
- `dev_done`
- `ux_review` _(optional — only if `requires_ux: true`)_
- `ux_needs_fix` _(optional)_
- `ux_passed` _(optional)_
- `security_review` _(optional — only if `requires_security_review: true`)_
- `security_needs_fix` _(optional)_
- `security_passed` _(optional)_
- `ready_for_qa`
- `qa_in_progress`
- `qa_passed`
- `needs_fix`
- `merged`
- `deployed_dev` _(optional — code is running in the dev/staging environment)_
- `deployed_prod` _(optional — code is running in production)_
- `deferred` _(optional — task parked indefinitely; see below)_
- `deprecated` _(optional — task rejected permanently; see below)_

## Standard flow

```
planned → in_progress → dev_done → ready_for_qa → qa_in_progress → qa_passed → merged
                                                                  ↘ needs_fix ↗
```

## Flow with deploy contours (optional)

Projects that track actual deployment state can extend the standard flow with two optional terminal statuses after `merged`:

```
... → merged → deployed_dev → deployed_prod
```

These statuses are optional. Projects without explicit deploy contours stay on `merged` as their final state.

A task whose deliverable reaches users outside any deploy contour (for example an adopter's catalog-distributed plugin) can declare the BACKLOG-only field `- **Deploy:** none`; it is then excluded from every deploy-pending surface (`deploy_queue`, the pending-deploy lists in `--snapshot`, the dashboard and the new-task warnings, and the close-session deploy label reads `— без деплоя`) at any `deploy_contours` value. The field is reporting-only: it never gates a transition, and `Hold:` (time-bounded) and `Prod prerequisites:` (what a deploy needs) remain distinct.

## Flow with UX review (requires_ux: true)

```
planned → in_progress → dev_done → ux_review → ux_passed → ready_for_qa → qa_in_progress → qa_passed → merged
                                             ↘ ux_needs_fix ↗                            ↘ needs_fix ↗
```

## Flow with security review (requires_security_review: true)

```
planned → in_progress → dev_done → security_review → security_passed → ready_for_qa → qa_in_progress → qa_passed → merged
                                                   ↘ security_needs_fix ↗                           ↘ needs_fix ↗
```

## Meaning

### planned
Task exists but work has not started.

### in_progress
Active implementation is underway.

### dev_done
Developer slice is complete and awaiting orchestrator review.

### ux_review
Orchestrator routed the slice to UX sub-agent for review. Only applies to tasks marked `requires_ux: true`.

### ux_needs_fix
UX sub-agent found issues. Task returns to developer with a concrete list of changes required.

### ux_passed
UX sub-agent reviewed the slice and found no issues. Transitions to `ready_for_qa` — UX does not accept its own work into `merged`.

### security_review
Orchestrator routed the slice to security-reviewer sub-agent for review. Only applies to tasks marked `requires_security_review: true`.

### security_needs_fix
Security-reviewer sub-agent found issues. Task returns to developer with a concrete list of changes required.

### security_passed
Security-reviewer sub-agent reviewed the slice and found no issues. Transitions to `ready_for_qa` — security-reviewer does not accept its own work into `merged`.

### ready_for_qa
Orchestrator (and UX if applicable) reviewed the slice and considers it coherent enough for QA.

> **QA is a stage on the implementation task, not a separate backlog task.**
> Anti-pattern: creating a standalone QA task (e.g. "T-155 — QA for T-153 and T-154") that validates sibling implementation tasks. This leaves the implementation tasks stuck at `dev_done` indefinitely, creating false "unresolved QA" signal in the backlog.
> Correct model: QA transitions (`dev_done → ready_for_qa → qa_passed`) happen on the implementation task itself.
> Escape hatch: if a multi-task integration QA pass is genuinely needed, implementation tasks must declare `- **Depends on:** T-NNN` (the integration QA task) and the Main Agent promotes them together after QA passes. The QA result does not auto-propagate — each task must receive its own status update.

### qa_in_progress
QA is actively reviewing the slice.

### qa_passed
QA accepted the slice.

**Held/waiting state (DR-005)** — a task can sit at `qa_passed` for a long time when it declares `- **Blocked by:** <repo>/T-NNN` and that blocker is not yet `merged`. This is not stalled work and not a validator violation: the task owner finished their side and is correctly waiting on someone else's. The validator's `blocked_by_open` check reflects this directly in its severity tier: `qa_passed` (and `ready_for_qa`) with an unmerged blocker is WARNING (exit 1 at worst, never blocks a commit); only `merged` with an unmerged blocker is FAILURE (exit 2) — that is the actual violation, shipping ahead of an unmet dependency. Do not read a `qa_passed` task with an open `Blocked by:` relation as broken; read it as deliberately held. An optional `Hold:` field (naming what is held, why, and since when) is accepted by DR-005 for surfacing this more explicitly, but is not yet implemented as of T-487 — see `docs/core/DECISIONS.md` DR-005.

### needs_fix
QA or orchestrator found issues that require rework.

### merged
Task is accepted and integrated. Code or artifact is complete and verified. For projects without explicit deploy contours, this is the final state.

### deployed_dev
_(Optional)_ Code is deployed and running in the development or staging environment. Use this when your project tracks deploy state separately from merge state.

### deployed_prod
_(Optional)_ Code is deployed and running in the production environment. This is the final terminal state for projects with explicit deploy contours.

### `runtime_verified` (optional)

Applies to tasks with `verification_type: runtime`. Signals that the runtime behavior was confirmed in a live environment after merge — the script executed without errors and output matched expectations.

This status is optional. Tasks may remain at `merged`. Use `runtime_verified` when you want explicit evidence that the runtime check was performed post-deployment.

Distinguished from `deployed_dev`/`deployed_prod`: those track deployment state. `runtime_verified` tracks behavioral confirmation.

### deferred
_(Optional)_ Task is parked indefinitely — it is not active but may re-enter the backlog. When a task is set to `deferred` in BACKLOG.md, its entry moves to the `## Deferred Tasks` section. Use `--rescope-task --status deferred` to relocate the TASK_STATUS.md entry to the `## Deferred tasks` section mechanically — hand-moving it is how duplicate entries get created. The validator does not raise `missing_in_backlog` for tasks with `deferred` status in TASK_STATUS.md — they are skipped even if absent from the active backlog set.

### deprecated
_(Optional)_ Task is rejected permanently — as opposed to `deferred`, which may return, a `deprecated` task will never be done. Tasks with `deprecated` status skip `missing_in_backlog` and `missing_in_task_status` validator checks, require no evidence, and do not appear in active counts.

**Before deprecating a defect task on "cannot reproduce":** do not trust the present-tense artifact alone. The Main Agent first reads the artifact at the task's in-flight commits (`git show <hash>:<file>`, or `git log -p` over the region) and asks what the consumer of that artifact actually reads, because a defect gated behind a status the consumer filters on is invisible in the present tense while still live. T-558 is the case: a defect measured absent in the current artifact was live, since the accretion had been hand-collapsed in the same commit that set the task to `merged`, and the consumer filtered on that status. The measurement goes to the architect, not straight to a deprecation; deprecating a defect task on the strength of "not in the current artifact" is the failure this paragraph exists to prevent.

**Wave-end requirement:** a `git push` (or equivalent publish step) is owed at the end of every session in which tasks reached `merged`, and it must be complete — with CI green on the pushed commit — before the next task is registered. This is a per-session contract, not a per-wave one: advancing the wave is a separate step (see "Session close vs wave close" below). Use `--close-session` — in interactive mode (TTY) it prompts for push when all active tasks are merged; in non-interactive/headless mode it prints the reminder `` All tasks merged — run `git push` to publish this session `` instead of prompting. Use `--interactive` to force the prompt even in headless contexts.

**Wave-close sweep:** `--close-session` sweeps two distinct sets out of TASK_STATUS.md's `## Active tasks` section before reporting whether any work remains in the wave:
- **Terminal-completed** — `merged`, `deployed_dev`, `deployed_prod`, `runtime_verified` → moved to `## Recently completed tasks`.
- **Terminal-skip** — `deferred` → moved to `## Deferred tasks` (created on demand); `deprecated` → moved to `## Recently completed tasks`. Neither counts as completed work, but neither blocks the wave either.

**Fail-closed rule:** an unrecognized status holds the wave open — this is deliberate. A wave that will not close is a visible problem; a wave that closes over unfinished work is invisible. `--close-wave` enforces the same thing from the other side: it refuses while anything remains in `## Active tasks`. Mechanically, only the two sets above are ever swept, so `planned`, `qa_passed`, any in-flight status (`in_progress`, `needs_fix`, `ready_for_qa`, etc.), and any status the sweep doesn't recognize all remain in `## Active tasks` and keep the wave open.

**Version bump requirement:** before any `git push` that carries ship-classified changes, check whether `scripts/mavp-version.js` needs a bump:
- **patch** (`0.3.x → 0.3.y`) — any push that carries changes to scripts, the validator, or the installer
- **minor** (`0.3.x → 0.4.0`) — any push that carries a new framework capability (new command, new agent type, new operator surface)
- **no bump** — pushes that only change process docs, templates, or project artifacts (BACKLOG, TASK_STATUS, PROCESS_STATE)

If unsure: check `git diff main --name-only` for files under `scripts/` — any match means at minimum a patch bump. The trigger is the push, never the wave: advancing the wave with `--close-wave` does not require, perform or imply a bump, and a bump never waits for a wave to close.

## Session close vs wave close

`--close-session` runs every session and never advances the wave; the wave advances only through `--close-wave`, when the operator confirms the wave's goal is met. In plain terms: finishing every task does not close a wave — a person decides that the goal was reached. Confusing "a session closed" or "every task is merged" with "the wave rolled over" leads to wrong assumptions about `wave`/`wave_session` and about what still lives in `## Active Wave`.

**Wave-increment trigger:** the `wave` counter in `PROCESS_STATE.json` only increments when `--close-wave` succeeds — never in `--close-session`, and never merely because TASK_STATUS.md's `## Active tasks` section is empty. As of T-445 the announcement check (`buildWaveCompletionAnnouncement()` in `scripts/mavp-operator-close-session.js`) is identical in interactive and non-interactive mode, so the same underlying state always produces the same message regardless of which mode ran the close; as of T-820 that message only describes the task list and changes nothing.

**`--close-wave` (T-820):** the only path that advances the wave. Two confirmation paths, chosen by the same mode rule `--close-session` uses (a TTY or `--interactive` → terminal path; otherwise agent path):
- **Terminal path** — prints the wave goal, the wave summary, the suite receipt and the git ahead/behind line, then requires the operator to TYPE the wave number. Any other answer aborts with nothing written. It then asks for the next wave's goal (Enter leaves it unset) and for a `git push` [Y/n].
- **Agent path** — requires `--operator-confirmed "<the operator's exact statement>"` with a non-empty value; `--next-goal "text"` is optional. No prompts and no push — it prints a `git push` reminder. The agent-side rule for when the flag may be used lives in CLAUDE.md ("Wave advance confirmation") and `docs/core/ORCHESTRATION_RULES.md` ("Wave advance confirmation — agent-side rule").

Four refusals, each exit 1 with `PROCESS_STATE.json`, `BACKLOG.md` and `TASK_STATUS.md` untouched; the first applies to the agent path only, the other three to both paths:
- (a) the agent path without `--operator-confirmed`, or with an empty value: `--close-wave needs operator confirmation. At a terminal: run ./scripts/mavp-operator --close-wave yourself and type the wave number. From an agent session: pass --operator-confirmed "<the operator's exact statement from this session>" — only on an explicit operator statement that the wave's goal is met; never inferred from "all tasks merged".`
- (b) any entry still in TASK_STATUS.md's `## Active tasks`: `--close-wave refused — wave N still has entries in TASK_STATUS.md's Active tasks:`, one `T-NNN still <status>` line each, and "Sweep finished work out of Active tasks with --close-session, then re-run --close-wave."
- (c) `wave_goal` is null while the wave is not listed in `parked_waves`: `--close-wave refused — wave N has no wave_goal and is not listed in parked_waves, so there is nothing to confirm as met.` Record a goal with `--set-wave-goal "<goal>"` and re-run; a parked wave waives the goal requirement.
- (d) validator exit 2: `--close-wave refused — validator exit 2 (repair required); nothing was changed.` followed by the validator report.

On success it archives the Active Wave heading (renamed `## Wave N — Archived`), increments `wave`, resets `wave_session` to 1, clears `wave_goal` and the wave strategy note, resets `wave_status` to `planning`, and writes `wave_summary`. It commits tracked changes (`git add -u`) as `chore: close wave N`, with the trailers `Operator-Confirmed:` (the operator's statement, or `typed at terminal`) and `Wave-Goal:` (the goal, or `parked — <reason>`). It then prints the line for the Main Agent to paste into `EXECUTION_LOG.md`: `wave close: W<N> → W<N+1> — goal: "..." — operator-confirmed: "..." — close commit <hash>`. The hash is deliberately bare — never the evidence-key form, which the validator would read as a task's own commit. `--close-wave` never pushes by itself: the terminal path asks, the agent path prints `` Run `git push` to publish the wave close ``.

**`--set-wave-goal` (T-819):** `./scripts/mavp-operator --set-wave-goal "text"` is the non-interactive way to record `wave_goal` (an empty string clears it; a missing argument exits 1 before anything is read or written). It exists because a non-interactive `--close-session` never prompts for a goal, so the goal was routinely left null — and `--close-wave` refuses while it is null.

**`wave_session` counter:** the number of the session that is open now — the ordinal of the current session inside the wave, not a count of closes already run. `--close-wave` sets it to 1, so the first session of the new wave starts at 1; `--close-session` on session N writes N+1 (`updateProcessStateJson()` writes `waveComplete ? 1 : prev + 1`, and both `--close-session` call sites pass `waveComplete=false`), so the next session start renders N+1. It feeds the `RENAME_SESSION: W{wave}[S{wave_session}] — T-xxx, ...` label so multiple sessions inside one wave get distinct, ordered names; the label uses the value read before that write, which is the closing session's own number. The value falls one behind the real session count in two shipped ways: a `--close-session` whose validator exited 2 skips the PROCESS_STATE mutation (printing `PROCESS_STATE mutation SKIPPED`) and was not re-run after repair, and a session ended with `--handoff` only, or without any close. Nothing resyncs it afterwards — hand-edit the `wave_session` field in `PROCESS_STATE.json` once to correct it.

**Merged-task residency:** a task reaching `merged` (or `deployed_dev`/`deployed_prod`) moves out of TASK_STATUS.md's `## Active tasks` into `## Recently completed tasks` on the very close-session run that observes the terminal status — not only once the wave completes. The matching BACKLOG.md block moves out of `## Active Wave` into that wave's `## Wave N — Archived (mid-wave)` section on the same run, via the same archival function (`archiveMergedTasksFromActiveWave()` in `scripts/mavp-operator-lib.js`) that `--archive-merged` calls directly. So a merged task's residency in `## Active Wave` ends at the next `--archive-merged` run or the next `--close-session` run, whichever comes first — it does not wait for the wave itself to close. Only the `## Active Wave` *heading* (renamed to `## Wave N — Archived`) and the `wave`/`wave_session` counters wait for `--close-wave`.

**`--archive-merged` mid-wave role:** runs that same archival step on demand, without the rest of the close-session ritual (no validator-gated commit, no wave-increment logic, no session-completed table). Use it to keep BACKLOG.md's Active Wave section lean mid-session when several tasks have merged but the wave itself is far from done. `--close-session` still surfaces titles archived this way in its results table, and `--close-wave` in `wave_summary`, once the wave eventually closes (`parseMidWaveArchivedTasks()`).

**Wave-completion announcements (T-445):** every close-session run prints one of two lines from a shared core, built by the same function in both modes so identical state always produces identical messaging (non-interactive mode also prints an additional advisory — see below). Neither line changes any state; both are quoted here exactly as `buildWaveCompletionAnnouncement()` prints them:
- `Wave N — all tasks merged; wave stays open until the operator confirms the goal is met and --close-wave runs (goal: <goal>)` — the Active tasks section emptied; `<goal>` is the recorded `wave_goal`, or `not set`. It is a statement about the task list, not a decision: the wave counter does not move and the Active Wave heading is not archived. When this line prints, the push line follows — non-interactive: `` All tasks merged — run `git push` to publish this session `` (followed by the CI-check reminder); interactive: `All tasks merged. The wave stays open until --close-wave.` and the `git push` [Y/n] prompt.
- `Wave N stays open — T-NNN still <status>, ...` — names each task still remaining in Active tasks, so a non-all-merged close is never a silent, unexplained no-op.

**Shipped-but-unbooked advisory (T-637):** in non-interactive mode only, close-session additionally prints one advisory line per task that sits at `qa_passed` whose Evidence `commit:` hash is already reachable from HEAD — shipped, but not yet booked into the ritual. The status guard is checked before any reachability check, so `dev_done` and `ready_for_qa` never qualify even when their hash is reachable — firing on them would route around QA. The advisory is propose-only: it prints and never writes `TASK_STATUS.md`, `BACKLOG.md`, or `PROCESS_STATE.*`; the operator books the task by hand via `./scripts/mavp-operator --set-status <id> merged`. Two stand-downs: a shallow clone prints a named stand-down line that deliberately carries no `--set-status` text (so it can never be misread as a proposal), and when git is unavailable the check is silent — no line at all. It complements, never replaces, the announcement line above, which still prints unchanged directly above it. The propose-only and stand-down-is-not-a-proposal properties are test-enforced by `scripts/test-close-session-shipped-unbooked.js`.

## Task types

By default every task is an implementation task — a developer sub-agent produces code or config, the orchestrator routes through QA, and the task reaches `merged`. Two specialised types exist for cases that do not fit this pattern.

### `exploration` — research-first tasks

Use `- **Type:** exploration` when the correct implementation approach is unknown before investigation.

**Required fields:**

```
- **Type:** exploration
- **Output doc:** docs/path/to/findings.md
- **Owner role:** main_agent
- **Verification type:** artifact
```

The validator warns when an `exploration` task is missing the `Output doc:` field.

**Research-first convention**

When a task's solution is unknown upfront — for example, a bug whose root cause must be diagnosed before picking a fix — the correct pattern is:

1. Create an `exploration` task with the fields above. The main_agent reads code, runs analysis, and writes the findings document.
2. Once the findings document captures the root cause and a recommended approach, create a follow-up implementation task that references the findings doc.
3. The implementation task proceeds through the normal lifecycle (`planned → in_progress → dev_done → … → merged`).

**Why not mark the task `owner: architect` as a workaround?** Architect is the pre-task decomposition role — it scopes work before tasks are registered. Using it as an investigator on an active backlog task is a semantic mismatch and leaves the task without a clear owner for the implementation follow-up.

**Example (from example-project T-180 / spam-in-digest-buffer incident):**

A bug appeared where spam messages entered the digest buffer. The fix was non-obvious. Correct procedure:
- Register `T-N — Investigate spam messages in digest buffer` as `Type: exploration`, `Output doc: docs/spam-digest-analysis.md`.
- Main agent investigates, writes findings.
- Register `T-N+1 — Fix: exclude spam from digest buffer` as a normal implementation task citing the analysis doc.

This keeps both the investigation and the implementation visible as distinct backlog items with proper evidence trails.

**Verification:** `exploration` tasks use `verification_type: artifact`. QA is satisfied when the output doc exists and the validator is healthy. No code change or QA sub-agent pass is required.

## Verification types

Each task in BACKLOG.md must declare a `verification_type`:

| Type | Meaning | QA gate |
|---|---|---|
| `artifact` | validator or diff check confirms correctness | automated — validator output is sufficient |
| `runtime` | script or build must execute AND produce a stated, observable output for a known input (a behavioral assertion) | automated — run the command, capture output, and check the observable result against the known input/expected-output pair, not just exit status |
| `visual` | UI or rendered output must be reviewed by a human | **manual only** — `qa_passed` requires explicit user confirmation; build passing is not sufficient |
| `manual` | human review of non-visual output (e.g. copy, UX flow) | manual — orchestrator reviews and confirms |

**Visual QA rule:** a task with `verification_type: visual` must not receive `qa_passed` based on build success alone. The user must explicitly confirm: "I reviewed T-XXX — looks correct." Record this confirmation as evidence in TASK_STATUS.md before setting `qa_passed`.

**Runtime QA rule — behavioral assertion required:** acceptance criteria for a `verification_type: runtime` task MUST state a behavioral assertion: a known input and the expected observable output that input must produce. "Script executes without error" or "exit code 0" alone is a structural check and is not sufficient.

- **Concrete example:** for a spam-classifier inference script, the criterion must read "given known-spam message X, the model classifies it `spam`; given known-ham message Y, the model classifies it `ham`" — not "the script runs and returns an output tensor."
- **Anti-pattern this rule closes:** a degenerate ONNX spam-classification model reached production because its acceptance check asserted only that inference produced a tensor of the correct shape (`[1,128]` in → `[1,2]` out). The shapes were correct on every input, but the model had collapsed to a constant output and never actually separated spam from ham. Structure-only checks (tensor shape, exit code, "no exception thrown") cannot catch this class of defect — only a behavioral assertion tied to a known input/expected-output pair can.

## Transition rules

- A task should not silently jump from development to merge if it entered QA. The QA path should remain visible in project artifacts.
- UX review is skipped unless the task explicitly has `requires_ux: true` in the backlog.
- UX sub-agent does not accept its own work — `ux_passed` transitions to `ready_for_qa`, not `merged`.
- Security review is skipped unless the task explicitly has `requires_security_review: true` in the backlog.
- Security-reviewer sub-agent does not accept its own work — `security_passed` transitions to `ready_for_qa`, not `merged`.
- Sub-agents do not self-approve QA — `qa_passed` is set by the Main Agent after reviewing evidence.

## Evidence format

All evidence fields use the format `key: value` (lowercase key, colon-space separator).

Required when `merged`:
- `commit: <git-hash>` — the commit hash that delivers this task

Optional fields:
- `branch: <branch-name>` — branch merged (e.g. `main`, `develop`)
- `manual_changes: <description>` — any operations performed outside version control

For cross-repo tasks (declared with `- **Repos:** repo-a, repo-b`):
- One evidence line per repo: `commit: <hash-a> (repo-a)` and `commit: <hash-b> (repo-b)`

Common mistake: writing `Commit abc1234` (capitalized, no colon) instead of `commit: abc1234` — the validator will reject the capitalized form and emit `merged_missing_commit_field`.

## BACKLOG.md and TASK_STATUS.md duplication contract

`BACKLOG.md` and `TASK_STATUS.md` are complementary artifacts. They share a minimal set of fields (the mirror contract) and each owns fields the other does not.

### What MUST mirror (kept in sync by validator + operator commands)

| Field | BACKLOG.md | TASK_STATUS.md |
|---|---|---|
| Task heading | `### T-NNN — <title>` | `### T-NNN — <title>` |
| Status | `- **Status:** <value>` | `- **Status:** <value>` |
| Owner role | `- **Owner role:** <value>` | `- **Owner role:** <value>` |
| Verification type | `- **Verification type:** <value>` | `- **Verification type:** <value>` |

Status, owner role, and verification type must be identical in both files at all times. The validator enforces this — status mismatches block commits (exit code 2).

### What belongs only in BACKLOG.md

- Problem statement, acceptance criteria, proposed solution
- `Depends on`, `Requires ux`, `Requires security review`, `Repo`, `Touches`, `Priority`
- Wave assignment (the task lives under `## Active Wave — Wave N`)

### What belongs only in TASK_STATUS.md

- `Last verified by` — who last ran QA or verification
- `Evidence` — commit hash, branch, test output, any verification artifact
- `Notes` — context notes, fix history, reviewer observations

### Avoiding the mirror-edit race

The PostToolUse hook runs `scripts/mavp-operator-sync-status.js` after every `BACKLOG.md` edit, and that script rewrites `TASK_STATUS.md` on disk (status field, heading title, and skeleton-entry creation — see the **Mirror rule** convention in the root `CLAUDE.md` for the exact scope). If an agent already holds an in-memory read of `TASK_STATUS.md` from before that rewrite, its next edit to that file can fail with a "modified since read" error, because the file changed underneath it.

Workflow to avoid this:

1. **Edit `BACKLOG.md` first.** Let the PostToolUse hook's auto-sync run and settle before touching `TASK_STATUS.md`.
2. **Re-read `TASK_STATUS.md`** immediately before editing any of its non-status fields (`Notes`, `Evidence`, `Last verified by`) — never reuse a read taken before the BACKLOG edit.
3. **Prefer the atomic ritual commands** — `--set-status`, `--update-status`, `--rename-task` — over hand-editing both files. These commands read-modify-write both artifacts in a single pass and are immune to the race by construction.

### Option (a) — append-only evidence journal — is out of scope

Collapsing TASK_STATUS.md into a pure evidence journal (moving all source-of-truth to BACKLOG.md) would require changing the mirror-rule invariant, the validator, and all operator surfaces. This is a separate architectural decision and is explicitly excluded from the current design.

### Tool support

`--new-task` and `--quick-task` automatically write matching stubs to both files when a task is created. You do not need to edit TASK_STATUS.md by hand for new tasks. The minimal stub format is:

```
### T-NNN — <title>
- **Status:** planned
- **Owner role:** <owner_role>
- **Verification type:** <verification_type>
- **Last verified by:** —
- **Evidence:** —
```
