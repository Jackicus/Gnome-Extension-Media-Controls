# Media Controls

A GNOME Shell extension (UUID `media-controls@jackt`) that draws a control bar
over a **fullscreen video player** — a replacement for VLC's own fullscreen
controller that works the same way over mpv, Celluloid or anything else that
speaks MPRIS, and that for VLC adds audio and subtitle tracks, subtitle timing
and chapters. It is a bar the shell draws over the player's window, not a
player. Shell versions 48 to 50 (50 by boot, 48 and 49 by audit against the
shell's sources — see Gotchas). GJS, ES modules.

It stands alone: it depends on no other extension and knows of none. If another
extension has trouble working beside it, that is fixed in that extension's own
project.

## Seeing it

The bar is drawn over a fullscreen window, so a change is only verified by
looking at it. `make nested` starts a **headless nested GNOME Shell**, loads the
extension into it, and opens a **live mirror window on the real desktop** (a
PipeWire screencast of the nested monitor) so the user can watch without logging
out. `./scripts/nested.sh player` plays a generated test clip in VLC inside it,
full screen — ten minutes of bars with two audio tracks, two subtitle tracks and
chapters, so the tracks pop-out has something to show; `mpris` reads or pokes
that player; `pad` plugs in a virtual Xbox pad and presses buttons on it.
**`start --clean`** gives it a settings database of its own — only this
extension enabled, the real session's look (colour scheme, accent, fonts) copied
in, nothing written to `~/.config/dconf/user` — which is what screenshots are
taken in (`docs/screenshots/`, with the `window` step for the preferences) and
what to use whenever another project's nested shell is up.

Read the **`drive-extension` skill** before driving it; it has the lifecycle,
the coordinates and the traps. Keep one nested shell up across edits and
`reload` into it; `make nested-stop` tears it down — **always** do that when
finished, and read what it prints: it checks that nothing of the nested session
survived (a prefs window once kept a nested shell alive after a `stop` that
reported success) and says so if something did.

All `make` targets delegate to `scripts/`: `dev.sh` for the extension itself and
`nested.sh` for the nested shell. Put new logic in those, not in the Makefile.
`./scripts/dev.sh devices` lists the MPRIS players on the bus and the pads
libmanette sees — the same two lists the preferences show.

## Layout

`src/` is an **exact mirror of the installed extension directory** (`make link`
symlinks it). Add a file to `src/` and it ships.

```
src/extension.js      loader: stages lib/ under $XDG_RUNTIME_DIR/media-controls/
src/lib/app.js        which player, when the bar is seen, the key, the pads,
                      the sleep timer, perform(action)
src/lib/mpris.js      PlayerRegistry + Player: the players on the bus, their
                      reckoned position, and the calls the bar makes
src/lib/bar.js        ControlBar: the St widget (seek row, transport, tracks,
                      sleep, volume, rate, close, clock line) and CentredRowLayout
src/lib/tracksmenu.js TracksMenu: the audio-and-subtitles pop-out (a PopupMenu)
src/lib/vlcremote.js  VlcRemote: VLC's remote-control socket
src/lib/vlcconfig.js  VLC's settings file: the two things we may change in it
src/lib/gamepads.js   libmanette → (button, action)
src/lib/actions.js    pure data shared with prefs.js: ACTIONS, BUTTONS,
                      NAVIGATION, RATES, SLEEP_STEPS, formatTime, playerNames
src/lib/anim.js       the only durations and curves
src/prefs.js          Bar / Players (with the VLC switches) / Controllers pages
src/stylesheet.css    paint only, every size in em (see Design rules)
src/schemas/          org.gnome.shell.extensions.media-controls
src/metadata.json     UUID, shell versions
scripts/dev.sh        link / install / reload / pack / logs / status / stalls / clean
scripts/nested.sh     the nested shell: start / player / do / pad / mpris / stop …
scripts/nested_driver.py  what `do`, `shot`, `say`, `window` run: input and
                      screenshots over the nested shell's RemoteDesktop/Screenshot
scripts/fakepad.py    the virtual Xbox pad `pad` plugs in (python-evdev)
scripts/stallwatch.py what `make stalls` runs
scripts/devices.js    what `dev.sh devices` runs: the players and pads on the bus
scripts/vlc-setup.js  vlcconfig.js from the command line (nested `player` uses it)
```

`docs/proposal.md` is a live proposal (taking the bar's colours from the
shell's theme classes instead of copying the OSD's); nothing in it has been
done yet.

The **action vocabulary** (`ACTIONS` in `actions.js`) is the one list every input
speaks: the bar's buttons emit an action id, the pads map a button id to one
(`gamepad-buttons`), and `app.js` `perform()` is the only place an action turns
into a call. Add an action there and in `ACTIONS`, and both the pads and the
preferences pick it up. `actions.js` and `vlcconfig.js` are imported by
`prefs.js`, which runs outside the shell: they must never import St, Clutter or
`ui/`.

`extension.js` copies `lib/` into a directory named after a checksum of its
files and imports from there, because GJS caches modules by URL for the life of
the shell — so `reload` picks up edits without a restart, and an unlock
re-enables into the same module graph.

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
Super+C) or the pad's `navigate` (Start) opens it **holding the focus**
(`Main.pushModal`, `POPUP` tier); Escape, a click outside, or the key again puts
it away. A pad button performs its action and flashes the bar — except the
subtitle actions, which leave it down so the subtitles under it stay visible.
And the player's own changes show it: a pause (from a remote's media key, say —
gsd-media-keys already sends those to the player), a seek, a new file. It hides
after `hide-delay` seconds unless the pointer is on it, it holds the focus, the
pop-out is open, a slider is being dragged, or — `stay-while-paused` — the
player is paused.

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
taken when the bar comes up from hidden, when a player starts playing, when it
moves to a new file, and whenever it announces `Seeked`. The bar redraws on a
timer that only exists while it is visible and something on it moves: every
250 ms while playing, and once a second otherwise, for the clock and the sleep
countdown, which move by the minute. Seeks use `SetPosition(trackid, µs)` where
the player names its track, relative `Seek` where it does not. **Nothing blocks a player**: every
call is asynchronous with a timeout and a cancellable that `disable()` cancels;
players are found with `NameOwnerChanged` (arg0 namespace
`org.mpris.MediaPlayer2`) plus one `ListNames` at enable, and followed with
`PropertiesChanged` and `Seeked`.

