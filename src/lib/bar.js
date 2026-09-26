// The bar itself: a panel at the foot of the player's monitor, holding the
// position, the transport buttons, the volume and the rate — and, where the
// player allows it, the audio-and-subtitles pop-out (tracksmenu.js), and the
// clock and sleep timer when they are switched on. It knows how to show a
// player and how to ask it for things; when to be seen is app.js's.
//
// Everything in it is the shell's: the seek and volume sliders are the quick
// settings' `Slider`, the buttons are `icon-button`s, the panel is painted the
// way the shell paints its OSD, and it is placed on its monitor by the same
// `MonitorConstraint` the OSD uses. Only the layout of the lower row is ours
// (`CentredRowLayout`).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {RATES, formatTime} from './actions.js';
import {Duration, Ease, RISE} from './anim.js';
import {TracksMenu} from './tracksmenu.js';

// The bar's width: most of a small monitor, capped on a large one so the
// slider stays a comfortable reach. Logical px.
const MAX_WIDTH = 960;
const SIDE_MARGIN = 32;
// How often the running time is redrawn while the bar is up and playing.
const TICK_MS = 250;
// Icon sizes at 100%, logical px: the shell's icon-button size, and the
// play button's larger one. The size setting multiplies them in JS, since St
// sizes a button's icon against the theme, not the panel's font size.
export const ICON_SIZE = 16;
const PLAY_ICON_SIZE = 22;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// Unredirection is the compositor's on 49 and 50 and was the display's
// before; whichever this shell has.
function setUnredirect(allowed) {
    if (global.compositor?.disable_unredirect) {
        if (allowed)
            global.compositor.enable_unredirect();
        else
            global.compositor.disable_unredirect();
    } else if (allowed) {
        Meta.enable_unredirect_for_display(global.display);
    } else {
        Meta.disable_unredirect_for_display(global.display);
    }
}

// "21:40" or "9:40 PM", as the top bar's clock is set to.
function clockTime(dateTime, format) {
    return dateTime.format(format === '12h' ? '%l:%M %p' : '%H:%M').trim();
}

// [start | centre | end], with the centre on the middle of the row whatever
// the sides hold and the sides sharing what is left — so the transport
// buttons stay put however long the title is, and a long title ellipsizes
// rather than pushing them over.
const CentredRowLayout = GObject.registerClass(
class CentredRowLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        // The bar's size setting, as a factor.
        this.scale = 1;
    }

    vfunc_get_preferred_width(container, forHeight) {
        const [start, centre, end] = container.get_children();
        const [cMin, cNat] = centre.get_preferred_width(forHeight);
        const [sMin, sNat] = start.get_preferred_width(forHeight);
        const [eMin, eNat] = end.get_preferred_width(forHeight);
        return [cMin + 2 * Math.max(sMin, eMin), cNat + 2 * Math.max(sNat, eNat)];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let min = 0, nat = 0;
        for (const child of container.get_children()) {
            const [m, n] = child.get_preferred_height(-1);
            min = Math.max(min, m);
            nat = Math.max(nat, n);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const [start, centre, end] = container.get_children();
        const width = box.get_width();
        const height = box.get_height();
        const gap = 12 * scaleFactor() * this.scale;
        const [, cNat] = centre.get_preferred_width(height);
        const cWidth = Math.min(cNat, width);
        const cX = Math.round((width - cWidth) / 2);

        const place = (child, x1, x2, align) => {
            const room = Math.max(0, x2 - x1);
            const [, natW] = child.get_preferred_width(height);
            const w = Math.min(natW, room);
            const [, natH] = child.get_preferred_height(w);
            const h = Math.min(natH, height);
            const x = align === 'end' ? x2 - w : x1;
            const y = Math.round((height - h) / 2);
            child.allocate(Clutter.ActorBox.new(box.x1 + x, box.y1 + y, box.x1 + x + w, box.y1 + y + h));
        };
        place(start, 0, cX - gap, 'start');
        place(centre, cX, cX + cWidth, 'start');
        place(end, cX + cWidth + gap, width, 'end');
    }
});

