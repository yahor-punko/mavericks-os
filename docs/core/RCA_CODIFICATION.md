# RCA-to-codification

## Purpose

A root-cause analysis (RCA) that ends in prose — "we understand what went wrong" — with no durable follow-up is a wasted investigation: the same failure recurs because nothing in the framework actually changed. This doc makes codification mandatory: every RCA document must end in a **Codification** section that routes each identified root cause to exactly one durable mechanism, and the Main Agent must register a follow-up task for each accepted routing so the fix is tracked to completion, not just written down. The same routing table and the same tie-break also govern durable lessons noticed outside any RCA — see "Codification outside an RCA" below.

## When to write an RCA

Write an RCA for any incident, near-miss, or recurring friction pattern worth investigating formally — a `needs_fix` loop that repeated more than once, a validator block that surprised the team, a production incident, or a process gap discovered after the fact. Register the RCA itself as an `exploration` task (see `docs/core/DECISIONS.md` — DR-001) if it produces no code, or as a step inside the task that surfaced the problem.

## Required structure

An RCA document (see `templates/RCA_TEMPLATE.md`) must contain:

1. **Problem** — what happened, observed symptoms, when/how it was noticed.
2. **Timeline** — ordered sequence of events leading to the problem.
3. **Root causes** — one or more distinct causes, each named and numbered (`RC-1`, `RC-2`, ...; do not confuse with the recheck `RC-N` id namespace used by `--arm-recheck` — an RCA root-cause id and a recheck id are different things that happen to share a prefix). State the cause plainly, not just the symptom.
4. **Codification** (mandatory, final section) — see below.

## The Codification section — mandatory, one routing per root cause

Every root cause listed in the RCA **must** be routed to exactly one of these five durable mechanisms. "Exactly one" means: pick the single mechanism that best fits the cause, do not split a cause across two mechanisms, and do not leave a root cause unrouted.

| Mechanism | Use when the root cause is... | How to file it |
|---|---|---|
| **(a) `.claude/rules` edit proposal** | A missing or ambiguous constraint that a rules file should have enforced. | Propose the exact edit to the relevant file under `.claude/rules/` (`backlog.md`, `docs.md`, `scripts.md`) or a new rules file if none fits. State the proposed text verbatim in the RCA; the Main Agent applies it directly (rules files are state-adjacent, not sub-agent-owned content). |
| **(b) Role-spec proposal via `SKILL_PROPOSALS/`** | A sub-agent's behavior pattern — not a hard rule — that should improve through the reflection loop. | File through the process in `docs/SKILL_OPTIMIZATION.md`, not as a direct edit to `.claude/agents/<role>.md`. If the minimum-N trajectory gate (Section 5 of that doc) has not been met yet, note the proposal as deferred until the next `--reflect-skill` run has enough signal. |
| **(c) Memory-index entry** | A lesson whose truth is **scoped to this operator or this machine** — a personal working preference, a local identity or path fact, this install's harness quirk. Route (c) is the **residual** route, not the default one: apply the portability test in "The portability tie-break" below before choosing it, because "remember this" fits every cause and would otherwise win every tie by being cheapest. | Add a one-line entry to the operator's per-operator memory index — whatever mechanism the operator's harness provides — following its existing format (short slug link + one-sentence summary). This is a per-operator mechanism, outside the repo, so cite it in the RCA doc even though it is not itself a repo file. If the portability test comes back framework-level, this row is not the routing: send the cause to (a), (b), (d) or (e), and let memory hold **at most a pointer** naming the `T-NNN` or artifact that carries the rule. |
| **(d) Armed recheck (`--arm-recheck`)** | A cause whose fix cannot be verified immediately — it needs a future revisit (e.g. "confirm the new validator rule didn't regress after a full wave," "re-audit this config next quarter"). | Run `./scripts/mavp-operator --arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]` against the task that will carry the recheck. See the **Recheck mechanism** convention in `CLAUDE.md`. |
| **(e) Mechanical enforcement** | A cause that a prose instruction cannot reliably fix because the checkpoint is structurally too late, or because compliance depends on a stateless agent remembering to self-check at the right moment — the fix must be a hook, validator, or test change, not wording. | File a developer task to add or extend the enforcement mechanism (a pre-commit hook check, a validator rule, a new/extended test). The task is a normal code change with its own acceptance criteria and verification type — cite the RCA's root-cause id in the task description so the lineage is greppable. |

If a root cause seems to need more than one mechanism, that is a signal the cause is actually two causes — split it and route each half separately.

### The portability tie-break — route (c) is residual (DR-013)

Routes (a), (b), (d) and (e) partition by the *shape* of the cause and rarely compete with one another; "exactly one, best fit" already settles them. Route (c) is different. Every lesson is rememberable, so "remember this" fits every cause, and memory is by far the cheapest route to file: one write, no task, no architect gate, no review. Absent a precedence rule, the cheapest route silently wins every tie — and it did, on 2026-08-23, when a framework-portable lesson about verifying a report's weakest claim went to memory instead of into the framework.

**The test is portability:** *would this lesson be equally true for a different operator running this framework on a different machine?*

- **Yes → framework-level.** The cause must route to (a), (b), (d) or (e). Memory may then hold **at most a pointer** — an entry naming the `T-NNN` or artifact that actually carries the rule.
- **No → operator-scoped.** The lesson's truth depends on this operator or this machine (a language preference, this machine's git identity, this operator's permission posture, a local harness quirk). Memory is the correct and only sensible home for it.