**Tracks** are VLC's alone: MPRIS has no audio or subtitle tracks, no subtitle
timing and no chapters. VLC's C remote-control interface (`oldrc`) can listen on
a Unix socket; `vlcconfig.js` turns it on in VLC's own settings file when the
user flips the Players page's switch, at `$XDG_RUNTIME_DIR/media-controls-vlc.sock`
(one path, since a settings file cannot name one per instance), together with
the switch that turns VLC's own fullscreen controller off. `VlcRemote` connects
when a VLC is attached, and keeps the connection only if the socket's **peer
credentials** are that VLC's pid and VLC then **answers** a harmless `atrack`
(it serves one client at a time; a second connection is accepted by the kernel
and never read). With no socket, another VLC holding it, or any other player,
the bar simply has no tracks button. The pop-out (`TracksMenu`) is the shell's
own `PopupMenu` standing on the panel: audio and subtitles as radio lists that
stay open as they are picked, a Timing row (− / value / + / ↺ in 0.1 s steps,
VLC's `key-subdelay-*` hotkeys at 50 ms each, the value tracked here since VLC
cannot be asked it, reset on each new input), and a chapter row when the file
has chapters.

**The pad drives the bar the way the keyboard does.** While the bar holds the
focus, or its pop-out is open, the d-pad, the bottom and the right face buttons
(`NAVIGATION` in `actions.js`) are pressed as the arrow keys, Return and Escape
on a **Clutter virtual keyboard** — the on-screen keyboard's mechanism — so
everything the keyboard reaches, the pad reaches, highlight and all. Those keys
are only ever injected while the bar or the pop-out holds the grab, so they
land on them and never on the player. Every other button keeps its own action.

