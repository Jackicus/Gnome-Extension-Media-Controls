// VLC's remote-control socket: the tracks, the subtitle timing and the
// chapters, none of which MPRIS carries. VLC only opens it when its settings
// say so (vlcconfig.js), so for any other VLC — and any other player — the
// bar simply has no tracks button.
//
// The protocol is lines of text. A command's reply ends with a line
// "<command>: returned <n> (<message>)"; `key` (a hotkey press) has no reply
// at all. VLC also sends "status change: ( … )" lines whenever it likes,
// which are read past — except a new input, which resets the subtitle timing
// kept here.
//
// One socket path serves every VLC (it is set in VLC's settings, which
// cannot name a per-instance path), and the first VLC to start holds it. So a
// connection is only kept once the socket's peer credentials say it is the
// VLC whose window the bar is attached to; with two VLCs open, the second has
// no tracks button rather than a menu for the wrong one. And VLC serves one
// client at a time — a second connection is accepted by the kernel and then
// never answered — so a connection only counts once VLC has answered a
// harmless `atrack` on it.
//
// While playback is paused VLC answers almost everything with "Press pause to
// continue." — tracks and chapters included — but still takes hotkey
// presses. So the lists read while playing are kept (`_last`), a paused menu
// shows those, and a track is picked while paused by pressing VLC's own
// cycle hotkey as many times as it takes to get from the current one to it
// (VLC cycles in the order it lists them: audio skipping Disable, subtitles
// through Off).
//
// Every call is asynchronous, with a timeout, and cancelled by close().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {SOCKET_PATH} from './vlcconfig.js';

const REPLY_TIMEOUT_MS = 2000;
const PAUSED = 'Press pause to continue.';
const encoder = new TextEncoder();

// VLC lists no tracks while paused, and none have been read before.
export class PausedError extends Error {}
// VLC's own subtitle-delay hotkeys move it by 50 ms a press.
export const SUBTITLE_STEP_MS = 50;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// "Japanese - [Japanese]" → "Japanese"; "Track 1 - [English]" → "English";
// "Signs & Songs - [English]" → "Signs & Songs · English".
export function trackLabel(raw) {
    const match = raw.match(/^(.*?) - \[(.*)\]$/);
    if (!match)
        return raw;
    const [, title, language] = match;
    if (!language || title === language)
        return title || language;
    if (/^Track \d+$/.test(title))
        return language;
    return `${title} · ${language}`;
}

// The body of an `atrack`/`strack` reply: "| <id> - <name>[ *]" lines.
function parseTracks(lines) {
    const tracks = [];
    for (const line of lines) {
        const match = line.match(/^\| (-?\d+) - (.*?)( \*)?$/);
        if (!match)
            continue;
        const id = Number(match[1]);
        tracks.push({
            id,
            label: id === -1 ? 'Off' : trackLabel(match[2]),
            current: !!match[3],
        });
    }
    return tracks;
}

