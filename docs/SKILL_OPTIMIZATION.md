# SKILL_OPTIMIZATION.md

Skill reflection loop contract for Mavericks — defines the SkillOpt-inspired system that mines past task outcomes, scores them, and proposes bounded edits to agent role specs. Developer agents implementing T-178 through T-182 and the main agent running the loop should read this document in full before starting.

**Upstream entry point:** an RCA's role-spec proposal (mechanism (b) in `docs/core/RCA_CODIFICATION.md`) files through the process below, not as a direct edit to `.claude/agents/<role>.md`.

---

## 1. Overview

The skill reflection loop automatically improves `.claude/agents/<role>.md` spec files based on real project history. It does **not** fine-tune model weights. It produces a human-readable proposal document; no changes are applied without explicit human review and approval.

**What it does:**
- Mines completed task slices from `TASK_STATUS.md`, `BACKLOG.md`, and `EXECUTION_LOG.md` as trajectories.
- Scores each trajectory using a multi-signal rubric (QA outcome, validator exit code, scope deviation).
- Passes success and failure minibatches to an optimizer model (opus-class) to identify improvable patterns.
- Proposes a bounded set of add/delete/replace edits to the role spec under a configurable "textual learning rate" budget.
- Writes the proposal to `SKILL_PROPOSALS/<role>-<date>.md` for human review.

**What it does not do (v1):**
- No autonomous application of edits — human approval is required.
- No synthetic task re-runs or benchmark generation.
- No fine-tuning of LLM weights.
- No automated holdout re-scoring gate (deferred to v2).
- No multi-role co-optimization in a single run.

---

## 2. Four phases

### Phase 1 — Rollout (passive mining)

Trajectories are collected from real project history, not synthetic benchmark runs. The script reads:
- `TASK_STATUS.md` — QA outcomes, evidence flags, validator exit codes per task.
- `BACKLOG.md` — role assignment, task type, acceptance criteria.
- `EXECUTION_LOG.md` — sub-agent spawning events and key decisions.

Each completed task-role pair produces one trajectory record (see Section 3). Tasks that are `planned` or `in_progress` are excluded. Only tasks with a declared `Owner role:` matching the target role are included. Terminal-success states `deployed_dev` and `deployed_prod` are treated equivalently to `merged` — tasks at those statuses are included in extraction and their actual status string is preserved in the trajectory record.

### Phase 2 — Reflect

The optimizer model (opus-class, e.g. `claude-opus-4`) receives:
- **Success minibatch** — trajectories scoring ≥ 0.7 (after the train/holdout split).
- **Failure minibatch** — trajectories scoring < 0.7.

The model identifies patterns in what high-performing task completions have in common and where low-performing completions deviate. It then proposes specific, bounded edits to the role spec.

Protected sections (see Section 7) are stripped before the doc is passed to the optimizer and are mechanically reinserted unchanged after edit proposal generation.

### Phase 3 — Edit (bounded by lr budget)

The optimizer proposes edits subject to the textual learning rate (lr) budget:

- **Default lr = 2** — at most 2 edit operations per reflect run.
- Each operation is one of: `add` (insert new text), `delete` (remove existing text), `replace` (swap one block for another).
- Each operation targets a named section heading or "end of file."
- Rationale for each operation must be one sentence, grounded in a pattern observed in the minibatches.

### Phase 4 — Gate (human review, v1)

The proposal file is committed to the repo. A human reviewer reads it, marks their decision (Accept / Accept with modifications / Reject), manually applies accepted edits to the role spec, and commits the result. No automated holdout re-scoring in v1. The existing validator confirms artifact consistency after any edit.

---

## 3. Trajectory schema

One record per completed task-role-stage. Stored as newline-delimited JSON (JSONL).

```json
{
  "taskId": "T-NNN",
  "role": "developer",
  "status": "merged",
  "needsFixCount": 0,
  "validatorExitCode": 0,
  "qaOutcome": "passed",
  "evidenceFlags": [],
  "toolUses": 41
}
```

