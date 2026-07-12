# docs/assets — README demo GIFs

This directory holds the three animated GIFs embedded in the top-level `README.md`
to demonstrate `./scripts/mavp-operator --demo`:

- `operator-dashboard.gif` — regenerated from `dashboard.tape` (`--phase dashboard`)
- `validator-drift.gif` — regenerated from `validator-drift.tape` (`--phase drift`)
- `session-memory.gif` — regenerated from `session.tape` (`--phase session`)

## Prerequisite

All three GIFs are recorded with [charmbracelet/vhs](https://github.com/charmbracelet/vhs):

```bash
brew install vhs
```

`vhs` in turn needs `ttyd` and `ffmpeg` on `PATH` — Homebrew installs both as
dependencies automatically. If you installed `vhs` a different way, install
`ttyd` and `ffmpeg` yourself first.

## Regenerating the GIFs

Run all three tapes from the repo root:

```bash
vhs docs/assets/dashboard.tape
vhs docs/assets/validator-drift.tape
vhs docs/assets/session.tape
```

Each tape writes its `.gif` output directly into `docs/assets/`. Review the
regenerated GIFs by eye (they are binary files — diffing them is meaningless)
before committing.

## Pacing: `--reveal` and one trailing `Sleep`

All three tapes invoke the demo with `--demo --phase <name> --reveal 1500`.
`--reveal <ms>` makes the demo itself pace its own story as discrete
full-screen frames (clearing the screen and sleeping in-process between
beats), so the tapes no longer need to guess per-step `Sleep` durations from
the outside. Each tape has exactly one generous trailing `Sleep` sized to
cover that phase's full in-process runtime plus margin, so the recording
never cuts off mid-story:

- `dashboard.tape` — one beat → `Sleep 6s`
- `validator-drift.tape` — ~4 beats → `Sleep 16s`
- `session.tape` — ~5 beats → `Sleep 20s`

If the demo's phase content grows (more beats, more reveals), re-check the
trailing `Sleep` against the phase's actual number of `revealSleep()` calls
in `scripts/mavp-operator-demo.js` and raise it if needed.

## Why the tapes set `HOME` to an empty temp directory

All three tapes' `Hide` block runs `export HOME=$(mktemp -d)` before invoking
the demo. `mavp-operator --demo` shells out to the real dashboard tooling,
which includes a today's-token-usage scan that reads `~/.claude/projects`.
Without this override, the recording would leak the maintainer's real global
token totals into the frame. Pointing `HOME` at a fresh, empty temp directory
keeps each recording both private (no real machine data ever appears on
screen) and deterministic (every regeneration starts from the same empty
state, regardless of who runs it or what their local `~/.claude/projects`
history contains).

## CI

CI does not require `vhs` — these tapes are a maintainer-only regeneration
path, not part of the build or test pipeline. The tapes are designed to run
cleanly from a fresh checkout with no other setup beyond installing `vhs`.
