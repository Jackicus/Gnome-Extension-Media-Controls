# Media Controls

A control bar for fullscreen video on GNOME. It works with VLC, mpv, Celluloid,
or any player that shows up in GNOME's media controls, and you can use it with
the mouse, the keyboard or a game controller.

![Media Controls over a video playing full screen in VLC](docs/screenshots/bar.jpg)

- **Looks like GNOME.** It uses the shell's own sliders, buttons and menus, in
  your accent colour.
- **Audio, subtitles and timing.** Pick the audio track and subtitles, and nudge
  out-of-sync subtitles until they line up. Chapters too. (VLC only.)
- **Any controller.** Xbox, PlayStation, Switch, 8BitDo, Steam Deck. Buttons go
  by where they sit, so every pad works the same.
- **Sized for the room.** One slider makes the whole bar bigger for a TV.
- **Clock and sleep timer.** See when the film will end, or have it pause after
  15 minutes to 2 hours. Both are optional.
- **Only where you're looking.** Just the focused fullscreen player gets the
  bar, so a controller in a game never pauses your film.

## Install

Needs GNOME Shell 48, 49 or 50.

```bash
git clone https://github.com/Jackicus/GNOME-Media-Controls.git
cd GNOME-Media-Controls
make install
```

Log out and back in, then run `gnome-extensions enable media-controls@jackt`.

**VLC:** open the preferences (`gnome-extensions prefs media-controls@jackt`),
go to **Players** and turn on both VLC switches. Then restart VLC.

**mpv:** install [mpv-mpris](https://github.com/hoyon/mpv-mpris) and run mpv
with `--no-osc`.

## Use

![The bar close up: running time, seek slider and remaining time on top; title, previous, skip back, play/pause, skip forward and next, the audio-and-subtitles button, volume, speed and close below](docs/screenshots/bar-closeup.png)

Play something full screen and move the mouse.

- **Keyboard:** Super+C opens the bar. The arrow keys move around it, Enter
  presses and Escape closes it.
- **Controller:** A plays or pauses. The d-pad skips and changes the volume.
  Start opens the bar so you can move around it. You can remap every button in
  the preferences.

### Audio and subtitles

![The audio-and-subtitles pop-out standing above the bar: Audio with Stereo picked and 5.1 Surround; Subtitles with Off, English and Español, Español picked; and a Timing row with minus, 0.0 s, plus and reset](docs/screenshots/tracks.jpg)

The button next to the volume opens this. Pick an audio track and subtitles,
then use − and + to move the subtitles by 0.1 s until they line up.

## Preferences

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/prefs-bar.png" alt="The Bar page: when the pointer shows the bar, how long before it hides, whether it stays while paused, the keyboard shortcut, the size slider, the clock and sleep-timer switches, and how far skip and volume steps go"></td>
    <td width="33%"><img src="docs/screenshots/prefs-players.png" alt="The Players page: VLC media player listed as running with its switch on, the VLC group with switches to hide VLC's own fullscreen controls and to allow audio and subtitle tracks, and a folded list of ignored players"></td>
    <td width="33%"><img src="docs/screenshots/prefs-controllers.png" alt="The Controllers page: an Xbox 360 pad listed as connected, its row lit with 'Pressed: Bottom face button', and below it the list of what each button does, with the bottom face button's row lit too"></td>
  </tr>
  <tr>
    <td valign="top"><b>Bar</b>: when it shows, how long it stays, its size,
    the clock and the sleep timer.</td>
    <td valign="top"><b>Players</b>: which players get the bar, and the two VLC
    switches.</td>
    <td valign="top"><b>Controllers</b>: every pad plugged in. Press a button
    to see what it does.</td>
  </tr>
</table>

## Troubleshooting

If the bar never shows up, `make logs` will show you what went wrong.

## Development

Run `make link` once, then `make reload` after each edit. `CLAUDE.md` explains
how it's built.

## Credits

The screenshots show [Big Buck Bunny](https://peach.blender.org/), © 2008
Blender Foundation,
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Its audio and
subtitle tracks were added for the demo.
