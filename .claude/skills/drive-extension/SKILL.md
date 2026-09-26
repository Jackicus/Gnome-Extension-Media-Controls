---
name: drive-extension
description: Run Media Controls in a throwaway nested GNOME Shell, mirrored live on the user's desktop, with VLC playing full screen inside it — move the pointer, press keys, plug in a virtual gamepad, screenshot, then shut it all down. Use whenever a change must be SEEN (the bar's layout, colours, reveal and hide, focus rings, the preferences window) or needs a fresh shell start (extension.js, metadata.json, the schema).
---

# Driving Media Controls in a nested shell

The bar is drawn over a fullscreen window, so the only way to verify a visual
change is to look at it. The nested shell is a complete second GNOME Shell with
its own session bus and virtual monitor, reading the same installed extension;
whatever the code breaks, it breaks there, never in the user's session (a throw
in `enable()` leaves the extension at State: ERROR, which `logs` shows).

It runs headless, and `start` opens a **live mirror window on the user's real
desktop** so they can watch. Two people are looking: you through screenshots,
the user through that window. Put a `say` before each step so both can follow.

## The loop

```bash
S=/tmp/claude-1000/...scratchpad            # your scratchpad; keep shots out of the repo
./scripts/nested.sh start --clean           # ~2 s; Media Controls is ACTIVE when it returns
./scripts/nested.sh player                  # VLC, full screen, test clip (made once, dist/)
./scripts/nested.sh do "say Showing the bar" "move 700 400" "move 760 430" "wait 0.5" \
                       "shot $S/bar.png 300 760 1000 140"
# ... edit src/ ...
./scripts/nested.sh reload
./scripts/nested.sh stop                    # closes the mirror, VLC, prefs, everything
```

`--clean` gives the nested shell its own settings database: only Media
Controls enabled, the real session's colour scheme, accent and fonts copied in,
and nothing written to the user's dconf — so no other extension shows in a
shot, and nothing clashes with another project's nested shell. Use it unless
the task is about how this extension sits beside the user's others (Dash to
Panel, Blur my Shell…), which only the plain `start` loads.

Then **Read the PNGs** and say what actually differs. If nothing visibly
changed, say so; do not assume the edit worked. Check what the player did with
`./scripts/nested.sh mpris` (status, position, volume, rate, title) — the bar
showing a pause is not the player pausing.

## Commands