export class VlcRemote extends EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();
        this._connection = null;
        this._input = null;
        this._output = null;
        this._pending = null;     // {verb, lines, resolve, reject, timeoutId}
        this._queue = [];
        this._writes = [];
        this._closed = false;
        // False once VLC was reached and ours but did not answer — busy
        // with a connection from before (app.js tries once more).
        this.answered = null;
        // What VLC last listed while playing: {audio, subtitles, chapter}.
        this._last = null;
        // Where this extension has moved the subtitle timing to, in ms, since
        // the file started. VLC cannot be asked, so a change made with VLC's
        // own keys is not in it; VLC's on-screen message shows the truth.
        this.subtitleDelay = 0;
    }

    // Resolves true once connected to the VLC with process id `pid`. (Not
    // `connect`: that is the signal method connectObject builds on.)
    open(pid) {
        return new Promise(resolve => {
            const client = new Gio.SocketClient();
            client.connect_async(Gio.UnixSocketAddress.new(SOCKET_PATH), this._cancellable, (_c, result) => {
                let connection;
                try {
                    connection = client.connect_finish(result);
                } catch (e) {
                    // No socket: VLC is not set up for it, or not running.
                    resolve(false);
                    return;
                }
                let peer = 0;
                try {
                    peer = connection.get_socket().get_credentials().get_unix_pid();
                } catch (e) {
                    // Credentials unavailable: treat as not ours.
                }
                if (this._closed || peer !== pid) {
                    connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
                    resolve(false);
                    return;
                }
                this._connection = connection;
                this._input = new Gio.DataInputStream({
                    base_stream: connection.get_input_stream(),
                    close_base_stream: false,
                });
                this._output = connection.get_output_stream();
                this._readLine();
                this._command('atrack').then(() => resolve(true), () => {
                    // Connected, and ours, but not answered.
                    this.answered = false;
                    this.close();
                    resolve(false);
                });
            });
        });
    }

    close() {
        this._closed = true;
        this._cancellable.cancel();
        this._fail(new Error('closed'));
        if (this._connection) {
            this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
            this._connection = null;
        }
        this._input = this._output = null;
    }

    // ------------------------------------------------------------------
    // What the bar asks
    // ------------------------------------------------------------------
    // {audio: [...], subtitles: [...], chapter: {current, count}} — fresh
    // while playing, what was last read while paused (PausedError if nothing
    // was).
    async state() {
        const audioReply = await this._command('atrack');
        if (audioReply.includes(PAUSED)) {
            if (this._last)
                return this._last;
            throw new PausedError('VLC lists its tracks only while playing');
        }
        const audio = parseTracks(audioReply);
        const subtitles = parseTracks(await this._command('strack'));
        const chapter = await this._readChapter();
        this._last = {audio, subtitles, chapter};
        return this._last;
    }

    // {current, count}, VLC counting from 0; only answered while playing.
    async _readChapter() {
        const match = (await this._command('chapter')).join('\n').match(/chapter (\d+)\/(\d+)/);
        return match ? {current: Number(match[1]), count: Number(match[2])} : {current: 0, count: 0};
    }

    setAudio(id) {
        return this._setTrack('audio', 'atrack', 'key-audio-track', id);
    }

    setSubtitles(id) {
        return this._setTrack('subtitles', 'strack', 'key-subtitle-track', id);
    }

    async _setTrack(kind, command, hotkey, id) {
        const reply = await this._command(`${command} ${id}`);
        if (reply.includes(PAUSED)) {
            // Audio cycling skips Disable; subtitle cycling goes through Off.
            const list = (this._last?.[kind] ?? []).filter(t => kind !== 'audio' || t.id !== -1);
            const from = list.findIndex(t => t.current);
            const to = list.findIndex(t => t.id === id);
            if (from === -1 || to === -1)
                return;
            for (let i = 0; i < (to - from + list.length) % list.length; i++)
                this._send(`key ${hotkey}`);
        }
        for (const track of this._last?.[kind] ?? [])
            track.current = track.id === id;
    }

    // Move the subtitles by `ms` (a multiple of SUBTITLE_STEP_MS), later
    // for positive. VLC shows its own "Subtitle delay" message as it goes.
    shiftSubtitles(ms) {
        const steps = Math.round(ms / SUBTITLE_STEP_MS);
        const key = steps > 0 ? 'key-subdelay-up' : 'key-subdelay-down';
        for (let i = 0; i < Math.abs(steps); i++)
            this._send(`key ${key}`);
        this.subtitleDelay += steps * SUBTITLE_STEP_MS;
        this.emit('changed');
    }

    resetSubtitles() {
        this._send('key key-subsync-reset');
        this.subtitleDelay = 0;
        this.emit('changed');
    }

    // VLC's own track hotkeys: they cycle, and VLC says which it landed on.
    cycleAudio() {
        this._send('key key-audio-track');
    }

    cycleSubtitles() {
        this._send('key key-subtitle-track');
    }

    // Resolves to the chapter it landed on: VLC's word while playing, the
    // count moved on by one while paused, when VLC cannot be asked.
    async chapter(delta) {
        const reply = await this._command(delta > 0 ? 'chapter_n' : 'chapter_p');
        if (!reply.includes(PAUSED)) {
            const chapter = await this._readChapter();
            if (this._last)
                this._last.chapter = chapter;
            return chapter;
        }
        this._send(delta > 0 ? 'key key-chapter-next' : 'key key-chapter-prev');
        const chapter = this._last?.chapter;
        if (chapter)
            chapter.current = Math.max(0, Math.min(chapter.count - 1, chapter.current + Math.sign(delta)));
        return chapter ?? null;
    }

    // ------------------------------------------------------------------
    // The line protocol
    // ------------------------------------------------------------------
    // Lines go out one after another: a GIO stream refuses a second write
    // while one is pending, and two hotkey presses come at once.
    _send(text) {
        if (!this._output)
            return;
        this._writes.push(text);
        if (this._writes.length === 1)
            this._write();
    }

    _write() {
        const text = this._writes[0];
        if (text === undefined || !this._output)
            return;
        const bytes = new GLib.Bytes(encoder.encode(`${text}\n`));
        this._output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            try {
                stream.write_bytes_finish(result);
            } catch (e) {
                this._writes = [];
                if (!isCancelled(e))
                    this._lost();
                return;
            }
            this._writes.shift();
            this._write();
        });
    }

    // Commands go one at a time, each waiting for its "returned" line.
    _command(text) {
        return new Promise((resolve, reject) => {
            if (!this._connection) {
                reject(new Error('not connected'));
                return;
            }
            this._queue.push({text, verb: text.split(' ')[0], lines: [], resolve, reject});
            this._next();
        });
    }

    _next() {
        if (this._pending || !this._queue.length)
            return;
        const pending = this._pending = this._queue.shift();
        pending.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPLY_TIMEOUT_MS, () => {
            pending.timeoutId = 0;
            if (this._pending === pending) {
                this._pending = null;
                pending.reject(new Error(`VLC did not answer ${pending.text}`));
                this._next();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._send(pending.text);
    }

    _readLine() {
        this._input?.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch (e) {
                if (!isCancelled(e))
                    this._lost();
                return;
            }
            if (line === null) {
                this._lost();
                return;
            }
            this._onLine(line.replace(/\r$/, '').replace(/^> ?/, ''));
            this._readLine();
        });
    }

    _onLine(line) {
        if (line.startsWith('status change:')) {
            if (line.includes('new input:')) {
                this.subtitleDelay = 0;
                this.emit('changed');
            }
            return;
        }
        const pending = this._pending;
        if (!pending)
            return;
        if (line.startsWith(`${pending.verb}: returned`)) {
            this._pending = null;
            if (pending.timeoutId)
                GLib.source_remove(pending.timeoutId);
            pending.resolve(pending.lines);
            this._next();
        } else {
            pending.lines.push(line);
        }
    }

    // VLC went away, or the connection broke.
    _lost() {
        if (!this._connection)
            return;
        this._connection = null;
        this._input = this._output = null;
        this._fail(new Error('VLC closed the connection'));
        this.emit('lost');
    }

    _fail(error) {
        const all = [this._pending, ...this._queue].filter(Boolean);
        this._pending = null;
        this._queue = [];
        for (const pending of all) {
            if (pending.timeoutId)
                GLib.source_remove(pending.timeoutId);
            pending.reject(error);
        }
    }
}
