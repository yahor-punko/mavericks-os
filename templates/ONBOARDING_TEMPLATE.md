<!-- Orientation only. Canonical rules live in CLAUDE.md and docs/core/. Do not add rule text here. -->
# Welcome to your Mavericks-powered project

## What this file is
A one-time welcome — it disappears after your first session. Just here to orient you.

## How you actually work
You don't drive this framework by hand — you talk to your agent (Claude Code) in plain language. You say what you want; it plans the work, hands pieces to specialized helpers, keeps the project's state and docs in order, and checks its own work as it goes.

## Sessions
Every session starts the same way: you type /session-start and your agent tells you where things stand. When you're ready to stop for the day, just ask your agent to close the session — it wraps things up and remembers where you left off for next time.

## Waves
A wave is a batch of work aimed at one goal you set for your agent. Once that goal is met, you close the wave together and pick the next one.

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
Your agent follows a shared set of rules baked into this project, plus the wider operating model every mavericks-powered project shares. Specifics live in `CLAUDE.md` and `.claude/rules/` here, and in `docs/core/` inside your mavericks installation ($MAVERICKS_HOME, default `$HOME/.mavericks`, falling back to the legacy `~/Documents/mavericks` if that's where your checkout lives).

## First step
Tell your agent your project goal and what you'd like to tackle first. It takes it from there.