| Field | Type | Description |
|---|---|---|
| `taskId` | string | Task identifier, e.g. `"T-042"`. Used as the stable key for train/holdout split. |
| `role` | string | The `.claude/agents/<role>.md` being assessed, e.g. `"developer"`. |
| `status` | string | Final task status at time of mining, e.g. `"merged"`. May also be `"deployed_dev"` or `"deployed_prod"` — these are treated as terminal-success states and are included in extraction alongside `merged`. |
| `needsFixCount` | integer | Number of `qa_needs_fix` / `ux_needs_fix` / `security_needs_fix` round-trips the task went through. **Preferred source:** the explicit `needs_fix_rounds:` field in the task's `TASK_STATUS.md` evidence block. Fallback: keyword heuristics (counting `needs_fix` status transitions in the evidence text). When the explicit field is present it always takes priority. |
| `validatorExitCode` | integer | Worst validator exit code observed during the task's lifecycle. `0` = healthy, `1` = drifting, `2` = repair required. **Preferred source:** the explicit `validator_blocked:` field in the task's `TASK_STATUS.md` evidence block (`true` maps to exit code `2`). Fallback: keyword heuristics when the field is absent. |
| `qaOutcome` | string | One of: `"passed"`, `"passed_after_needs_fix"`, `"failed"`. |
| `evidenceFlags` | string[] | List of scope-deviation flags found in task evidence, e.g. `["edited_files_outside_scope", "skipped_commit"]`. Empty array when clean. |
| `toolUses` | integer (optional) | Number of tool calls the sub-agent used to complete the task, sourced from the explicit `tool_uses:` field in the task's `TASK_STATUS.md` evidence block. Additive/optional: when the evidence block has no `tool_uses:` line, this field is omitted from the record entirely — no default value is injected and extraction does not error. **Main-Agent recording convention:** at task completion, the Main Agent reads the `tool_uses` count reported in the task-completion notification and records it as `tool_uses: <N>` in the task's `TASK_STATUS.md` evidence block (e.g. `tool_uses: 41`), alongside `commit:` and other evidence fields. This gives future `maxTurns` / turn-budget calibration a data-grounded signal instead of anecdotal estimates. |

---

## 4. Scoring rubric

Scores are in the range [0.0, 1.0]. Score is computed per trajectory and clamped to this range.

**Base score from QA outcome:**

| `qaOutcome` value | Base score |
|---|---|
| `"passed"` | 1.0 |
| `"passed_after_needs_fix"` | 0.7 |
| `"failed"` | 0.0 |

**Penalties (applied additively after base):**

| Condition | Penalty |
|---|---|
| Each `needsFixCount` beyond the first | −0.1 per additional round-trip |
| `validatorExitCode` was 2 at any point | −0.2 |
| Each scope-deviation flag in `evidenceFlags` | −0.1 per flag |

**Formula:**

```
score = base
      - 0.1 * max(0, needsFixCount - 1)
      - 0.2 * (validatorExitCode == 2 ? 1 : 0)
      - 0.1 * len(evidenceFlags)

score = clamp(score, 0.0, 1.0)
```

**Examples:**

| Scenario | Calculation | Final score |
|---|---|---|
| Clean pass, no issues | 1.0 | 1.0 |
| Passed after 1 needs_fix round-trip | 0.7 | 0.7 |
| Passed after 2 needs_fix round-trips | 0.7 − 0.1 | 0.6 |
| Passed after 1 needs_fix + validator exit 2 | 0.7 − 0.2 | 0.5 |
| Passed but 2 scope flags | 1.0 − 0.2 | 0.8 |
| Failed with validator exit 2 + 1 scope flag | 0.0 − 0.2 − 0.1 → clamped | 0.0 |
| Passed after 3 needs_fix + validator exit 2 + 2 scope flags | 0.7 − 0.2 − 0.2 − 0.2 → clamped | 0.1 |

