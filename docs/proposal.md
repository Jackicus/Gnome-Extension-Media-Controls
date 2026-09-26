# Proposal: take the bar's colours from the shell's theme

*Proposed 2026-09-25. Nothing has changed yet.*

The bar's widgets and behaviour are already the shell's. Its colours are not:
`stylesheet.css` copies the OSD's `#2e2e33` and gives the buttons colours of
its own. So the bar ignores High Contrast, a shell theme, and any future
restyle of that dark surface. This proposal hands the colours to three of the
shell's own style classes, keeps sizes in our stylesheet, and deletes more
than it adds.

## Where the bar is now

Already the shell's: the `Slider`s, the `PopupMenu` pop-out and its items,
`MonitorConstraint` placement, `addChrome`, `pushModal`, the key binding,
`PointerWatcher`, the focus manager, the virtual keyboard. No private API.

Already followed: Large Text (every size is in em), the accent colour, the
animations switch and slow-down factor, the 12/24-hour clock setting.

Not followed, because the paint is copied:

| Setting | What the shell does | What the bar does |
|---|---|---|
| High Contrast | OSD and screenshot panel turn `#000` with a 2px light border and an inset outline; buttons get outlines | Stays `#2e2e33` with a 6% border |
| A shell theme (User Themes, a distro's own such as Yaru) | Restyles its surfaces | Keeps stock Adwaita's look |
| A future GNOME restyle | — | Keeps today's look |

On stock GNOME today the difference is invisible.

## Why the screenshot panel

The shell paints its surfaces in two families:

- **Popovers** — quick settings, the calendar, popup menus, and the
  `.button` / `.icon-button` / `.slider` inside them. These go light in the
  light theme.
- **Dark overlays** — the OSD, the Alt+Tab switcher, the screenshot panel. One
  shared rule, dark in both themes:

  ```css
  .screenshot-ui-panel, .switcher-list, .osd-window {
      color: #ffffff; background-color: #2e2e33;
      border: 1px solid rgba(255, 255, 255, 0.02);
      border-radius: 999px; padding: 12px; }
  ```

The bar is a dark overlay built from popover widgets, which is why the
stylesheet repaints them. The screenshot panel is the closest thing the shell
has to the bar: a dark panel floating at the bottom centre of a monitor, a row
of buttons, a large round button in the middle. It comes with a button class
made for that surface (`screenshot-ui-type-button`: flat on `#2e2e33`, with
hover, active, checked, insensitive and focus states, in both themes). Unlike
`.osd-window`, `.screenshot-ui-panel` has no rules for its descendants (the
OSD's set every `StIcon` to 32px and every `StLabel`'s margin), so it paints
the panel and nothing inside it.

Checked against GNOME Shell 50.5's `gnome-shell-dark.css`,
`gnome-shell-light.css` and `gnome-shell-high-contrast.css`.

## The change

| Widget | Style classes now | Proposed | Our rules deleted |
|---|---|---|---|
| Panel (`this.panel` in `bar.js`) | `mc-bar` | `screenshot-ui-panel mc-bar` | `color`, `background-color`, `border`, `box-shadow` from `.mc-bar` |
| Transport, tracks, mute, close, rate, sleep (`iconButton()`, `mc-sleep`, `mc-rate` in `bar.js`) | `icon-button mc-button` | `screenshot-ui-type-button mc-button` | `.mc-bar .mc-button` colours, `:hover`, `:active`, `:insensitive` |
| Play (`mc-play`) | `icon-button mc-button mc-play` | `button default mc-button mc-play` | `.mc-play` colours, `:hover`, `:active` |

`button default` is the shell's default action button in dialogs: the accent
fill, with its hover, active and focus states, in every theme.

**One paint class per widget.** A button with both `icon-button` and
`screenshot-ui-type-button` is painted by whichever rule comes later in the
theme's file. In Adwaita that happens to be the screenshot button's (line 477
against 60), but another theme may order them differently, so `icon-button`
goes. Its geometry comes with it into `.mc-bar .mc-button`:
`border-radius: 999px; padding: 0.818em; min-height: 1.091em; min-width: 0`.

**The rule afterwards:** the shell's classes set colour, our stylesheet sets
size and shape. The shell's classes size in px (`padding: 18px`,
`min-width: 48px`, `border-radius: 32px`); in px, the size setting and Large
Text would stop reaching them. Our rules match at the same specificity and
load after the theme, so our em sizes win.