**Pads** go through **libmanette** (`gi://Manette?version=0.2`, the library
WebKitGTK reads gamepads with), imported when enabled so a system without it
loses the pads and keeps the bar. It watches udev, opens each pad's evdev node
on the main loop, and maps whatever was plugged in onto the kernel's standard
buttons with the SDL controller database — so a button is named by **position**
(`south`, `east`, `dpad-left`, `left-trigger`, …, `BUTTONS` in `actions.js`)
and an Xbox, PlayStation or Switch pad presses the same one. Triggers arrive as
`BTN_TL2`/`BTN_TR2` presses, d-pad hats as `BTN_DPAD_*`. Pads are never
grabbed. `ignored-gamepads` holds SDL GUIDs (a model, not a unit).

**Settings that are off by default**: `show-clock` (a line under the title, "21∶40
· ends at 23∶12", formatted by the shell's own `dateUtils.formatTime`, so
12/24-hour as the top bar's clock is set) and `sleep-timer` (a
button cycling 15–120 minutes, then the end of the file, then off; it pauses the
player, the pause brings the bar up, and GNOME's own screen blank follows once
the player stops holding it off — the end-of-file step pauses half a second
before the end so a player set to exit at the end stays open). `bar-scale`
(75–200 %) is one `font-size` percentage on the panel and the pop-out, which
every em in the stylesheet follows, plus the icon sizes, which `bar.js` sets
itself (see Gotchas).

## Design rules

- **A modification of GNOME, not a second one.** The seek and volume sliders are
  the quick settings' `Slider`; the buttons are `icon-button`s; the pop-out is a
  `PopupMenu` with the shell's radio ornaments; the panel is painted as the
  shell paints its OSD (`#2e2e33`, which the shell keeps dark in the light theme
  too); placement is the OSD's `MonitorConstraint`. The only layout of our own
  is `CentredRowLayout`, which keeps the transport buttons centred however long
  the title is. Look for the shell's widget first.
- **Motion sits beside the shell's.** `anim.js` holds the only durations:
  200 ms arriving (the bar rises 8 px as it fades in), 120 ms leaving, both
  ease-out-quad — the shell's curve, at lengths inside its own 100–250 ms.
  `actor.ease()` honours the animations toggle and slow-down factor.
- **Every size is in em** (1em is the shell's UI font; 0.818em its caption
  step), so the bar follows Large Text and the size setting scales all of it.
  A px size in the stylesheet — other than a hairline border or a shadow — is a
  bug. Icons are the exception, sized in JS (`ICON_SIZE` × the setting).
- **Colour comes from the accent** (`-st-accent-color`, `-st-accent-fg-color`,
  `st-lighten()`, `st-mix()`, `st-transparentize()`). Neutrals are the shell's.
  Buttons and sliders inside the bar carry their own colours
  (`.mc-bar .mc-button`, `.mc-bar .slider`) because the theme's are dark on
  light in the light theme and the bar is always dark. The focus highlight is
  the accent at full strength: it has to be found from a sofa.
- **JS sizes are physical pixels; CSS is not.** A number that meets an
  allocation (`panel.width`, the row gap) is logical px times the stage's
  `scale_factor`; nothing written into CSS is scaled. `St.Icon.icon_size` is
  logical.
- **No private shell API.** There is none today — no underscore field is read or
  written (`TracksMenu` uses `PopupMenu`'s public `sourceActor`,
  `setSourceAlignment` and `itemActivated`). Keep it that way; if one becomes
  unavoidable, list it here with what breaks when it moves.

## Gotchas

VLC's remote-control socket, all found the hard way:

- **The module is `oldrc`.** `--extraintf rc` loads VLC 3's *Lua* CLI, which
  cannot listen on a Unix socket and ignores `--rc-unix`.
- **`oldrc` will not start without a terminal** ("fd 0 is not a TTY"), socket or
  not, unless `rc-fake-tty` is set.
