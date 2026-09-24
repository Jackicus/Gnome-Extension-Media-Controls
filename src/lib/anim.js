// Motion vocabulary: the shell's ease-out-quad, at lengths inside its own
// 100–250 ms rather than copied from any one of them. These are the only
// durations and curves in use; actor.ease() already honours the animations
// toggle and the slow-down factor, so nothing here checks them.

import Clutter from 'gi://Clutter';

export const Duration = {
    FAST: 120,     // things leaving
    NORMAL: 200,   // things arriving
};

export const Ease = {
    OUT: Clutter.AnimationMode.EASE_OUT_QUAD,
};

// How far the bar rises as it fades in, in logical px.
export const RISE = 8;
