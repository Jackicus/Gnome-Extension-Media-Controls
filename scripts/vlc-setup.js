// Sets VLC's settings file the way the preferences' VLC switches do, using
// the same module (src/lib/vlcconfig.js): its fullscreen controller off and
// its remote-control socket on. Which file is $XDG_CONFIG_HOME/vlc/vlcrc, so
// `nested.sh player` points XDG_CONFIG_HOME at a throwaway directory and runs
// this there; run as is, it changes the real one.
//
//     gjs -m scripts/vlc-setup.js [on|off]
import {writeVlcState, vlcrcPath} from '../src/lib/vlcconfig.js';

const on = (ARGV[0] ?? 'on') !== 'off';
const state = writeVlcState({hideControls: on, trackControl: on});
print(`${vlcrcPath()}: hide controls ${state.hideControls}, track control ${state.trackControl}`);
