// The media players on the session bus, as far as they have told us, and the
// few things the bar asks of them.
//
// MPRIS is the D-Bus interface VLC (with --dbus, its default), mpv (with
// mpv-mpris), Celluloid, Showtime and the browsers speak, and what the shell's
// own media controls read. It says when a player comes and goes, what it has
// open, how long that is, whether it is playing, its volume and rate, and when
// it seeks. It never says where playback has got to unless asked. So the
// position is read, and the clock reading it was taken at kept beside it;
// where playback is at any moment is that position moved on by the clock
// while playing (`Player.now`). A reading is taken when the bar comes up,
// when a player starts playing and when it moves to a new file; a seek
// announces its own.
//
// Nothing here blocks a player: every call is asynchronous and cancelled on
// disable, and a player that never answers leaves a stale row, not a frozen
// shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_NAMESPACE = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT = 'org.mpris.MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
// Long enough for a busy player, short enough that a hung one is given up on
// well before GDBus's own 25 s default.
const CALL_TIMEOUT = 5000;

const clock = () => GLib.get_monotonic_time() / 1e6;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// The last part of a URL, decoded — what a file is called when its metadata
// has no title. A string operation, so it never touches the file.
function nameFromUrl(url) {
    if (typeof url !== 'string' || !url)
        return '';
    const last = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
    try {
        return decodeURIComponent(last);
    } catch (e) {
        return last;
    }
}

// One player: one unique bus name, however many well-known names it holds
// (VLC takes a second per instance). Emits 'changed' whenever anything it
// shows changed, and 'seeked' when the player announces a jump.
export class Player extends EventEmitter {
    constructor(registry, owner) {
        super();
        this._registry = registry;
        this.owner = owner;
        this.busName = null;
        this.pid = 0;
        // org.mpris.MediaPlayer2
        this.identity = '';
        this.desktopEntry = '';
        this.canQuit = false;
        // org.mpris.MediaPlayer2.Player
        this.status = 'Stopped';
        this.trackId = null;
        this.url = '';
        this.title = '';
        this.artist = '';
        this.length = 0;
        this.volume = 1;
        this.rate = 1;
        this.minRate = 1;
        this.maxRate = 1;
        this.canSeek = false;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.position = 0;
        this.readAt = clock();
        // What Mute puts back: MPRIS has a volume but no mute.
        this._unmuted = null;
    }

    get playing() {
        return this.status === 'Playing';
    }

    // Where playback is now, in seconds.
    get now() {
        let position = this.position;
        if (this.playing)
            position += (clock() - this.readAt) * this.rate;
        return this.length ? Math.min(position, this.length) : position;
    }

    get hasRate() {
        return this.minRate < 1 || this.maxRate > 1;
    }

    get muted() {
        return this.volume === 0 && this._unmuted !== null;
    }

    read(position) {
        this.position = Math.max(0, position);
        this.readAt = clock();
    }

    // Take the clock's reckoning as read, before what it runs on changes.
    settle() {
        this.read(this.now);
    }

    // ------------------------------------------------------------------
    // What the bar asks of it
    // ------------------------------------------------------------------
    playPause() {
        this._call(PLAYER, 'PlayPause');
    }

    pause() {
        if (this.playing)
            this._call(PLAYER, 'Pause');
    }

    next() {
        if (this.canGoNext)
            this._call(PLAYER, 'Next');
    }

    previous() {
        if (this.canGoPrevious)
            this._call(PLAYER, 'Previous');
    }

    // Absolute where the player names its track, as MPRIS asks; relative
    // where it does not. Either way in microseconds.
    seekTo(seconds) {
        if (!this.canSeek)
            return;
        const target = Math.max(0, this.length ? Math.min(seconds, this.length - 1) : seconds);
        if (this.trackId && this.trackId !== NO_TRACK) {
            this._call(PLAYER, 'SetPosition',
                new GLib.Variant('(ox)', [this.trackId, Math.round(target * 1e6)]));
        } else {
            this._call(PLAYER, 'Seek', new GLib.Variant('(x)', [Math.round((target - this.now) * 1e6)]));
        }
        this.read(target);
        this.emit('changed');
    }

    seekBy(seconds) {
        this.seekTo(this.now + seconds);
    }