---

## 5. Minimum-N gate

The optimizer refuses to run when fewer than 8 scored trajectories exist for the target role.

**Threshold:** 8 trajectories (across train + holdout).

**Error message format:**
```
Error: insufficient trajectories for role "<role>".
Found: <N> scored trajectory/trajectories. Minimum required: 8.
Run more tasks assigned to this role and re-run --reflect-skill.
```

No proposal file is written when this gate fires. The script exits with a non-zero exit code.

---

## 6. All-success / all-failure guard

Before running the reflect step, the script checks score distribution across training trajectories.

**Condition:** All training trajectories score ≥ 0.9 (all-success) OR all training trajectories score ≤ 0.1 (all-failure).

**Behavior:** Skip the reflect step. Write a notice to stdout:
```
Warning: insufficient contrast signal for role "<role>".
All training trajectories score [≥0.9 | ≤0.1]. Cannot identify improvable patterns.
No proposal generated.
```

No proposal file is written. This is not an error — the script exits 0 but logs the reason.

**Rationale:** The optimizer needs a mix of successes and failures to identify what makes the difference. A uniform batch provides no signal gradient.

---

## 7. Protected-section convention

Non-negotiable rules in `.claude/agents/<role>.md` — rules that must never be modified by the optimizer — are wrapped in HTML comment markers:

```
<!-- protected -->
...rule text that must never be modified by the optimizer...
<!-- /protected -->
```

**Mechanics:**
1. Before passing the role spec to the optimizer, the script mechanically strips all `<!-- protected -->` ... `<!-- /protected -->` blocks from the document text.
2. The optimizer receives and edits only the unprotected content.
3. After generating the proposed edits, the script mechanically reinserts the protected blocks at their original positions.
4. The proposal document (Section 8) reflects only edits to unprotected sections.

**Example:**

```markdown
## Core rules

Always read the file before editing.

<!-- protected -->
## Identity

You are the developer sub-agent in Mavericks. You operate under the direct-reference model.
You may not modify BACKLOG.md or TASK_STATUS.md.
<!-- /protected -->

## Working practices

...improvable content here...
```

In this example, the "Identity" section is protected. The optimizer may propose changes to "Core rules" or "Working practices" but not to "Identity."

**When to protect a section:** Protect any rule that enforces system-level invariants (role identity, file modification boundaries, commit conventions, validator requirements). Do not protect heuristics, style guidance, or task-approach recommendations — these are candidates for improvement.

**Rule:** All immediate-stop preconditions — hard requirements that must be met before the agent proceeds — must be wrapped in a protected block. An immediate-stop precondition is any instruction of the form "if X is not present, stop and report; do not proceed."

---

## 8. Edit proposal format

Proposals are written to `SKILL_PROPOSALS/<role>-<date>.md`. Reproduce this template verbatim when generating a proposal:

```markdown
# Skill Proposal: <role> — <date>

## Metadata
- Role: <role>
- Trajectories used: <N train> / <N total>
- Score range: <min>–<max>
- Generated: <date>

## Proposed edits (lr budget: 2)

### Edit 1 — <op: add|delete|replace>
**Target section:** <section heading or "end of file">
**Rationale:** <one sentence from optimizer>

**Before:**
```
<original text or "(none)" for add>
```

**After:**
```
<proposed text or "(none)" for delete>
```

---

## Reviewer notes
(fill in before applying)

## Decision
- [ ] Accept all
- [ ] Accept with modifications (describe below)
- [ ] Reject
```

**Notes on fields:**
- `<N train>` is the count of trajectories in the training split (70% of total, rounded down).
- `<N total>` is the total count of scored trajectories for the role.
- `<min>` and `<max>` are the lowest and highest scores in the training split.
- Each edit block is numbered sequentially. There are at most `lr` edit blocks (default: 2).
- `<op>` is exactly one of: `add`, `delete`, `replace`.
- For `add` operations, "Before" is `(none)`.
- For `delete` operations, "After" is `(none)`.

