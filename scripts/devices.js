// What Media Controls would see right now: the MPRIS players on the session
// bus and the game controllers libmanette can open. Read-only -- property
// reads, never a method call on a player. Run through `./scripts/dev.sh
// devices`, or under `./scripts/nested.sh run` for the nested session's bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const bus = Gio.DBus.session;
const call = (dest, path, iface, method, args, type) => bus.call_sync(dest, path, iface, method, args,
    type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, 2000, null);

print('Players (MPRIS):');
const [names] = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
    null, '(as)').deep_unpack();
const seen = new Set();
let players = 0;
for (const name of names.filter(n => n.startsWith('org.mpris.MediaPlayer2.')).sort()) {
    try {
        const [owner] = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetNameOwner', new GLib.Variant('(s)', [name]), '(s)').deep_unpack();
        if (seen.has(owner))
            continue;
        seen.add(owner);
        const [pid] = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [owner]), '(u)').deep_unpack();
        const getAll = iface => call(owner, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties',
            'GetAll', new GLib.Variant('(s)', [iface]), '(a{sv})').recursiveUnpack()[0];
        const root = getAll('org.mpris.MediaPlayer2');
        const player = getAll('org.mpris.MediaPlayer2.Player');
        const meta = player.Metadata ?? {};
        const length = (meta['mpris:length'] ?? 0) / 1e6;
        print(`  ${root.Identity ?? name}  [${root.DesktopEntry ?? '-'}]  pid ${pid}  ${name}`);
        print(`    ${player.PlaybackStatus ?? '?'}  ${meta['xesam:title'] ?? meta['xesam:url'] ?? ''}` +
            `${length ? `  (${Math.round(length)} s)` : ''}  volume ${player.Volume ?? '?'}  rate ${player.Rate ?? '?'}`);
        players++;
    } catch (e) {
        print(`  ${name}: not answering (${e.message})`);
    }
}
if (!players)
    print('  none');

print('Controllers (libmanette):');
try {
    const {default: Manette} = await import('gi://Manette?version=0.2');
    const it = new Manette.Monitor().iterate();
    let pads = 0;
    for (let [ok, device] = it.next(); ok; [ok, device] = it.next()) {
        print(`  ${device.get_name()}  guid ${device.get_guid()}  ${device.get_mapping() ? 'mapped' : 'NO MAPPING'}`);
        pads++;
    }
    if (!pads)
        print('  none');
} catch (e) {
    print(`  libmanette unavailable: ${e.message}`);
}