function iconButton(iconName, accessibleName, extraClass = '') {
    return new St.Button({
        style_class: `icon-button mc-button ${extraClass}`.trim(),
        icon_name: iconName,
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// The shell greys a button and takes it out of the focus chain together
// (popupMenu.js syncSensitive); St does only the first by itself.
function setSensitive(actor, on) {
    actor.reactive = actor.can_focus = on;
}

function rateLabel(rate) {
    return `${Number(rate.toFixed(2))}×`;
}

function volumeIcon(volume) {
    if (volume <= 0)
        return 'audio-volume-muted-symbolic';
    if (volume < 0.34)
        return 'audio-volume-low-symbolic';
    if (volume < 0.67)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

export const ControlBar = GObject.registerClass({
    Signals: {'action': {param_types: [GObject.TYPE_STRING]}},
}, class ControlBar extends Clutter.Actor {
    // The actor itself only places the panel: the constraint sizes it to the
    // monitor, and the alignment shrinks it back around the panel at the
    // bottom centre — the OSD's arrangement (osdWindow.js).
    _init() {
        super._init({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            visible: false,
            opacity: 0,
        });
        this._constraint = new Layout.MonitorConstraint({index: 0});
        this.add_constraint(this._constraint);

        this._player = null;
        this._syncing = false;
        this._seeking = false;
        this._volumeDragging = false;
        this._tickId = 0;
        this._tickMode = null;          // 'playing', 'idle' or null
        this._shown = false;            // arriving or here, not leaving
        this._unredirectOff = false;
        this._scale = 1;
        this._monitorIndex = 0;
        this._clockFormat = null;       // null: no clock line
        this._sleepText = null;         // null: no sleep button

        this.panel = new St.BoxLayout({
            style_class: 'mc-bar',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        this.add_child(this.panel);
        // Arrow keys walk the panel's buttons while it holds the keyboard.
        // The focus manager does that from the stage, which a key never
        // reaches while the panel holds the grab, so the panel asks it to
        // navigate from the event itself — as the shell's popup menu items
        // do. A slider that has the focus takes Left and Right first (seek,
        // volume); Up and Down leave it.
        global.focus_manager.add_group(this.panel);
        this.panel.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                this.emit('action', 'hide-bar');
                return Clutter.EVENT_STOP;
            }
            if (global.focus_manager.navigate_from_event(event))
                return Clutter.EVENT_STOP;
            // The pop-out's menu has the panel for its source, and a menu
            // toggles on Return, Space or the arrow towards it (Up) reaching
            // its source. A button has taken Return already; what gets here
            // is a slider's, or an arrow with nowhere to go — Up from the
            // top row — and it stops, or the pop-out would open unfilled.
            switch (key) {
            case Clutter.KEY_Up:
            case Clutter.KEY_Down:
            case Clutter.KEY_Left:
            case Clutter.KEY_Right:
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
            case Clutter.KEY_space:
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildSeekRow();
        this._buildControlRow();

        // Every icon the size setting scales, with its size at 100%.
        this._icons = [
            ...[this._previous, this._back, this._forward, this._next, this._tracks, this._mute, this._close]
                .map(button => [button.child, ICON_SIZE]),
            [this._play.child, PLAY_ICON_SIZE],
            [this._sleepIcon, ICON_SIZE],
        ];

        this.tracksMenu = new TracksMenu(this.panel, this._tracks);
        this._menuManager = new PopupMenu.PopupMenuManager(this.panel);
        this._menuManager.addMenu(this.tracksMenu);
        this.connect('destroy', () => this._onDestroy());
    }

    get dragging() {
        return this._seeking || this._volumeDragging;
    }

    get hovered() {
        return this.panel.hover;
    }

    get menuOpen() {
        return this.tracksMenu.isOpen;
    }

    // ------------------------------------------------------------------
    // Building
    // ------------------------------------------------------------------
    _buildSeekRow() {
        const row = new St.BoxLayout({style_class: 'mc-seek-row', x_expand: true});
        this._elapsed = new St.Label({style_class: 'mc-time mc-elapsed', y_align: Clutter.ActorAlign.CENTER});
        this._seek = new Slider(0);
        this._seek.add_style_class_name('mc-seek');
        this._seek.accessible_name = 'Position';
        this._remaining = new St.Label({style_class: 'mc-time mc-remaining', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._elapsed);
        row.add_child(this._seek);
        row.add_child(this._remaining);
        this.panel.add_child(row);

        this._seek.connect('drag-begin', () => {
            this._seeking = true;
        });
        this._seek.connect('drag-end', () => {
            this._seeking = false;
            if (this._player?.length)
                this._player.seekTo(this._seek.value * this._player.length);
        });
        // While dragging, the running time previews where the drop will land.
        this._seek.connect('notify::value', () => {
            if (this._seeking && !this._syncing)
                this._tick();
        });
        // The slider's own steps are a fraction of the whole — minutes, on a
        // film. A scroll or an arrow key skips the way the buttons do.
        this._seek.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.RIGHT)
                this.emit('action', 'seek-forward');
            else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.LEFT)
                this.emit('action', 'seek-back');
            return Clutter.EVENT_STOP;
        });
        this._seek.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            const rtl = this._seek.get_text_direction() === Clutter.TextDirection.RTL;
            if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
                const forward = (key === Clutter.KEY_Right) !== rtl;
                this.emit('action', forward ? 'seek-forward' : 'seek-back');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildControlRow() {
        this._rowLayout = new CentredRowLayout();
        const row = new St.Widget({
            style_class: 'mc-control-row',
            layout_manager: this._rowLayout,
            x_expand: true,
        });

        const info = new St.BoxLayout({
            style_class: 'mc-info',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'mc-title'});
        this._subtitle = new St.Label({style_class: 'mc-subtitle'});
        this._clock = new St.Label({style_class: 'mc-subtitle mc-clock', visible: false});
        for (const label of [this._title, this._subtitle, this._clock]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            info.add_child(label);
        }

        const transport = new St.BoxLayout({style_class: 'mc-transport'});
        this._previous = iconButton('media-skip-backward-symbolic', 'Previous');
        this._back = iconButton('media-seek-backward-symbolic', 'Skip back');
        this._play = iconButton('media-playback-start-symbolic', 'Play', 'mc-play');
        this._forward = iconButton('media-seek-forward-symbolic', 'Skip forward');
        this._next = iconButton('media-skip-forward-symbolic', 'Next');
        const actions = [
            [this._previous, 'previous'], [this._back, 'seek-back'], [this._play, 'play-pause'],
            [this._forward, 'seek-forward'], [this._next, 'next'],
        ];
        for (const [button, action] of actions) {
            button.connect('clicked', () => this.emit('action', action));
            transport.add_child(button);
        }

        const extras = new St.BoxLayout({style_class: 'mc-extras', y_align: Clutter.ActorAlign.CENTER});
        // Only where the player can be asked for its tracks (app.js
        // setRemote); the pop-out hangs off it.
        this._tracks = iconButton('media-view-subtitles-symbolic', 'Audio and subtitles');
        this._tracks.visible = false;
        this._tracks.connect('clicked', () => this.emit('action', 'tracks'));
        this._sleep = new St.Button({
            style_class: 'icon-button mc-button mc-sleep',
            accessible_name: 'Sleep timer',
            can_focus: true,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sleepBox = new St.BoxLayout({style_class: 'mc-sleep-box'});
        this._sleepIcon = new St.Icon({icon_name: 'weather-clear-night-symbolic', style_class: 'mc-sleep-icon'});
        sleepBox.add_child(this._sleepIcon);
        this._sleepLabel = new St.Label({style_class: 'mc-sleep-label', y_align: Clutter.ActorAlign.CENTER});
        sleepBox.add_child(this._sleepLabel);
        this._sleep.set_child(sleepBox);
        this._sleep.connect('clicked', () => this.emit('action', 'sleep-timer'));
        this._mute = iconButton('audio-volume-high-symbolic', 'Mute');
        this._mute.connect('clicked', () => this.emit('action', 'mute'));
        this._volume = new Slider(1);
        this._volume.add_style_class_name('mc-volume');
        this._volume.accessible_name = 'Volume';
        this._volume.x_expand = false;
        this._volume.y_align = Clutter.ActorAlign.CENTER;
        this._volume.connect('drag-begin', () => {
            this._volumeDragging = true;
        });
        this._volume.connect('drag-end', () => {
            this._volumeDragging = false;
        });
        this._volume.connect('notify::value', () => {
            if (!this._syncing)
                this._player?.setVolume(this._volume.value);
        });
        this._rate = new St.Button({
            style_class: 'icon-button mc-button mc-rate',
            label: '1×',
            accessible_name: 'Playback speed',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rate.connect('clicked', () => this._cycleRate());
        this._close = iconButton('window-close-symbolic', 'Close the player');
        this._close.connect('clicked', () => this.emit('action', 'quit'));
        for (const child of [this._tracks, this._sleep, this._mute, this._volume, this._rate, this._close])
            extras.add_child(child);

        row.add_child(info);
        row.add_child(transport);
        row.add_child(extras);
        this.panel.add_child(row);
    }

    // ------------------------------------------------------------------
    // What it shows
    // ------------------------------------------------------------------
    setPlayer(player) {
        if (player === this._player)
            return;
        // As the seek slider: an arrow key moves by the volume step the
        // buttons and the pad use, not the Slider's own tenth.
        this._volume.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            const rtl = this._volume.get_text_direction() === Clutter.TextDirection.RTL;
            if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
                const up = (key === Clutter.KEY_Right) !== rtl;
                this.emit('action', up ? 'volume-up' : 'volume-down');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._player?.disconnectObject(this);
        this._player = player;
        this._player?.connectObject('changed', () => this.sync(), this);
        this.sync();
    }

    // Onto the monitor the player is on, as wide as suits it.
    setMonitor(index) {
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return;
        this._monitorIndex = index;
        this._constraint.index = index;
        const scale = scaleFactor();
        this.panel.width = Math.min(monitor.width - 2 * SIDE_MARGIN * scale, MAX_WIDTH * scale * this._scale);
    }

    // The size setting, in percent. Every size in the stylesheet is in em,
    // so one font size on the panel scales the lot; the pop-out follows.
    setScale(percent) {
        this._scale = percent / 100;
        const style = percent === 100 ? null : `font-size: ${percent}%;`;
        this.panel.style = style;
        this.tracksMenu.actor.style = style;
        this._rowLayout.scale = this._scale;
        this._rowLayout.layout_changed();
        for (const [icon, size] of this._icons)
            icon.icon_size = Math.round(size * this._scale);
        this.tracksMenu.setIconSize(Math.round(ICON_SIZE * this._scale));
        this.setMonitor(this._monitorIndex);
    }

    // The tracks button and its pop-out, for a player that can be asked
    // (a VlcRemote), or neither.
    setRemote(remote) {
        this._tracks.visible = !!remote;
        this.tracksMenu.setRemote(remote);
    }

    openTracks({focus = false} = {}) {
        if (!this._tracks.visible)
            return;
        if (this.tracksMenu.isOpen)
            this.tracksMenu.close();
        else
            this.tracksMenu.openFresh({focus});
    }

    // The clock line under the title — '24h' or '12h', as the top bar's is —
    // or null for none.
    setClock(format) {
        this._clockFormat = format;
        this._clock.visible = !!format;
        this._tick();
        this._updateTicking();
    }

    // The sleep timer button, labelled by `text()` as it runs; null for no
    // button at all.
    setSleep(text) {
        this._sleepText = text;
        this._sleep.visible = !!text;
        this._tick();
        this._updateTicking();
    }

    sync() {
        const p = this._player;
        if (!p)
            return;
        this._syncing = true;
        try {
            this._title.text = p.title || p.identity || 'Unknown';
            const subtitle = p.artist || (p.title ? p.identity : '');
            this._subtitle.text = subtitle;
            this._subtitle.visible = !!subtitle;

            this._play.icon_name = p.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this._play.accessible_name = p.playing ? 'Pause' : 'Play';
            setSensitive(this._previous, p.canGoPrevious);
            setSensitive(this._next, p.canGoNext);
            setSensitive(this._back, p.canSeek);
            setSensitive(this._forward, p.canSeek);
            setSensitive(this._seek, p.canSeek && p.length > 0);

            if (!this._volumeDragging)
                this._volume.value = Math.min(1, p.volume);
            this._mute.icon_name = volumeIcon(p.volume);
            this._mute.accessible_name = p.muted ? 'Unmute' : 'Mute';

            this._rate.visible = p.hasRate;
            this._rate.label = rateLabel(p.rate);
        } finally {
            this._syncing = false;
        }
        this._tick();
        this._updateTicking();
    }

    _tick() {
        const p = this._player;
        if (!p)
            return;
        const at = this._seeking ? this._seek.value * p.length : p.now;
        this._elapsed.text = formatTime(at);
        this._remaining.text = p.length ? `−${formatTime(p.length - at)}` : '';
        if (this._clockFormat) {
            const now = GLib.DateTime.new_now_local();
            const left = p.length ? (p.length - at) / (p.rate || 1) : 0;
            this._clock.text = left
                ? `${clockTime(now, this._clockFormat)} · ends at ${clockTime(now.add_seconds(left), this._clockFormat)}`
                : clockTime(now, this._clockFormat);
        }
        if (this._sleepText) {
            const text = this._sleepText();
            this._sleepLabel.text = text;
            this._sleepLabel.visible = !!text;
        }
        if (!this._seeking) {
            this._syncing = true;
            this._seek.value = p.length ? Math.min(1, at / p.length) : 0;
            this._syncing = false;
        }
    }

    // A timer only while there is something on the bar that moves: the
    // running time while playing, every TICK_MS; otherwise the clock and the
    // sleep countdown, which move by the minute, so once a second will do —
    // with `stay-while-paused` a paused bar can be up for hours.
    _updateTicking() {
        let mode = null;
        if (this.visible && this._player?.playing)
            mode = 'playing';
        else if (this.visible && (this._clockFormat || this._sleepText))
            mode = 'idle';
        if (mode === this._tickMode)
            return;
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._tickMode = mode;
        if (!mode)
            return;
        const tick = () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        };
        this._tickId = mode === 'playing'
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, tick)
            : GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);
        GLib.Source.set_name_by_id(this._tickId, '[media-controls] tick');
    }

    _cycleRate() {
        const p = this._player;
        if (!p?.hasRate)
            return;
        const allowed = RATES.filter(r => r >= p.minRate && r <= p.maxRate);
        const at = allowed.findIndex(r => r > p.rate + 1e-6);
        p.setRate(allowed[at === -1 ? 0 : at]);
    }

    // ------------------------------------------------------------------
    // Coming and going
    // ------------------------------------------------------------------
    reveal() {
        // Arriving already, or here. The pointer asks again every 100 ms
        // while it moves, and restarting the ease each time kept it from
        // ever settling (the opacity stalls at 254 as it is rounded down).
        if (this._shown)
            return;
        this._shown = true;
        if (!this._unredirectOff) {
            // Over a fullscreen window the compositor may be sending that
            // window straight to the screen; the shell's OSD turns that off
            // while it is up, and so does this.
            setUnredirect(false);
            this._unredirectOff = true;
        }
        this.remove_all_transitions();
        if (!this.visible) {
            this.translation_y = RISE * scaleFactor();
            this.show();
        }
        // Above whatever chrome came after it, as the OSD raises itself.
        this.get_parent()?.set_child_above_sibling(this, null);
        this.ease({
            opacity: 255,
            translation_y: 0,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._tick();
        this._updateTicking();
    }

    conceal({animate = true} = {}) {
        if (!this.visible)
            return;
        this._shown = false;
        this.remove_all_transitions();
        this.tracksMenu.close();
        const done = () => {
            this.hide();
            this.opacity = 0;
            this.translation_y = 0;
            this._updateTicking();
            if (this._unredirectOff) {
                setUnredirect(true);
                this._unredirectOff = false;
            }
        };
        if (!animate) {
            done();
            return;
        }
        this.ease({
            opacity: 0,
            duration: Duration.FAST,
            mode: Ease.OUT,
            onComplete: done,
        });
    }

    // Where the keyboard lands when the bar is opened with it.
    focusDefault() {
        this._play.grab_key_focus();
    }

    _onDestroy() {
        this.tracksMenu.destroy();
        this._player?.disconnectObject(this);
        this._player = null;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
            this._tickMode = null;
        }
        if (this._unredirectOff) {
            setUnredirect(true);
            this._unredirectOff = false;
        }
        global.focus_manager.remove_group(this.panel);
    }
});
