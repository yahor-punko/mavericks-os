# session.tape — VHS script for docs/assets/session-memory.gif
#
# Regenerate with: vhs docs/assets/session.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/session-memory.gif

Set Shell "bash"
Set FontSize 20
Set Padding 20
Set Width 1750
Set Height 910
Set Theme "Dracula"
Set TypingSpeed 20ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export PATH=$(git rev-parse --show-toplevel)/scripts:$PATH" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase session --reveal 900"
Sleep 400ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process): session has
# ~7 reveal beats x 900ms plus tool-exec overhead (~6.9s total runtime). The
# trailing Sleep is sized so the final frame holds ~1.3s after the story ends
# without a long static tail, and the GIF never cuts mid-story.
Sleep 7200ms
