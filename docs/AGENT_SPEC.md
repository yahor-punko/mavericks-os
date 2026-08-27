# Agent Specification

Reference document for spawning sub-agents in the Mavericks framework.

## Sub-agent brief template

Use this when spawning any sub-agent from the Main Agent. Include all applicable fields.

```
Role: [developer | product-docs | technical-writer | qa | ux | security-reviewer | frontend-design | ui-designer | exa-researcher | architect | analyst]
Slice: T-XXX — [title from BACKLOG.md]
Goal: [one sentence — what this sub-agent must achieve]
work_dir: [absolute path to target repo]  # cross-repo only — OMIT for same-repo (mavericks) tasks; developer uses CWD (worktree root) by default
Adjacent docs read: [cross-repo tasks only — list each <repo>/CLAUDE.md read before starting, found or not found. Omit for same-repo tasks.]
Module: [module id from docs/MODULES.md, if applicable — e.g. web-panel, antispam]
Repo: [repo name(s) this task touches — e.g. example-service, or example-service, mavericks]
Stale risk: [true | false — set true if this task touches cached data, ML models, or long-lived config]
Read current main: [optional — set when the task must READ current-main state; pre-authorizes `git merge --ff-only main` from the worktree root as the sub-agent's first step, run before the Base floor check below when both are set. Omit otherwise.]
Base floor: [target repo's base-branch head hash at spawn time — REQUIRED for cross-repo and branch-based-repo worktree spawns, recommended otherwise; the developer runs `git log --oneline HEAD..<floor>` before any edit and quotes the output. See "Base floor" below.]
Model: [opus | sonnet]     # optional — only include when escalating a worker away from its sonnet default; see "Model selection" below
Effort: [medium | high | xhigh | max]   # optional — only include when deviating from the session default; see "Effort selection" below
Turn budget: [role's maxTurns from the "Per-role maxTurns table" below]   # optional override/retry channel — most roles now self-state their budget (see "Budget awareness" below); fill this on a retry after a cap-hit, or when deviating from the role's own stated number; see "Turn budget selection" below
Test scope: [worktree developer only — seed a `node scripts/run-tests.js --filter <fragment>` baseline; the developer extends it with its own test files and grep-derived coverage and reports the delta; never instruct the full suite in a worktree — see docs/core/ORCHESTRATION_RULES.md — "Test-execution scope (worktree developers)"]
Files to modify: [explicit list]
What NOT to change: [boundaries — other files, other tasks]
Definition of done: [acceptance criteria verbatim from BACKLOG.md]
Report back: changed files + line ranges, confirmation criteria met, any blockers
Before exiting: commit all changes with a meaningful message, then end the report with the completion token — literal last line, `MAVP_REPORT role=<role> task=<T-NNN|n/a> verdict=<done|blocked|needs_fix|pass|fail>` — see "Report completion token" below.
```

## Field descriptions

### Role
Sub-agent persona from `.claude/agents/`. Choose the role whose skill set best matches the task.

### Slice
Task ID and title from BACKLOG.md. Must match exactly.

### Goal
One sentence describing the outcome. No implementation details — those belong in the acceptance criteria.

### work_dir
Absolute path to the target repository. **Omit for same-repo (mavericks) tasks.** Only include when the task modifies a different repository. Developer agents use CWD (worktree root) by default.

### Context prefetch bundle — inject content, never reference the path
The context prefetch bundle (see CLAUDE.md — "Context prefetch bundle") is a **Main-Agent-only** brief-composition input. Retrieve it with `./scripts/mavp-operator --emit-bundle T-NNN` and paste the relevant CONTENT directly into the brief text. `.mavp/context/` is gitignored and does not exist inside a worktree checkout, so a brief must never instruct a worktree sub-agent to read a `.mavp/context/T-NNN.md` path — that read will silently fail.

### Module
Optional. Module ID from `docs/MODULES.md`. When provided, the sub-agent should load the module's `context_docs` before starting. The `--agent` JSON includes this field for each in-flight task.

