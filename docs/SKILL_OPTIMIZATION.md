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

The optimizer model (pinned to the current Opus generation — see the model-pin comment above the `client.messages.create` call in `scripts/mavp-skill-reflect.js`) receives:
- **Success minibatch** — trajectories scoring ≥ 0.7 (after the train/holdout split).
- **Failure minibatch** — trajectories scoring < 0.7.

The model identifies patterns in what high-performing task completions have in common and where low-performing completions deviate. It then proposes specific, bounded edits to the role spec.

Protected sections (see Section 7) are stripped before the doc is passed to the optimizer and are mechanically reinserted unchanged after edit proposal generation.

**Optimizer failure modes.** The optimizer step can fail in three distinct ways, and the script tells them apart rather than collapsing them into one generic label:

- **API transport failure** — the call to the optimizer model never landed at all (bad key, network error, auth rejection). This is the only class labelled as a call failure; the label is scoped to the API call itself, not to anything that happens after a response is received.
- **Unexpected response shape** — the call landed and a response came back, but it carried no text content block (for example, the model returned only a reasoning/thinking block, or stopped before producing any text). The diagnostic names the block types actually present in the response and the response's stop reason, so a budget exhaustion can be told apart from a model that returned only reasoning.
- **JSON parse failure** — text came back, but it was not the requested JSON object. The diagnostic carries a leading excerpt of the raw text plus the response's stop reason, so a truncated response is recognisable.

None of the three aborts the run: all three write the proposal file with an `Optimizer error:` line, propose zero edits, and exit 0. A proposal with no edits should be read for that line before assuming the reflection loop itself is broken.

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

**Base score from QA outcome** (`scoreTrajectory()` in `scripts/mavp-operator-lib.js`):

| `qaOutcome` value | Base score |
|---|---|
| `"passed"` | 1.0 |
| `"skipped"` | 0.8 |
| `"passed_after_needs_fix"` | **superseded — no base score** |
| `"failed"` | 0.0 |

`"skipped"` covers `artifact`/`unit`-verification tasks that skip the QA agent pass (see the **Verification types** convention in `CLAUDE.md`) — the shipped rubric scores these lower than a full QA pass but well above a failure.

`"passed_after_needs_fix"` no longer has a base score of its own. `extractTrajectories()` (`scripts/mavp-operator-lib.js`) does not emit this value — a task that passed after one or more `needs_fix` round-trips is recorded with `qaOutcome: "passed"` (base 1.0), and the round-trip cost is captured entirely by the `needsFixCount` penalty below, not by a separate base score. Section 3's schema table still lists `"passed_after_needs_fix"` as an enum value for historical reasons; treat this note as the live statement of which values `scoreTrajectory()` actually scores.

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

**Examples** (recomputed against the shipped base scores above; cross-checked against the `scoreTrajectory examples` comment block directly above `getDeployPendingForRepo` in `scripts/mavp-operator-lib.js`):

| Scenario | Calculation | Final score |
|---|---|---|
| Clean pass, no issues | 1.0 | 1.0 |
| Passed after 1 needs_fix round-trip | 1.0 − 0.1 × max(0, 1−1) | 1.0 |
| Passed after 2 needs_fix round-trips | 1.0 − 0.1 × max(0, 2−1) | 0.9 |
| Passed after 1 needs_fix + validator exit 2 | 1.0 − 0.1 × max(0, 1−1) − 0.2 | 0.8 |
| Passed but 2 scope flags | 1.0 − 0.2 | 0.8 |
| Skipped (artifact/unit task, no QA agent pass), no issues | 0.8 | 0.8 |
| Skipped with validator exit 2 + 1 scope flag | 0.8 − 0.2 − 0.1 | 0.5 |
| Failed with validator exit 2 + 1 scope flag | 0.0 − 0.2 − 0.1 → clamped | 0.0 |
| Passed after 3 needs_fix + validator exit 2 + 2 scope flags | 1.0 − 0.1 × max(0, 3−1) − 0.2 − 0.2 | 0.4 |

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