| Command | Does |
|---|---|
| `player [--qt] [--windowed] [--plain] [FILE] [-- VLC ARGS]` | VLC in the nested session: cvlc by default, `--qt` for the Qt interface; full screen unless `--windowed`. No FILE = the generated 10-minute test pattern: running time burned in, audio Japanese/English, subtitles English "Second N"/Spanish "Segundo N" (one a second, so timing shows), a chapter every 2 min. Its throwaway vlcrc gets the tracks socket (the preferences' own code) unless `--plain`, which is how to check a VLC with no tracks button. Run it twice for two players. |
| `mpris` | The first player's PlaybackStatus, Position (µs), Volume, Rate, title |
| `mpris get PROP` / `set PROP '<VALUE>'` / `METHOD [ARGS]` / `Quit` | Poke it directly (`set Volume '<0.8>'`, `PlayPause`, `Quit`) |
| `pad [HOLD] BUTTON...` | Plug in a virtual Xbox 360 pad, wait HOLD s (default 1.5) for libmanette to open it, press each BUTTON, unplug. Buttons are the `gamepad-buttons` ids: `south` `east` `west` `north` `dpad-left` `dpad-right` `dpad-up` `dpad-down` `left-shoulder` `right-shoulder` `left-trigger` `right-trigger` `select` `start` `mode` `left-stick` `right-stick`, plus `wait:SECS`. |
| `do "STEP"...` | A batch over one connection: `say TEXT`, `move X Y`, `click X Y`, `key KEYSYM` (`Super+c`, `Escape`, `Right`, `Return`, `f`), `wait SECS`, `shot [FILE [X Y W H]]`, `window FILE` (the focused window alone, corners transparent — for the preferences), `overview on\|off` |
| `run CMD...` | Run against the nested bus **and displays** (never the real desktop's): `run gnome-extensions prefs media-controls@jackt` opens the preferences inside it |
| `reload`, `logs [N] [--all]`, `status`, `mirror on\|off` | As named. `[Media Controls]` lines are ours; `Attached to <player> (pid N)` says which player the bar belongs to. |

## Reading the screen (1600×900)

- **VLC's socket, directly:** while the extension is attached it holds VLC's
  one connection, so a `python3` probe of the socket hangs. Test the protocol
  on a headless VLC of your own instead (`cvlc -I dummy --extraintf oldrc
  --rc-fake-tty --rc-unix=$XDG_RUNTIME_DIR/<short>.sock --vout=dummy
  --aout=dummy --no-dbus FILE`, and kill it by pid).
- **Showing the bar:** two `move`s to different points over the player
  (`pointer-reveal` `anywhere`) — the pointer watcher only reacts to a change.
  With `bottom-edge`, the moves must land below y ≈ 720. It hides
  `hide-delay` (3) s after the last movement unless paused.
- **The bar:** panel `320,780` to `1280,872`; crop shots to `300 760 1000 140`.
  Seek slider on y ≈ 803 from x ≈ 405 to 1195 — `click 800 803` is the middle
  of the clip. Transport on y ≈ 840: previous 708, skip back 750, **play 799**,
  skip forward 850, next 891. **Tracks 1018** (when VLC's socket answered —
  give it ~3 s after `player` or a `reload`), mute 1057, volume slider
  1080–1160, rate 1194, **close 1240** (quits the player). At another
  `bar-scale`, or with the sleep button on, read positions off a `shot` first.
- **The pop-out** (`click 1018 841`) stands above the bar centred on the
  tracks button, x ≈ 900–1140; its height depends on the file (the default
  clip's chapters add a row), so `shot` it and read the item rows off that
  before clicking one. An item's highlight follows the pointer, so park the
  pointer away from the pop-out before checking where the keyboard or pad
  focus landed. Picking keeps it open. Opened with the mouse it needs
  one Escape; the next Escape goes to VLC (which leaves fullscreen).
- **Keyboard mode:** `key Super+c` opens it holding the keyboard with play
  focused; `Right`/`Left`/`Up`/`Down` move the focus, `Return` presses,
  `Escape` backs out a level. Keep the keys of one walk in one `do`.
- **Pad mode:** `pad start` does the same as Super+C; then `dpad-*`, `south`
  (press) and `east` (back) are the arrow keys, Return and Escape. `pad north`
  opens the pop-out with the current audio track focused. Each `pad` call plugs
  a fresh pad in (1.5 s), so for a walk with shots in between, open with `pad`
  and continue with `key` steps — the path is the same.
- **Preferences** (after `run gnome-extensions prefs media-controls@jackt`,
  `wait 2.5`): a 640×800 window, centred in the work area — so where it lands
  depends on the panels loaded. Under `--clean` (stock top bar) its tabs are
  Bar (687,86), Players (800,86), Controllers (925,86); with other panels, take
  a `shot` and read them off before clicking. The first frame after a tab
  switch can carry redraw leftovers; `wait 1` before a `window` shot. A pad
  plugged in while Controllers is showing lists itself, and a press lights its
  row and the button's row for 1.2 s — start `pad` in the background and shoot
  during it.
- **Two players:** `player --windowed` starts a second VLC in a window on top;
  `key f` makes the focused VLC fullscreen. The bar follows focus.

## Closing what you open

**`stop` when the task is finished — including when a check failed.** It TERMs
every process of the nested session (VLC, a prefs window, anything `run`
started) while the bus is still up, then the shell's own group, then checks
nothing survived and says so if something did — read that line. Keep one shell
up while iterating and `reload` into it; `start` reuses a running one.

Backstops, for accidents only: the mirror closes itself when the shell dies; a
shell started from a Claude Code session stops itself after 10 minutes with no
`nested.sh` command (`MEDIA_CONTROLS_NESTED_IDLE=<seconds>` at `start`, `0` =
never); the project's SessionEnd hook stops it when that session ends.

**`stop` + `start` at least once before calling a change done.** `reload` keeps
the old dconf snapshot and whatever the previous build left on screen; only a
fresh start exercises `extension.js` and the enable path as a login does. Edits
to `extension.js`, `metadata.json` or the schema *need* one.

## Gotchas

- **Settings.** Under `--clean`, change them inside the nested session:
  `run timeout 5 gsettings --schemadir src/schemas set org.gnome.shell.extensions.media-controls show-clock true`
  writes its own database alone, and takes effect at once. Without `--clean`,
  dconf is shared with the real session and every other nested shell
  (CLAUDE.md, Gotchas): change settings **before** `start` or **after**
  `stop`, never while another project's is up (`ls $XDG_RUNTIME_DIR/*-nested`),
  and put back what you changed.
- **VLC plays with no window** if it picks a GL output — the headless shell has
  no GPU for Xwayland. `player` passes `--vout=xcb_x11 --avcodec-hw=none`; keep
  them if you pass your own args.
- **Escape reaches VLC** when the bar does not hold the keyboard, and VLC's
  Escape leaves fullscreen — after which the bar (correctly) detaches. If a shot
  shows VLC in a window, that is why: `key f` or restart the player.
- **A virtual pad is a real kernel device**: the real session sees it too while
  it is plugged in. It does nothing there unless a fullscreen player is focused
  on the real desktop.
- **Screenshots for the README** live in `docs/screenshots/`: taken under
  `--clean`, 1600×900, the film is `dist/big-buck-bunny-demo.mkv` — Big Buck
  Bunny (CC BY 3.0, credited in the README) with two audio tracks (Stereo, 5.1
  Surround) and two subtitle tracks (English, Español), so the tracks pop-out
  has something to show. It was made by hand, is not in git and no script
  regenerates it; `make clean` leaves it alone. The hero is a JPEG, the
  preference windows PNGs from `window`.
- **Never click or hover at the top-left**: the Activities hot corner.
- **`Eval` is blocked** in the nested shell; drive it with input and D-Bus like a
  user would. Screenshots and banners borrow `org.gnome.SettingsDaemon.MediaKeys`
  on the throwaway bus; never try that on the real one.
- **Other extensions load too** without `--clean` (the nested shell reads the
  real enabled list): their top-bar icons and log lines appear alongside.
