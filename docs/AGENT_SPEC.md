# Agent Specification

Reference document for spawning sub-agents in the Mavericks framework.

## Sub-agent brief template

Use this when spawning any sub-agent from the Main Agent. Include all applicable fields.

```
Role: [developer | product-docs | technical-writer | qa | ux | security-reviewer | frontend-design | ui-designer | exa-researcher | architect | analyst]
Slice: T-XXX — [title from BACKLOG.md]
Goal: [one sentence — what this sub-agent must achieve]
work_dir: [absolute path to target repo]  # cross-repo only — OMIT for same-repo (mavericks) tasks; developer uses CWD (worktree root) by default
Module: [module id from docs/MODULES.md, if applicable — e.g. web-panel, antispam]
Repo: [repo name(s) this task touches — e.g. example-service, or example-service, mavericks]
Stale risk: [true | false — set true if this task touches cached data, ML models, or long-lived config]
Files to modify: [explicit list]
What NOT to change: [boundaries — other files, other tasks]
Definition of done: [acceptance criteria verbatim from BACKLOG.md]
Report back: changed files + line ranges, confirmation criteria met, any blockers
Before exiting: commit all changes with a meaningful message.
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

`sonnet` is the default for every worker role listed above. The Main Agent escalates a given spawn to `opus` (Opus 4.8) **per-invocation** — via a spawn-time `model: opus` override, not a frontmatter change — when the slice matches one or more of the concrete signals below. The architect is excluded from this table; its model policy is fixed (see "Architect" above) and never follows worker escalation.

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

The architect's frontmatter default is `model: claude-opus-4-8` — a deliberate exception to the alias-only rule, kept as a safe fallback if the runtime spawn override below is not applied.

**Runtime spawn rule (Main Agent):** when spawning the architect sub-agent, the Main Agent passes a per-invocation model override using an alias:

1. Spawn with `model: fable` (Fable 5, primary).
2. If Fable is unavailable, re-spawn the same brief with `model: opus` (Opus 4.8).
3. Never spawn architect below Opus 4.8 — in particular, never `model: sonnet`.

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
| developer | 90 | Implementation role with verify loops; two slices orphaned uncommitted work at the prior cap of 40. |
| product-docs | 40 | Doc-authoring role; observed marginal pressure at the prior cap of 30. |
| technical-writer | 40 | Same doc-authoring class as product-docs — aligned for consistency. |
| frontend-design | 45 | Implementation role with build/preview verify loops — between docs and developer. |
| architect | 25 | Read-heavy role; tool-use counts over-count turns for this role class. |
| qa | 20 | Bounded read → run → verdict; no observed cap pressure. |
| ui-designer | 20 | Bounded visual-design role; no observed cap pressure. |
| analyst | 15 | Read-only research; no observed cap pressure. |
| exa-researcher | 15 | Bounded retrieval; no observed cap pressure. |
| security-reviewer | 15 | Read-only audit; no observed cap pressure. |
| ux | 15 | Read-only review; no observed cap pressure. |

These values are derived from a small, anecdotal evidence set (see `docs/TURN_BUDGET.md` — "Evidence" and "Confidence & recheck"). They are deliberately generous so under-calibration cannot re-orphan work. Recompute and re-derive per role class once historical `tool_uses` data is instrumented, per the recheck plan in `docs/TURN_BUDGET.md`.

### Why aliases, not full-ids

The Agent-tool `model` parameter accepts **aliases only** (`sonnet`, `opus`, `haiku`, `fable`) — it does not accept full model-ids as a per-invocation override. Frontmatter defaults should follow the same convention (alias for workers) except where a full-id is a deliberate, explicitly-justified exception (architect's `claude-opus-4-8` default). A full-id observed in frontmatter has previously caused silent degradation to the wrong model, and pinning to a specific past-generation Sonnet full-id is the exact drift this policy exists to prevent.

The `architect` role covers both **pre-task analysis** (idea → T-NNN decomposition) and **mid-project architecture questions**. It is not a BACKLOG task type — it runs before or alongside tasks and reports to the Main Agent.

## Module registry

Module declarations live in `docs/MODULES.md`. Each module entry provides:
- `repos[]` — repositories this module typically touches
- `context_docs[]` — documentation files to load when working on this module
- `default_owner` — suggested sub-agent role
- `qa_checklist` — QA checks specific to this module type

The `--agent` JSON includes `context_docs` for each in-flight task that declares a module.
