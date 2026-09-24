---
description: Report install mode, shell state, and the players and controllers the extension can see
allowed-tools: Bash(make status), Bash(./scripts/dev.sh status), Bash(./scripts/dev.sh devices)
---

Run `./scripts/dev.sh status` and `./scripts/dev.sh devices`, and report:

- **install** — `symlink` means dev mode (edits in `src/` are live after a
  reload); `copy` means a real install that won't pick up edits until
  `make install` is re-run.
- **state** — `ACTIVE` is healthy. `unknown to the running shell` means the UUID
  was never registered, which needs a logout, not a reload.
- **pads** — whether libmanette is installed; without it the bar works but game
  controllers do not.
- **players** — every MPRIS player on the session bus, with its desktop entry,
  pid and state. The bar attaches to whichever of them owns the focused
  fullscreen window, unless it is on `ignored-players` (browsers by default).
- **controllers** — every pad libmanette sees, its SDL GUID, and whether a
  mapping is known (`NO MAPPING` means its buttons may not match the
  positions in the preferences).

If anything is off, say which command fixes it.
