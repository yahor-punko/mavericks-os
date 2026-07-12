# dashboard.tape — VHS script for docs/assets/operator-dashboard.gif
#
# Regenerate with: vhs docs/assets/dashboard.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/operator-dashboard.gif

Set Shell "bash"
Set FontSize 16
Set Width 1500
Set Height 1050
Set Theme "Dracula"
Set TypingSpeed 40ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase dashboard --reveal 1500"
Sleep 800ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process), so a
# single trailing Sleep covering the full runtime plus margin is all that's
# needed here — the dashboard phase is one beat.
Sleep 6s
