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

Claude Code's settings precedence is: managed settings > CLI flags > `.claude/settings.local.json` (personal, gitignored) > `.claude/settings.json` (shared, committed) > `~/.claude/settings.json` (user-global). A personal `settings.local.json` always wins over the shared default, so you can opt out without touching the committed file:

1. Create or edit `.claude/settings.local.json` in your local checkout (it is gitignored and never affects other contributors).
2. Set your own `permissions.defaultMode` to one of `"default"`, `"plan"`, `"acceptEdits"`, or `"dontAsk"` — for example:

   ```json
   {
     "permissions": {
       "defaultMode": "acceptEdits"
     }
   }
   ```

3. Restart your Claude Code session for the setting to take effect.

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