- **vlcrc options are read only under their module's section**: `rc-fake-tty`
  anywhere but under `[oldrc]` is ignored. `vlcconfig.js` uncomments the line
  VLC wrote in the right section, or adds it under its header.
- **VLC drops the last character of every line of vlcrc as its newline** — the
  last line's too, so a file that does not end in one loses a letter (the
  socket came up as `…vlc.soc`).
- **A Unix socket path is at most 107 bytes**, so it lives straight in
  `$XDG_RUNTIME_DIR`, which is also private (0700).
- **While paused, VLC answers almost everything with "Press pause to
  continue."** — listing and setting tracks, chapters — but still takes `key`
  hotkeys. `VlcRemote` keeps the lists it read while playing (read on connect
  and whenever the bar comes up playing), shows those paused, and picks a track
  paused by pressing `key-audio-track`/`key-subtitle-track` as many times as it
  takes: VLC cycles in the order it lists them, audio skipping Disable,
  subtitles through Off. Chapters use `key-chapter-next/prev`.
- **One client at a time**, and a dropped connection is only noticed when VLC
  next reads. So the connection is checked with `atrack` before it is trusted,
  one unanswered attempt is retried a second later (a reload, a shell restart),
  and `_dropRemote` closes before anything else.
- **A subtitle that already started is not drawn after a track switch**; the
  next one is. Not a failed switch.
- **Subtitles are drawn along the foot of the picture, under the bar.** Hence
  the subtitle actions leaving the bar down.

The extension:

- **Two writes at once on a GIO stream fail** ("Stream has outstanding
  operation"); `VlcRemote` queues its lines. That failure used to read as VLC
  going away.
- **Never name a method `connect` on an `EventEmitter`** — nor `connectAfter`,
  `disconnect`, `disconnectAll`, `emit` or `signalHandlerIsConnected`.
  `connectObject` is built on the signal methods it finds on the prototype;
  a `connect` of our own made every tracked connection a Promise, and
  `disconnectObject` threw.
- **`disable()` runs each teardown step on its own**, catching each. One that
  threw used to abandon the rest — and the bar and handlers left behind kept
  running beside the next enable's (two "Attached" lines per event).
- **A `PopupMenuSection` closes the whole menu when one of its items is
  activated** (its own `itemActivated`), so `TracksMenu` overrides it on the
  sections as well as the menu.
- **A `PopupMenu` toggles on Return or Space reaching its source actor** — the
  panel, for `TracksMenu` (so it stands above the bar rather than over its top
  row) — so the panel's key handler swallows those; a focused button has
  already taken them.
- **St does not size a button's icon against the panel's font**, so a font-size
  on the panel scaled everything but the icons. `bar.js` sets `icon_size` from
  `ICON_SIZE` × the setting, the pop-out's buttons too.
- **`addChrome()` takes no `affectsInputRegion` on 50.** It was X11-only and is
  gone from `layout.js`'s `defaultParams`; passing it throws "Unrecognized
  parameter". 48's default for it is `true`, so no params is right everywhere.
- **`Clutter.Grab` has no `get_seat_state()` on 50** (`activate`, `dismiss`,
  `is_revoked` only). The shell no longer checks what a `pushModal` grab got.
- **Arrow keys never reach the focus manager while the bar holds the grab.**
  `St.FocusManager` moves focus from the stage's event handler, and a grab stops
  the event at the grab actor. The panel calls `navigate_from_event` itself, as
  the shell's popup menu items do. A focused slider takes Left/Right first (the
  seek slider skips by `seek-step` instead of the Slider's 10%-of-the-film
  step); Up/Down leave it.
- **`extension.js` and `metadata.json` are cached for the life of the shell**;
  `reload` picks up `lib/`, the stylesheet and the schema only. New UUIDs need a
  logout (or a nested `stop` + `start`).

The nested shell:

