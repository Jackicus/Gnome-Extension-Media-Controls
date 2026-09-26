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
//   `hide-delay` seconds unless the pointer is on it, it has the keyboard, its
//   pop-out is open, a slider is being dragged, or — with `stay-while-paused`
//   — the player is paused. The pointer is watched with the shell's PointerWatcher, which
//   polls only while the user is active and takes no input away from the
//   video.
//
// How is it above the video?  It is chrome (`Main.layoutManager.addChrome`)
//   with `trackFullscreen` off, which is the default: chrome sits in uiGroup
//   above every window, and only actors that ask to (the top bar) hide over a
//   fullscreen one. While it is up it turns unredirection off, as the OSD does.
//
// Beyond MPRIS: a VLC whose settings open its remote-control socket
// (vlcconfig.js) also gets the audio-and-subtitles pop-out (vlcremote.js,
// tracksmenu.js), connected only once the socket's owner is the attached
// player's own process. The pad can move around the bar: while it holds the
// focus — opened with Start (`navigate`), the key, or with the pop-out up — the
// d-pad and the bottom and right buttons are pressed as the arrow keys,
// Return and Escape on a virtual keyboard, so the pad drives exactly what the
// keyboard drives. Those keys are only ever pressed while the bar holds the
// grab, so they can never reach the player. The sleep timer and the clock
// are settings, off by default.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import {NAVIGATION, SLEEP_STEPS, SUBTITLE_SHIFT_MS, isIgnored, normaliseName, playerNames, stepRate} from './actions.js';
import {ControlBar} from './bar.js';
import {Gamepads} from './gamepads.js';
import {PlayerRegistry} from './mpris.js';
import {VlcRemote} from './vlcremote.js';

// How often the pointer is looked at while the user is active, in ms.
const POINTER_INTERVAL = 100;
// `bottom-edge` counts this much of the monitor's height as the edge.
const EDGE_FRACTION = 0.2;
// A VLC without its socket is asked again at most this often, in seconds, as
// the bar comes up: it may have been set up since, or still be starting.
const REMOTE_RETRY = 10;
// The sleep timer's end-of-file step pauses this far before the end, so a
// player that exits at the end of its file stays open, paused.
const SLEEP_END_MARGIN = 0.5;