---

## 9. Human review gate

**How to accept edits:**
1. Open `SKILL_PROPOSALS/<role>-<date>.md`.
2. Review each proposed edit against the rationale and the pattern it addresses.
3. Fill in "Reviewer notes" with any observations.
4. Mark the "Decision" checkbox.
5. Manually apply accepted edits to `.claude/agents/<role>.md`. Do not use automated apply in v1 — edit the file directly.
6. Run the validator: `node scripts/mavp-validator.js`. Confirm exit code 0.
7. Commit both `.claude/agents/<role>.md` and the proposal file with a message referencing the wave and role.

**How to reject edits:**
1. Mark the "Reject" checkbox in the proposal file.
2. Optionally note the reason in "Reviewer notes."
3. Commit the proposal file as-is (rejected proposals are retained for audit history).
4. No changes to `.claude/agents/<role>.md`.

**Partial acceptance:** Check "Accept with modifications," describe the modification in "Reviewer notes," and apply your modified version of the edit to the role spec.

**Commit message convention:**
```
feat(skill-opt): apply <role> spec edits from wave <N> reflect run
```

---

## 10. Artifact paths

| Artifact | Path | Notes |
|---|---|---|
| Trajectory store | `.mavp/trajectories/<role>.jsonl` | Committed to the repo. **Not** in `.gitignore`. One file per role. |
| Proposals | `SKILL_PROPOSALS/<role>-<date>.md` | Committed for auditability. Never deleted — rejected proposals are retained. |
| Role specs | `.claude/agents/<role>.md` | Modified only after human review (v1) or after gate passes (v2). |
| Reflect log | `.mavp/reflect-log.jsonl` | Committed. Append-only. One record per reflect run across all roles. |
| Auto-apply log | `.mavp/auto-apply-log/<role>-<date>.md` | Written before autonomous apply. Committed. Human-readable diff. |

**Code-vs-data loading contract:** `mavp-skill-reflect.js` always loads `mavp-operator-lib.js` from its own install directory (via `require('./mavp-operator-lib')`), never from `MAVERICKS_PROJECT_ROOT`. All data paths — the trajectory store, proposal output, role spec, and the `TASK_STATUS.md` / `BACKLOG.md` files the script mines — resolve under `MAVERICKS_PROJECT_ROOT` (the target project). Under the direct-reference model, bootstrapped projects run the mavericks-installed binary but supply their own data; do not change the lib `require` path to point at the project or the script will fail when the project has no local copy of the library.

**Trajectory store format:** newline-delimited JSON (JSONL). Each line is one trajectory record (Section 3). Append-only — do not delete or overwrite existing records. New trajectories are appended after each wave close.

---

## 11. Train/holdout split

Trajectories are split 70% train / 30% holdout, keyed on `taskId` for stability across runs.

- The split is deterministic: the same `taskId` always falls in the same partition.
- The holdout set is **not used in v1** beyond ensuring it is excluded from training minibatches.
- Holdout is reserved for v2 automated re-scoring gate (see Section 12.1).
- Never include holdout trajectories in the minibatches passed to the optimizer.

---

## 12. v1 vs v2 scope boundary

### v1 (this wave — implemented by T-178 through T-182)

- Passive mining only — trajectories come from real project history.
- Single-role per reflect run (`--reflect-skill <role>`).
- Human-gated — no edit is applied without explicit reviewer approval.
- Manual edit application — reviewer edits the file directly.
- No automated holdout re-scoring.
- Holdout partition is computed and reserved but not evaluated.
- Validator (exit code check) is the only automated gate after edit application.

### v2 roadmap — automation gate and autonomous apply

v2 activates the holdout partition (reserved but idle in v1) as an automated quality gate and, when that gate passes, applies edits without human approval. The sections below are implementation-ready specifications.

#### 12.1 Held-out re-scoring gate

