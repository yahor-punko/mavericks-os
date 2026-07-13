# Case study: Synth

*Measured through 13 July 2026.*

## System context

Synth is a production AI-powered Telegram moderation and group-management
system built in Python on the Claude/Anthropic API stack, developed with
Claude Code. It runs on AWS across **20 Git repositories** and **15 active,
deployed Lambda functions**. Mavericks ran the operation from a single
control repository whose central backlog declared 10 of those 20
repositories as task targets, with 19 tasks explicitly naming more than
one repository. The lifecycle figures below (523 commits, 25 waves, 323
tasks) are the control repository's own history; per-repository
implementation commits across the target repos are additional and are
not aggregated into a single total here.

## How coordination worked

Mavericks does not run a copy of itself inside every repository. State is
centralized: one control repository holds the backlog, task-status file,
and process-state artifacts, and each task carries a `Repo:` field naming
its target repository (or repositories, for the subset of tasks that name
more than one). When a task is merged, the control repository's task-status
evidence records a per-repo `commit: <hash> (repo)` line for each
repository the task actually changed, so the control backlog stays the
single, auditable source of truth for *where* work landed even though the
diffs themselves live in the target repositories.

Mavericks ran the Synth operation from a single control repository. Its
central backlog attributes each task to a target repository via a `Repo:`
field: **275 tasks** carry such an attribution, naming **10 of the
system's 20 repositories** as work targets, and **19 tasks** explicitly
target more than one repository. This evidences that delivery across 10
repositories was planned, tracked, and reviewed from one control point. It
is per-task repository attribution held in one central backlog — not an
independently-audited per-commit trail inside each repository. The 523
commits and 25 waves are the control repository's own history;
per-repository implementation commits are additional and are not
aggregated here.

Attribution is uniform across the sample, not a subset: all 275 tasks
carry a `Repo:` field, and the 10-repository set is the complete,
deduplicated list of named targets drawn from every one of those tasks —
there is no separate tier of "strict" evidence limited to a handful of
repositories.

This is the load-bearing claim of this case study: the coordination model
is not a hypothetical extension of a single-repository tool, it is how a
20-repository, 15-active-Lambda production system was actually operated
over the measured window.

## Baseline

Before Mavericks, the control repository recorded work primarily through
Git history.

Across the baseline window (17 September 2024 – 16 April 2026, approximately
19 months) it accumulated 364 commits, with no versioned backlog, explicit
task-state model, repository-level QA gate, or artifact-consistency
validator. Planning context, current state, and decision rationale
therefore lived mostly in the developer's memory and commit messages.

## Mavericks-era execution

Mavericks was adopted on 17 April 2026 and remained in use throughout the
measured window (17 April – 13 July 2026, approximately 12.5 weeks).

The versioned backlog itself — `BACKLOG.md` and `TASK_STATUS.md` — was
introduced together with Mavericks: their first commit, `e66a6ac`, is the
onboarding commit that added the framework. Because there was no earlier
backlog to import historical tasks from, every lifecycle record counted in
this case study belongs to the Mavericks-era window by construction, not
merely by a current-snapshot read of task status.

During that period, the control repository recorded:

- 523 commits in the control repository, plus additional per-repo
  implementation commits across the coordinated repositories (not
  aggregated here);
- 81 close-session checkpoints;
- 25 delivery waves;
- 242 tasks with status `merged`;
- 81 tasks with status `deployed_prod`;
- 36 tasks explicitly marked `deferred`.

At the snapshot date, 323 tasks had therefore reached merge or beyond.

These figures are the control repository's own git and artifact history.
They are not an aggregate across the 10 target repositories — no
single commit total spanning all repositories is claimed anywhere in this
document.

The `main_agent` orchestrator routed work across developer, QA, architect,
security-reviewer, analyst, product-docs, and technical-writer roles rather
than keeping planning, execution, and review within a single undifferentiated
agent context — including dispatch across the repositories declared as
task targets via the `Repo:` field described above.

## What the process surfaced

The control repository's Git history contains at least 18 commits
explicitly dedicated to reconciling drift between backlog and task-status
artifacts, including missing `commit:` fields, stale evidence, and status
mismatches. This shows that inconsistencies were surfaced and repaired
rather than remaining implicit in chat history or repository state.

Five tasks contain recorded security-review evidence before merge.

Among 49 tasks with recorded QA evidence, three required a second
`needs_fix` cycle, and none required a third. This indicates limited repeat
QA churn in the recorded sample; it does not measure tasks without QA
evidence or defects discovered after deployment.

## Observed operational outcome

Across the approximately 12.5-week window:

- 323 tasks reached merge or beyond;
- 275 tasks carried an explicit repository-target field, naming 10 of the
  system's 20 Git repositories as task targets, with 19 tasks explicitly
  targeting more than one repository;
- 81 close-session checkpoints preserved explicit handoff state;
- work was organised across 25 delivery waves;
- 36 deferred tasks remained visible in the delivery system;
- at least 18 artifact-drift corrections were explicitly recorded.