No proposal file is written when this gate fires. The script exits 0 — the min-N gate is a "skipped with a reason," not an error, per the exit-code contract stated in the header comment of `scripts/mavp-skill-reflect.js` (`0 — proposal written (or skipped with a reason)`; `1` is reserved for unrecoverable errors such as a bad role argument, a file-read failure, or a missing API key).

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
- Success batch size: <N successes>
- Failure batch size: <N failures> (<comma-separated failure task IDs, or "none">)

> **Low-contrast warning:** this proposal's failure batch has only <N failures> trajectory/trajectories (<failure task IDs>) — below the contrast floor of 3 (docs/SKILL_OPTIMIZATION.md §12.2). Treat the rationale below as generalized from very few cases, not a stable pattern.

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

## Conflict check

The optimizer that generated this proposal was not shown this project's own operating rules (`.claude/rules/*.md`, `CLAUDE.md`) or the framework's `docs/core/ORCHESTRATION_RULES.md`, and cannot self-check a proposed edit against them. Before deciding below, check each proposed edit against all three:

- [ ] Checked against this project's `.claude/rules/*.md`
- [ ] Checked against this project's `CLAUDE.md`
- [ ] Checked against the framework's `docs/core/ORCHESTRATION_RULES.md`

## Decision
- [ ] Accept all
- [ ] Accept with modifications (describe below)
- [ ] Reject
```

**Notes on fields:**
- `<N train>` is the count of trajectories in the training split (see Section 11 for the current split rule — no longer a fixed 70% prefix).
- `<N total>` is the total count of scored trajectories for the role.
- `<min>` and `<max>` are the lowest and highest scores in the training split.
- `<N successes>` / `<N failures>` are the sizes of the success and failure minibatches actually passed to the optimizer (Phase 2, Section 2) — computed from the training split only: up to 10 highest-scoring trajectories with score ≥ 0.7 for the success batch, up to 10 lowest-scoring trajectories with score < 0.7 for the failure batch (`renderFailureContrastDisclosure()` in `scripts/mavp-operator-lib.js`, called from `scripts/mavp-skill-reflect.js`).
- The failure batch task IDs are listed inline in the "Failure batch size" line so a reviewer can see exactly which trajectories informed the proposal without opening the trajectory store.
- The `> **Low-contrast warning:**` line appears only when the failure batch has fewer than 3 trajectories (`FAILURE_CONTRAST_FLOOR` in `scripts/mavp-operator-lib.js`, anchored to the v2 contrast requirement in Section 12.2) — it is omitted entirely otherwise. It is disclosure-only: a low-contrast failure batch never blocks proposal generation, and the same caveat text is also injected into the optimizer's own prompt so the model itself is warned not to over-generalize.
- Each edit block is numbered sequentially. There are at most `lr` edit blocks (default: 2).
- `<op>` is exactly one of: `add`, `delete`, `replace`.
- For `add` operations, "Before" is `(none)`.
- For `delete` operations, "After" is `(none)`.
- The `## Conflict check` block is rendered by `renderConflictCheckChecklist()` (`scripts/mavp-operator-lib.js`), the same helper that also feeds the equivalent disclosure into the optimizer's own prompt via `buildOptimizerPrompt()` — see the note under Section 9 below and `docs/core/ORCHESTRATION_RULES.md` — "Test-execution scope (worktree developers)" for the incident this closes (T-703). It appears in every generated proposal, not only low-contrast ones.

---

## 9. Human review gate

