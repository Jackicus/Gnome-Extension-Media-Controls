# Media Controls

A GNOME Shell extension (UUID `media-controls@jackt`) that draws a control bar
over a **fullscreen video player** — a replacement for VLC's own fullscreen
controller that works the same way over mpv, Celluloid or anything else that
speaks MPRIS. It is a bar the shell draws over the player's window, not a
player. Shell versions 48 to 50 (50 by boot, 48 and 49 by audit against the
shell's sources — see Gotchas). GJS, ES modules.

It came out of Media Libraries (`~/Projects/Gnome-Extension-Media-Libraries`)
but shares nothing with it and does not depend on it. Media Libraries follows
playback over MPRIS for its watched marks and resume; this one drives the
player. Neither duplicates the other, and both can run at once.

## Seeing it

The bar is drawn over a fullscreen window, so a change is only verified by
looking at it. `make nested` starts a **headless nested GNOME Shell**, loads the
extension into it, and opens a **live mirror window on the real desktop** (a
PipeWire screencast of the nested monitor) so the user can watch without logging
out. `./scripts/nested.sh player` plays a generated test clip in VLC inside it,
full screen; `mpris` reads or pokes that player; `pad` plugs in a virtual Xbox
pad and presses buttons on it. **`start --clean`** gives it a settings database
of its own — only this extension enabled, the real session's look (colour
scheme, accent, fonts) copied in, nothing written to `~/.config/dconf/user` —
which is what screenshots are taken in (`docs/screenshots/`, with the `window`
step for the preferences) and what to use whenever another project's nested
shell is up.

Read the **`drive-extension` skill** before driving it; it has the lifecycle,
the coordinates and the traps. Keep one nested shell up across edits and
`reload` into it; `make nested-stop` tears it down — **always** do that when
finished, and read what it prints: it checks that nothing of the nested session
survived (a prefs window kept Media Libraries' nested shell alive after a
`stop` that reported success) and says so if something did.

All `make` targets delegate to `scripts/`: `dev.sh` for the extension itself and
`nested.sh` for the nested shell. Put new logic in those, not in the Makefile.
`./scripts/dev.sh devices` lists the MPRIS players on the bus and the pads
libmanette sees — the same two lists the preferences show.

## Layout

`src/` is an **exact mirror of the installed extension directory** (`make link`
symlinks it). Add a file to `src/` and it ships.

```
src/extension.js     loader: stages lib/ under $XDG_RUNTIME_DIR/media-controls/
src/lib/app.js       which player, when the bar is seen, the key, perform(action)
src/lib/mpris.js     PlayerRegistry + Player: the players on the bus, their
                     reckoned position, and the calls the bar makes
src/lib/bar.js       ControlBar: the St widget (seek row, transport, volume,
                     rate, close) and CentredRowLayout
src/lib/gamepads.js  libmanette → actions
src/lib/actions.js   pure data shared with prefs.js: ACTIONS, BUTTONS, RATES,
                     formatTime, playerNames/isIgnored
src/lib/anim.js      the only durations and curves
src/prefs.js         Bar / Players / Controllers pages
src/schemas/         org.gnome.shell.extensions.media-controls
```

The **action vocabulary** (`ACTIONS` in `actions.js`) is the one list every input
speaks: the bar's buttons emit an action id, the pads map a button id to one
(`gamepad-buttons`), and `app.js` `perform()` is the only place an action turns
into a call on the player. Add an action there and in `ACTIONS`, and both the
pads and the preferences pick it up. `actions.js` is imported by `prefs.js`,
which runs outside the shell: it must never import St, Clutter or `ui/`.

`extension.js` is Media Libraries' loader: it copies `lib/` into a directory
named after a checksum of its files and imports from there, because GJS caches
modules by URL for the life of the shell — so `reload` picks up edits without a
restart, and an unlock re-enables into the same module graph.

## How it fits together

Three questions, each answered once, in `app.js`:

**Which player?** The MPRIS player that owns the **focused window, when that
window is fullscreen** and the overview is not up (`_update`, `_playerFor`).
Matched by **process id** first — `GetConnectionUnixProcessID` on the player's
bus connection against `Meta.Window.get_pid()` — and by **desktop entry** after
that, against the window's app id, sandboxed app id, GTK application id and WM
class, for a sandboxed player whose bus connection is a proxy's. Two VLCs, two
pids: the one you are looking at is the one you get (tested: a pad press paused
only the focused one). No fullscreen player focused → nothing is attached and
nothing reacts — the pads included, so a game is never driven. `ignored-players`
is matched against **every name a player goes by** (`playerNames`: desktop entry,
identity, and the bus name without its `.instanceN`) — Chrome names no desktop
entry and calls itself "Chrome", but is `org.mpris.MediaPlayer2.chromium.*`.
Browsers are ignored by default: a fullscreen video in one draws its own
controls.

