<!-- Orientation only. Canonical rules live in CLAUDE.md and docs/core/. Do not add rule text here. -->
# Welcome to your Mavericks-powered project

## What this file is
A one-time welcome — it disappears after your first session. Just here to orient you.

## How you actually work
You don't drive this framework by hand — you talk to your agent (Claude Code) in plain language. You say what you want; it plans the work, hands pieces to specialized helpers, keeps the project's state and docs in order, and checks its own work as it goes.

## What your agent handles for you
Turning your goals into tracked tasks, moving them through build → review → done, running the safety checks, and wrapping up each round of work. You watch it happen — you don't have to run it.

## What stays with you
The decisions only you can make — what to build, the trade-offs — and the final go-ahead before anything is pushed or published. The agent always stops and asks first.

## If you're curious
Just ask: "what's the plan?", "where do things stand?", "what's left before we ship?" Under the hood your agent uses an operator tool (`./scripts/mavp-operator`), but you never need to memorize commands.

## Working across several sessions?
Before you wrap up a big piece of work, ask me to save a handoff — I'll write
down where we are so your next session picks up without you re-explaining anything.

## The rules it follows
Live in `CLAUDE.md` and `.claude/rules/` here in your project, plus the shared operating model in your mavericks installation ($MAVERICKS_HOME, default `~/Documents/mavericks`) under `docs/core/`.

## First step
Tell your agent your project goal and what you'd like to tackle first. It takes it from there.
