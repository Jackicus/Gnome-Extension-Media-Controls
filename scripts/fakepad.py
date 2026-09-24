#!/usr/bin/env python3
"""Plug in a virtual Xbox 360 pad, press some buttons on it, and unplug it.

    fakepad.py HOLD BUTTON...

HOLD is how long to wait after plugging it in before the first press, so that
whatever watches for pads (libmanette, in the shell and in the preferences)
has opened it. A BUTTON is one of the ids the `gamepad-buttons` setting uses
(src/lib/actions.js BUTTONS) -- south, east, west, north, dpad-left,
dpad-right, dpad-up, dpad-down, left-shoulder, right-shoulder, left-trigger,
right-trigger, select, start, mode, left-stick, right-stick -- or `wait:SECS`
to pause between presses.

Each is sent the way the kernel's xpad driver reports that button, which is
not always the code of the same name: on an Xbox pad the left face button is
BTN_X, which the kernel also calls BTN_NORTH, and the top one is BTN_Y, alias
BTN_WEST. libmanette's mapping (the SDL controller database) is what turns
them back into positions, which is exactly what this is here to exercise.

It claims to be a wired Xbox 360 pad (045e:028e) so that database knows it.
Needs write access to /dev/uinput, which logind's uaccess grants the seat's
user on most desktops (Steam's udev rules do so explicitly). The REAL session
sees the pad too while it is plugged in.
"""

import sys
import time

from evdev import AbsInfo, UInput
from evdev import ecodes as e

STICK = AbsInfo(0, -32768, 32767, 16, 128, 0)
TRIGGER = AbsInfo(0, 0, 255, 0, 0, 0)
HAT = AbsInfo(0, -1, 1, 0, 0, 0)

CAPABILITIES = {
    e.EV_KEY: [e.BTN_A, e.BTN_B, e.BTN_X, e.BTN_Y, e.BTN_TL, e.BTN_TR,
               e.BTN_SELECT, e.BTN_START, e.BTN_MODE, e.BTN_THUMBL, e.BTN_THUMBR],
    e.EV_ABS: [(e.ABS_X, STICK), (e.ABS_Y, STICK), (e.ABS_RX, STICK), (e.ABS_RY, STICK),
               (e.ABS_Z, TRIGGER), (e.ABS_RZ, TRIGGER), (e.ABS_HAT0X, HAT), (e.ABS_HAT0Y, HAT)],
}

# Position -> what xpad sends for it: (event type, code, pressed value).
XPAD = {
    'south': (e.EV_KEY, e.BTN_A, 1),
    'east': (e.EV_KEY, e.BTN_B, 1),
    'west': (e.EV_KEY, e.BTN_X, 1),
    'north': (e.EV_KEY, e.BTN_Y, 1),
    'left-shoulder': (e.EV_KEY, e.BTN_TL, 1),
    'right-shoulder': (e.EV_KEY, e.BTN_TR, 1),
    'left-trigger': (e.EV_ABS, e.ABS_Z, 255),
    'right-trigger': (e.EV_ABS, e.ABS_RZ, 255),
    'select': (e.EV_KEY, e.BTN_SELECT, 1),
    'start': (e.EV_KEY, e.BTN_START, 1),
    'mode': (e.EV_KEY, e.BTN_MODE, 1),
    'left-stick': (e.EV_KEY, e.BTN_THUMBL, 1),
    'right-stick': (e.EV_KEY, e.BTN_THUMBR, 1),
    'dpad-left': (e.EV_ABS, e.ABS_HAT0X, -1),
    'dpad-right': (e.EV_ABS, e.ABS_HAT0X, 1),
    'dpad-up': (e.EV_ABS, e.ABS_HAT0Y, -1),
    'dpad-down': (e.EV_ABS, e.ABS_HAT0Y, 1),
}


def press(ui, name):
    if name.startswith('wait:'):
        time.sleep(float(name[5:]))
        return
    if name not in XPAD:
        sys.exit(f'Unknown button {name!r}; known: {", ".join(XPAD)}')
    kind, code, value = XPAD[name]
    ui.write(kind, code, value)
    ui.syn()
    time.sleep(0.06)
    ui.write(kind, code, 0)
    ui.syn()
    print(f'pressed {name}', flush=True)
    time.sleep(0.35)


def main(argv):
    if len(argv) < 1:
        sys.exit(__doc__)
    hold = float(argv[0])
    ui = UInput(CAPABILITIES, name='Microsoft X-Box 360 pad', vendor=0x045e,
                product=0x028e, version=0x114, bustype=e.BUS_USB)
    try:
        print(f'plugged in {ui.device.path}', flush=True)
        time.sleep(hold)
        for name in argv[1:]:
            press(ui, name)
        time.sleep(0.5)
    finally:
        ui.close()
        print('unplugged', flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