These figures describe activity, coordination reach, and workflow
throughput — not product value or causal productivity. Commits include
process-state updates, and tasks are not normalised for size or complexity.

The stronger observed result is operational continuity and auditability
across a genuinely multi-repository system: project state was versioned in
one place, cross-repository work was dispatched and tracked from that one
place, handoffs were recorded, deferrals remained visible, and drift
corrections were inspectable — instead of depending on chat history, tribal
knowledge, or one operator's memory spread across 20 separate repositories.

## Limitations

This is still an observational, N=1 case study — one operator, one control
backlog, no control group — even though the coordinated work spans the 10
repositories declared as task targets. Coordinating many repositories from
one backlog is not the same as an independently replicated or randomized
comparison.

The before and after windows cover different phases of the same project.
The development toolchain, underlying models, project intensity, and task
mix also changed over time; they were not held constant. The comparison
therefore cannot isolate Mavericks' contribution from developer learning,
changes in Claude Code, model improvements, or a simple increase in work
intensity. The jump in commit rate between the baseline and Mavericks-era
windows is not attributable to Mavericks alone.

Commit counts are activity measures, not proxies for quality, customer
value, or engineering productivity. Tasks are author-defined and are not
normalised for scope or complexity.

The QA and security figures include only tasks with recorded evidence.
Repository artifacts and commit messages are operational records rather
than independent telemetry.

No single aggregate commit count spanning all 10 target repositories
is published in this document — the 523-commit figure is the control
repository's own history, not a cross-repository total, and per-repository
implementation commit counts are not summed here.

Finally, the Mavericks-era window measured here is approximately 12.5 weeks,
which is too short to establish whether the same cadence, coordination
reach, and process quality will hold over a year.

<details>
<summary>Measurement method</summary>

All commands below were run in the control repository this case study
covers, at commit `ea80676`, unless otherwise noted.

- **Commit counts:** `git log --format="%cI" | awk -F'T' '{print $1}' | awk '$1 < "2026-04-17"' | wc -l` → 364 (baseline); `git log --format="%cI" | awk -F'T' '{print $1}' | awk '$1 >= "2026-04-17"' | wc -l` → 523 (Mavericks era). Chosen over `git log --since=`/`--after=` because those flags stop the DAG walk on the first out-of-range commit per parent path and undercount repositories with merge commits (105 merges here); the control repository's full 887-commit history splits exactly as 364 + 523.
- **Task-status counts:** snapshot of the control repository's `BACKLOG.md` at commit `ea80676` — `grep -c '\*\*Status:\*\* merged' BACKLOG.md` → 242; `grep -c '\*\*Status:\*\* deployed_prod' BACKLOG.md` → 81; `grep -c '\*\*Status:\*\* deferred' BACKLOG.md` → 36. This is a current-snapshot read, not a date-range query; it is valid as a full-window count because the versioned backlog was introduced with Mavericks on 17 April 2026 (first commit `e66a6ac`, the onboarding commit that added the framework) with no earlier backlog to import from — so every lifecycle record present in the snapshot belongs to the Mavericks-era window by construction.
- **Session checkpoints:** `git log --oneline --since=2026-04-17 | grep -ic "close session"` → 81 (commit-message pattern matched against the "chore: close session ..." convention).
- **Delivery waves:** the `"wave": 25` field in the control repository's `PROCESS_STATE.json` at commit `ea80676`.
- **Drift-correction commits:** `git log --since=2026-04-17 --format="%s" | grep -icE "validator|drift"` → 18, followed by manual review of each matched subject line to confirm it names an actual backlog/task-status artifact fix (missing `commit:` field, stale evidence, status mismatch) rather than an unrelated mention of the words "validator" or "drift".
- **QA and security evidence:** `grep -c "needs_fix_rounds:" TASK_STATUS.md` → 49 tasks with the field recorded (46 at `0`, 2 at `1`, 1 at `2`); `grep -c '\*\*Owner:\*\* security-reviewer' TASK_STATUS.md` → 5 tasks with recorded security-review ownership.
- **Repository-target attribution (275):** `grep -cE '\*\*Repo:\*\*' BACKLOG.md` → 275 tasks carrying an explicit `Repo:` field.
- **Distinct repository targets (10):** extract every `**Repo:**` field value from `BACKLOG.md`, normalize one known repository-name transcription typo, extract tokens matching the canonical `synth-*` naming pattern (`grep -oE 'synth-[a-z0-9-]+'`), deduplicate, then intersect the result against the canonical list of `synth-*` repository directories → 10 distinct repositories. This is the full deduplicated target list drawn from all 275 attributed tasks, not a subset drawn from the most-active repositories.
- **Multi-repo tasks (19):** `grep -hoE '\*\*Repo:\*\*[^|]*' BACKLOG.md | sed 's/\*\*Repo:\*\*//' | grep -cE ',|\+'` → 19 tasks whose `Repo:` field value names more than one repository.
- **Repositories in the system (20):** count of canonical `synth-*` repository directories in the private control environment, obtained via the same dedup-and-intersect method above rather than by enumerating repository names in this document.

</details>