This is a tie-break, not a ban and not a ranking of all five routes. Operator-personal lessons legitimately live in memory, and pushing them into shipped, adopter-facing docs would pollute the framework with one person's preferences. What the tie-break forbids is the opposite direction: a lesson that would hold for any operator of this framework going only to memory, where it is invisible to adopters, invisible to the reflection loop in `docs/SKILL_OPTIMIZATION.md` (which mines task outcomes, never memory), and not greppable over the repo — it dies with one operator's machine.

**Adopter note:** route (c) is optional infrastructure. An operator whose harness provides no per-operator memory at all loses nothing under this rule, because nothing load-bearing for the project may ever live *only* in memory — everything framework-level has already been routed to (a), (b), (d) or (e) by the test above.

### Enforcement posture — pull-consumed, no validator check, no hook

This tie-break is **pull-consumed**: read it when the routing decision is being made. There is no validator check and no hook behind it, and absence of compliance is not a mechanically detectable finding. Two reasons, stated so no one has to rediscover them:

1. **DR-009 does not reach this rule.** DR-009 (`docs/core/DECISIONS.md`) rules that info severity is never an acceptable *terminal* tier for a rule the operator channel can violate silently — but its own scope limit confines it to "rules that govern **the operator's own direct writes to state artifacts**," naming `BACKLOG.md`, `TASK_STATUS.md`, and `PROCESS_STATE.json`. A memory write lands outside the repo tree entirely, where no hook observes it and no validator can read it; there is no write for a check to sit in front of.
2. **No matcher could judge it anyway.** Portability is a semantic property of a lesson, not a syntactic property of a string. DR-009's own precondition for escalating a rule to blocking is a matcher *proven not to reject legitimate output* — a precondition that cannot be met here, because the legitimate case (an operator-scoped lesson) and the violating case (a framework-portable one) are indistinguishable in form.

**Compensating observable form.** In place of a mechanical check, the rule carries an auditable shape: a memory entry recording a framework-portable lesson must name inline the `T-NNN` or artifact that carries the rule. Compliance is then checkable by reading the memory index itself — a pointer with no carrier named is the visible failure. The existing index already does this informally in places (entries that cite the task that codified them); the tie-break makes it the required form. This is the same posture as the `Reopen trigger:` field and the registration-home convention in `CLAUDE.md` — both deliberately pull-consumed, both with no validator check, both relying on a form that makes non-compliance legible on inspection.

## Codification outside an RCA

The routing table and the portability tie-break above govern **any durable lesson**, whether or not an RCA document exists. Most lessons never get an RCA: they surface mid-session, as a single observation about how the work went wrong, too small to investigate formally but not too small to codify.

**The trigger is the urge itself.** When the reflex mid-session is "I should write this down so I remember it next time," that reflex is the signal to run the portability test — before the memory entry is written, not after.

- **Framework-level verdict** → the Main Agent registers a task through the normal architect gate (see `CLAUDE.md` — "Orchestrator checklist"), exactly as for an RCA-sourced routing, and the routing lands in (a), (b), (d) or (e) via that task. Writing the lesson into memory is not a substitute for registering it, and a lesson being small is not a reason to skip the gate.
- **Operator-scoped verdict** → write the memory entry. That is the whole action; no task is owed.

Nothing else about the process changes: "exactly one, best fit" still applies, a cause that seems to need two mechanisms is still two causes, and the follow-up-task rule below still governs whatever routing is accepted.

## Follow-up task registration

For each root cause whose codification routing is accepted, the **Main Agent registers a follow-up debt or improvement task** in `BACKLOG.md` (via `--new-task`) that implements the routing (e.g. the actual rules-file edit, the role-spec proposal filing, the memory-index write, or confirming the recheck was armed). The RCA document itself is not the fix — the follow-up task is what closes the loop. Cite the RCA's root-cause id (`RC-N`) in the follow-up task's description so the lineage is greppable.

## Citing decisions and tasks

When an RCA's root cause traces back to, or produces, a framework decision, use the `docs/core/DECISIONS.md` lineage fields to keep the chain traceable by grep:

- If the RCA led to a new decision record, write that DR with `Informed by:` pointing at the RCA doc path, and `Tasks:` listing the RCA task and the follow-up task(s) it spawned.
- If the RCA's follow-up task revises an existing decision, use `Supersedes:` on the new DR.
- Reference the DR id in the RCA's Codification section for any root cause routed as a rules edit that also warrants a decision record (not every rules edit needs one — only those non-obvious enough to need "why rejected" reasoning, per the pattern in DR-001).

Example: a rules-edit codification for a recurring backlog-drift cause might read `Routed to: (a) .claude/rules/backlog.md edit — see DR-002; follow-up: T-401`.

## Related docs

- `docs/core/DECISIONS.md` — decision-record format and the `Informed by:` / `Supersedes:` / `Tasks:` lineage fields used above; DR-013 is the ruling behind "The portability tie-break" and "Codification outside an RCA".
- `docs/SKILL_OPTIMIZATION.md` — full process for role-spec proposals (mechanism (b)).
- `CLAUDE.md` — Recheck mechanism convention (mechanism (d)).
- `templates/RCA_TEMPLATE.md` — fill-in template for new RCA documents.
