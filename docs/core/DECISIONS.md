# Framework decisions

Lightweight decision records for choices about framework structure. Each record states the problem, what was considered, what was rejected and why, and what was adopted instead.

---

## DR-001 — Research-first tasks: `exploration` type over a new lifecycle status

**Date:** 2026-05-31

**Problem:** Tasks whose correct solution is unknown before investigation do not fit the standard lifecycle. The immediate workaround — setting `owner: architect` on a backlog task — is a semantic mismatch because the architect role is a pre-task decomposition step, not an active investigator.

**What was considered:** Adding a new validator-aware lifecycle status (`needs_research` or `spike`) that would sit before `in_progress` and signal that the task requires a research phase.

**Why rejected:**
- A new status adds complexity for every framework adopter, even those who never do pre-investigation work.
- The status would require validator changes, template updates, and documentation across multiple files.
- Two existing mechanisms already cover the need: the `exploration` task type (produces a doc artifact with no deliverable code) and the architect gate (pre-task decomposition and design review).
- Adding a third mechanism would overlap with both without removing either.

**What was adopted instead:** The research-first convention using `exploration` type:
1. Register the investigation as an `exploration` task (`Output doc:`, `Owner role: main_agent`, `Verification type: artifact`).
2. Main agent runs the investigation and writes the findings document.
3. Register a follow-up implementation task that references the findings.

This keeps investigation and implementation as separate, visible backlog items with proper evidence trails, and re-uses existing validator support for `exploration` tasks without adding new lifecycle states.

**Documented in:** `docs/core/TASK_LIFECYCLE.md` — "Task types / exploration" section.