Declared in BACKLOG.md as: `- **Module:** web-panel`

### Repo
Optional but recommended for any task in `in_progress` or later. Single repo name or comma-separated list for cross-repo tasks.

Declared in BACKLOG.md as: `- **Repo:** example-service` or `- **Repos:** example-service, mavericks`

The validator warns when a task in `in_progress` or later lacks a Repo: field.

### Stale risk
Optional. Set to `true` when the task touches data or configuration that might be outdated (e.g. ML model weights, cached feature flags, third-party API contracts). When `stale_risk: true`, the evidence block in TASK_STATUS.md must include `stale_verified: true` before the task can advance without a validator warning.

Declared in BACKLOG.md as: `- **Stale risk:** true`

### Base floor
Optional field, **required for cross-repo spawns and for branch-based target repos**, recommended otherwise. Brief-only — it has no BACKLOG.md counterpart.

Carries the hash the Main Agent captured from the target repo's base branch immediately before dispatch (`git -C <target-repo> rev-parse --short <base-branch>`). The harness owns both the base commit a worktree is branched from and the repository it is placed under, and constrains neither on request — observed bases have been arbitrarily stale, sticky across separate runs, and not an ancestor of any live branch, and a task targeting one repo has been given a worktree under another. `Base floor:` is what makes that placement measurable instead of assumed.

The developer runs `git log --oneline HEAD..<floor>` before its first edit and quotes the exact output in its report:

| Output | Meaning | Action |
|---|---|---|
| empty (exit 0) | base is at or after the floor | proceed |
| commits listed (exit 0) | stale base — the worktree lacks that history | stop, blocker report |
| `fatal: Invalid revision range` (exit 128) | wrong repository | stop, blocker report |

The range direction matters: `HEAD..<floor>` lists commits reachable from the floor but not from HEAD, so non-empty output means the worktree is *missing* required history. When `Read current main:` is also set, the pre-authorized `git merge --ff-only main` runs first and this check second; a floor failure surviving the ff-merge is a hard stop. When the field is omitted the developer proceeds exactly as before, so no existing brief flow changes retroactively.

Enforcement is by discipline, not mechanism — no hook of ours can fire inside a worktree. The quoted output is the compensating control: it makes compliance checkable from the report artifact. See `.claude/agents/developer.md` — "Worktree mechanics" for the developer-side contract and `docs/core/ORCHESTRATION_RULES.md` — "GAP C"/"GAP E" for the Main-Agent-side duties and the grounding measurements.

### commit: in evidence
All tasks with `merged` status must include `commit: <hash>` in the evidence field in TASK_STATUS.md. The validator will block (exit code 2) on merged tasks without a commit hash in the evidence.

Evidence example in TASK_STATUS.md:
```
- **Evidence:** Implemented feature X at line 42. node --check passes. commit: abc1234
```

## Task fields in BACKLOG.md

A complete task entry example with all optional fields:

```markdown
### T-NNN — Task title here
- **Status:** in_progress
- **Priority:** high
- **Owner role:** developer
- **Depends on:** T-095
- **Module:** web-panel
- **Repo:** example-service
- **Stale risk:** false
- **Acceptance criteria:** [describe what done looks like]
- **Verification type:** runtime
- **Evidence expected:** node --check exits 0; feature works end-to-end
```

## Report completion token

This section is the **single source of truth** for the sub-agent report completion-token contract. `CLAUDE.md`'s sub-agent brief template and every role spec under `.claude/agents/` reference this section rather than re-defining the grammar.

**The contract:** every sub-agent's final report must end with a literal last line — the completion token — in this exact grammar, with no other text following it:

```
MAVP_REPORT role=<role> task=<T-NNN|n/a> verdict=<done|blocked|needs_fix|pass|fail>
```

