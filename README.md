# Media Controls

A control bar for fullscreen video on GNOME. It works with VLC, mpv, Celluloid,
or any player that shows up in GNOME's media controls, and you can use it with
the mouse, the keyboard or a game controller.

![Media Controls over a video playing full screen in VLC](docs/screenshots/bar.jpg)

- Seek, play/pause, skip, volume, speed
- On VLC: audio tracks, subtitles, subtitle timing, chapters
- Works with Xbox, PlayStation, Switch and most other controllers
- Optional clock and sleep timer
- Looks like the rest of GNOME and uses your accent colour

## Install

Needs GNOME Shell 48, 49 or 50.

```bash
git clone https://github.com/Jackicus/Gnome-Extension-Media-Controls.git
cd Gnome-Extension-Media-Controls
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

If the bar never shows up, `make logs` will show you what went wrong.

## Development

Run `make link` once, then `make reload` after each edit. `CLAUDE.md` explains
how it's built.

## Credits

The screenshot shows [Big Buck Bunny](https://peach.blender.org/), © 2008
Blender Foundation,
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
