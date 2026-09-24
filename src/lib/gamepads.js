// Game controllers, through libmanette — GNOME's gamepad library, the one
// WebKitGTK reads pads with. It watches udev for pads coming and going, opens
// each one's evdev node on the main loop without blocking, and maps whatever
// was plugged in onto the kernel's standard buttons with the SDL controller
// database, so an Xbox, PlayStation, Switch or 8BitDo pad all press the same
// `BTN_SOUTH`. Which action a button performs is the `gamepad-buttons`
// setting, keyed by the ids in actions.js BUTTONS.
//
// Pads are never grabbed: a game running beside the player still sees every
// press. The actions only reach a player when app.js has one attached — a
// focused, fullscreen window of a player — so a pad in a game does nothing
// here.
//
// libmanette is imported when enabled rather than at the top, so a system
// without it loses the pads and keeps the bar.

import {buttonForCode} from './actions.js';

export class Gamepads {
    constructor(settings, onButton) {
        this._settings = settings;
        this._onButton = onButton;
        this._monitor = null;
        this._devices = new Set();
        this._generation = 0;
    }

    async enable() {
        const generation = ++this._generation;
        let Manette;
        try {
            ({default: Manette} = await import('gi://Manette?version=0.2'));
        } catch (e) {
            console.warn('[Media Controls] libmanette is not installed, so game controllers are off');
            return;
        }
        // Disabled, or disabled and enabled again, while the import ran.
        if (generation !== this._generation)
            return;
        this._monitor = new Manette.Monitor();
        const it = this._monitor.iterate();
        for (let [ok, device] = it.next(); ok; [ok, device] = it.next())
            this._watch(device);
        this._monitor.connectObject(
            'device-connected', (_monitor, device) => this._watch(device),
            'device-disconnected', (_monitor, device) => this._unwatch(device),
            this);
    }

    disable() {
        this._generation++;
        for (const device of this._devices)
            device.disconnectObject(this);
        this._devices.clear();
        if (this._monitor) {
            this._monitor.disconnectObject(this);
            // Closes every pad's evdev node now rather than whenever the
            // collector gets to the monitor.
            this._monitor.run_dispose();
            this._monitor = null;
        }
    }

    _watch(device) {
        if (this._devices.has(device))
            return;
        this._devices.add(device);
        console.log(`[Media Controls] Controller connected: ${device.get_name()}`);
        device.connectObject('button-press-event', (_device, event) => this._pressed(device, event), this);
    }

    _unwatch(device) {
        if (!this._devices.delete(device))
            return;
        device.disconnectObject(this);
        console.log(`[Media Controls] Controller disconnected: ${device.get_name()}`);
    }

    _pressed(device, event) {
        if (this._settings.get_strv('ignored-gamepads').includes(device.get_guid()))
            return;
        const [ok, code] = event.get_button();
        const button = ok ? buttonForCode(code) : null;
        if (!button)
            return;
        const action = this._settings.get_value('gamepad-buttons').deep_unpack()[button.id] ?? 'none';
        if (action !== 'none')
            this._onButton(action);
    }
}