- `role` — the sub-agent's role name exactly as declared in `.claude/agents/<role>.md` frontmatter (e.g. `developer`, `security-reviewer`).
- `task` — the task id the report concerns (`T-NNN`), or the literal `n/a` when the report is not tied to a single registered task.
- `verdict` — one value from the fixed enum `done | blocked | needs_fix | pass | fail`. Which values a given role uses is role-specific — see each role spec's own "Report completion token" paragraph for its applicable subset (implementation-style roles typically use `done` / `blocked` / `needs_fix`; verdict-bearing review roles use `pass` / `fail`).

**Why this works — the rationale must travel with the rule, or it reads as ceremony and gets dropped.** Harness truncation cuts the **tail** of a turn, never the head — a truncated report always shows whatever narration came first, never a coherent ending. Making the mandatory final line a fixed, literal token means a truncated report **cannot** contain it: for the token to be missing, the report must have been cut before reaching its own last line. Token absence is therefore a truncation detector with **zero false positives by construction** — it can never fire on a report that genuinely finished, only on one that was cut short. This is the entire reason the check is worth running on every report; without this property it would just be bureaucratic formatting.

**Explicit limits — this contract does less than it may sound like:**
- **Detection only.** It does not prevent truncation — the underlying harness behavior that truncates a turn is outside this repo's control. It converts a silent failure into an observable one.
- **No mechanical enforcement is possible.** Sub-agent reports are in-band chat content, not a file or artifact — no hook, script, or validator check observes them, so there is nothing to add to `mavp-validator.js` or any `PostToolUse` hook here. The check is necessarily manual: a Main-Agent-side reading discipline, defined in `docs/core/ORCHESTRATION_RULES.md` — "Sub-agent report completion check".
- **Verdict-bearing roles gate on presence, not just wording.** For `qa`, `security-reviewer`, and `ux`, a verdict is never bookable as a pass (`qa_passed` / `security_passed` / `ux_passed`) unless the token's last line is present and its `verdict` is `pass`. A report that reads like a pass in its body but is missing the token must be treated as unresolved, not accepted at face value.

## Roles reference

| Role | Skill set | Typical tasks |
|------|-----------|---------------|
| developer | Node.js, scripts, code | Feature implementation, bug fixes, script changes |
| product-docs | Markdown docs, process | Process doc updates, spec writing |
| technical-writer | Copy, clarity | User-facing docs, README updates |
| qa | Test execution, verification | QA passes, evidence verification |
| ux | UX review, usability | UX audit, interaction review |
| security-reviewer | Security audit | Auth flows, external inputs, third-party integrations |
| frontend-design | CSS, layout | UI design, component styling |
| ui-designer | Visual design, Figma | Mockups, design tokens |
| exa-researcher | Research, search | Technical research, competitive analysis |
| architect | Codebase analysis, system design | Pre-task analysis, cross-service design, task decomposition |
| analyst | Web research, synthesis | Technology landscape, library/API options, competitive research |

## Model selection

This section is the **single source of truth** for model selection across the framework. `docs/core/ROLES.md`, `CLAUDE.md`, and `docs/core/ORCHESTRATION_RULES.md` reference this section by pointer — they do not re-inline the policy.

### Worker agents

All worker roles (developer, qa, ux, product-docs, technical-writer, security-reviewer, frontend-design, ui-designer, exa-researcher, analyst) declare `model: sonnet` in their `.claude/agents/*.md` frontmatter.

`sonnet` is a **model alias**, not a pinned full-id. It resolves to the current Sonnet generation (Sonnet 5 as of this writing) and advances automatically as new generations ship. Do not pin worker frontmatter to a full-id (e.g. `claude-sonnet-5`) — full-ids go stale and version-pinning is exactly the failure mode this policy replaces.

#### Worker model-escalation table

`sonnet` is the default for every worker role listed above. The Main Agent escalates a given spawn to `opus` (latest Opus) **per-invocation** — via a spawn-time `model: opus` override, not a frontmatter change — when the slice matches one or more of the concrete signals below. The architect is excluded from this table; its model policy is fixed (see "Architect" above) and never follows worker escalation.

