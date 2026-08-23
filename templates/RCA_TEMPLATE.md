# RCA: <short title>

See `docs/core/RCA_CODIFICATION.md` for the full process this template implements.

## Problem

<What happened. Observed symptoms. When/how it was noticed.>

## Timeline

- <YYYY-MM-DD HH:MM> — <event>
- <YYYY-MM-DD HH:MM> — <event>

## Root causes

### RC-1 — <name the cause, not the symptom>

<Explanation.>

### RC-2 — <name the cause, not the symptom>

<Explanation. Add more RC-N sections as needed.>

## Codification (mandatory)

Route each root cause above to exactly one mechanism. Do not leave any root cause unrouted; do not split one cause across two mechanisms.

Before choosing mechanism (c), apply the portability tie-break in `docs/core/RCA_CODIFICATION.md` — "The portability tie-break": memory is the residual route, not the default one.

### RC-1 routing
- **Mechanism:** [ (a) .claude/rules edit | (b) role-spec proposal via SKILL_PROPOSALS/ | (c) memory-index entry | (d) armed recheck | (e) mechanical enforcement ]
- **Detail:** <the proposed rules-file text / the SKILL_PROPOSALS filing note / the memory-index entry text / the `--arm-recheck` command with due date / the hook-validator-test change to file as a developer task>
- **Decision record (optional):** <DR-NNN, if this routing also warrants a decision record per docs/core/DECISIONS.md>
- **Follow-up task:** <T-NNN — registered by the Main Agent to implement this routing>

### RC-2 routing
- **Mechanism:** [ (a) | (b) | (c) | (d) | (e) ]
- **Detail:** <...>
- **Decision record (optional):** <DR-NNN>
- **Follow-up task:** <T-NNN>

<Add one routing block per root cause.>