    setVolume(volume) {
        volume = Math.max(0, Math.min(1, volume));
        if (volume > 0)
            this._unmuted = null;
        this.volume = volume;
        this._set('Volume', new GLib.Variant('d', volume));
        this.emit('changed');
    }

    toggleMute() {
        if (this.muted) {
            this.setVolume(this._unmuted || 0.5);
        } else {
            const was = this.volume || 0.5;
            this.setVolume(0);
            this._unmuted = was;
        }
    }

    setRate(rate) {
        if (!this.hasRate || rate === this.rate)
            return;
        this.settle();
        this.rate = rate;
        this._set('Rate', new GLib.Variant('d', rate));
        this.emit('changed');
    }

    quit() {
        if (this.canQuit)
            this._call(ROOT, 'Quit');
    }

    // One exact reading of the position, for when the clock's reckoning is
    // about to be shown after a while unseen.
    refreshPosition() {
        this._registry.call(this.owner, PROPERTIES, 'Get',
            new GLib.Variant('(ss)', [PLAYER, 'Position']), '(v)', reply => {
                const position = reply.recursiveUnpack()[0];
                if (typeof position === 'number') {
                    this.read(position / 1e6);
                    this.emit('changed');
                }
            });
    }

    _call(iface, method, args = null) {
        this._registry.call(this.owner, iface, method, args, null, null,
            e => console.warn(`[Media Controls] ${this.identity || this.owner} refused ${method}: ${e.message}`));
    }

    _set(prop, value) {
        this._registry.call(this.owner, PROPERTIES, 'Set', new GLib.Variant('(ssv)', [PLAYER, prop, value]),
            null, null,
            e => console.warn(`[Media Controls] ${this.identity || this.owner} refused ${prop}: ${e.message}`));
    }

    // ------------------------------------------------------------------
    // What it says
    // ------------------------------------------------------------------
    applyRoot(props) {
        if ('Identity' in props)
            this.identity = props.Identity ?? '';
        if ('DesktopEntry' in props)
            this.desktopEntry = props.DesktopEntry ?? '';
        if ('CanQuit' in props)
            this.canQuit = !!props.CanQuit;
    }

    applyPlayer(props) {
        if ('Rate' in props) {
            this.settle();
            this.rate = props.Rate > 0 ? props.Rate : 1;
        }
        if ('MinimumRate' in props)
            this.minRate = props.MinimumRate;
        if ('MaximumRate' in props)
            this.maxRate = props.MaximumRate;
        // Where the clock's reckoning may be furthest from the truth, one
        // exact reading is taken: a new file (the next in a playlist does not
        // always start at 0), and playing again after a buffering pause, or
        // in a player that only reports Playing once the first frame is out.
        let refresh = false;
        if ('Metadata' in props) {
            const meta = props.Metadata ?? {};
            const url = meta['xesam:url'] ?? '';
            if (url !== this.url) {
                this.read(0);
                refresh = true;
            }
            this.url = url;
            this.trackId = meta['mpris:trackid'] ?? null;
            this.length = (meta['mpris:length'] ?? 0) / 1e6;
            this.title = meta['xesam:title'] || nameFromUrl(url);
            const artist = meta['xesam:artist'];
            this.artist = Array.isArray(artist) ? artist.join(', ') : artist ?? '';
        }
        if ('PlaybackStatus' in props && props.PlaybackStatus !== this.status) {
            this.settle();
            this.status = props.PlaybackStatus;
            refresh = true;
        }
        if (refresh && this.playing)
            this.refreshPosition();
        if ('Position' in props)
            this.read(props.Position / 1e6);
        if ('Volume' in props) {
            this.volume = props.Volume;
            if (this.volume > 0)
                this._unmuted = null;
        }
        for (const [key, field] of [['CanSeek', 'canSeek'], ['CanGoNext', 'canGoNext'],
            ['CanGoPrevious', 'canGoPrevious']]) {
            if (key in props)
                this[field] = !!props[key];
        }
    }
}

// Every player on the bus. Emits 'added' and 'removed' with the Player, and
// 'changed' with the Player whenever one of them changed.
export class PlayerRegistry extends EventEmitter {
    constructor() {
        super();
        this._bus = null;
        this._cancellable = null;
        this._subscriptions = [];
        // Unique bus name -> Player, and each well-known name -> its owner.
        this._players = new Map();
        this._names = new Map();
    }