**When is it seen?** Pointer motion over the player (`pointer-reveal`:
`anywhere` like VLC's controller, `bottom-edge` for the lower fifth of the
monitor, or `never`), watched with the shell's `PointerWatcher` — which polls
`global.get_pointer()` only while the user is active, and takes no input away
from the video, which a reactive hot strip would. The `toggle-bar` key (default
Super+C) opens it **holding the keyboard** (`Main.pushModal`, `POPUP` tier);
Escape, a click outside, or the key again puts it away. A pad button performs its
action and flashes the bar. And the player's own changes show it: a pause (from a
remote's media key, say — gsd-media-keys already sends those to the player), a
seek, a new file. It hides after `hide-delay` seconds unless the pointer is on
it, it holds the keyboard, a slider is being dragged, or — `stay-while-paused` —
the player is paused.

**How is it above the video?** It is chrome: `Main.layoutManager.addChrome()`
with no params. Chrome lives in `uiGroup` above `global.window_group`, and only
chrome that asks for `trackFullscreen` (the top bar) hides over a fullscreen
window; the default is off. It places itself with the OSD's own arrangement — a
`Layout.MonitorConstraint` sizes the actor to the monitor and `x_align CENTER`
/ `y_align END` shrink it back around the panel — and raises itself above later
chrome when shown, as `osdWindow.js` does. While shown it disables
unredirection, as the OSD does, so a fullscreen window being scanned out
directly cannot hide it.

**Position** is never polled. MPRIS never announces where playback has got to,
so `Player` keeps the last reading and the monotonic time it was taken, and
`now` reckons forward from that at the current rate while playing. A reading is
taken when the bar comes up from hidden, when a player starts playing, and
whenever it announces `Seeked`; the bar redraws its running time on a 250 ms
timer that only exists while it is visible and the player is playing. Seeks use
`SetPosition(trackid, µs)` where the player names its track, relative `Seek`
where it does not. **Nothing blocks a player**: every call is asynchronous with
a 5 s timeout and a cancellable that `disable()` cancels; players are found with
`NameOwnerChanged` (arg0 namespace `org.mpris.MediaPlayer2`) plus one `ListNames`
at enable, and followed with `PropertiesChanged` and `Seeked`.

**Pads** go through **libmanette** (`gi://Manette?version=0.2`, the library
WebKitGTK reads gamepads with), imported when enabled so a system without it
loses the pads and keeps the bar. It watches udev, opens each pad's evdev node
on the main loop, and maps whatever was plugged in onto the kernel's standard
buttons with the SDL controller database — so a button is named by **position**
(`south`, `east`, `dpad-left`, `left-trigger`, …, `BUTTONS` in `actions.js`)
and an Xbox, PlayStation or Switch pad presses the same one. Triggers arrive as
`BTN_TL2`/`BTN_TR2` presses, d-pad hats as `BTN_DPAD_*`. Pads are never
grabbed. `ignored-gamepads` holds SDL GUIDs (a model, not a unit).

MPRIS covers play/pause, seek, volume, rate, next/previous and quit. It has **no
audio or subtitle track selection and no chapters** — those need VLC's rc
interface (`--extraintf rc`) or mpv's IPC socket, and are not built. If they
are, they belong behind the same `perform()` vocabulary, as optional
per-player capabilities, not a second code path.

## Design rules

- **A modification of GNOME, not a second one.** The seek and volume sliders are
  the quick settings' `Slider`; the buttons are `icon-button`s; the panel is
  painted as the shell paints its OSD (`#2e2e33`, which the shell keeps dark in
  the light theme too); placement is the OSD's `MonitorConstraint`. The only
  layout of our own is `CentredRowLayout`, which keeps the transport buttons
  centred however long the title is. Look for the shell's widget first.
- **Motion copies the shell.** `anim.js` holds the only durations: 200 ms
  ease-out-quad arriving (the bar rises 8 px as it fades in), 120 ms leaving.
  `actor.ease()` honours the animations toggle and slow-down factor.