**How to accept edits:**
1. Open `SKILL_PROPOSALS/<role>-<date>.md`.
2. Review each proposed edit against the rationale and the pattern it addresses.
3. Fill in "Reviewer notes" with any observations.
4. **Conflict check (T-703):** the optimizer that drafted this proposal was never shown this project's own operating rules (`.claude/rules/*.md`, `CLAUDE.md`) or the framework's `docs/core/ORCHESTRATION_RULES.md` — its prompt explicitly discloses this and prohibits it from proposing edits that mandate process-level behavior (test-execution scope, git operations, push/commit rituals, task registration or status, permissions), but it can still miss a subtler conflict. Before marking Decision, check each proposed edit against all three corpora and tick the checklist boxes in the "Conflict check" section. This step exists precisely because a proposal has, in a live run, recommended an edit that re-mandated behavior those corpora already categorically prohibit — the "run the full existing test suite" example is exactly the incident `docs/core/ORCHESTRATION_RULES.md` — "Test-execution scope (worktree developers)" was written to close.
5. Mark the "Decision" checkbox.
6. Manually apply accepted edits to `.claude/agents/<role>.md`. Do not use automated apply in v1 — edit the file directly.
7. Run the validator: `./scripts/mavp-operator --validate`. Confirm exit code 0.
8. Commit both `.claude/agents/<role>.md` and the proposal file with a message referencing the wave and role.

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

**Trajectory store format:** newline-delimited JSON (JSONL). Each line is one trajectory record (Section 3). **Rewrite, not append:** `writeTrajectories()` (`scripts/mavp-operator-lib.js`) overwrites `.mavp/trajectories/<role>.jsonl` on every `--reflect-skill <role>` run with a canonical snapshot — its own doc comment states the rewrite is intentional, "each run produces a canonical snapshot." Records are deduplicated by `taskId` (last-wins: the most recently extracted record for a given task replaces any prior one); records without a `taskId` pass through unchanged rather than being dropped. A trajectory reaches the file because each run re-extracts the full history from `TASK_STATUS.md`/`BACKLOG.md`/`EXECUTION_LOG.md` and writes the whole set back out — not because a new line is appended onto an untouched prior file.

---

## 11. Train/holdout split

Trajectories are split into train and holdout partitions by `splitTrajectoriesForReflect()` (`scripts/mavp-operator-lib.js`), keyed on the numeric portion of each trajectory's `taskId`. This is a deterministic stratified split, not a percentage-based prefix slice:

- **Failures always go to train.** Any trajectory scoring below 0.7 is placed in train unconditionally, regardless of its `taskId`. A failure is the scarce contrast signal the failure minibatch (Phase 2, Section 2) exists to consume — withholding one in a holdout set that no v1 code path reads would be pure loss with no offsetting benefit.
- **Successes split by numeric-ID modulo.** A trajectory scoring ≥ 0.7 goes to holdout iff `numericId % 10` is 7, 8, or 9 (3 of the 10 possible remainders); otherwise it goes to train. An id whose numeric portion can't be parsed goes to train.
- **Deterministic and, for the first time, genuinely per-task stable.** The split uses no RNG, no clock, and no run-order dependence — a task's bucket is a pure function of its own numeric id alone, so it never migrates between train and holdout purely because the corpus grew. This closes a gap in the split it replaced (a `taskId`-order prefix slice, `trainCount = floor(n * 0.7)`): that boundary moved every time the corpus grew, so a task sitting near the boundary could cross from holdout into train (or vice versa) solely because unrelated, newer tasks pushed the cutoff — the "same `taskId` always falls in the same partition" claim was asserted but not actually true. The current split is the first version of this document where that claim holds.
- **Holdout size is ~30% in expectation, not exactly 30%.** Because the modulo rule applies only to successes (3 of 10 buckets) and failures are excluded from it entirely, the realized holdout fraction floats near 30% rather than landing on it exactly — the actual size depends on the corpus's mix of failures vs. successes.
- **A trajectory can legitimately move from holdout to train between runs.** If a trajectory's score changes — for example because its evidence was later enriched with a previously-missing `needs_fix_rounds:` or `validator_blocked:` field and it is reclassified from success to failure — it moves into train on the next run regardless of which modulo bucket its id falls in. This is intended, not drift: a newly recognized failure must reach the optimizer.
- The holdout set is **not used in v1** beyond ensuring it is excluded from training minibatches — it is reserved for the v2 automated re-scoring gate (see Section 12.1); do not evaluate it against a spec in v1.
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
