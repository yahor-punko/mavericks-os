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

**Wave-end requirement:** when the last task in a wave is marked `merged`, a `git push` (or equivalent publish step) is required before the wave is considered closed. Mid-wave merges may defer push until wave close, but the push must happen before opening the next wave. Use `--close-session` — in interactive mode (TTY) it prompts for push when all active tasks are merged; in non-interactive/headless mode it prints a "Wave complete — run git push to close the wave" reminder instead of prompting. Use `--interactive` to force the prompt even in headless contexts.

**Wave-close sweep:** `--close-session` sweeps two distinct sets out of TASK_STATUS.md's `## Active tasks` section before computing wave completion:
- **Terminal-completed** — `merged`, `deployed_dev`, `deployed_prod`, `runtime_verified` → moved to `## Recently completed tasks`.
- **Terminal-skip** — `deferred` → moved to `## Deferred tasks` (created on demand); `deprecated` → moved to `## Recently completed tasks`. Neither counts as completed work, but neither blocks the wave either.

**Fail-closed rule:** an unrecognized status holds the wave open — this is deliberate. A wave that will not close is a visible problem; a wave that closes over unfinished work is invisible. Mechanically, only the two sets above are ever swept, so `planned`, `qa_passed`, any in-flight status (`in_progress`, `needs_fix`, `ready_for_qa`, etc.), and any status the sweep doesn't recognize all remain in `## Active tasks` and keep the wave open.

**Version bump requirement:** before closing a wave (before `git push`), check whether `scripts/mavp-version.js` needs a bump:
- **patch** (`0.3.x → 0.3.y`) — any wave that changed scripts, the validator, or the installer
- **minor** (`0.3.x → 0.4.0`) — any wave that added a new framework capability (new command, new agent type, new operator surface)
- **no bump** — waves that only changed process docs, templates, or project artifacts (BACKLOG, TASK_STATUS, PROCESS_STATE)

If unsure: check `git diff main --name-only` for files under `scripts/` — any match means at minimum a patch bump.

## Session close vs wave close

`--close-session` runs every session, but only some closes advance the wave. Confusing "a session closed" with "the wave rolled over" leads to wrong assumptions about `wave`/`wave_session` and about what still lives in `## Active Wave`.

**Wave-increment trigger:** the `wave` counter in `PROCESS_STATE.json` only increments when, after this `--close-session` run, TASK_STATUS.md's `## Active tasks` section is empty — every task has left it (merged/deployed or otherwise archived out). As of T-445 this check (`buildWaveCompletionAnnouncement()` in `scripts/mavp-operator-close-session.js`) is identical in interactive and non-interactive mode, so the same underlying state always produces the same wave-complete decision regardless of which mode ran the close. A close that leaves any task in-flight does not touch `wave`.

**`wave_session` counter:** counts how many `--close-session` runs have happened inside the current wave. It increments by 1 on every close that does not complete the wave, and resets to 1 the moment the wave advances. It feeds the `RENAME_SESSION: W{wave}[S{wave_session}] — T-xxx, ...` label so multiple sessions inside one wave get distinct, ordered names.

**Merged-task residency:** a task reaching `merged` (or `deployed_dev`/`deployed_prod`) moves out of TASK_STATUS.md's `## Active tasks` into `## Recently completed tasks` on the very close-session run that observes the terminal status — not only once the wave completes. The matching BACKLOG.md block moves out of `## Active Wave` into that wave's `## Wave N — Archived (mid-wave)` section on the same run, via the same archival function (`archiveMergedTasksFromActiveWave()` in `scripts/mavp-operator-lib.js`) that `--archive-merged` calls directly. So a merged task's residency in `## Active Wave` ends at the next `--archive-merged` run or the next `--close-session` run, whichever comes first — it does not wait for the wave itself to close. Only the `## Active Wave` *heading* (renamed to `## Wave N — Archived`) and the `wave`/`wave_session` counters wait for wave completion.

**`--archive-merged` mid-wave role:** runs that same archival step on demand, without the rest of the close-session ritual (no validator-gated commit, no wave-increment logic, no session-completed table). Use it to keep BACKLOG.md's Active Wave section lean mid-session when several tasks have merged but the wave itself is far from done. `--close-session` still surfaces titles archived this way in `wave_summary` and its results table once the wave eventually closes (`parseMidWaveArchivedTasks()`).

**Wave-completion announcements (T-445):** every close-session run prints one of two lines from a shared core, built by the same function in both modes so identical state always produces identical messaging (non-interactive mode also prints an additional advisory — see below):
- `Wave N complete — archiving + incrementing` — the Active tasks section emptied this run; the wave counter advances and the Active Wave heading is archived.
- `Wave N stays open — T-NNN still <status>, ...` — names each task still remaining in Active tasks, so a non-advancing close is never a silent, unexplained no-op.

**Shipped-but-unbooked advisory (T-637):** in non-interactive mode only, close-session additionally prints one advisory line per task that sits at `qa_passed` whose Evidence `commit:` hash is already reachable from HEAD — shipped, but not yet booked into the ritual. The status guard is checked before any reachability check, so `dev_done` and `ready_for_qa` never qualify even when their hash is reachable — firing on them would route around QA. The advisory is propose-only: it prints and never writes `TASK_STATUS.md`, `BACKLOG.md`, or `PROCESS_STATE.*`; the operator books the task by hand via `./scripts/mavp-operator --set-status <id> merged`. Two stand-downs: a shallow clone prints a named stand-down line that deliberately carries no `--set-status` text (so it can never be misread as a proposal), and when git is unavailable the check is silent — no line at all. It complements, never replaces, the `Wave N stays open` line above, which still prints unchanged directly above it. The propose-only and stand-down-is-not-a-proposal properties are test-enforced by `scripts/test-close-session-shipped-unbooked.js`.

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
