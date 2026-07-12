# dashboard.tape — VHS script for docs/assets/operator-dashboard.gif
#
# Regenerate with: vhs docs/assets/dashboard.tape  (run from the repo root)
# See docs/assets/README.md for prerequisites and details.

Output docs/assets/operator-dashboard.gif

Set Shell "bash"
Set FontSize 20
Set Padding 20
Set Width 1710
Set Height 940
Set Theme "Dracula"
Set TypingSpeed 20ms

Hide
Type "cd $(git rev-parse --show-toplevel)" Enter
Type "export PATH=$(git rev-parse --show-toplevel)/scripts:$PATH" Enter
Type "export HOME=$(mktemp -d)" Enter
Type "clear" Enter
Show

Type "mavp-operator --demo --phase dashboard --reveal 2050"
Sleep 400ms
Enter

# Pacing is driven by the demo's own --reveal frames (in-process): the
# dashboard phase has 2 reveal beats (banner, then the rendered dashboard) x
# 1800ms. With only two beats, the trailing Sleep holds the final dashboard —
# the payoff frame — for ~1.8s of reading time before the GIF ends; it never
# cuts mid-story.
Sleep 3700ms
