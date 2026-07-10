# Operator Dashboard — Panel Reference

`./scripts/mavp-operator` renders a multi-panel terminal dashboard that gives a full view of the current project state. This document describes every panel shown, including the two observability panels added in Wave 37 (T-238 and T-239).

## How to open

```bash
./scripts/mavp-operator          # one-shot render
./scripts/mavp-operator --watch  # auto-refresh; press r to refresh manually, s for snapshot, q to quit
```

## Panel layout

The dashboard renders in four sections from top to bottom.

### Row 1 (two columns)

**Current State** (left) — initiative, wave, active task, owner, next handoff, and a compact intervention summary when any blocker or approval is pending.

**Waits & Blockers** (right) — all tracked wait states, sorted by severity then age. When any item has severity >= 3 the panel title changes to `Waits & Blockers — ACTION NEEDED (N)` and the border turns red.

### Row 2 (two columns)

**Runtime Actors** (left) — each agent or sub-agent session with its status badge, role, current task, and parent/child nesting. Completed actors are visually demoted when intervention-needed items exist.

**Recent Movement** (right) — newest-first list of completions, handoffs, and state transitions. Visually softened when blockers are present (the title appends `— secondary context`).

### Row 3 — Wave Tasks panel

**Wave N Tasks** — all tasks assigned to the current wave, one per line. Shows at most 10 tasks; additional tasks are summarised as `+N more`.

Status badges per task row:

| Badge | Meaning |
|---|---|
| `✓` (green) | Task is `merged` |
| `●` (cyan) | Task is active — any status between `in_progress` and `qa_passed` |
| `○` (dim) | Task is `planned` |

The panel header reads `Wave N — X tasks`. Each task row shows the badge, task ID, title (truncated at 45 characters), and status label.

### Row 4 — Agent Trajectories panel

**Agent Trajectories** — per-role quality statistics derived from the trajectory store at `.mavp/trajectories/*.jsonl`. One row per role with data.

Example output:

```
developer      92% ██████████  n=50 ok=46  fixes:3  blocked:1
qa             75% ████████░░  n=20 ok=15
product-docs   60% ██████░░░░  n=10 ok=6   fixes:2
```

Column definitions:

| Column | Definition |
|---|---|
| `N%` + bar | Success rate (percentage of tasks with `score >= 0.7`). Green >= 80%, yellow >= 50%, red below 50%. Bar is 10 blocks wide (one block = 10%). |
| `n=` | Total tasks recorded for this role in the trajectory store. |
| `ok=` | Tasks whose score reached the success threshold (score >= 0.7). |
| `fixes:N` | Count of tasks where `needsFixCount > 0` — tasks that required at least one QA needs-fix round-trip before passing. Only shown when N > 0. |
| `blocked:N` | Count of tasks where `validatorExitCode === 2` or `validator_blocked: true` — tasks that had a commit blocked by the validator. Only shown when N > 0. |

**When is a task considered successful?** A task scores >= 0.7 when it passed QA on the first attempt (score 1.0) or passed after a single needs-fix round-trip (score 0.7 base). Additional needs-fix cycles, validator blocks, and scope-deviation flags each lower the score. The full scoring formula is defined in `docs/SKILL_OPTIMIZATION.md` Section 4.

**When is this panel hidden?** The panel is omitted entirely when the `.mavp/trajectories/` directory does not exist or contains no `.jsonl` files with parseable records.

## Footer

```
r refresh • s snapshot • q quit • updated <age> • sessions:<status> • tasks:<status>
```

`sessions:ok` / `sessions:—` indicates whether the live session source was reachable. `tasks:ok` / `tasks:—` indicates whether TASK_STATUS.md was parsed successfully.
