// VLC's own settings file, and the two things this extension may change in
// it — only when the user flips the switch for it in the preferences:
//
//   hideControls   VLC's fullscreen controller off (`qt-fs-controller`), so
//                  the bar is the only one over the video, however VLC was
//                  started — from a file manager, a launcher, anything.
//   trackControl   VLC's remote-control interface on a private socket, which
//                  is how the bar lists and switches audio and subtitle
//                  tracks and moves the subtitle timing: MPRIS has none of
//                  that. `oldrc` is VLC's C interface (the one that can listen
//                  on a Unix socket; plain `rc` picks the Lua one, which
//                  cannot), and it refuses to start without a terminal unless
//                  `rc-fake-tty` is set, socket or not.
//
// Pure GLib/Gio, so prefs.js (outside the shell) and app.js (inside it, for
// SOCKET_PATH) both import it.
//
// vlcrc is "name=value" lines under "[module]" headers, every default
// written out commented ("#name=value"). A module's options are only read
// under that module's header — `rc-fake-tty` anywhere but under [oldrc] is
// ignored — so a value is set by uncommenting its line in place, which VLC
// wrote in the right section, or, in a file without the line, added under its
// module's header (made if missing). VLC only reads the file
// as it starts — a change applies from the next VLC — and a VLC that was
// already running rewrites the file from what it read if its own preferences
// are saved.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// $XDG_RUNTIME_DIR is private to the user (0700), so the socket is too. It
// has to be short: a Unix socket path is at most 107 bytes.
export const SOCKET_PATH = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'media-controls-vlc.sock']);

const RC_MODULE = 'oldrc';
// The section each option this file touches lives in.
const SECTION = {
    'qt-fs-controller': 'qt',
    'extraintf': 'core',
    'rc-unix': 'oldrc',
    'rc-fake-tty': 'oldrc',
};

export function vlcrcPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'vlc', 'vlcrc']);
}

function readLines(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes).split('\n');
    } catch (e) {
        return null;
    }
}

// The value an option is set to, or null where it is left at VLC's default.
function valueOf(lines, name) {
    for (const line of lines ?? []) {
        if (line.startsWith(`${name}=`))
            return line.slice(name.length + 1);
    }
    return null;
}

const modulesOf = value => (value ?? '').split(/[:,]/).map(m => m.trim()).filter(Boolean);

// What this machine's VLC is set to, as far as the two switches go.
export function readVlcState(path = vlcrcPath()) {
    const lines = readLines(path);
    return {
        exists: lines !== null,
        hideControls: valueOf(lines, 'qt-fs-controller') === '0',
        trackControl: modulesOf(valueOf(lines, 'extraintf')).includes(RC_MODULE) &&
            valueOf(lines, 'rc-unix') === SOCKET_PATH &&
            valueOf(lines, 'rc-fake-tty') === '1',
    };
}

// Set `name`, or put it back to VLC's default with `value` null.
function setValue(lines, name, value) {
    const set = value === null ? null : `${name}=${value}`;
    const at = lines.findIndex(l => l.startsWith(`${name}=`));
    const commented = lines.findIndex(l => l.startsWith(`#${name}=`));
    if (at !== -1) {
        if (set)
            lines[at] = set;
        else if (commented !== -1)
            lines.splice(at, 1);
        else
            lines[at] = `#${lines[at]}`;
    } else if (set) {
        if (commented !== -1) {
            lines.splice(commented + 1, 0, set);
            return;
        }
        const section = SECTION[name];
        const header = lines.findIndex(l => l === `[${section}]` || l.startsWith(`[${section}] `));
        if (header !== -1)
            lines.splice(header + 1, 0, set);
        else
            lines.push('', `[${section}]`, set);
    }
}

// Flip one or both switches. Returns the state it left the file in; throws
// if the file could not be written.
export function writeVlcState({hideControls, trackControl}, path = vlcrcPath()) {
    const lines = readLines(path) ?? ['# Written by Media Controls; VLC fills in the rest.', ''];
    if (hideControls !== undefined)
        setValue(lines, 'qt-fs-controller', hideControls ? '0' : null);
    if (trackControl !== undefined) {
        // Keep whatever other extra interfaces were already listed.
        const others = modulesOf(valueOf(lines, 'extraintf')).filter(m => m !== RC_MODULE);
        const modules = trackControl ? [...others, RC_MODULE] : others;
        setValue(lines, 'extraintf', modules.length ? modules.join(':') : null);
        setValue(lines, 'rc-unix', trackControl ? SOCKET_PATH : null);
        setValue(lines, 'rc-fake-tty', trackControl ? '1' : null);
    }
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    const file = Gio.File.new_for_path(path);
    // VLC drops the last character of every line as its newline, the last
    // line's included: a file that does not end in one loses a letter.
    let text = lines.join('\n');
    if (!text.endsWith('\n'))
        text += '\n';
    file.replace_contents(new TextEncoder().encode(text), null, true,
        Gio.FileCreateFlags.NONE, null);
    return readVlcState(path);
}
