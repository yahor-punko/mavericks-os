# validator-drift.tape — VHS script for docs/assets/validator-drift.gif
#
# Regenerate with: vhs docs/assets/validator-drift.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/validator-drift.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 800
Set Theme "Dracula"
Set TypingSpeed 40ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase drift --reveal 1500"
Sleep 800ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process): drift has
# ~4 beats x ~2 reveals each x 1.5s per reveal, so a single generous trailing
# Sleep covers the full runtime plus margin so the GIF never cuts mid-story.
Sleep 16s
