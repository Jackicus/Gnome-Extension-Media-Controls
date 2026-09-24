// Media Controls: a bar the shell draws over a fullscreen video player.
//
// Three questions decide everything here, and each has one answer:
//
// Which player?  The one that owns the focused window, when that window is
//   fullscreen (`_update`). A player is matched to its window by process id
//   first — the bus tells us whose connection a player is, the window says
//   whose it is — and by desktop entry after that, for a sandboxed player
//   whose bus connection goes through a proxy. With two players running, the
//   one you are looking at is the one you get; with no fullscreen player
//   focused, the bar is not attached to anything and nothing here reacts.
//   Players named in `ignored-players` (the browsers, by default: they draw
//   their own controls) are never matched.
//
// When is it seen?  When the pointer moves over the player (`pointer-reveal`
//   `anywhere`, as VLC's own fullscreen controller does) or near its bottom
//   edge (`bottom-edge`); when the `toggle-bar` key is pressed, which also
//   gives it the keyboard; when a pad button does something; and when the
//   player pauses, seeks or changes file by itself. It goes after
//   `hide-delay` seconds unless the pointer is on it, it has the keyboard, a
//   slider is being dragged, or — with `stay-while-paused` — the player is
//   paused. The pointer is watched with the shell's PointerWatcher, which
//   polls only while the user is active and takes no input away from the
//   video.
//
// How is it above the video?  It is chrome (`Main.layoutManager.addChrome`)
//   with `trackFullscreen` off, which is the default: chrome sits in uiGroup
//   above every window, and only actors that ask to (the top bar) hide over a
//   fullscreen one. While it is up it turns unredirection off, as the OSD does.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import {isIgnored, stepRate} from './actions.js';
import {ControlBar} from './bar.js';
import {Gamepads} from './gamepads.js';
import {PlayerRegistry} from './mpris.js';

// How often the pointer is looked at while the user is active, in ms.
const POINTER_INTERVAL = 100;
// `bottom-edge` counts this much of the monitor's height as the edge.
const EDGE_FRACTION = 0.2;

const normalise = id => (id ?? '').toLowerCase().replace(/\.desktop$/, '');

