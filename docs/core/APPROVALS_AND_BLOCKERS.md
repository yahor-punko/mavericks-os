# Approvals and blockers

## Rule

Approval-sensitive blockers should be surfaced immediately and in a short standard form.

## Recommended format

```text
Blocker:
/approve <id> allow-once

Command:
<exact shell command>
```

## Why

Approval loops are process blockers. They should not be buried in long prose.

## Silence rule

If active work is blocked or paused for too long, emit a short status heartbeat instead of waiting for the human to ask.

## Additional guardrails

- After any sub-task result that obviously implies an orchestrator-run command, immediately run that command and surface the approval request in the same turn.
- Do not end on phrases like “next run for me” or “the next command is ...” without issuing the actual command or blocker request.
- Do not ask for approval to “continue a sub-agent” when the real blocker is an orchestrator-run command; move the blocker to the orchestrator and show the concrete command instead.
- If approval is required, the next user-facing message should be a standalone blocker-first message, not a mixed progress update. Put the exact `/approve <id> allow-once` and exact command in a clearly foregrounded format so the user never has to ask whether approval is needed.
