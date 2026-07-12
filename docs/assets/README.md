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

Each tape invokes the demo with `--demo --phase <name> --reveal <ms>`.
`--reveal <ms>` makes the demo itself pace its own story as discrete
full-screen frames (clearing the screen and sleeping in-process between
beats), so the tapes no longer need to guess per-step `Sleep` durations from
the outside. The reveal value is tuned per phase to hit a target GIF length
(dashboard 5–7s, session 8–12s, validator-drift 9–12s). Each tape has exactly
one trailing `Sleep`, sized so the final frame holds ~1.2–1.5s after the story
ends — long enough to read, short enough to avoid a long static tail — while
still covering the phase's full in-process runtime so the recording never cuts
mid-story:

- `dashboard.tape` — 2 beats → `--reveal 2050` → `Sleep 3700ms`
- `validator-drift.tape` — ~6 beats → `--reveal 1350` → `Sleep 8300ms`
- `session.tape` — ~7 beats → `--reveal 900` → `Sleep 7200ms`

The trailing `Sleep` and `--reveal` are coupled: the static tail at the end
≈ `Sleep − (beats × reveal) − overhead`. If the demo's phase content grows
(more beats, more reveals), re-check both against the phase's actual number of
`revealSleep()` calls in `scripts/mavp-operator-demo.js`, and re-measure the
output with `ffprobe` (see below).

## Sizing: font, crop, and no line-wrapping

Each tape sets `FontSize 20`, `Padding 20`, and a `Width`/`Height` cropped
tightly to that phase's widest content so the terminal fills the frame (the
README downscales the GIF, so a tight crop reads better than one padded with
dead space). The dimensions are deliberate — the demo's dashboard panels are
the widest content (~120 columns), so `Width` must stay large enough that no
panel or line wraps. If you change `FontSize`, re-derive `Width`/`Height`:
the terminal grid is `cols ≈ (Width − 2×Padding) / (0.66 × FontSize)` and
`rows ≈ (Height − 2×Padding) / (1.22 × FontSize)`; keep `cols` above the
phase's widest line and `rows` above its tallest screen (dashboard ~120×33,
session ~125×32, validator-drift ~86×23, plus a couple of rows for the shell
prompt). After any change, extract a mid frame
(`ffmpeg -i <gif> -ss <t> -vframes 1 /tmp/f.png`) and confirm nothing wraps.

Two notes on file size: VHS always writes GIFs at 25fps regardless of
`Set Framerate`, and the file size is dominated by the number of distinct
full-screen reveal frames (not the canvas size or the duration of static
holds). Tight, fast recordings are therefore heavier per second than the old
slow ones that sat on a long static frame.

## Verifying a regenerated GIF

```bash
# duration (seconds)
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 docs/assets/session-memory.gif
# dimensions (WxH)
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 docs/assets/session-memory.gif
```

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