- **dconf is shared with the real session — and with every other nested shell.**
  Each `dconf-service` caches the database when it starts and rewrites the
  *whole file* on its next write, so the last writer wins with a stale copy.
  Without `--clean`, change settings **before** `start` or **after** `stop`, and
  check whether another project's nested shell is running (`ls
  $XDG_RUNTIME_DIR/*-nested`) before writing at all: `enabled-extensions` has
  moved under several at once. `start` enables this extension in the nested
  shell if dconf doesn't list it, which writes `enabled-extensions` for the
  real session's next login too. **`start --clean` sidesteps all of it**: its
  own profile (`DCONF_PROFILE`, handed to everything the nested bus activates)
  has a writable `~/.config/dconf/media_controls_nested` over a read-only seed
  compiled at start, and `stop` deletes the writable one. Settings changed
  there with `run gsettings …` go to that database alone.
- **A dconf database is named by a D-Bus object-path element**
  (`/ca/desrt/dconf/Writer/<name>`): letters, digits and underscores. With a
  hyphen every write fails and `gsettings set` waits forever. Wrap nested
  `gsettings` calls in `timeout`.
- **VLC in the headless nested shell** has no GPU for Xwayland: its GL outputs
  fail ("video output creation failed") and it plays on with **no window**. The
  `player` command uses `--vout=xcb_x11 --avcodec-hw=none`. Its dummy audio
  output reports volume 0 and ignores a new one, so the generated test clip
  carries *silent* audio tracks and plays through the real sound server
  (`--aout=pulse`); any other file gets `--no-audio`.
- **VLC keeps a recent-media list and its volume in `~/.config/vlc`**, so
  `player` points VLC's `XDG_CONFIG_HOME`/`XDG_DATA_HOME` into the run
  directory, and sets that throwaway vlcrc up with `scripts/vlc-setup.js` (the
  preferences' own code; `--plain` skips it). The socket path is the real one,
  so a VLC on the real desktop that holds it leaves the nested one without a
  tracks button — `player` warns.
- **The nested shell's X11 display needs its own cookie.** `start` records the
  display (from the listening socket the nested gnome-shell holds) and the
  `.mutter-Xwaylandauth.*` it wrote, and `run`/`player` pass both; `stop`
  deletes that cookie, since nothing else does.
- **On an Xbox pad the kernel's `BTN_X` is `BTN_NORTH` (0x133) but is the
  *left* button**, and `BTN_Y` (`BTN_WEST`, 0x134) the top one. libmanette's
  output is positional; what the kernel sends is not. `fakepad.py` therefore
  takes position names and sends what xpad would.
- **Escape goes to the player when the bar does not hold the focus**, and
  VLC's Escape leaves fullscreen (after which the bar correctly detaches). A
  pop-out opened with the mouse needs one Escape, not two.
- **Never `pkill -f` a pattern that appears in your own command line** — it
  matches the shell running the command. Quit players with
  `./scripts/nested.sh mpris Quit` (root interface) or kill them by pid.

Everywhere:

- **Check the logs.** Exceptions inside the extension surface only in the shell
  journal (`make logs`) or, nested, `./scripts/nested.sh logs`. A JS error in
  `enable()` leaves nothing on screen, which reads as "the bar never shows".
- **A freeze leaves no log; `make stalls` catches one in the act** (main-loop
  stalls via `Properties.Get` on `org.gnome.Shell` — never `Peer.Ping`, which
  GDBus answers on its worker thread — and processes stuck in the kernel).
- **The 48 floor is by audit, not boot.** The APIs used are all present in 48:
  `St.BoxLayout({orientation})`, `-st-accent-color`, `Slider` with
  `drag-begin`/`drag-end`, `global.stage.get_event_actor()`,
  `global.focus_manager.navigate_from_event()`, `EventEmitter` in
  `misc/signals.js`, `PopupMenu.setSourceAlignment`, Clutter virtual input
  devices. `Ornament.NO_DOT` falls back to `NONE` where missing. Unredirection
  moved from `Meta.*_unredirect_for_display` to `global.compositor` around 49;
  `bar.js` `setUnredirect` uses whichever exists.