export class MediaControlsApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._registry = null;
        this._bar = null;
        this._pads = null;
        this._player = null;
        this._window = null;
        this._pointerWatch = null;
        this._hideId = 0;
        this._grab = null;
        this._pressId = 0;
        this._updateId = 0;
        this._watched = null;
    }

    enable() {
        this._settings = this._extension.getSettings();

        this._bar = new ControlBar();
        this._bar.connect('action', (_bar, action) => this.perform(action));
        this._bar.panel.connect('notify::hover', () => this._armHide());
        // No params: trackFullscreen is off by default, which is the point,
        // and 48's affectsInputRegion (default on) is gone by 50.
        Main.layoutManager.addChrome(this._bar);

        this._registry = new PlayerRegistry();
        this._registry.connectObject(
            'added', () => this._queueUpdate(),
            'removed', () => this._queueUpdate(),
            // A player's pid arrives after it does, and its desktop entry
            // with its properties; either can be what matches it.
            'changed', () => {
                if (!this._player)
                    this._queueUpdate();
            },
            this);
        this._registry.enable();

        global.display.connectObject('notify::focus-window', () => this._queueUpdate(), this);
        Main.overview.connectObject(
            'showing', () => this._queueUpdate(),
            'hidden', () => this._queueUpdate(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueUpdate(), this);
        this._settings.connectObject(
            'changed::ignored-players', () => this._queueUpdate(),
            'changed::pointer-reveal', () => this._syncPointerWatch(),
            'changed::gamepads', () => this._syncGamepads(),
            this);

        Main.wm.addKeybinding('toggle-bar', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP, () => this._toggleKeyboard());

        this._syncGamepads();
        this._update();
    }

    // Safe on a half-done enable(): an exception partway through leaves the
    // extension enabled as far as the shell knows, and this is what runs next.
    disable() {
        Main.wm.removeKeybinding('toggle-bar');
        this._ungrab();
        this._pads?.disable();
        this._pads = null;
        this._stopPointerWatch();
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }
        this._watchWindow(null);
        this._player?.disconnectObject(this);
        this._player = null;
        this._window = null;
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._registry?.disconnectObject(this);
        this._registry?.disable();
        this._registry = null;
        this._bar?.destroy();
        this._bar = null;
        this._settings = null;
    }

    // ------------------------------------------------------------------
    // Which player
    // ------------------------------------------------------------------
    // Several things can change at once (focus moves as the overview hides);
    // they are settled together on the next idle.
    _queueUpdate() {
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const focused = global.display.focus_window;
        this._watchWindow(focused);
        const window = focused?.is_fullscreen() && !Main.overview.visible ? focused : null;
        const player = window ? this._playerFor(window) : null;
        this._attach(player, player ? window : null);
    }

    // The focused window can go fullscreen, leave it or close without the
    // focus moving.
    _watchWindow(window) {
        if (window === this._watched)
            return;
        this._watched?.disconnectObject(this);
        this._watched = window;
        window?.connectObject(
            'notify::fullscreen', () => this._queueUpdate(),
            'notify::main-monitor', () => this._queueUpdate(),
            'unmanaged', () => this._queueUpdate(),
            this);
    }

    _playerFor(window) {
        const ignored = this._settings.get_strv('ignored-players').map(normalise);
        const players = this._registry.players.filter(p => !isIgnored(p, ignored));
        const pid = window.get_pid();
        const byPid = pid > 0 && players.find(p => p.pid === pid);
        if (byPid)
            return byPid;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const ids = [app?.get_id(), window.get_sandboxed_app_id(), window.get_gtk_application_id(),
            window.get_wm_class(), window.get_wm_class_instance()].filter(Boolean).map(normalise);
        return players.find(p => p.desktopEntry && ids.includes(normalise(p.desktopEntry))) ?? null;
    }

    _attach(player, window) {
        if (player === this._player && window === this._window) {
            if (window)
                this._bar.setMonitor(window.get_monitor());
            return;
        }
        this._player?.disconnectObject(this);
        this._player = player;
        this._window = window;
        this._ungrab();
        this._bar.setPlayer(player);
        if (!player) {
            this._bar.conceal({animate: false});
            this._syncPointerWatch();
            return;
        }
        console.log(`[Media Controls] Attached to ${player.identity || player.busName} (pid ${player.pid})`);
        this._bar.setMonitor(window.get_monitor());
        let status = player.status;
        let url = player.url;
        player.connectObject(
            // What the player does by itself is shown: a pause (by a remote's
            // media key, say) brings the bar up and keeps it there, a new file
            // flashes it, and playing again lets it go.
            'changed', () => {
                if (player.status !== status || player.url !== url) {
                    status = player.status;
                    url = player.url;
                    this._reveal();
                }
            },
            'seeked', () => this._reveal(),
            this);
        this._syncPointerWatch();
        // Paused already when it came into focus: say so.
        if (player.status === 'Paused')
            this._reveal();
    }

    // ------------------------------------------------------------------
    // When it is seen
    // ------------------------------------------------------------------
    _reveal() {
        if (!this._player)
            return;
        if (!this._bar.visible)
            this._player.refreshPosition();
        this._bar.reveal();
        this._armHide();
    }

    _conceal() {
        this._ungrab();
        this._bar.conceal();
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }

    _armHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
        if (!this._bar?.visible)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('hide-delay') * 1000, () => {
                this._hideId = 0;
                if (this._staying())
                    this._armHide();
                else
                    this._conceal();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._hideId, '[media-controls] hide');
    }

    _staying() {
        return this._bar.hovered || this._bar.dragging || !!this._grab ||
            (this._settings.get_boolean('stay-while-paused') && this._player?.status === 'Paused');
    }

    _syncPointerWatch() {
        const want = !!this._player && this._settings.get_string('pointer-reveal') !== 'never';
        if (want && !this._pointerWatch)
            this._pointerWatch = getPointerWatcher().addWatch(POINTER_INTERVAL, (x, y) => this._pointerMoved(x, y));
        else if (!want)
            this._stopPointerWatch();
    }

    _stopPointerWatch() {
        this._pointerWatch?.remove();
        this._pointerWatch = null;
    }

    _pointerMoved(x, y) {
        if (!this._window)
            return;
        const monitor = Main.layoutManager.monitors[this._window.get_monitor()];
        if (!monitor || x < monitor.x || x >= monitor.x + monitor.width ||
            y < monitor.y || y >= monitor.y + monitor.height)
            return;
        if (this._settings.get_string('pointer-reveal') === 'bottom-edge' &&
            y < monitor.y + monitor.height * (1 - EDGE_FRACTION) && !this._bar.hovered)
            return;
        this._reveal();
    }

    // The key opens the bar holding the keyboard, so the arrow keys walk its
    // buttons and Escape — or the key again — puts it away. The grab is the
    // popup tier the shell's own menus use.
    _toggleKeyboard() {
        if (this._grab) {
            this._conceal();
            return;
        }
        if (!this._player)
            return;
        this._reveal();
        this._grab = Main.pushModal(this._bar.panel, {actionMode: Shell.ActionMode.POPUP});
        // While the panel holds the grab, a press anywhere reaches it; one
        // that landed outside it puts the bar away, as a popup menu goes.
        this._pressId = this._bar.panel.connect('button-press-event', (actor, event) => {
            if (!actor.contains(global.stage.get_event_actor(event)))
                this._conceal();
            return Clutter.EVENT_PROPAGATE;
        });
        this._bar.focusDefault();
        this._armHide();
    }

    _ungrab() {
        if (!this._grab)
            return;
        this._bar.panel.disconnect(this._pressId);
        this._pressId = 0;
        Main.popModal(this._grab);
        this._grab = null;
    }

    // ------------------------------------------------------------------
    // What it does
    // ------------------------------------------------------------------
    // One vocabulary (actions.js ACTIONS) for the bar's buttons, the pads and
    // anything else that asks. Returns whether a player was there to ask.
    perform(action) {
        const p = this._player;
        if (!p)
            return false;
        const seek = this._settings.get_int('seek-step');
        const volume = this._settings.get_int('volume-step') / 100;
        switch (action) {
        case 'play-pause': p.playPause(); break;
        case 'seek-back': p.seekBy(-seek); break;
        case 'seek-forward': p.seekBy(seek); break;
        case 'previous': p.previous(); break;
        case 'next': p.next(); break;
        case 'volume-up': p.setVolume(p.volume + volume); break;
        case 'volume-down': p.setVolume(p.volume - volume); break;
        case 'mute': p.toggleMute(); break;
        case 'slower': p.setRate(stepRate(p.rate, -1, p.minRate, p.maxRate)); break;
        case 'faster': p.setRate(stepRate(p.rate, 1, p.minRate, p.maxRate)); break;
        case 'quit': this._quit(); return true;
        case 'hide-bar': this._conceal(); return true;
        case 'show-bar': break;
        default: return false;
        }
        this._reveal();
        return true;
    }

    // Quit over MPRIS where the player allows it; otherwise ask its window
    // to close, the way its own close button would.
    _quit() {
        const window = this._window;
        this._conceal();
        if (this._player.canQuit)
            this._player.quit();
        else
            window?.delete(global.get_current_time());
    }

    _syncGamepads() {
        const want = this._settings.get_boolean('gamepads');
        if (want && !this._pads) {
            this._pads = new Gamepads(this._settings, action => this.perform(action));
            this._pads.enable().catch(e => console.error('[Media Controls] Could not watch controllers:', e));
        } else if (!want && this._pads) {
            this._pads.disable();
            this._pads = null;
        }
    }
}
