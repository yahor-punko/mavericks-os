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
Test scope: [worktree developer only — seed a `node scripts/run-tests.js --filter <fragment>` baseline; the developer extends it with its own test files and grep-derived coverage and reports the delta; marked corpus-wide guard tests run automatically with any `--filter` and must not be seeded; never instruct the full suite in a worktree — see docs/core/ORCHESTRATION_RULES.md — "Test-execution scope (worktree developers)"]
Scratch dir: [optional — set whenever the brief names scratch files or asks for probes, fuzzers or throwaway scripts: a per-task directory such as <session scratch root>/T-NNN/, never the shared session scratch root, which parallel sub-agents overwrite — see "Scratch dir" below]
Files to modify: [explicit list, repo-relative paths only — never absolute: an absolute path points a worktree agent at the shared main checkout instead of its own worktree — see docs/core/ORCHESTRATION_RULES.md "GAP D"]
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

### Scratch dir
Optional. Brief-only — it has no BACKLOG.md counterpart. The harness provides one session scratch directory that every parallel sub-agent in the session writes to, so two agents share one namespace (observed 2026-10-25, T-839/T-840: one agent overwrote the other's probe file). Whenever a brief names scratch files or asks for probes, fuzzers or throwaway scripts, the Main Agent sets `Scratch dir:` to a per-task subdirectory of the session scratch root (`<session scratch root>/T-NNN/`, a placeholder — never a literal absolute path in a shipped doc) and the agent keeps everything of that kind under it. Enforcement is by discipline; see `docs/core/ORCHESTRATION_RULES.md` — "Repository-global exclusive resources" (fifth enumerated instance).

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

### Frontmatter contract

The harness reads a fixed subset of the keys in each `.claude/agents/<role>.md` frontmatter block: `name`, `description`, `model`, `tools`, `isolation`, `maxTurns`. Two further keys — `deny-tools` and `permissions-mode` — are Mavericks-only: the harness ignores them entirely, and they exist solely for `scripts/test-agent-spec-sync.js` to assert against.

**An ill-formed `hooks:` value silently unregisters the agent.** This is not a validation error surfaced anywhere — the role simply stops appearing in the Agent tool's type list, and a spawn returns `Agent type '<role>' not found` with no reference back to the frontmatter as the cause. Measured 2026-09-21 (T-752, five-probe matrix): a `hooks:` block written as a bare YAML sequence of `- event: ... / condition: ... / action: ... / message: ...` items is rejected and unregisters the spec; a `hooks:` block written as the harness's documented event-keyed mapping (`PreToolUse:` → `hooks:` → `- type: command, command: ...`) registers correctly; and quoting the `description:` scalar makes no difference to registration either way.

**Frontmatter `PreToolUse` hooks were measured not to fire at all under this repo's shipped configuration.** A schema-correct, event-keyed `PreToolUse`/`Bash` hook that unconditionally exits 2 and writes to stderr on every Bash call was spawned and did not fire — the probing agent's own `git status` returned normal output. Recorded alongside this measurement: `hasTrustDialogAccepted: false` for this project in `~/.claude.json`, and `claude --version` reporting `2.1.197` while `isolation: worktree` demonstrably works — a key the harness changelog places at `2.1.267`, meaning the running harness is newer than the binary reports. Because of this, **no role spec may carry a `hooks:` block without a quoted live-fire observation** — a schema-valid block that never fires reads as a working guard to the next author while providing none, which is exactly how two shipped documents came to assert a guard (`.claude/agents/developer.md`'s destructive-git block) that had been inert since 2026-05-29.

**Registration is proven only by a live spawn, never by reading the file.** Byte-identical frontmatter has been observed to register successfully at one point in time and fail to register later with no diff against it (T-752) — the harness-side cause of that specific regression was not isolated, only the frontmatter-side contributor (the sequence-form `hooks:` block) was. Treat "the file looks correct" and "the role is spawnable" as two independent claims; only the second is evidence.

## Model selection

This section is the **single source of truth** for model selection across the framework. `docs/core/ROLES.md`, `CLAUDE.md`, and `docs/core/ORCHESTRATION_RULES.md` reference this section by pointer — they do not re-inline the policy.

### Worker agents

All worker roles (developer, qa, ux, product-docs, technical-writer, security-reviewer, frontend-design, ui-designer) declare `model: sonnet` in their `.claude/agents/*.md` frontmatter. Fable-only roles (architect, analyst, exa-researcher) declare `model: fable` in their `.claude/agents/*.md` frontmatter — see "Fable-only roles" below.

`sonnet` is a **model alias**, not a pinned full-id. It resolves to the current Sonnet generation and advances automatically as new generations ship. Do not pin worker frontmatter to a full-id (an id that names one specific Sonnet generation) — full-ids go stale and version-pinning is exactly the failure mode this policy replaces.

#### Worker model-escalation table

`sonnet` is the default for every worker role listed above. The Main Agent escalates a given spawn to `opus` (latest Opus) **per-invocation** — via a spawn-time `model: opus` override, not a frontmatter change — when the slice matches one or more of the concrete signals below. The architect, the analyst and the exa-researcher are excluded from this table; their model policy is fixed (see "Fable-only roles" below) and never follows worker escalation.

| Signal | Example | Escalate to |
|--------|---------|--------------|
| Complex refactor | Restructuring a module's control flow or data model across multiple files | `opus` |
| Novel / non-boilerplate logic | New algorithm, non-templated business logic, first-of-its-kind integration | `opus` |
| High risk / blast radius | Change can affect production data, billing, auth, or many downstream consumers | `opus` |
| Cross-cutting change | Touches shared libraries, conventions, or contracts used by multiple modules/repos | `opus` |
| Full (non-checklist) security review | `security-reviewer` performing a full review (see CLAUDE.md — Security review) rather than a lightweight self-checklist | `opus` |
| None of the above | Mechanical edits, boilerplate, well-understood single-file changes, checklist-style reviews | `sonnet` (default — no override needed) |

Escalation is a Main Agent judgment call applied at spawn time; it does not change the role's frontmatter default. When escalating, record it in the sub-agent brief with an optional `Model:` field (see "Sub-agent brief — optional Model: and Effort: fields" below).

### Fable-only roles (architect, analyst, exa-researcher)

The architect, the analyst and the exa-researcher run on the **fable model family only**. No other family is sanctioned for any of the three roles, and none follows the worker escalation table above. This is the operator's ruling of 2026-10-25; it governs sub-agent spawns only — the orchestrator's own session model is configured elsewhere and is not covered by this section. The policy it replaces is recorded in `docs/core/DECISIONS.md` — DR-015.

Fable-only roles (architect, analyst, exa-researcher) declare `model: fable` in their frontmatter, and all three roles' specs carry a `## Model selection` section and a `## Model self-report` section (see "Model self-report" below). The frontmatter value is **declared intent only**, not an enforced channel: it was measured not to honour the `fable` alias (T-734, 2026-09-01 — see "Why aliases, not full-ids" below). The channel that reaches the fable family is the spawn-time parameter, which is why the rules below are written against the spawn.

**Runtime spawn rule (Main Agent):** every spawn of the architect, the analyst or the exa-researcher passes a per-invocation `model: fable` override, mandatory on every spawn, on every slice — it is not a judgment call and does not vary with the slice. Every spawn of the architect or the analyst additionally passes `effort: xhigh`, likewise mandatory. `effort: xhigh` is fixed for the architect and the analyst only: the exa-researcher's effort is not fixed and follows the effort-selection table below (session default `high`, per-invocation override per the worker rows).

**Stop rule — what "unavailable" means.** This is the canonical definition; the copies in `.claude/agents/architect.md`, `.claude/agents/analyst.md`, `.claude/agents/exa-researcher.md`, `docs/core/ORCHESTRATION_RULES.md`, and `CLAUDE.md` point here. After **two consecutive loud spawn failures on `model: fable`** (retry once after the first), the Main Agent stops and reports a blocker to the operator. It never re-spawns the role on another model. A *loud* failure is a spawn-time error the Main Agent can actually see: an HTTP 5xx (e.g. a 529 capacity refusal), a transport or DNS failure, or an explicit model-unavailable refusal. One loud failure is not enough, since a 529 is a transient capacity signal and the retry frequently succeeds; two is enough, since a third retry is unbounded waiting. A consequence the operator has accepted: while the fable family is unavailable, every gate that depends on these three roles is halted rather than run on a different model.

**Discard rule.** A *silent* outcome is not a spawn failure — the report arrives, from whichever model produced it. Every report from these roles opens with the self-report line (see "Model self-report" below). A report whose opening line does not name the fable family — a different family, or no such line at all — is discarded unintegrated and the spawn is repeated once with the same override. A second miss is a blocker, reported the same way as the stop rule.

**Model names are family names only.** Specs and policy text name a model by family (`fable`, `opus`, `sonnet`, `haiku`) and never by version. `scripts/test-agent-spec-sync.js` fails on a versioned family token in any `.claude/agents/*.md` or in this document.

### Model self-report

This section is the **single source of truth** for the model self-report mechanism of the Fable-only roles (architect, analyst, exa-researcher), following the same pattern as "Report completion token" and "Budget awareness" elsewhere in this document — the contract lives here once, and each of `.claude/agents/architect.md`, `.claude/agents/analyst.md` and `.claude/agents/exa-researcher.md` carries the operative copy, because agent spec files are read by the harness in isolation with no include mechanism. `scripts/test-agent-spec-sync.js` is what keeps the copies from drifting apart.

**Why this exists.** The frontmatter `model:` field of these roles is declared intent only: the frontmatter channel was measured not to honour the `fable` alias (T-734, 2026-09-01 — see "Why aliases, not full-ids" below), so no frontmatter edit can make the fable family the enforced default. It is reachable only via a per-invocation spawn-time override the Main Agent must remember to apply on every spawn (see "Fable-only roles" above). A forgotten override produces no visible symptom: a report from the wrong model reads exactly like one from the fable family, and no shipped mechanism — grep, hook, or validator — observes which model actually produced a given report. This section's mechanism is what makes that degradation visible at all, and the discard rule is what acts on it.

**The mechanism.** The final report of each Fable-only role must open with a literal first line, before any other content, stating the model it believes it is running as, in the form `Model self-report: <model-name>`, with a family name only (e.g. `fable` or `opus`). `scripts/test-agent-spec-sync.js` asserts that each Fable-only role's spec carries a "Model self-report" section and that this literal grammar matches, verbatim, between that spec and this section.

**Explicit limits — the same posture as the completion token, stated plainly rather than as a guarantee:**
- **Runtime compliance is unobservable.** Nothing forces the agent to actually write the opening line — sub-agent reports are in-band chat content, not a file or artifact, so no hook, script, or validator can check whether any one report actually complied. This is the identical limit already stated for the completion token above, applied here without modification.
- **A self-report can itself be wrong — this is a detector, not proof.** T-288 (`TASK_STATUS.md:4171`) recorded a spec whose frontmatter declared a full-id naming one Sonnet generation while the agent's own self-report named an earlier Sonnet generation — the self-report is what caught that degradation, and it is also proof the self-report is not ground truth, only the best observation available.

### Effort selection

This section is the **single source of truth** for reasoning-effort selection across the framework, alongside "Model selection" above.

The session-level default is `effortLevel: "high"` (`alwaysThinkingEnabled: true`), seeded into adapter projects by `node scripts/mavp-install.js` (bootstrap). Treat this default as a **ceiling for ordinary work, not a floor for everything** — the Main Agent may select a lower or higher effort per-invocation via `opts.effort` depending on the slice, per the table below.

#### Effort-selection table

| Role / slice type | Effort level | Notes |
|--------------------|--------------|-------|
| Architect (all invocations) | `xhigh` | Fixed — never varies by slice. See "Fable-only roles" above. |
| Analyst (all invocations) | `xhigh` | Fixed — never varies by slice. See "Fable-only roles" above. |
| Exa researcher (all invocations) | `high` | Session default; per-invocation override per the worker rows; not fixed. Fable-only for model, not for effort — see "Fable-only roles" above. |
| Mechanical worker slices (boilerplate, well-understood single-file edits, checklist-style reviews, doc-only formatting) | `medium` | Per-invocation `opts.effort` override, below the session default. |
| Ordinary worker slices (the common case — most developer/product-docs/qa/etc. tasks) | `high` | Session default; no override needed. |
| Heavy worker slices (matches one or more worker model-escalation signals above: complex refactor, novel logic, high risk/blast radius, cross-cutting change, full security review) | `xhigh` | Per-invocation `opts.effort` override. |
| Exceptional slices (rare — highest-stakes or highest-ambiguity work identified by the Main Agent) | `max` | Per-invocation `opts.effort` override **only** — `max` must never be a frontmatter or session default. |

#### Application mechanic

- **Session default (`high`)** is set once per session and applies to every agent unless overridden.
- **Per-invocation `opts.effort`** is how the Main Agent deviates from the session default for a specific spawn — down to `medium` for mechanical slices, or up to `xhigh`/`max` for heavy or exceptional slices. This does not change any frontmatter default.
- **`max` is per-invocation only.** It must never appear as a frontmatter default or as a session-wide setting — reserve it for the rare slice the Main Agent judges to warrant the highest available effort.
- **Architect and analyst effort is fixed at `xhigh`** regardless of slice complexity — neither role participates in this table's variability, and neither is ever lowered to `medium` or raised to `max`. The exa-researcher, the third Fable-only role, is not fixed: its effort follows this table (session default `high`, per-invocation override per the worker rows).

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
| qa | 70 | Bounded read → run → verdict. Wave-100 session-2 evidence (four runtime QA spawns against the prior cap of 40): one cap-hit (T-763, 40/40, resumed to 47 cumulative) and two completions within five turns of cap (T-771 36/40, T-769 35/40); recalibrated per `docs/TURN_BUDGET.md` "Session 6 evidence" — ceil(47×1.5)=71 → ceiling-to-next-multiple-of-10 per resolution 3 → 80, discounted for read-heavy over-count (T-310/T-727 precedent) → 70, 49% headroom over the 47 floor. |
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

**QA convergence is event-based, not count-based.** The `qa` role's tailored convergence target no longer rests on self-counting to roughly 80% of `maxTurns`; its `## Budget awareness` section now prescribes a plan phase of at most 5 tool calls (task block, `git show --stat` of the evidence commit, then one executed check per criterion plus a reading set), a per-criterion ceiling of 8 tool calls (then `NOT verified — budget`), and a one-line ledger emitted as text after each criterion, with the final report written at the earliest of all criteria ledgered, the plan allowance exhausted, or the retained 80% trigger. Why: the count-based trigger shipped in 0.48.0 (T-728) and failed on an adopter's 0.51.1 (a qa spawn used all 70 turns and returned one sentence) and locally on T-763 (cap-hit 40/40) — a global count to roughly 56 calls is not something the agent tracks reliably, whereas "I finished a criterion" is an event it observes. No `maxTurns` value changes; the heading and backticked `maxTurns: N` literal that `scripts/test-agent-spec-sync.js` asserts are unchanged. The ledger is insurance whose return at cap the framework cannot verify.

**Why the mandatory-brief-line alternative was refused.** The obvious-looking fix — make the `Turn budget:` brief-line field mandatory on every spawn — was considered and rejected, for three reasons:

1. **Unenforceable.** A brief is in-band chat content, not a file or artifact. No hook, script, or validator observes it, which is the identical limit already stated for completion-token checking (see "Report completion token" above) — there is nothing here to add a mechanical check against.
2. **Already ruled once.** `EXECUTION_LOG.md:640` records an explicit prior refusal of a mechanical forcer for this exact brief line, on this exact ground: the brief is in-band text with the same limit as completion-token checking.
3. **Redundant now that the number lives in the spec body.** With `maxTurns: N` embedded in the role's own file and `scripts/test-agent-spec-sync.js` asserting it matches frontmatter, the mechanism no longer depends on the Main Agent remembering to fill an optional field on every spawn. The brief line survives — see the reworded description above — as an override/retry channel for a spawn deviating from the role's own default, not as the mechanism's only input.

See `docs/core/DECISIONS.md` — DR-014 for the full ruling record, including the evidence-tier caveat behind the underlying `maxTurns` recalibration this mechanism depends on.

### Why aliases, not full-ids

The Agent-tool `model` **spawn parameter** accepts **aliases only** (`sonnet`, `opus`, `haiku`, `fable`) — it does not accept full model-ids as a per-invocation override. Frontmatter `model:` defaults follow the same alias-only convention: every role, including the Fable-only roles, declares an alias — there is no full-id exception. A full-id observed in frontmatter has previously caused silent degradation to the wrong model, and pinning to a full-id that names one specific past generation (Sonnet or Opus) is the exact drift this policy exists to prevent — a version-pinned id freezes a spec on an old generation as newer generations ship. **The full-id ban is unchanged and stands on those drift grounds alone**, independently of the channel distinction below.

**The two channels are not interchangeable — this is narrower than "aliases work unconditionally."** Alias-only is a rule about what may be WRITTEN in each channel. It is not a claim that both channels RESOLVE every alias, and reading it that way is what licensed the refuted T-734 flip. Measured 2026-09-01 (T-734 — see its evidence block in `TASK_STATUS.md`): an architect spec whose frontmatter read `model: fable`, spawned with **no** `model` parameter, self-reported `opus`; a discriminating spawn at the same moment **with** `model: fable` self-reported the fable family. Same spec, same minute, opposite results — Fable was demonstrably available, so this was not transient unavailability. **The frontmatter channel does not honour the `fable` alias and degrades silently to `opus`; the spawn-param channel does honour it.** This holds regardless of harness documentation listing `fable` as a valid frontmatter value: the in-harness measurement governs locally, and that docs-vs-measurement conflict is recorded on T-734's deprecated block as its reopen trigger (re-run the discriminating pair after a harness update). Practical consequence: Fable is reachable only through the spawn parameter, so no frontmatter edit can make it the default — see `docs/core/DECISIONS.md` — DR-015 for the full option table and ruling.

The `architect` role covers both **pre-task analysis** (idea → T-NNN decomposition) and **mid-project architecture questions**. It is not a BACKLOG task type — it runs before or alongside tasks and reports to the Main Agent.

## Module registry

Module declarations live in `docs/MODULES.md`. Each module entry provides:
- `repos[]` — repositories this module typically touches
- `context_docs[]` — documentation files to load when working on this module
- `default_owner` — suggested sub-agent role
- `qa_checklist` — QA checks specific to this module type

The `--agent` JSON includes `context_docs` for each in-flight task that declares a module.

**Brief rule.** A brief names only the `context_docs` beyond what the context-bundle injection already carries into it (see `docs/core/ORCHESTRATION_RULES.md` — "Context cost of a spawn"); it does not re-list the module's full set. The architect reads those `context_docs` first, before the codebase.
