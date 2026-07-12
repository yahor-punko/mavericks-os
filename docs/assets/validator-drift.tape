# validator-drift.tape — VHS script for docs/assets/validator-drift.gif
#
# Regenerate with: vhs docs/assets/validator-drift.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/validator-drift.gif

Set Shell "bash"
Set FontSize 20
Set Padding 20
Set Width 1245
Set Height 705
Set Theme "Dracula"
Set TypingSpeed 20ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export PATH=$(git rev-parse --show-toplevel)/scripts:$PATH" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase drift --reveal 1350"
Sleep 400ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process): drift has
# ~6 reveal beats x 1350ms plus tool-exec overhead. The trailing Sleep is
# sized so the final frame holds ~1.2s after the story ends without a long
# static tail, and the GIF never cuts mid-story.
Sleep 8300ms
