---
description: Show recent Media Controls output from the GNOME Shell journal
argument-hint: "[systemd time spec, e.g. '5 min ago' — defaults to 10 min]"
allowed-tools: Bash(./scripts/dev.sh logs:*)
---

Show what the extension has logged recently.

Time window requested: $ARGUMENTS

Run `./scripts/dev.sh logs "<window>"`, using the window above — or `10 min ago`
if it's empty. Anything systemd accepts works (`5 min ago`, `today`, `09:00`).

Summarise rather than dump: how many enable/disable cycles, which players the
bar attached to (`Attached to … (pid N)`), which controllers came and went, and
any errors or stack traces in full. Exceptions inside a GNOME extension only
ever surface here, never in a terminal, so this is the place to look when the
bar silently never shows.
