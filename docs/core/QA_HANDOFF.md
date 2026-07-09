# QA handoff

## Purpose

Turn QA from an implicit chat behavior into a visible workflow artifact.

## Convention: QA is a stage, not a task

QA is a lifecycle stage on the implementation task (`dev_done → ready_for_qa → qa_passed`). Do not create a standalone backlog task whose sole purpose is to validate sibling implementation tasks — this leaves those tasks stuck at `dev_done` and produces misleading backlog state.

If a multi-task integration QA pass is genuinely required, implementation tasks must declare `- **Depends on:** T-NNN` (the integration QA task) and the Main Agent promotes them together after QA passes. The QA result does not auto-propagate; each task receives its own status update.

## Lifecycle

`in_progress -> dev_done -> ready_for_qa -> qa_in_progress -> qa_passed|needs_fix -> merged`

## Minimum evidence at each stage

### dev_done
- task ID
- short implementation summary
- files changed or artifacts produced
- known caveats
- optional: `branch: <name>` (e.g. `main`, `develop`, `both`) — recommended for projects with branch-based deploy contours; validator warns when `commit:` is present but `branch:` is absent

### ready_for_qa
- orchestrator coherence check
- explicit evidence for QA to inspect
- acceptance focus clarified

### qa_in_progress
- task under review identified
- review focus stated
- review evidence named
- check `manual_changes:` — if non-empty, confirm all out-of-band operations are reflected in committed code or config

### qa_passed / needs_fix
- outcome recorded
- what was checked recorded
- reason for pass/fail recorded
- for tasks with `requires_config_check: true`: `config_check:` block must be present in evidence — list each config key confirmed present and correct in target environment; `qa_passed` must not be set without it

### merged
- orchestrator acceptance recorded
- next-task selection updated
- `completed_at` date recorded in TASK_STATUS when known (enables cycle time tracking)
- for `runtime` and `unit` verification types: evidence must include `commit: <hash> — <one-line summary>` (the validator warns if absent)

## Checklist for `verification_type: runtime` tasks

When a task declares `verification_type: runtime`, QA must confirm observable behavior in a live environment — not just that the code merged. This only works when there is a concrete, reproducible way to observe that behavior.

**Acceptance criteria MUST include a behavioral assertion.** A behavioral assertion states a known input and the expected observable output that input must produce. "Script runs without error" or "exit code 0" is a structural check, not a behavioral one, and does not satisfy this requirement on its own.

- **Concrete example:** for a spam-classifier inference script, the acceptance criterion must read "given known-spam message X, the model output classifies it `spam`; given known-ham message Y, the model output classifies it `ham`" — not "the script executes and returns an output tensor."
- **Anti-pattern — structure-only checks are insufficient:** a degenerate ONNX spam-classification model reached production because its acceptance check asserted only that inference produced a tensor of the correct shape (`[1,128]` in → `[1,2]` out). Every input produced a correctly-shaped tensor, but the model had collapsed to a constant output and never actually separated spam from ham. QA must reject a runtime task whose acceptance criteria assert only structure (shape, exit code, "no exception thrown") with no expected-output-for-known-input pairing — send it back as `needs_fix` with a note that a behavioral assertion is missing.

**At task-creation time**, the author should record how the runtime result can be verified. Use an optional `evidence_query:` field in the task Notes or TASK_STATUS evidence block:

```
evidence_query: <log pattern | metric query | grep command | dashboard check>
```

Examples:
- `evidence_query: grep "email_sent entityId=" /var/log/app.log | tail -20`
- `evidence_query: CloudWatch Insights — filter @message like "payment_processed" | stats count() by requestId`
- `evidence_query: Datadog metric synth.job.processed > 0 in last 5 min after deploy`

This field is **optional** — not all projects use the same log or metrics system. It is **recommended** for any runtime task where the confirming signal is not obvious.

**If `evidence_query:` is absent**, QA should ask: "What log line, metric, or query proves this worked?" before marking `qa_passed`. If no discriminating signal exists, note that in the evidence and explain how correlation was performed (e.g. time-window match, manual log stream cross-reference).

**Checklist for task authors (runtime tasks):**
- [ ] Do the acceptance criteria state a known input and the expected observable output (a behavioral assertion), not just "runs without error"?
- [ ] Is there a log line, metric, or query that uniquely proves this feature ran?
- [ ] Does the log entry include a discriminating identifier (entity ID, request ID, correlation token)?
- [ ] Is that query or pattern recorded in `evidence_query:` so QA can reproduce it independently?
- [ ] If none of the above applies: is the absence noted in the task notes with a fallback verification plan?

## Success condition for a healthy handoff

A new contributor should be able to reconstruct:
- what was handed off
- what QA checked
- why it passed or failed
- what happens next

without relying only on chat history.