| Signal | Example | Escalate to |
|--------|---------|--------------|
| Complex refactor | Restructuring a module's control flow or data model across multiple files | `opus` |
| Novel / non-boilerplate logic | New algorithm, non-templated business logic, first-of-its-kind integration | `opus` |
| High risk / blast radius | Change can affect production data, billing, auth, or many downstream consumers | `opus` |
| Cross-cutting change | Touches shared libraries, conventions, or contracts used by multiple modules/repos | `opus` |
| Full (non-checklist) security review | `security-reviewer` performing a full review (see CLAUDE.md — Security review) rather than a lightweight self-checklist | `opus` |
| None of the above | Mechanical edits, boilerplate, well-understood single-file changes, checklist-style reviews | `sonnet` (default — no override needed) |

Escalation is a Main Agent judgment call applied at spawn time; it does not change the role's frontmatter default. When escalating, record it in the sub-agent brief with an optional `Model:` field (see "Sub-agent brief — optional Model: and Effort: fields" below).

### Architect

The architect's frontmatter default is `model: opus` — the alias-only rule holds with no exception, and this default still functions as a safe fallback if the runtime spawn override below is not applied.

**Runtime spawn rule (Main Agent):** when spawning the architect sub-agent, the Main Agent passes a per-invocation model override using an alias:

1. Spawn with `model: fable` (Fable 5, primary).
2. If Fable is unavailable, re-spawn the same brief with `model: opus` (latest Opus).
3. Never spawn architect below Opus — in particular, never `model: sonnet`.

This mirrors the runtime policy already codified in `.claude/agents/architect.md` ("Model selection" section).

### Effort selection

This section is the **single source of truth** for reasoning-effort selection across the framework, alongside "Model selection" above.

The session-level default is `effortLevel: "high"` (`alwaysThinkingEnabled: true`), seeded into adapter projects by `node scripts/mavp-install.js` (bootstrap). Treat this default as a **ceiling for ordinary work, not a floor for everything** — the Main Agent may select a lower or higher effort per-invocation via `opts.effort` depending on the slice, per the table below.

#### Effort-selection table

| Role / slice type | Effort level | Notes |
|--------------------|--------------|-------|
| Architect (all invocations) | `xhigh` | Fixed — never varies by slice. See "Architect" above. |
| Mechanical worker slices (boilerplate, well-understood single-file edits, checklist-style reviews, doc-only formatting) | `medium` | Per-invocation `opts.effort` override, below the session default. |
| Ordinary worker slices (the common case — most developer/product-docs/qa/etc. tasks) | `high` | Session default; no override needed. |
| Heavy worker slices (matches one or more worker model-escalation signals above: complex refactor, novel logic, high risk/blast radius, cross-cutting change, full security review) | `xhigh` | Per-invocation `opts.effort` override. |
| Exceptional slices (rare — highest-stakes or highest-ambiguity work identified by the Main Agent) | `max` | Per-invocation `opts.effort` override **only** — `max` must never be a frontmatter or session default. |

#### Application mechanic

- **Session default (`high`)** is set once per session and applies to every agent unless overridden.
- **Per-invocation `opts.effort`** is how the Main Agent deviates from the session default for a specific spawn — down to `medium` for mechanical slices, or up to `xhigh`/`max` for heavy or exceptional slices. This does not change any frontmatter default.
- **`max` is per-invocation only.** It must never appear as a frontmatter default or as a session-wide setting — reserve it for the rare slice the Main Agent judges to warrant the highest available effort.
- **Architect effort is fixed at `xhigh`** regardless of slice complexity — it does not participate in this table's variability and is never lowered to `medium` or raised to `max`.

#### Sub-agent brief — optional Model: and Effort: fields

The sub-agent brief template (see top of this document) may include two optional fields when the Main Agent deviates from defaults:

```
Model: [opus | sonnet]     # optional — only include when escalating a worker away from its sonnet default
Effort: [medium | high | xhigh | max]   # optional — only include when deviating from the session default
```

