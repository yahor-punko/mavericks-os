# RCA-to-codification

## Purpose

A root-cause analysis (RCA) that ends in prose — "we understand what went wrong" — with no durable follow-up is a wasted investigation: the same failure recurs because nothing in the framework actually changed. This doc makes codification mandatory: every RCA document must end in a **Codification** section that routes each identified root cause to exactly one durable mechanism, and the Main Agent must register a follow-up task for each accepted routing so the fix is tracked to completion, not just written down.

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
| **(c) Memory-index entry** | A recurring operational lesson worth surfacing across sessions, where the fix is "remember this," not "change a rule or spec." | Add a one-line entry to the operator's Claude Code memory index (`MEMORY.md`) following its existing format (short slug link + one-sentence summary). This is a per-operator mechanism, outside the repo, so cite it in the RCA doc even though it is not itself a repo file. |
| **(d) Armed recheck (`--arm-recheck`)** | A cause whose fix cannot be verified immediately — it needs a future revisit (e.g. "confirm the new validator rule didn't regress after a full wave," "re-audit this config next quarter"). | Run `./scripts/mavp-operator --arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]` against the task that will carry the recheck. See the **Recheck mechanism** convention in `CLAUDE.md`. |
| **(e) Mechanical enforcement** | A cause that a prose instruction cannot reliably fix because the checkpoint is structurally too late, or because compliance depends on a stateless agent remembering to self-check at the right moment — the fix must be a hook, validator, or test change, not wording. | File a developer task to add or extend the enforcement mechanism (a pre-commit hook check, a validator rule, a new/extended test). The task is a normal code change with its own acceptance criteria and verification type — cite the RCA's root-cause id in the task description so the lineage is greppable. |

If a root cause seems to need more than one mechanism, that is a signal the cause is actually two causes — split it and route each half separately.

## Follow-up task registration

For each root cause whose codification routing is accepted, the **Main Agent registers a follow-up debt or improvement task** in `BACKLOG.md` (via `--new-task`) that implements the routing (e.g. the actual rules-file edit, the role-spec proposal filing, the memory-index write, or confirming the recheck was armed). The RCA document itself is not the fix — the follow-up task is what closes the loop. Cite the RCA's root-cause id (`RC-N`) in the follow-up task's description so the lineage is greppable.

## Citing decisions and tasks

When an RCA's root cause traces back to, or produces, a framework decision, use the `docs/core/DECISIONS.md` lineage fields to keep the chain traceable by grep:

- If the RCA led to a new decision record, write that DR with `Informed by:` pointing at the RCA doc path, and `Tasks:` listing the RCA task and the follow-up task(s) it spawned.
- If the RCA's follow-up task revises an existing decision, use `Supersedes:` on the new DR.
- Reference the DR id in the RCA's Codification section for any root cause routed as a rules edit that also warrants a decision record (not every rules edit needs one — only those non-obvious enough to need "why rejected" reasoning, per the pattern in DR-001).

Example: a rules-edit codification for a recurring backlog-drift cause might read `Routed to: (a) .claude/rules/backlog.md edit — see DR-002; follow-up: T-401`.

## Related docs

- `docs/core/DECISIONS.md` — decision-record format and the `Informed by:` / `Supersedes:` / `Tasks:` lineage fields used above.
- `docs/SKILL_OPTIMIZATION.md` — full process for role-spec proposals (mechanism (b)).
- `CLAUDE.md` — Recheck mechanism convention (mechanism (d)).
- `templates/RCA_TEMPLATE.md` — fill-in template for new RCA documents.
