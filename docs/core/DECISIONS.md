# Framework decisions

Lightweight decision records for choices about framework structure. Each record states the problem, what was considered, what was rejected and why, and what was adopted instead.

## Optional lineage fields

Each DR record may declare three optional fields so the what-to-why chain (task ↔ decision ↔ log entry) is traceable by grepping a single id:

- **`Informed by:`** — upstream inputs this decision drew on (e.g. another DR id, an exploration task's output doc, an analyst/architect brief).
- **`Supersedes:`** — the id of a prior DR this one replaces, if any.
- **`Tasks:`** — the `T-NNN` id(s) this DR governs or was produced by.

These fields are metadata only — omit any that don't apply, and add no new required structure. Combined with the `EXECUTION_LOG.md` entry convention (see CLAUDE.md — "Key conventions"), grepping a DR id across this file, `EXECUTION_LOG.md`, and `BACKLOG.md`/`TASK_STATUS.md` surfaces the decision itself, every log entry that acted on it, and every task that cites it. **Graph-rendering or lineage-visualization tooling is explicitly out of scope** — the mechanism is plain grep over existing text artifacts, not a new tool.

---

## DR-001 — Research-first tasks: `exploration` type over a new lifecycle status

**Date:** 2026-05-31

**Informed by:** none (first decision record)

**Tasks:** T-214 (registered this record and the research-first convention it documents)

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

---

## DR-002 — Main Agent may apply publish-manifest registration entries directly

**Date:** 2026-07-14

**Informed by:** `docs/rca/2026-07-publish-manifest-registration.md` (RC-1 and RC-3)

**Tasks:** T-398 (the fix this decision generalizes from), T-399 (this record), T-400, T-401 (follow-up codification tasks)

**Problem:** T-397 created two new git-tracked framework files without classifying them in `scripts/publish-manifest.json`, which was only caught later at publish-assembly time and required a full follow-up task (T-398) to fix. `product-docs` and `technical-writer` are scope-forbidden from editing `scripts/` and (for technical-writer) tool-unequipped to run node — so a "self-register" instruction is unexecutable for them. Something must apply the one-line manifest entry on their behalf without reintroducing the friction of spawning a whole developer task for a single classification line.

**What was considered:** Requiring a dedicated developer task for every manifest registration, mirroring the existing rule that all other `scripts/publish-manifest.json` changes go through a developer task.

**Why rejected:** A full developer-task cycle (architect gate, brief, spawn, review, merge) for a single ship/exclude line is exactly the friction that turned a same-task fix into T-398, a whole separate task. Requiring it for every future registration would recreate the same overhead on every doc-authoring task that creates a new file — disproportionate to the size of the change and a disincentive to comply promptly.

**What was adopted instead:** `scripts/publish-manifest.json` **registration entries** (adding a path to the `ship` or `exclude` list with its classification) are treated as a state-adjacent classification ledger action, the same doctrine already applied to rules-file edits under mechanism (a) in `docs/core/RCA_CODIFICATION.md`. The Main Agent may apply a registration entry directly when a scope-forbidden role emits the `MANIFEST_REGISTRATION_NEEDED: <path> -> <ship|exclude> (<reason>)` token in its final report (see `.claude/rules/docs.md` / `.claude/rules/scripts.md`, filed by T-400). All **other** changes to `scripts/publish-manifest.json` — restructuring, reclassifying existing entries, or any change beyond adding a new registration line — still require a developer task.

**Documented in:** `docs/core/RCA_CODIFICATION.md` (mechanism (a) routing example), `.claude/rules/docs.md`, `.claude/rules/scripts.md` (via T-400).

---

## DR-003 — Canonical self-install is a first-class installer mode

**Date:** 2026-07-15

**Informed by:** the T-405 canonical self-activation incident — the guide's shipped instruction to run a full `--update .` against the framework root clobbered the tracked `scripts/mavp-operator` wrapper and other framework-owned files, because the installer treated the framework's own checkout as an ordinary adopter target.

**Tasks:** T-404 (incident), T-405 (hook-activation docs that shipped the unsafe instruction), T-406 (installer self-install detection + `--hooks-only` mode), T-407 (wrapper flag parity), T-408 (this record; doc correction)

**Problem:** Running the installer against the mavericks framework's own directory is a legitimate, recurring operation (activating Claude Code hooks locally after cloning), but the installer had no way to distinguish "target is a normal adopter project" from "target IS the framework itself." Treating the two identically meant a full `--update` would overwrite the framework's own tracked wrapper, agents, and rules with a copy of themselves — a no-op at best, a downgrade at worst — while the guide's advertised "no repo diff" claim was false as shipped.

**What was considered:** Treat canonical self-install as a normal adopter case and rely on documentation alone to warn operators to use a narrower command by hand.

**Why rejected:** Documentation-only guidance does not prevent the mistake — it already existed and still shipped an incorrect full-`--update` recommendation (T-405). Nothing stopped a future run of the documented command from clobbering the wrapper again; the failure mode is mechanical and should be caught mechanically, not by relying on every future reader to notice the risk.

**What was adopted instead:** The installer detects when the resolved target directory IS the framework's own root (via `fs.realpathSync` comparison, catching symlinked homes) and degrades automatically: `--update` (and a fresh install's wrapper write) skip overwriting `scripts/mavp-operator`, the project-specific script sync, and the `.claude/{agents,skills,rules}` copy — those files are the source in this case, so only the hooks/config-related steps still run (managed hooks merge, settings backfills, the `.mavp-hook-ts` gitignore entry, the pre-commit hook copy). `--hooks-only <dir>` is shipped as the explicit, minimal command for this case and is now the documented recommendation for canonical self-activation (see `docs/core/BOOTSTRAP_GUIDE.md` — "Claude Code hooks activation"). A full `--update .` against the framework root remains safe post-fix (self-install detection skips the framework-file sync automatically) but is no longer the recommended command, since it does more work than hook activation requires.

**Documented in:** `docs/core/BOOTSTRAP_GUIDE.md` ("Claude Code hooks activation" — narrow activation and canonical self-activation step), `scripts/mavp-install.js` header comment ("Self-install detection").
