# BACKLOG

## Selection rules

- unblockers first
- end-to-end value second
- quality/polish third
- docs/process last unless they unblock delivery

## Active Wave

### T-001 — Example task
- **Status:** planned
- **Owner:** developer
- **Depends on:** —
- **Root cause:** [optional — T-NNN of the task that closes the underlying structural cause]
- **Module:** [optional — module id from docs/MODULES.md, e.g. web-panel]
- **Repo:** [optional — repo name(s) this task touches, e.g. example-service]
- **Touches:** [optional — comma-separated file paths this task modifies, e.g. scripts/mavp-operator-lib.js, CLAUDE.md]
- **Stale risk:** false
- **Update architecture:** false
- **Requires UX review:** false
- **Requires config check:** false
- **Prod prerequisites:** [optional — comma-separated infra/env items required before prod deploy, e.g. prod CI workflow, ECR repo, secrets rotation]
- **Acceptance criteria:** [describe what done looks like]
  For `Verification type: runtime`, acceptance criteria MUST include a behavioral assertion — a known input and the expected observable output that input must produce. "Script runs without error" / "exit code 0" alone is a structural check and is not sufficient. Example: "given known-spam message X, the model output classifies it `spam`; given known-ham message Y, the model output classifies it `ham`" — not "the script executes and returns an output tensor." Anti-pattern: a degenerate ONNX spam-classification model reached production because its check asserted only correct tensor shape (`[1,128]` in → `[1,2]` out) while the model always output the same class — structure-only checks cannot catch this.
- **Verification type:** artifact | runtime | visual | manual
- **Evidence expected:** [what evidence confirms completion]
  Example for merged tasks: `commit: <hash>  branch: main — <description>` (colon after `commit` is required; `commit abc1234` or `Commit abc1234` will fail validation)
- **Next if passed:** T-002

## Completed tasks