After the optimizer proposes edits, the script runs `scoreTrajectory` on each holdout trajectory twice: once against the current (unmodified) spec and once against the proposed (edited) spec. Outcomes are simulated from the trajectory fields already recorded — no new LLM calls are required for scoring.

**Gate pass condition:** both of the following must hold:

1. Mean holdout score with proposed edits ≥ mean holdout score with current spec + **0.05** (minimum meaningful improvement threshold).
2. No individual holdout trajectory score decreases by more than **0.2** relative to the current spec (regression guard).

**Gate fail behavior:**

- The proposal is discarded — it is not written to `SKILL_PROPOSALS/`.
- One record is appended to `.mavp/reflect-log.jsonl` (see Section 14) with `"gateResult": "failed"` and a `gateFailReason` string.
- The script exits 0 (not an error) but prints the reason to stdout:
  ```
  Gate failed for role "<role>": <reason>.
  Proposal discarded. Reason logged to .mavp/reflect-log.jsonl.
  ```

**Possible `gateFailReason` values:**
- `"delta_below_threshold"` — mean improvement < 0.05.
- `"regression_on_holdout_trajectory:<taskId>"` — a specific trajectory regressed by > 0.2.
- `"insufficient_holdout_count"` — fewer than 6 holdout trajectories available.

#### 12.2 Minimum data requirements for v2

v2 requires more data than v1's minimum-N=8:

| Requirement | v1 | v2 |
|---|---|---|
| Total trajectories per role | ≥ 8 | ≥ 20 |
| Training split | ~70% of total | exactly 14 |
| Holdout split | ~30% of total | exactly 6 |
| Contrast requirement | any mix | ≥ 3 with `qaOutcome="passed"` AND ≥ 3 with `qaOutcome != "passed"` |

**Fallback behavior:** if any v2 requirement is not met, the script falls back to v1 human-gated mode automatically:

```
Info: role "<role>" does not meet v2 data requirements (<reason>).
Falling back to v1 human-gated mode.
```

Reason strings: `"total_below_20"`, `"insufficient_contrast"`, `"insufficient_holdout"`.

The fallback is logged to `.mavp/reflect-log.jsonl` with `"mode": "v1-human"` and `"gateResult": "skipped"`.

#### 12.3 Autonomous apply conditions

Autonomous apply is enabled ONLY when ALL of the following five conditions hold simultaneously:

1. **Gate passes** — holdout delta ≥ 0.05 and no regression (Section 12.1).
2. **No protected sections were touched** — mechanically verified: after applying the proposed edits, the script re-extracts all `<!-- protected -->` ... `<!-- /protected -->` blocks and confirms they are byte-for-byte identical to the originals.
3. **lr budget was not exceeded** — the number of edit operations in the proposal is ≤ 2 (the default lr budget).
4. **Diff written before apply** — a human-readable diff of the proposed change is written to `.mavp/auto-apply-log/<role>-<date>.md` before the file is modified. If the write fails, the apply is aborted.
5. **Committed with audit marker** — the edited role spec is committed with a message containing `[auto-applied skill edit]` so the change is easily discoverable in `git log`.

If any condition fails, the proposal is demoted to v1 human-gated mode: written to `SKILL_PROPOSALS/<role>-<date>.md` for manual review, and `"outcome": "proposed-for-review"` is recorded in the reflect log.

**Auto-apply log format** (`.mavp/auto-apply-log/<role>-<date>.md`):

```markdown
# Auto-apply log: <role> — <date>

Gate delta: +<delta>
Edit ops: <count>
Protected sections unchanged: yes

## Diff

<unified diff of the proposed change>
```

#### 12.4 Reflect log format (`.mavp/reflect-log.jsonl`)

Each reflect run appends exactly one record. The file is append-only — never overwrite existing records.

