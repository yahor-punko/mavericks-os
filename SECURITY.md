# Security Policy

## ⚠️ Before you clone: this repo ships with autonomous tool execution enabled by default

Mavericks' committed `.claude/settings.json` sets:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

**What this means in practice:** `bypassPermissions` is the most permissive Claude Code permission mode. Unlike `acceptEdits` (which only auto-accepts file edits), `bypassPermissions` suppresses the interactive approval prompt for **every** tool call — file edits, Bash commands (including destructive ones), and network access all proceed without asking you first. On a fresh clone, if you open this project in Claude Code and start a session, agents will read, write, and execute across your filesystem and shell without a per-action confirmation dialog.

This is a deliberate framework default, not an oversight: it lets every contributor start from the same fully-autonomous baseline for agent-driven work, and it is documented as the intended shipped default in [`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md) (see the "Shared permission-mode default" note). The single remaining human checkpoint under this mode is the mandatory pre-push results review enforced by `--close-session` (see the "Mandatory pre-push review" convention in [`CLAUDE.md`](CLAUDE.md)) — there is no other approval gate between an agent's actions and their effect. An agent cannot self-grant this mode, either: adoption always passes through a human-run install command (see `docs/core/BOOTSTRAP_GUIDE.md`), which is the intended consent point for this default.

### How to opt out

`bypassPermissions` is the shipped **requested** default — the committed `.claude/settings.json` declares it, but the harness that resolves it at session start is not this repo's code, and a 2026-08 observation confirms the harness does not always honor the declared value (see below). Claude Code's settings precedence, as documented at time of writing, is: managed settings > CLI flags > `.claude/settings.local.json` (personal, gitignored) > `.claude/settings.json` (shared, committed) > `~/.claude/settings.json` (user-global) — under this order, a personal `settings.local.json` should always win over the shared default. **Known counter-observation:** for roughly three weeks in 2026-08, a user-global `~/.claude/settings.json` `defaultMode` of `dontAsk` — the layer this order ranks weakest — decided sessions instead of the committed `bypassPermissions`, with no local override in play. Nothing in this repo's artifacts explains why the divergence happened; the question is left open and harness-owned rather than answered — see DR-010 in `docs/core/DECISIONS.md`. Treat the precedence order above as a sourced claim, not a guarantee.

**Verify what mode is actually in effect:** the session-start brief (`./scripts/mavp-operator --agent`) reports a `permission_mode` field alongside `permission_mode_source` (`hook_payload` | `persisted_runtime` | `settings_file`) and `permission_mode_verified` (`true` only when a same-session harness channel confirmed it — otherwise the value is a *declared* setting, not a confirmed one). Read that line rather than assuming any opt-out below actually took effect:

1. Create or edit `.claude/settings.local.json` in your local checkout (it is gitignored and never affects other contributors).
2. Set your own `permissions.defaultMode` to one of `"default"`, `"plan"`, `"acceptEdits"`, or `"dontAsk"` — for example:

   ```json
   {
     "permissions": {
       "defaultMode": "acceptEdits"
     }
   }
   ```

3. Restart your Claude Code session, then check the `permission_mode` field reported at session start (above) to confirm the change actually took effect.

If you maintain a fork or a bootstrapped project derived from this repo, you can instead change `permissions.defaultMode` directly in the committed `.claude/settings.json` — see the migration notes in `docs/core/BOOTSTRAP_GUIDE.md` for how `mavp-install.js --update` treats existing values (it never overwrites a deliberately-set value other than the legacy `acceptEdits` default).

## Reporting a vulnerability

If you discover a security vulnerability in Mavericks (in the operator tooling under `scripts/`, the validator, the installer, or process docs that could lead to unsafe default behavior), please report it privately rather than opening a public issue.

- **Preferred:** open a [GitHub Security Advisory](https://github.com/yahor-punko/mavericks-os/security/advisories/new) on this repository. This keeps the report private until a fix is available.
- **Alternative:** email **yahorpunko@gmail.com** with a description of the issue, steps to reproduce, and the potential impact.

Please include:
- A clear description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is ideal).
- The affected file(s) or command(s), and the framework version (`./scripts/mavp-operator --version`) if applicable.

### What to expect

- We aim to acknowledge new reports within a few days.
- We will work with you to confirm the issue, assess severity, and prepare a fix before any public disclosure.
- Credit will be given in the fix's changelog entry unless you prefer to remain anonymous.

### Scope

In scope:
- The Node.js operator tooling in `scripts/` (`mavp-operator`, `mavp-validator.js`, `mavp-install.js`, and supporting libraries).
- The pre-commit hook and PostToolUse validator hook.
- Default configuration shipped by the installer (including `permissions.defaultMode`, as disclosed above).

Out of scope:
- Vulnerabilities in Claude Code itself (report those to Anthropic).
- Vulnerabilities in projects that have bootstrapped Mavericks but modified its defaults.
