---
name: spawn-brief
description: Invoke before composing any sub-agent brief. Holds the brief template with every field (Role, Slice, Goal, Base floor, Test scope, Definition of done, Before exiting) and each field's rule.
user-invocable: true
---

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
Read current main: [optional — set when the task must READ current-main state (e.g. version numbers, files merged earlier this session) OR when the task's own registration commit postdates the session's starting HEAD (true of nearly every task registered this session — its own worktree can't see its contract otherwise); pre-authorizes `git merge --ff-only main` from the worktree root as the sub-agent's first step; harness worktrees branch from a stale base — see docs/core/ORCHESTRATION_RULES.md "Worktree integration — Main Agent". Omit otherwise.]
Base floor: [the target repo's base-branch head hash at spawn time (`git -C <target-repo> rev-parse --short <base-branch>`) — REQUIRED for cross-repo and branch-based-repo worktree spawns, recommended otherwise. The developer runs `git log --oneline HEAD..<floor>` before any edit and quotes the output: empty = proceed, non-empty = stale base (stop), `fatal: Invalid revision range` = wrong repo (stop). Harness worktree base AND placement are untrusted — see docs/core/ORCHESTRATION_RULES.md "GAP C"/"GAP E". When `Read current main:` is also set, the ff-merge runs first and this check second. Omit only when neither condition applies; when omitted the developer proceeds as today.]
Model: [opus | sonnet]     # optional — only include when escalating a worker away from its sonnet default; see docs/AGENT_SPEC.md — Model selection
Effort: [medium | high | xhigh | max]   # optional — only include when deviating from the session default; see docs/AGENT_SPEC.md — Effort selection
Turn budget: [role's maxTurns from docs/AGENT_SPEC.md's per-role table]   # optional override/retry channel — most roles now self-state their budget in their own spec (see docs/AGENT_SPEC.md — "Budget awareness"); fill this on a retry after a cap-hit, or when deviating from the role's own stated number; see docs/core/ORCHESTRATION_RULES.md — "Cap-hit triage"
Test scope: [worktree developer only — seed a `node scripts/run-tests.js --filter <fragment>` baseline; before seeding, confirm the fragment substring-matches the basenames of the test files the task is expected to add or touch (a filename-level check, no execution needed), and prefer the widest subsystem fragment over the most specific script name — a too-narrow fragment misses sibling coverage (T-680: `publish-release` vs the wider `publish`) or excludes the task's own new test file entirely (T-679: `install` could not match `test-wrapper-*`, so it never ran in the worktree); the developer extends the seeded fragment with its own test files and grep-derived coverage and reports the delta; marked corpus-wide guard tests run automatically with any `--filter` and must not be seeded; never instruct the full suite in a worktree — see docs/core/ORCHESTRATION_RULES.md — "Test-execution scope (worktree developers)"]
Scratch dir: [optional — set whenever the brief names scratch files or asks for probes, fuzzers or throwaway scripts: a per-task directory such as <session scratch root>/T-NNN/, never the shared session scratch root, which parallel sub-agents overwrite — see docs/core/ORCHESTRATION_RULES.md "Repository-global exclusive resources"]
Frame set: [ux product-surface reviews only — path of the frame-set index taken at commit <hash>; see "Frame set" below]
Reviewing as: [ux product-surface reviews only — who sees the screen and when]
Files to modify: [explicit list, repo-relative paths only — never absolute: an absolute path points a worktree agent at the shared main checkout instead of its own worktree (GAP D, docs/core/ORCHESTRATION_RULES.md "Worktree integration — Main Agent")]
What NOT to change: [boundaries — other files, other tasks]
Definition of done: [acceptance criteria verbatim from BACKLOG.md]
Report back: changed files + line ranges, confirmation criteria met, any blockers
Before exiting: commit all changes with a meaningful message, then end your final report with the completion token — literal last line, `MAVP_REPORT role=<role> task=<T-NNN|n/a> verdict=<done|blocked|needs_fix|pass|fail>` — see `docs/AGENT_SPEC.md` — "Report completion token".
```