const clock = () => GLib.get_monotonic_time() / 1e6;

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
        this._remote = null;
        this._remoteTriedAt = -Infinity;
        this._remoteRetryId = 0;
        this._keyboard = null;
        this._sleep = null;
        this._sleepId = 0;
    }

    enable() {
        this._settings = this._extension.getSettings();

        this._bar = new ControlBar();
        this._bar.connect('action', (_bar, action) => this.perform(action));
        this._bar.panel.connect('notify::hover', () => this._armHide());
        this._bar.tracksMenu.connect('open-state-changed', () => this._armHide());
        this._bar.setScale(this._settings.get_int('bar-scale'));
        // No params: trackFullscreen is off by default, which is the point,
        // and 48's affectsInputRegion (default on) is gone by 50.
        Main.layoutManager.addChrome(this._bar);

        this._registry = new PlayerRegistry();
        this._registry.connectObject(
            'added', () => this._queueUpdate(),
            'removed', (_registry, player) => {
                if (this._sleep?.player === player)
                    this._setSleep(null);
                this._queueUpdate();
            },
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
            'changed::bar-scale', () => this._bar.setScale(this._settings.get_int('bar-scale')),
            'changed::show-clock', () => this._syncClock(),
            'changed::sleep-timer', () => this._syncSleep(),
            this);
        this._syncClock();
        this._syncSleep();

        Main.wm.addKeybinding('toggle-bar', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP, () => this._toggleFocus());

        this._syncGamepads();
        this._update();
    }

    // Safe on a half-done enable(), and each step on its own: one that throws
    // must not leave the rest standing — a bar and handlers left behind by a
    // disable that stopped halfway keep running beside the next enable's.
    disable() {
        const steps = [
            () => Main.wm.removeKeybinding('toggle-bar'),
            () => this._setSleep(null),
            () => this._dropRemote(),
            () => this._ungrab(),
            () => this._keyboard?.run_dispose(),
            () => this._pads?.disable(),
            () => this._stopPointerWatch(),
            () => this._hideId && GLib.source_remove(this._hideId),
            () => this._updateId && GLib.source_remove(this._updateId),
            () => this._watchWindow(null),
            () => this._player?.disconnectObject(this),
            () => global.display.disconnectObject(this),
            () => Main.overview.disconnectObject(this),
            () => Main.layoutManager.disconnectObject(this),
            () => this._settings?.disconnectObject(this),
            () => this._registry?.disconnectObject(this),
            () => this._registry?.disable(),
            () => this._bar?.destroy(),
        ];
        for (const step of steps) {
            try {
                step();
            } catch (e) {
                console.error('[Media Controls] Error during disable:', e);
            }
        }
        this._pads = null;
        this._hideId = this._updateId = 0;
        this._player = this._window = null;
        this._keyboard = null;
        this._registry = null;
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
        const ignored = this._settings.get_strv('ignored-players').map(normaliseName);
        const players = this._registry.players.filter(p => !isIgnored(p, ignored));
        const pid = window.get_pid();
        const byPid = pid > 0 && players.find(p => p.pid === pid);
        if (byPid)
            return byPid;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const ids = [app?.get_id(), window.get_sandboxed_app_id(), window.get_gtk_application_id(),
            window.get_wm_class(), window.get_wm_class_instance()].filter(Boolean).map(normaliseName);
        return players.find(p => p.desktopEntry && ids.includes(normaliseName(p.desktopEntry))) ?? null;
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
        this._dropRemote();
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
        this._connectRemote(player);
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
        if (!this._bar.visible) {
            this._player.refreshPosition();
            this._readTracks();
            if (!this._remote && clock() - this._remoteTriedAt > REMOTE_RETRY)
                this._connectRemote(this._player);
        }
        this._bar.reveal();
        this._armHide();
    }

    _conceal() {
        // The bar closes its pop-out, and the pop-out's own grab, first.
        this._bar.conceal();
        this._ungrab();
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
        return this._bar.hovered || this._bar.dragging || !!this._grab || this._bar.menuOpen ||
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

    // The key (and the pad's `navigate`) opens the bar holding the keyboard,
    // so the arrow keys walk its buttons and Escape — or the key again — puts
    // it away. The grab is the popup tier the shell's own menus use.
    _toggleFocus() {
        if (this._grab)
            this._conceal();
        else
            this._enterFocus();
    }

    _enterFocus() {
        if (!this._player || this._grab)
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
        case 'navigate': this._toggleFocus(); return true;
        case 'tracks': this._openTracks(); return true;
        // These leave the bar where it is: subtitles are drawn along the
        // foot of the picture, under the bar, and are what is being watched
        // while they are timed. VLC says what changed in its own message.
        case 'cycle-audio': this._remote?.cycleAudio(); return true;
        case 'cycle-subtitles': this._remote?.cycleSubtitles(); return true;
        case 'subtitles-earlier': this._remote?.shiftSubtitles(-SUBTITLE_SHIFT_MS); return true;
        case 'subtitles-later': this._remote?.shiftSubtitles(SUBTITLE_SHIFT_MS); return true;
        case 'sleep-timer':
            if (!this._settings.get_boolean('sleep-timer'))
                return false;
            this._cycleSleep();
            // Nothing on the player changed, so the bar is told itself.
            this._bar.sync();
            break;
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

    // ------------------------------------------------------------------
    // Tracks
    // ------------------------------------------------------------------
    // VLC's remote-control socket, when this VLC opened one. A first attempt
    // that finds VLC still busy with the connection before it (a reload, a
    // shell restart) is tried once more a moment later.
    _connectRemote(player, retry = true) {
        this._dropRemote();
        if (!player?.pid || !playerNames(player).includes('vlc'))
            return;
        this._remoteTriedAt = clock();
        const remote = new VlcRemote();
        this._remote = remote;
        remote.open(player.pid).then(ok => {
            if (this._remote !== remote)
                return;
            if (!ok) {
                remote.close();
                this._remote = null;
                if (retry && remote.answered === false) {
                    this._remoteRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._remoteRetryId = 0;
                        if (this._player === player && !this._remote)
                            this._connectRemote(player, false);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
            remote.connectObject('lost', () => {
                if (this._remote === remote)
                    this._dropRemote();
            }, this);
            this._bar.setRemote(remote);
            this._readTracks();
        });
    }

    // Closed before anything else, so a VLC is never left holding a
    // connection nobody reads: it serves only one. A retry still pending is
    // for this player, and goes too.
    _dropRemote() {
        if (this._remoteRetryId) {
            GLib.source_remove(this._remoteRetryId);
            this._remoteRetryId = 0;
        }
        const remote = this._remote;
        if (!remote)
            return;
        this._remote = null;
        remote.close();
        remote.disconnectObject(this);
        this._bar?.setRemote(null);
    }

    // VLC lists its tracks only while playing (vlcremote.js), so they are read
    // whenever there is a chance — connecting, the bar coming up — for the
    // pop-out to have them if it is opened paused.
    _readTracks() {
        if (this._remote && this._player?.playing)
            this._remote.state().catch(() => {});
    }

    // With the keyboard or the pad in charge the pop-out takes the focus, so
    // its lists can be walked the same way; from the mouse it just opens.
    // Without a remote there is no tracks button, and only the bar comes up.
    _openTracks() {
        this._reveal();
        this._bar.openTracks({focus: !!this._grab});
    }

    // ------------------------------------------------------------------
    // The pad
    // ------------------------------------------------------------------
    _onPadButton(button, action) {
        if (!this._player)
            return;
        const key = NAVIGATION[button];
        if (key && (this._grab || this._bar.menuOpen)) {
            this._pressKey(Clutter[`KEY_${key}`]);
            return;
        }
        // The pop-out from the pad is walked with the pad.
        if (action === 'tracks' && this._remote)
            this._enterFocus();
        this.perform(action);
    }

    // The on-screen keyboard's way of pressing a key. Only called while the
    // bar or its pop-out holds the grab, so the key lands on them.
    _pressKey(keyval) {
        if (!this._keyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
    }

    // ------------------------------------------------------------------
    // Clock and sleep timer
    // ------------------------------------------------------------------
    // The 12/24-hour setting is the shell's formatting's to read (bar.js).
    _syncClock() {
        this._bar.setClock(this._settings.get_boolean('show-clock'));
    }

    _syncSleep() {
        const on = this._settings.get_boolean('sleep-timer');
        if (!on)
            this._setSleep(null);
        this._bar.setSleep(on ? () => this._sleepText() : null);
    }

    _sleepText() {
        if (!this._sleep)
            return '';
        if (this._sleep.step === 'end')
            return 'End';
        return `${Math.max(1, Math.ceil((this._sleep.until - clock()) / 60))} min`;
    }

    // Off, then each of SLEEP_STEPS in turn, then off again.
    _cycleSleep() {
        const at = this._sleep ? SLEEP_STEPS.indexOf(this._sleep.step) : -1;
        this._setSleep(SLEEP_STEPS[at + 1] ?? null);
    }

    _setSleep(step) {
        if (this._sleepId) {
            GLib.source_remove(this._sleepId);
            this._sleepId = 0;
        }
        for (const id of this._sleep?.signals ?? [])
            this._sleep.player.disconnect(id);
        this._sleep = null;
        if (step === null || !this._player)
            return;
        const player = this._player;
        this._sleep = {step, player, signals: []};
        if (step === 'end') {
            // Wherever the end moves to: a seek, a pause, another rate.
            this._sleep.signals = [
                player.connect('changed', () => this._armSleepEnd()),
                player.connect('seeked', () => this._armSleepEnd()),
            ];
            this._armSleepEnd();
        } else {
            this._sleep.until = clock() + step * 60;
            this._sleepId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, step * 60, () => {
                this._sleepId = 0;
                this._sleepEnded();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _armSleepEnd() {
        if (this._sleepId) {
            GLib.source_remove(this._sleepId);
            this._sleepId = 0;
        }
        const p = this._sleep?.player;
        if (!p?.playing || !p.length)
            return;
        const left = Math.max(0, (p.length - p.now) / (p.rate || 1) - SLEEP_END_MARGIN);
        this._sleepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(left * 1000), () => {
            this._sleepId = 0;
            this._sleepEnded();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Pause, and leave it at that: the pause brings the bar up and keeps it
    // there, and once the player stops holding the screen awake GNOME's own
    // blank-screen delay takes it from there.
    _sleepEnded() {
        const player = this._sleep?.player;
        this._setSleep(null);
        if (player && this._registry.players.includes(player))
            player.pause();
    }

    _syncGamepads() {
        const want = this._settings.get_boolean('gamepads');
        if (want && !this._pads) {
            this._pads = new Gamepads(this._settings, (button, action) => this._onPadButton(button, action));
            this._pads.enable().catch(e => console.error('[Media Controls] Could not watch controllers:', e));
        } else if (!want && this._pads) {
            this._pads.disable();
            this._pads = null;
        }
    }
}
