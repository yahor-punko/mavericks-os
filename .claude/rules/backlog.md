---
paths:
  - "BACKLOG.md"
  - "TASK_STATUS.md"
---

# Backlog and Task Status Rules

- Every status change in BACKLOG.md must be mirrored in TASK_STATUS.md active tasks (and vice versa) before the turn ends.
- Never set status to `merged` without QA evidence recorded in TASK_STATUS.md.
- Never add a task to BACKLOG.md Active Wave without a matching entry in TASK_STATUS.md.
- After any edit to these files, the validator runs automatically via PostToolUse hook — check its output before proceeding.
- Archived tasks in `## Wave N — Archived` are not compared by the validator; do not put active tasks there.
- Task IDs are sequential integers (T-NNN). Never reuse a retired ID.
- `- **Blocked by:** <repo>/T-NNN` declares a cross-repo merge gate: the validator resolves `<repo>` via `docs/REPO_MAP.md` and blocks (or warns) merge until the referenced task in that repo is `merged`. Do not confuse with same-repo `Depends on:`.
- No-blockers convention: when a task has no cross-repo blockers, either omit the `Blocked by:` field entirely or set it to the standard em-dash (`—`) or plain hyphen (`-`) placeholder — both are treated as "no blockers", never as `blocked_by_unresolvable`. The gate only evaluates `Blocked by:` at gated statuses (`ready_for_qa`, `qa_passed`, `merged`), so a genuinely malformed value will not be reported until the task reaches one of those statuses.
- `- **Hold:** <what> — <why> (<since>)` (DR-005) marks a task as deliberately held, never mandatory and its absence is never a finding. It may downgrade ONLY `blocked_by_open`, and never a FAILURE-severity finding — `merged` × unmerged-blocker stays FAILURE/exit 2 regardless. It can never touch `merged_missing_commit_field`, evidence-completeness, mirror/sync-status, duplicate-entry detection, `config_check`, or `stale_verified` — see `HOLD_DOWNGRADABLE_CHECKS` in `mavp-validator.js`, a whitelist, not a blacklist of protected checks.
- Never register a verification command, named mutant, or expected-output claim in acceptance criteria without executing it first — quote the observed output, or label it `UNEXECUTED — verify before relying`. See `docs/core/ORCHESTRATION_RULES.md` — "Executed-check rule" for the full rule, the fixture-vs-live-reproduction distinction, and why no mechanical enforcement exists.