Omit both fields when spawning at defaults (`sonnet` frontmatter model, session-default `high` effort). Include `Model:` when applying a worker escalation per the table above. Include `Effort:` when applying a per-invocation `opts.effort` override per the effort-selection table above.

### Turn budget selection

This section is the **single source of truth** for `maxTurns` calibration across the framework, alongside "Model selection" and "Effort selection" above. The source calibration document is `docs/TURN_BUDGET.md` — consult it for the underlying evidence and confidence caveats before changing any value here.

`maxTurns` is a **runaway guard**, not a working ceiling: an agent should never reach it in normal operation. Each role's frontmatter in `.claude/agents/<role>.md` declares a fixed `maxTurns:` value; there is no per-invocation override mechanism for turn budget (unlike model and effort, which support spawn-time overrides).

#### Headroom formula

```
recommended maxTurns = round_to_10( ceil( max_observed_for_role_class × 1.5 ) )
```

The ×1.5 multiplier converts the highest observed turn count for a role class into a guard rail with headroom, so a normally-operating agent never approaches the cap. Where no in-wave data exists, the value is estimated by role class (implementation vs. docs-authoring vs. read-only review/research) and held near its current setting, since a low cap is a useful protection for bounded roles.

#### Per-role maxTurns table

| Role | maxTurns | Basis |
|------|----------|-------|
| developer | 140 | Implementation role with verify loops; a full verify-heavy slice hit the prior cap of 90 twice across resumes (T-552). |
| product-docs | 70 | Doc-authoring role; a censored cap-hit (T-521, 42 vs the prior cap of 40) drove a third recalibration — see `docs/TURN_BUDGET.md` "T-557 recalibration". |
| technical-writer | 70 | Same doc-authoring class as product-docs — aligned for consistency (still zero independent observations). |
| frontend-design | 45 | Implementation role with build/preview verify loops — between docs and developer. |
| architect | 50 | Read-heavy role; tool-use counts over-count turns for this role class. Nine-run external table shows truncations at 39/40 vs the prior cap of 25; recalibrated per `docs/TURN_BUDGET.md` "T-727 recalibration" — ceil(40×1.5)=60 → 60, discounted for read-heavy over-count (same precedent as this row's own original basis) → 50. |
| qa | 40 | Bounded read → run → verdict. Nine-run external table shows truncations at 20/26/30 vs the prior cap of 20, and a local T-710 report truncated at exactly cap 20 with no completion token was likely misclassified `infra_failure` instead of a cap-hit; recalibrated per `docs/TURN_BUDGET.md` "T-727 recalibration" — ceil(30×1.5)=45 → 50, discounted for read-heavy over-count → 40. |
| ui-designer | 20 | Bounded visual-design role; no observed cap pressure. |
| analyst | 15 | Read-only research; no observed cap pressure. |
| exa-researcher | 15 | Bounded retrieval; no observed cap pressure. |
| security-reviewer | 40 | A full single-repo self-recon review needs strictly more than the prior cap of 25 — three independent reviews truncated at cap+1 (T-552). |
| ux | 15 | Read-only review; no observed cap pressure. |

These values are derived from a small, anecdotal evidence set (see `docs/TURN_BUDGET.md` — "Evidence" and "Confidence & recheck"). They are deliberately generous so under-calibration cannot re-orphan work. Recompute and re-derive per role class once historical `tool_uses` data is instrumented, per the recheck plan in `docs/TURN_BUDGET.md`.

### Budget awareness

This section is the **single source of truth** for the budget-awareness mechanism, following the same pattern as "Report completion token" above: this document states the contract once, and the individual role specs under `.claude/agents/` each carry their own operative copy, because agent specs are standalone files the harness reads in isolation — there is **no include mechanism** for them, so the number cannot live in one place and be referenced from the rest. `scripts/test-agent-spec-sync.js` is what stops the copies drifting apart, not discipline.

**Roster — a frontmatter predicate, not a judgment call.** A role is in-roster when its frontmatter `deny-tools:` line denies **both** `Edit` and `Write`. For that role, the sub-agent's final report is its sole deliverable — there is no committed file a checkpoint could have protected if a truncation ate the report's tail — so self-counting against a known ceiling is the only mitigation available. The current roster, derived mechanically rather than hand-maintained: `analyst`, `architect`, `exa-researcher`, `qa`, `security-reviewer`, `ux`. `ui-designer` is capped at 20 turns but stays OUT — it keeps `Write` (it produces file artifacts). `developer`, `product-docs`, `technical-writer`, and `frontend-design` are OUT for the same reason as each other: their deliverable is committed files, and checkpoint commits already protect partial progress against a mid-work truncation. Because the boundary is a predicate the test enforces (`isReportOnlyRole()` in `scripts/test-agent-spec-sync.js`, matched against a `deepStrictEqual` pin of the six names above), no future "sweep every role by hand" judgment call is ever needed again — a new report-only role simply fails the test until it grows the section below.

**The mechanism.** Each roster role's spec file carries a `## Budget awareness` section stating its own turn budget in a machine-readable, backticked `` `maxTurns: N` `` literal, plus a self-count instruction, a convergence trigger at roughly 80% of budget, a note that the brief-line `Turn budget:` field can override it, and a role-tailored target for what "converge" means for that role. `scripts/test-agent-spec-sync.js` asserts, for every roster role, that the section exists and that its stated `N` equals the role's own frontmatter `maxTurns` — so an agent reading only its own spec file always has a live, correct number to converge against, without needing to read `AGENT_SPEC.md`, a brief field, or any other file at all.

**Why the mandatory-brief-line alternative was refused.** The obvious-looking fix — make the `Turn budget:` brief-line field mandatory on every spawn — was considered and rejected, for three reasons:

1. **Unenforceable.** A brief is in-band chat content, not a file or artifact. No hook, script, or validator observes it, which is the identical limit already stated for completion-token checking (see "Report completion token" above) — there is nothing here to add a mechanical check against.
2. **Already ruled once.** `EXECUTION_LOG.md:640` records an explicit prior refusal of a mechanical forcer for this exact brief line, on this exact ground: the brief is in-band text with the same limit as completion-token checking.
3. **Redundant now that the number lives in the spec body.** With `maxTurns: N` embedded in the role's own file and `scripts/test-agent-spec-sync.js` asserting it matches frontmatter, the mechanism no longer depends on the Main Agent remembering to fill an optional field on every spawn. The brief line survives — see the reworded description above — as an override/retry channel for a spawn deviating from the role's own default, not as the mechanism's only input.

See `docs/core/DECISIONS.md` — DR-014 for the full ruling record, including the evidence-tier caveat behind the underlying `maxTurns` recalibration this mechanism depends on.

### Why aliases, not full-ids

The Agent-tool `model` parameter accepts **aliases only** (`sonnet`, `opus`, `haiku`, `fable`) — it does not accept full model-ids as a per-invocation override. Frontmatter defaults follow the same convention unconditionally: every role, including architect, declares an alias — there is no full-id exception. A full-id observed in frontmatter has previously caused silent degradation to the wrong model, and pinning to a specific past-generation full-id (Sonnet or Opus) is the exact drift this policy exists to prevent — a version-pinned id freezes a spec on an old generation as newer generations ship.

The `architect` role covers both **pre-task analysis** (idea → T-NNN decomposition) and **mid-project architecture questions**. It is not a BACKLOG task type — it runs before or alongside tasks and reports to the Main Agent.

## Module registry

Module declarations live in `docs/MODULES.md`. Each module entry provides:
- `repos[]` — repositories this module typically touches
- `context_docs[]` — documentation files to load when working on this module
- `default_owner` — suggested sub-agent role
- `qa_checklist` — QA checks specific to this module type

The `--agent` JSON includes `context_docs` for each in-flight task that declares a module.
