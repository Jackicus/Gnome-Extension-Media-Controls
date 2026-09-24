---
description: Show Media Controls over a fullscreen VLC in a nested shell, mirrored live on the desktop, and describe what it looks like
argument-hint: "[optional: what to try first, e.g. 'pause it', 'keyboard mode', 'press A on a pad']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Media Controls currently looks like, using the `drive-extension`
skill. The user is watching the mirror window, so narrate with `say` before each
step.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start --clean` (reuses one if running; opens the mirror window;
   Media Controls is ACTIVE when it returns), then `./scripts/nested.sh player`.
2. In **one** `./scripts/nested.sh do …` call: `say`, two `move`s over the
   player to bring the bar up, anything requested above, then
   `shot <scratchpad>/bar.png 300 760 1000 140`. Use `pad` for controller
   buttons and `mpris` to confirm what the player actually did.
3. **Read the PNG** and describe what's actually on screen — layout, spacing,
   state of the buttons, anything visibly broken.
4. `./scripts/nested.sh stop` when done, even if a step failed, and read its
   last line: it says whether anything of the nested session survived.

Check `./scripts/nested.sh logs` if the bar never appears; a JS exception in
`enable()` reads as "nothing happened".
