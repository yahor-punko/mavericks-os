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