## What stays ours

- **Sizes and shape**, in em: panel padding, margin and spacing, its corner
  radius, round buttons. The size setting and Large Text keep working.
- **The focus ring** (`.mc-button:focus`, `.mc-play:focus`): the accent at full
  strength, so it can be found from a sofa. The shell's is paler. This is the
  one deliberate difference in paint.
- **Slider colours** (`.mc-bar .slider`): the shell's `.slider` is dark on light
  in the light theme. Ours is white on a dark panel, which holds on `#2e2e33` and
  on High Contrast's `#000`.
- **Text colours** for the time, subtitle and clock (white at 70–80%). They
  assume a dark panel.
- `CentredRowLayout`, the title and time labels, and the pop-out (already the
  shell's `PopupMenu`, following the theme).

## What it gains, and what it doesn't

- **Gains:** High Contrast, shell themes and GNOME restyles reach the bar with
  no work here.
- **Shell versions:** no gain. One more thing can move: three class names.
- **When a class goes:** if GNOME renames `screenshot-ui-panel`, or a theme
  doesn't style it, the panel loses its background. The bar still works and
  can be clicked, but it's visibly wrong. The screenshot UI arrived in GNOME
  42, so an old or unmaintained theme could show this.
- **Looks different:** the panel loses its drop shadow, because the screenshot
  panel has none. Keeping ours would override High Contrast's inset outline,
  so it goes. Hover and pressed shades change slightly, to the screenshot
  panel's.

## Left out

- **Tooltips.** `Screenshot.Tooltip` is exported and would suit the icon
  buttons. It's a feature, though, not compatibility.
- **A separate `stylesheet-light.css`.** The shell would load it in the light
  theme alone, so the slider override could stay out of the dark theme. It's
  an extra file for no visible difference.
- **The popover look** (`popup-menu-content`, `.button` pills, the plain
  slider). This is the only route with no colour of our own, but in the light
  theme it's a white bar over the film. Every surface the shell puts over
  content is from the dark family.
- **`QuickToggle` pills** for rate and sleep. Their colours follow the theme,
  so a light pill would sit on the dark bar, and a `QuickToggle` is a fixed
  12em wide.
- **`MediaMessage`** (the calendar's media player): a notification card tied to
  the shell's own player object, with no seek or volume. **`QuickSlider`**: its
  flat button is painted for the popover's background. **`OsdWindow`**: it
  can't be clicked.

## Open question: the focus ring and `!important`

The shell's `.icon-button:focus` and `.screenshot-ui-type-button:focus` set
their `box-shadow` with `!important`. If St ranks `!important` above
specificity, as CSS does, our focus ring's `box-shadow` is losing to the
shell's **today**, and only our tint behind it applies. Check this in the
nested shell before anything else. If the ring is losing, our two focus rules
need `!important` too, whether or not this proposal goes ahead.

## Checking it

1. Confirm `.screenshot-ui-panel`, `.screenshot-ui-type-button` and
   `.button.default` and their paint in the 48 and 49 sources, as the rest of
   the 48 floor was audited.
2. In a `start --clean` nested shell with the test clip, screenshot the bar in
   dark, light (`org.gnome.desktop.interface color-scheme`) and High Contrast
   (`org.gnome.desktop.a11y.interface high-contrast`), beside
   `docs/screenshots/bar-closeup.png`.
3. Open the bar with the key, walk it with the arrows and the virtual pad: the
   ring on the transport buttons, play, rate and sleep. Settle the
   `!important` question.
4. Hover, press, and a disabled button (previous/next with one file).
5. The size setting at 75% and 200%, and Large Text.
6. Retake `docs/screenshots/` if the look moved.

## Docs to change with it

- **CLAUDE.md, Design rules:** "the panel is painted as the shell paints its
  OSD" becomes "the panel and its buttons wear the screenshot panel's classes".
  The colour rule becomes: the shell's classes set colour, ours set size; the
  exceptions are the focus ring, the sliders and the text shades.
- **The `stylesheet.css` header,** which describes the copied OSD paint.
- **README, "Looks like GNOME":** add that it follows the shell theme and High
  Contrast.
