// The bar itself: a panel at the foot of the player's monitor, holding the
// position, the transport buttons, the volume and the rate. It knows how to
// show a player and how to ask it for things; when to be seen is app.js's.
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
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {RATES, formatTime} from './actions.js';
import {Duration, Ease, RISE} from './anim.js';

// The bar's width: most of a small monitor, capped on a large one so the
// slider stays a comfortable reach. Logical px.
const MAX_WIDTH = 960;
const SIDE_MARGIN = 32;
// How often the running time is redrawn while the bar is up and playing.
const TICK_MS = 250;

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

const DIRECTIONS = new Map([
    [Clutter.KEY_Left, St.DirectionType.LEFT],
    [Clutter.KEY_Right, St.DirectionType.RIGHT],
    [Clutter.KEY_Up, St.DirectionType.UP],
    [Clutter.KEY_Down, St.DirectionType.DOWN],
    [Clutter.KEY_Tab, St.DirectionType.TAB_FORWARD],
    [Clutter.KEY_ISO_Left_Tab, St.DirectionType.TAB_BACKWARD],
]);

// [start | centre | end], with the centre on the middle of the row whatever
// the sides hold and the sides sharing what is left — so the transport
// buttons stay put however long the title is, and a long title ellipsizes
// rather than pushing them over.
const CentredRowLayout = GObject.registerClass(
class CentredRowLayout extends Clutter.LayoutManager {
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
        const gap = 12 * scaleFactor();
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
        this._unredirectOff = false;

        this.panel = new St.BoxLayout({
            style_class: 'mc-bar',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        this.add_child(this.panel);
        // Arrow keys walk the panel's buttons while it holds the keyboard.
        // The focus manager does that from the stage, which a key never
        // reaches while the panel holds the grab, so the panel moves the
        // focus itself — as the shell's popup menu items do. A slider that
        // has the focus takes Left and Right first (seek, volume); Up and
        // Down leave it.
        global.focus_manager.add_group(this.panel);
        this.panel.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                this.emit('action', 'hide-bar');
                return Clutter.EVENT_STOP;
            }
            const direction = DIRECTIONS.get(key);
            if (direction === undefined)
                return Clutter.EVENT_PROPAGATE;
            const wrap = direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD;
            this.panel.navigate_focus(global.stage.get_key_focus(), direction, wrap);
            return Clutter.EVENT_STOP;
        });

        this._buildSeekRow();
        this._buildControlRow();
        this.connect('destroy', () => this._onDestroy());
    }

    get dragging() {
        return this._seeking || this._volumeDragging;
    }

    get hovered() {
        return this.panel.hover;
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
        const row = new St.Widget({
            style_class: 'mc-control-row',
            layout_manager: new CentredRowLayout(),
            x_expand: true,
        });

        const info = new St.BoxLayout({
            style_class: 'mc-info',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'mc-title'});
        this._subtitle = new St.Label({style_class: 'mc-subtitle'});
        for (const label of [this._title, this._subtitle]) {
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
        for (const child of [this._mute, this._volume, this._rate, this._close])
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
        this._constraint.index = index;
        const scale = scaleFactor();
        this.panel.width = Math.min(monitor.width - 2 * SIDE_MARGIN * scale, MAX_WIDTH * scale);
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
            this._previous.reactive = p.canGoPrevious;
            this._next.reactive = p.canGoNext;
            this._back.reactive = this._forward.reactive = p.canSeek;
            this._seek.reactive = p.canSeek && p.length > 0;

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
        if (!this._seeking) {
            this._syncing = true;
            this._seek.value = p.length ? Math.min(1, at / p.length) : 0;
            this._syncing = false;
        }
    }

    // A timer only while there is a running time to show moving.
    _updateTicking() {
        const want = this.visible && !!this._player?.playing;
        if (want && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
            GLib.Source.set_name_by_id(this._tickId, '[media-controls] tick');
        } else if (!want && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
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
        if (this.visible && this.opacity === 255)
            return;
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
        this.remove_all_transitions();
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
        this._player?.disconnectObject(this);
        this._player = null;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._unredirectOff) {
            setUnredirect(true);
            this._unredirectOff = false;
        }
        global.focus_manager.remove_group(this.panel);
    }
});
