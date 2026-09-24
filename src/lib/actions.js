// What the bar can be asked to do, and the pad buttons that can ask it.
//
// Pure data: prefs.js imports this too, and runs outside the shell, so nothing
// here may import St, Clutter or the shell's own modules.
//
// A pad reaches us through libmanette, which maps whatever was plugged in —
// Xbox, PlayStation, Switch, 8BitDo, a Steam Deck — onto the kernel's standard
// gamepad buttons (Documentation/input/gamepad.rst), so a button is named by
// its *position* on the standard layout and carries that code. The face
// buttons are compass points because the letters on them disagree: the one at
// the bottom is A on an Xbox pad, Cross on a PlayStation and B on a Nintendo.

export const ACTIONS = [
    {id: 'none', title: 'Nothing'},
    {id: 'play-pause', title: 'Play or pause'},
    {id: 'seek-back', title: 'Skip back'},
    {id: 'seek-forward', title: 'Skip forward'},
    {id: 'previous', title: 'Previous'},
    {id: 'next', title: 'Next'},
    {id: 'volume-up', title: 'Volume up'},
    {id: 'volume-down', title: 'Volume down'},
    {id: 'mute', title: 'Mute'},
    {id: 'slower', title: 'Slower'},
    {id: 'faster', title: 'Faster'},
    {id: 'show-bar', title: 'Show the bar'},
    {id: 'hide-bar', title: 'Hide the bar'},
    // Opens the bar holding the keyboard and the pad: the d-pad then moves
    // the highlight, the bottom button presses, the right one goes back.
    {id: 'navigate', title: 'Move around the bar'},
    {id: 'tracks', title: 'Audio and subtitles'},
    {id: 'cycle-audio', title: 'Next audio track'},
    {id: 'cycle-subtitles', title: 'Next subtitle track'},
    {id: 'subtitles-earlier', title: 'Subtitles earlier'},
    {id: 'subtitles-later', title: 'Subtitles later'},
    {id: 'sleep-timer', title: 'Sleep timer'},
    {id: 'quit', title: 'Close the player'},
];

// While the bar holds the focus, these buttons move around it instead of
// doing what they are set to — the keys they stand for are what a keyboard
// would press.
export const NAVIGATION = {
    'dpad-up': 'Up',
    'dpad-down': 'Down',
    'dpad-left': 'Left',
    'dpad-right': 'Right',
    'south': 'Return',
    'east': 'Escape',
};

// The sleep timer's steps, in minutes, and then the end of the file; one more
// press turns it off.
export const SLEEP_STEPS = [15, 30, 45, 60, 90, 120, 'end'];

// How far one press of Subtitles earlier/later moves them, in ms.
export const SUBTITLE_SHIFT_MS = 100;

export const BUTTONS = [
    {id: 'south', code: 0x130, title: 'Bottom face button', hint: 'A · Cross · B on Nintendo'},
    {id: 'east', code: 0x131, title: 'Right face button', hint: 'B · Circle · A on Nintendo'},
    {id: 'west', code: 0x134, title: 'Left face button', hint: 'X · Square · Y on Nintendo'},
    {id: 'north', code: 0x133, title: 'Top face button', hint: 'Y · Triangle · X on Nintendo'},
    {id: 'dpad-left', code: 0x222, title: 'D-pad left'},
    {id: 'dpad-right', code: 0x223, title: 'D-pad right'},
    {id: 'dpad-up', code: 0x220, title: 'D-pad up'},
    {id: 'dpad-down', code: 0x221, title: 'D-pad down'},
    {id: 'left-shoulder', code: 0x136, title: 'Left shoulder', hint: 'LB · L1 · L'},
    {id: 'right-shoulder', code: 0x137, title: 'Right shoulder', hint: 'RB · R1 · R'},
    {id: 'left-trigger', code: 0x138, title: 'Left trigger', hint: 'LT · L2 · ZL'},
    {id: 'right-trigger', code: 0x139, title: 'Right trigger', hint: 'RT · R2 · ZR'},
    {id: 'select', code: 0x13a, title: 'Select', hint: 'Back · View · Share · Minus'},
    {id: 'start', code: 0x13b, title: 'Start', hint: 'Menu · Options · Plus'},
    {id: 'mode', code: 0x13c, title: 'Guide', hint: 'Xbox · PS · Home'},
    {id: 'left-stick', code: 0x13d, title: 'Left stick press'},
    {id: 'right-stick', code: 0x13e, title: 'Right stick press'},
];

export const buttonForCode = code => BUTTONS.find(b => b.code === code) ?? null;

// The steps the rate moves through: the Slower and Faster actions and the
// rate button all walk this list, never a free value.
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Where `rate` sits among RATES moved `by` steps, clamped to the ends and to
// what the player itself accepts.
export function stepRate(rate, by, min = 0, max = Infinity) {
    const allowed = RATES.filter(r => r >= min && r <= max);
    if (!allowed.length)
        return rate;
    // The nearest step to the rate now, so a player that was set to 1.1 by
    // something else lands back on the list.
    let at = 0;
    allowed.forEach((r, i) => {
        if (Math.abs(r - rate) < Math.abs(allowed[at] - rate))
            at = i;
    });
    const to = Math.max(0, Math.min(allowed.length - 1, at + by));
    return allowed[to];
}

// "1:05:09" / "4:02" — hours only when there are any, as the shell's own
// clocks and every player write a running time.
export function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// A name as it is compared: lower case, without a .desktop suffix.
export const normaliseName = name => (name ?? '').toLowerCase().replace(/\.desktop$/, '');

// Every name a player goes by, normalised: its desktop entry, the name it
// gives itself, and its bus name without the per-instance part. Chrome, for
// one, names no desktop entry and calls itself "Chrome", but is
// org.mpris.MediaPlayer2.chromium.instance123 on the bus.
export function playerNames({desktopEntry, identity, busName}) {
    const suffix = (busName ?? '').replace(/^org\.mpris\.MediaPlayer2\./, '').replace(/\.instance[\w-]*$/, '');
    return [...new Set([desktopEntry, identity, suffix].filter(Boolean).map(normaliseName))];
}

// Ignored if any of its names is on the list.
export const isIgnored = (player, list) => playerNames(player).some(name => list.includes(name));
