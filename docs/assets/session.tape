# session.tape — VHS script for docs/assets/session-memory.gif
#
# Regenerate with: vhs docs/assets/session.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/session-memory.gif

Set Shell "bash"
Set FontSize 16
Set Width 1500
Set Height 850
Set Theme "Dracula"
Set TypingSpeed 40ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase session --reveal 1500"
Sleep 800ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process): session
# has ~5 beats x ~2 reveals each x 1.5s per reveal, so a single generous
# trailing Sleep covers the full runtime plus margin so the GIF never cuts
# mid-story.
Sleep 20s