```json
{
  "date": "YYYY-MM-DD",
  "role": "developer",
  "mode": "v1-human" | "v2-auto",
  "trajectoriesTotal": 20,
  "trainCount": 14,
  "holdoutCount": 6,
  "baselineMeanScore": 0.82,
  "proposedMeanScore": 0.89,
  "delta": 0.07,
  "gateResult": "passed" | "failed" | "skipped",
  "gateFailReason": null,
  "editOpsCount": 2,
  "outcome": "auto-applied" | "proposed-for-review" | "discarded"
}
```

| Field | Type | Description |
|---|---|---|
| `date` | string | ISO date of the reflect run. |
| `role` | string | Target role, e.g. `"developer"`. |
| `mode` | string | `"v1-human"` when falling back to human gate; `"v2-auto"` when automation gate was attempted. |
| `trajectoriesTotal` | integer | Total scored trajectories available for this role. |
| `trainCount` | integer | Trajectories in the training split. |
| `holdoutCount` | integer | Trajectories in the holdout split. |
| `baselineMeanScore` | number | Mean `scoreTrajectory` result on holdout using the current spec. `null` in v1-human mode. |
| `proposedMeanScore` | number | Mean `scoreTrajectory` result on holdout using the proposed spec. `null` in v1-human mode. |
| `delta` | number | `proposedMeanScore - baselineMeanScore`. `null` in v1-human mode. |
| `gateResult` | string | `"passed"` — gate cleared; `"failed"` — gate did not clear; `"skipped"` — v1 mode or pre-gate fallback. |
| `gateFailReason` | string or null | Reason string (Section 12.1) when `gateResult` is `"failed"`, otherwise `null`. |
| `editOpsCount` | integer | Number of edit operations in the proposal. `0` when no proposal was generated. |
| `outcome` | string | `"auto-applied"` — edits committed autonomously; `"proposed-for-review"` — written to `SKILL_PROPOSALS/`; `"discarded"` — gate failed, no proposal. |

`.mavp/reflect-log.jsonl` is committed to the repo alongside trajectory stores. It is **not** in `.gitignore`.

#### 12.5 Transition checklist — v1 to v2 per role

All four conditions below must be true before switching a role from v1 to v2:

1. The role has ≥ 20 merged trajectories in `.mavp/trajectories/<role>.jsonl`.
2. A pilot run (T-183 or equivalent) has confirmed signal quality for this role — at least one reflect run produced a `gateResult: "passed"` in the reflect log.
3. At least one successful v1 human-approved edit has been applied to `.claude/agents/<role>.md` and confirmed beneficial (i.e., was not reverted in a subsequent wave).
4. This `SKILL_OPTIMIZATION.md` v2 section has been reviewed and signed off by the main agent (document a one-line approval in the wave's `EXECUTION_LOG.md`).

Until all four conditions are met for a role, the script treats that role as v1-human regardless of trajectory count.

#### 12.6 Remaining v2 items (not yet specified)

The following v2 features are deferred beyond the automation gate and are not specified in this document:

- **Multi-role co-optimization:** run reflect across multiple roles in a single pass.
- **Active rollout generation:** generate synthetic task scenarios to probe edge cases.
- **Configurable lr per role:** allow different lr budgets per role based on volatility and trajectory volume.

---

## 13. Recommended cadence

Run the skill reflection loop **once per wave per role**, triggered by the operator at wave close (after `--close-session` but before `git push`).

**Typical workflow at wave close:**
1. Run `--close-session` to finalize the wave.
2. For each role that had 3+ tasks complete in the wave, run `./scripts/mavp-operator --reflect-skill <role>`.
3. Review any generated proposal in `SKILL_PROPOSALS/`.
4. Apply accepted edits to `.claude/agents/<role>.md`, commit.
5. Run validator to confirm health.
6. `git push`.

**When to skip:** If fewer than 3 tasks completed for a role in the wave, the trajectory signal added is thin — skip the reflect run and wait until the next wave. The minimum-N gate (Section 5) provides a hard floor regardless.

**Who triggers it:** The main agent or the human operator. Sub-agents do not trigger reflect runs on their own role specs.