- **Type is in em** (1em is the shell's UI font; 0.818em its caption step), so
  it follows Large Text. A px font-size in the stylesheet is a bug.
- **Colour comes from the accent** (`-st-accent-color`, `-st-accent-fg-color`,
  `st-lighten()`, `st-mix()`, `st-transparentize()`). Neutrals are the shell's.
  Buttons and sliders inside the bar carry their own colours
  (`.mc-bar .mc-button`, `.mc-bar .slider`) because the theme's are dark on
  light in the light theme and the bar is always dark.
- **JS sizes are physical pixels; CSS is not.** A number that meets an
  allocation (`panel.width`, the row gap) is logical px times the stage's
  `scale_factor`; nothing written into CSS is scaled.
- **No private shell API.** There is none today — no underscore field is read or
  written. Keep it that way; if one becomes unavoidable, list it here with what
  breaks when it moves.

## Gotchas

- **`addChrome()` takes no `affectsInputRegion` on 50.** It was X11-only and is
  gone from `layout.js`'s `defaultParams`; passing it throws "Unrecognized
  parameter" and the extension fails to enable. 48's default for it is `true`,
  so no params is right everywhere.
- **`Clutter.Grab` has no `get_seat_state()` on 50** (`activate`, `dismiss`,
  `is_revoked` only). The shell no longer checks what a `pushModal` grab got.
- **Arrow keys never reach the focus manager while the bar holds the grab.**
  `St.FocusManager` moves focus from the stage's event handler, and a grab stops
  the event at the grab actor. The panel's own `key-press-event` calls
  `navigate_focus` itself — the shell's popup menu items do the same. A focused
  slider takes Left/Right first (the seek slider skips by `seek-step` instead of
  the Slider's 10%-of-the-film step); Up/Down leave it.
- **An exception halfway through `enable()` still gets a `disable()`**, which
  must cope with whatever was not built yet (`app.js` uses `?.` throughout
  there).
- **`extension.js` and `metadata.json` are cached for the life of the shell**;
  `reload` picks up `lib/`, the stylesheet and the schema only. New UUIDs need a
  logout (or a nested `stop` + `start`).
- **dconf is shared with the real session — and with every other nested shell.**
  Each `dconf-service` caches the database when it starts and rewrites the
  *whole file* on its next write, so the last writer wins with a stale copy.
  Change settings **before** `start` or **after** `stop`, and check whether
  another project's nested shell is running (`ls $XDG_RUNTIME_DIR/*-nested`)
  before writing at all: on the day this was built, Wallpaper Engine and Media
  Libraries sessions had theirs up at the same time, and `enabled-extensions`
  moved under all of them. `start` enables this extension in the nested shell
  if dconf doesn't list it, which writes `enabled-extensions` for the real
  session's next login too. **`start --clean` sidesteps all of it**: its own
  profile (`DCONF_PROFILE`, handed to everything the nested bus activates) has
  a writable `~/.config/dconf/media-controls-nested` over a read-only seed
  compiled at start, and `stop` deletes the writable one. Settings changed
  there with `run gsettings …` go to that database alone.
- **VLC in the headless nested shell** has no GPU for Xwayland: its GL outputs
  fail ("video output creation failed") and it plays on with **no window**. The
  `player` command uses `--vout=xcb_x11 --avcodec-hw=none`. Its dummy audio
  output reports volume 0 and ignores a new one, so the generated test clip
  carries a *silent* audio track and plays through the real sound server
  (`--aout=pulse`); any other file gets `--no-audio`.
- **VLC keeps a recent-media list and its volume in `~/.config/vlc`**, so a
  test run in the nested shell used to land at the top of the user's own
  recent files. `player` points VLC's `XDG_CONFIG_HOME`/`XDG_DATA_HOME` into
  the run directory. (PipeWire still restores VLC's last stream volume, 85%
  here; that is the sound server's, not VLC's.)
- **The nested shell's X11 display needs its own cookie.** `start` records the
  display (from the listening socket the nested gnome-shell holds) and the
  `.mutter-Xwaylandauth.*` it wrote, and `run`/`player` pass both; `stop`
  deletes that cookie, since nothing else does.
- **On an Xbox pad the kernel's `BTN_X` is `BTN_NORTH` (0x133) but is the
  *left* button**, and `BTN_Y` (`BTN_WEST`, 0x134) the top one. libmanette's
  output is positional; what the kernel sends is not. `fakepad.py` therefore
  takes position names and sends what xpad would.
- **Never `pkill -f` a pattern that appears in your own command line** — it
  matches the shell running the command. Quit players with
  `./scripts/nested.sh mpris Quit` (root interface) or kill them by pid.
- **Check the logs.** Exceptions inside the extension surface only in the shell
  journal (`make logs`) or, nested, `./scripts/nested.sh logs`. A JS error in
  `enable()` leaves nothing on screen, which reads as "the bar never shows".
- **A freeze leaves no log; `make stalls` catches one in the act** (main-loop
  stalls via `Properties.Get` on `org.gnome.Shell` — never `Peer.Ping`, which
  GDBus answers on its worker thread — and processes stuck in the kernel).
- **The 48 floor is by audit, not boot.** The APIs used are all present in 48:
  `St.BoxLayout({orientation})`, `-st-accent-color`, `Slider` with
  `drag-begin`/`drag-end`, `global.stage.get_event_actor()`, `EventEmitter` in
  `misc/signals.js`. Unredirection moved from `Meta.*_unredirect_for_display`
  to `global.compositor` around 49; `bar.js` `setUnredirect` uses whichever
  exists.