    get players() {
        return [...this._players.values()];
    }

    enable() {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        const bus = this._bus;
        this._subscriptions = [
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', MPRIS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
                (_bus, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (oldOwner)
                        this._dropName(name);
                    if (newOwner)
                        this._addName(name, newOwner);
                }),
            bus.signal_subscribe(null, PROPERTIES, 'PropertiesChanged', MPRIS_PATH, null,
                Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (!player)
                        return;
                    const [iface, changed, invalidated] = params.recursiveUnpack();
                    if (iface === PLAYER)
                        player.applyPlayer(changed);
                    else if (iface === ROOT)
                        player.applyRoot(changed);
                    else
                        return;
                    // A player that only says a property changed, not what
                    // to, is asked for the lot.
                    if (invalidated.length)
                        this._readAll(player, iface);
                    this._changed(player);
                }),
            bus.signal_subscribe(null, PLAYER, 'Seeked', MPRIS_PATH, null, Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (!player)
                        return;
                    player.read(params.recursiveUnpack()[0] / 1e6);
                    this._changed(player);
                    player.emit('seeked');
                }),
        ];

        // The players already up: after an unlock, the one that was playing
        // through it.
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, CALL_TIMEOUT, this._cancellable,
            (_bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deep_unpack();
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Media Controls] Could not list media players: ${e.message}`);
                    return;
                }
                for (const name of names.filter(n => n.startsWith(`${MPRIS_NAMESPACE}.`)))
                    this._lookUpOwner(name);
            });
    }

    disable() {
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._players.clear();
        this._names.clear();
        this._bus = null;
    }

    // An asynchronous call on a player's object; `onReply` gets the unpacked
    // reply, `onError` any error but a cancellation.
    call(owner, iface, method, args, replyType, onReply, onError) {
        if (!this._bus)
            return;
        this._bus.call(owner, MPRIS_PATH, iface, method, args,
            replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT,
            this._cancellable, (bus, result) => {
                let reply;
                try {
                    reply = bus.call_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        onError?.(e);
                    return;
                }
                if (this._players.has(owner))
                    onReply?.(reply);
            });
    }

    _changed(player) {
        player.emit('changed');
        this.emit('changed', player);
    }

    // ------------------------------------------------------------------
    // Players coming and going
    // ------------------------------------------------------------------
    _lookUpOwner(name) {
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
            new GLib.Variant('(s)', [name]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, CALL_TIMEOUT,
            this._cancellable, (bus, result) => {
                try {
                    const [owner] = bus.call_finish(result).deep_unpack();
                    this._addName(name, owner);
                } catch (e) {
                    // Gone again already, or cancelled: nothing to follow.
                }
            });
    }

    _addName(name, owner) {
        this._names.set(name, owner);
        if (this._players.has(owner))
            return;
        const player = new Player(this, owner);
        player.busName = name;
        this._players.set(owner, player);
        this._readAll(player, ROOT);
        this._readAll(player, PLAYER);
        // Which process it is, to find its window by (app.js `_playerFor`).
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [owner]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, CALL_TIMEOUT, this._cancellable, (bus, result) => {
                try {
                    [player.pid] = bus.call_finish(result).deep_unpack();
                } catch (e) {
                    return;
                }
                if (this._players.get(owner) === player)
                    this._changed(player);
            });
        this.emit('added', player);
    }

    _readAll(player, iface) {
        this.call(player.owner, PROPERTIES, 'GetAll', new GLib.Variant('(s)', [iface]), '(a{sv})', reply => {
            const [props] = reply.recursiveUnpack();
            if (this._players.get(player.owner) !== player)
                return;
            if (iface === ROOT)
                player.applyRoot(props);
            else
                player.applyPlayer(props);
            this._changed(player);
        });
    }

    _dropName(name) {
        const owner = this._names.get(name);
        this._names.delete(name);
        if (!owner || [...this._names.values()].includes(owner))
            return;
        const player = this._players.get(owner);
        this._players.delete(owner);
        if (player)
            this.emit('removed', player);
    }
}
