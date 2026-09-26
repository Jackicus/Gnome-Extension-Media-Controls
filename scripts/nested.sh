#!/usr/bin/env bash
#
# Drive a throwaway nested GNOME Shell for testing Media Controls.
#
#   ./scripts/nested.sh start [WxH]   start a nested shell (default 1600x900) with
#                                     Media Controls ACTIVE, and open a live mirror window
#                                     of it on the real desktop
#   ./scripts/nested.sh start --headless [WxH]
#                                     no mirror window; screenshots are the only view
#   ./scripts/nested.sh start --clean [WxH]
#                                     with a settings database of its own: only Media
#                                     Controls enabled, your look (colour scheme, accent,
#                                     fonts) copied in, and nothing written to your real
#                                     dconf -- for screenshots, and whenever another
#                                     nested shell is running (flags combine)
#   ./scripts/nested.sh player [--qt] [--windowed] [--plain] [FILE] [-- VLC ARGS...]
#                                     play FILE (default: a generated test video) in VLC
#                                     inside the nested shell, full screen, silent, with
#                                     MPRIS on and VLC's own bar off; --qt uses VLC's Qt
#                                     interface instead of cvlc. Its throwaway settings
#                                     are set up as the preferences' VLC switches would
#                                     (tracks socket on) unless --plain
#   ./scripts/nested.sh mpris [METHOD [ARGS]|get PROP|set PROP VALUE]
#                                     talk to the first MPRIS player on the nested bus:
#                                     no argument prints its state; Quit ends it
#   ./scripts/nested.sh pad [HOLD] BUTTON...
#                                     plug in a virtual Xbox 360 pad, wait HOLD seconds
#                                     (default 1.5) for it to be picked up, press each
#                                     BUTTON (south, west, dpad-up, left-trigger, ...: the
#                                     gamepad-buttons ids), unplug it
#   ./scripts/nested.sh do "STEP" "STEP"...
#                                     run several steps in one go (one connection):
#                                     say TEXT | click X Y | move X Y | key KEYSYM |
#                                     wait SECS | shot [FILE [X Y W H]] | window FILE |
#                                     overview on|off
#   ./scripts/nested.sh say TEXT      flash TEXT as an on-screen banner in the nested
#                                     shell, so whoever is watching knows what's next
#   ./scripts/nested.sh shot [FILE [X Y W H]]
#                                     screenshot the nested desktop (or one region)
#   ./scripts/nested.sh click X Y     click at those desktop coordinates
#   ./scripts/nested.sh move X Y      move the pointer there (hover) without clicking
#   ./scripts/nested.sh key KEYSYM    press a key or chord (Escape, Super+c, ...)
#   ./scripts/nested.sh overview on|off   show/hide the Activities overview
#   ./scripts/nested.sh reload        disable/enable Media Controls inside the nested shell
#   ./scripts/nested.sh preview       start --clean, play the test clip, bring the bar
#                                     up and screenshot it to dist/preview.png
#   ./scripts/nested.sh mirror on|off open/close the live mirror window
#   ./scripts/nested.sh run CMD...    run CMD against the nested shell's session bus
#                                     and display (never the real desktop's)
#   ./scripts/nested.sh logs [N] [--all]
#                                     last N lines of the nested shell's output, with
#                                     D-Bus activation chatter filtered out
#   ./scripts/nested.sh status        is it running, and what is it running as
#   ./scripts/nested.sh stop          close the mirror, shut the shell down, clean up,
#                                     and check that nothing of the session survived
#
# The nested shell is a complete second GNOME Shell with its own session bus. It
# reads the same ~/.local/share/gnome-shell/extensions, so it picks up new UUIDs at
# its own startup -- and anything the extension breaks, it breaks there, not in
# your session (a throw in enable() leaves it at State: ERROR; see 'logs').
#
# It always runs headless: this mutter build has no windowed (nested) backend.
# The mirror is a screencast of its virtual monitor, played on the real desktop
# through PipeWire, which both sessions share. That is how you watch along.
#
# Nothing is left behind on the desktop: the mirror closes when the shell stops or
# dies, and a shell started from a Claude Code session stops itself after
# MEDIA_CONTROLS_NESTED_IDLE seconds (default 600, 0 = never) without a command here,
# and when that session ends (the SessionEnd hook runs 'session-end').
#
set -euo pipefail

UUID="media-controls@jackt"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$REPO_DIR/scripts/nested.sh"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/media-controls-nested"
BUS_FILE="$RUN_DIR/bus"
PID_FILE="$RUN_DIR/pid"
LOG_FILE="$RUN_DIR/log"
GEOM_FILE="$RUN_DIR/geometry"
X11_FILE="$RUN_DIR/x11-display"
XAUTH_FILE="$RUN_DIR/x11-auth"
PROFILE_FILE="$RUN_DIR/dconf-profile"
# --clean's database: ~/.config/dconf/<this>, written only by the nested
# session's own dconf-service and deleted by 'stop'.
# dconf names a database by a D-Bus object path element (/ca/desrt/dconf/
# Writer/<name>), so letters, digits and underscores only: a hyphen fails
# every write, and gsettings waits on it forever.
CLEAN_DB="media_controls_nested"
MIRROR_PID_FILE="$RUN_DIR/mirror-pid"
MIRROR_LOG="$RUN_DIR/mirror-log"
WATCH_PID_FILE="$RUN_DIR/watchdog-pid"
ACTIVITY_FILE="$RUN_DIR/activity"
OWNER_FILE="$RUN_DIR/owner-session"
IDLE_FILE="$RUN_DIR/idle-seconds"
GUARD_OWNED_FILE="$RUN_DIR/owns-crash-guard"
# GNOME Shell creates this for its first 60 s; if the shell crashes while it
# exists, the systemd unit disables every extension. The nested shell shares the
# runtime dir, so it creates the REAL session's copy -- and a stop inside those
# 60 s leaves it behind, arming that for the user's next real crash.
CRASH_GUARD="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"
IDLE_SECS="${MEDIA_CONTROLS_NESTED_IDLE:-600}"
# The real session's display and bus, captured before nested_env overrides them:
# the mirror window has to open on the desktop the user is looking at.
HOST_WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
HOST_BUS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}"
DRIVER="$REPO_DIR/scripts/nested_driver.py"
FAKEPAD="$REPO_DIR/scripts/fakepad.py"
TEST_VIDEO="$REPO_DIR/dist/test-video.mkv"
WL_DISPLAY="media-controls-dev"

info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

pid_alive() {
    [[ -f "$1" ]] || return 1
    local pid
    pid="$(cat "$1" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_running()     { pid_alive "$PID_FILE"; }
mirror_running() { pid_alive "$MIRROR_PID_FILE"; }

require_running() {
    is_running || die "No nested shell running. Start one with: ./scripts/nested.sh start"
}

nested_bus() {
    [[ -s "$BUS_FILE" ]] || die "Nested shell has no session bus address yet."
    cat "$BUS_FILE"
}

# The nested mutter's own X11 display (Xwayland, started on demand), found from
# the listening socket it holds -- the first of the two it opens. Empty if it
# has none.
find_x11_display() {
    { ss -xlp 2>/dev/null | grep -F "pid=$1," | grep -oE '/tmp/\.X11-unix/X[0-9]+' \
        | head -1 | sed 's|.*/X|:|'; } || true
}

# And the cookie X11 clients need for it: mutter writes a fresh
# $XDG_RUNTIME_DIR/.mutter-Xwaylandauth.* at startup, so it is the newest one
# not older than this run. Nothing removes it when a nested shell is killed;
# 'stop' does.
find_x11_auth() {
    local newest
    newest="$(ls -t "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/.mutter-Xwaylandauth.* 2>/dev/null | head -1 || true)"
    [[ -n "$newest" && "$newest" -nt "$GEOM_FILE" ]] && echo "$newest"
    return 0
}

# Run a command against the nested shell's bus and displays rather than the real
# session's. Without this every gnome-extensions/gdbus call would hit your live
# desktop -- and an X11 client (VLC's Qt interface) would open its window there.
# DISPLAY is the nested Xwayland's, or unset if it has none, never the host's.
# Under --clean, DCONF_PROFILE points everything at the private database too.
nested_env() {
    local x11 xauth profile=()
    x11="$(cat "$X11_FILE" 2>/dev/null || true)"
    xauth="$(cat "$XAUTH_FILE" 2>/dev/null || true)"
    [[ -s "$PROFILE_FILE" ]] && profile=(DCONF_PROFILE="$PROFILE_FILE")
    if [[ -n "$x11" && -n "$xauth" ]]; then
        env "${profile[@]}" DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" WAYLAND_DISPLAY="$WL_DISPLAY" \
            DISPLAY="$x11" XAUTHORITY="$xauth" "$@"
    else
        env -u DISPLAY "${profile[@]}" DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" WAYLAND_DISPLAY="$WL_DISPLAY" "$@"
    fi
}

# --clean: a dconf profile of the nested session's own. Its writable database
# starts empty every time, over a read-only one seeded here with this
# extension alone in enabled-extensions and the real session's look, so the
# nested shell shows nothing of the other extensions and matches the desktop
# it is screenshotted for. The real ~/.config/dconf/user is never opened for
# writing -- which also keeps it out of the way of any other project's
# nested shell (see CLAUDE.md, dconf).
setup_clean_profile() {
    command -v dconf >/dev/null || die "'dconf' not found; --clean needs 'dconf compile'."
    local seed="$RUN_DIR/dconf-seed" key value
    mkdir -p "$seed"
    {
        echo "[org/gnome/shell]"
        echo "enabled-extensions=['$UUID']"
        echo "welcome-dialog-last-shown-version='999'"
        echo
        echo "[org/gnome/desktop/interface]"
        for key in color-scheme accent-color gtk-theme icon-theme cursor-theme font-name \
                   document-font-name monospace-font-name text-scaling-factor; do
            value="$(gsettings get org.gnome.desktop.interface "$key" 2>/dev/null)" && echo "$key=$value"
        done
    } > "$seed/00-nested"
    dconf compile "$RUN_DIR/dconf-defaults" "$seed" || die "dconf could not compile the --clean defaults."
    printf 'user-db:%s\nfile-db:%s\n' "$CLEAN_DB" "$RUN_DIR/dconf-defaults" > "$PROFILE_FILE"
    remove_clean_db
}

remove_clean_db() {
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/dconf/$CLEAN_DB" \
          "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/dconf/$CLEAN_DB"
}

geometry() { cat "$GEOM_FILE" 2>/dev/null || echo '1600x900'; }

driver() {
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" python3 "$DRIVER" "$@"
}

nested_state() {
    nested_env gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p'
}

# Poll until the extension reaches STATE, up to about 6 seconds.
wait_state() {
    local tries=0
    while [[ "$(nested_state)" != "$1" ]] && (( tries < 60 )); do
        sleep 0.1
        tries=$((tries + 1))
    done
    [[ "$(nested_state)" == "$1" ]]
}

touch_activity() {
    [[ -d "$RUN_DIR" ]] && touch "$ACTIVITY_FILE" 2>/dev/null || true
}

cmd_start() {
    # Mirrored by default: the whole point of driving the extension is that the
    # user can see what is being tried, without logging out to look.
    local mirror=1 clean=0 geometry=1600x900
    for arg in "$@"; do
        case "$arg" in
            --headless) mirror=0 ;;
            --clean) clean=1 ;;
            [0-9]*x[0-9]*) geometry="$arg" ;;
            *) die "Unknown start option '$arg'. Usage: start [--headless] [--clean] [WxH]" ;;
        esac
    done
    [[ "$geometry" =~ ^[0-9]+x[0-9]+$ ]] || die "Geometry must look like 1600x900, got '$geometry'."

    if is_running; then
        info "Reusing the nested shell already running (pid $(cat "$PID_FILE"), $(geometry))."
        (( clean )) && [[ ! -s "$PROFILE_FILE" ]] \
            && warn "It shares the real session's settings; 'stop' and start again for --clean."
        [[ $mirror -eq 1 ]] && ! mirror_running && cmd_mirror on
        [[ "$(nested_state)" == "ACTIVE" ]] || enable_in_nested
        return 0
    fi

    command -v gnome-shell >/dev/null || die "'gnome-shell' not found."
    command -v dbus-run-session >/dev/null || die "'dbus-run-session' not found."

    # A crashed or killed run can leave a mirror, a watchdog or a player behind
    # with no pid file pointing at it; clear those before starting over.
    kill_strays

    # Make sure the extension is installed before the shell scans for it, since a
    # nested shell only discovers UUIDs at startup -- same as the real one.
    if [[ ! -e "$HOME/.local/share/gnome-shell/extensions/$UUID" ]]; then
        warn "$UUID is not installed; running 'make link' first."
        "$REPO_DIR/scripts/dev.sh" link >/dev/null 2>&1 || true
    fi

    rm -rf "$RUN_DIR"
    mkdir -p "$RUN_DIR"
    : > "$LOG_FILE"
    echo "$geometry" > "$GEOM_FILE"
    # If the real shell's own guard is already there (it logged in under a minute
    # ago), it is not ours to remove.
    [[ -e "$CRASH_GUARD" ]] || touch "$GUARD_OWNED_FILE"
    # Only a shell a Claude Code session started is that session's to clean up.
    [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] && echo "$CLAUDE_CODE_SESSION_ID" > "$OWNER_FILE"

    local mode_args=(--wayland --wayland-display "$WL_DISPLAY" --headless --virtual-monitor "$geometry")
    local profile=()
    if (( clean )); then
        setup_clean_profile
        profile=(DCONF_PROFILE="$PROFILE_FILE")
    fi

    info "Starting nested GNOME Shell (headless, $geometry$( (( clean )) && echo ', own settings, no other extensions'))..."

    # dbus-run-session creates the bus; we echo its address out so later commands
    # can address this shell specifically. DISPLAY is dropped so nothing the
    # nested session starts can reach the real desktop's Xwayland. The bus
    # daemon hands its environment -- DCONF_PROFILE included -- to everything it
    # activates, the prefs window among them.
    setsid env -u DISPLAY "${profile[@]}" dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
        exec gnome-shell "${@:2}"
    ' _ "$BUS_FILE" "${mode_args[@]}" >>"$LOG_FILE" 2>&1 &

    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Wait for the shell to own its name on the new bus before declaring success.
    local waited=0
    until [[ -s "$BUS_FILE" ]] && nested_env gdbus call --session \
            --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; do
        if ! kill -0 "$pid" 2>/dev/null; then
            warn "Nested shell exited during startup. Last output:"
            filtered_log 20 >&2
            rm -f "$PID_FILE"
            return 1
        fi
        if (( waited >= 200 )); then
            warn "Nested shell did not answer on D-Bus within 20s. Last output:"
            filtered_log 20 >&2
            cmd_stop >/dev/null
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    ok "Nested shell up (pid $pid)."

    # gnome-shell is exec'd by the bash under dbus-run-session, so it is a
    # grandchild of $pid (whose own arguments carry the same flags); its
    # Xwayland socket and cookie are what X11 clients need.
    local shell_pid
    shell_pid="$(pgrep -f -- "^gnome-shell .*--wayland-display $WL_DISPLAY" | head -1 || true)"
    if [[ -n "$shell_pid" ]]; then
        find_x11_display "$shell_pid" > "$X11_FILE"
        find_x11_auth > "$XAUTH_FILE"
    fi

    # The shell only enables what dconf lists, and a UUID the real session has never
    # enabled is not listed: it would sit at INITIALIZED doing nothing.
    if nested_env gsettings get org.gnome.shell enabled-extensions 2>/dev/null | grep -qF "'$UUID'"; then
        wait_state ACTIVE \
            || die "Media Controls is $(nested_state) after startup -- check './scripts/nested.sh logs' for a JS error."
        ok "Media Controls ACTIVE."
    else
        enable_in_nested
    fi

    touch_activity
    start_watchdog "$pid"
    [[ $mirror -eq 1 ]] && cmd_mirror on
    return 0
}

enable_in_nested() {
    nested_env gnome-extensions enable "$UUID" 2>/dev/null || die "Could not enable $UUID in the nested shell."
    wait_state ACTIVE \
        || die "Enabled but $(nested_state) -- check './scripts/nested.sh logs' for a JS error."
    ok "Media Controls ACTIVE."
}

# Stops the nested shell after IDLE_SECS without a command, and cleans up (the
# mirror above all) if the shell dies on its own. Only for shells a Claude Code
# session started: a person watching the mirror is not sending commands, so for
# them silence is not idleness.
start_watchdog() {
    [[ -s "$OWNER_FILE" ]] || return 0
    [[ "$IDLE_SECS" =~ ^[0-9]+$ ]] || IDLE_SECS=600
    echo "$IDLE_SECS" > "$IDLE_FILE"
    setsid bash -c '
        self=$1 activity=$2 idle=$3 shell_pid=$4
        while kill -0 "$shell_pid" 2>/dev/null; do
            sleep 5
            [[ -f "$activity" ]] || exit 0
            if (( idle > 0 )); then
                age=$(( $(date +%s) - $(stat -c %Y "$activity" 2>/dev/null || date +%s) ))
                (( age >= idle )) && exec "$self" stop --idle
            fi
        done
        exec "$self" stop
    ' _ "$SELF" "$ACTIVITY_FILE" "$IDLE_SECS" "$1" >/dev/null 2>&1 < /dev/null &
    echo $! > "$WATCH_PID_FILE"
}

# Every process that belongs to the nested session without being in its process
# group: anything D-Bus activated or launched with `run` (a prefs window, a
# player) carries the nested bus address or display name in its environment,
# and some of them start sessions of their own, so the group kill misses them.
# A prefs window is exactly what kept the last project's nested shell alive
# after 'stop' said it had gone.
all_session_pids() {
    local bus="" pid env
    bus="$(cat "$BUS_FILE" 2>/dev/null || true)"
    for env in /proc/[0-9]*/environ; do
        pid="${env#/proc/}"; pid="${pid%/environ}"
        [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
        [[ -r "$env" ]] || continue
        if { [[ -n "$bus" ]] && grep -qaF "DBUS_SESSION_BUS_ADDRESS=$bus" "$env" 2>/dev/null; } \
            || grep -qaF "WAYLAND_DISPLAY=$WL_DISPLAY" "$env" 2>/dev/null; then
            echo "$pid"
        fi
    done
    # The shell itself and its bus daemon, found by the arguments they run with.
    pgrep -f -- "--wayland-display $WL_DISPLAY" 2>/dev/null || true
}

# session_pids [GROUP]: all of them, or all but those in process group GROUP.
session_pids() {
    if [[ -n "${1:-}" ]]; then
        all_session_pids | in_other_group "$1"
    else
        all_session_pids
    fi
}

# Filters out the pids in process group $1: the shell's own, which 'stop'
# takes down gently by itself.
in_other_group() {
    local pid
    while read -r pid; do
        [[ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" == "$1" ]] || echo "$pid"
    done
}

# Anything of ours that outlived its pid file: mirror streams, watchdogs and
# processes still attached to a nested session that is gone.
kill_strays() {
    local pid
    for pid in $(pgrep -f -- "$DRIVER stream" 2>/dev/null) \
               $(pgrep -f -- "_ $SELF $ACTIVITY_FILE" 2>/dev/null) \
               $(pgrep -f -- "$FAKEPAD" 2>/dev/null); do
        [[ "$pid" == "$$" ]] && continue
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
}

# TERM everything in the session, give it a moment, KILL what is left, and say
# plainly if anything still survives -- a 'stop' that reports success over a live
# process is how a window gets stranded.
sweep_session() {
    local pids waited=0
    pids="$(session_pids "${1:-}" | sort -u | tr '\n' ' ')"
    [[ -z "${pids// }" ]] && return 0
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    while (( waited < 30 )); do
        pids="$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done | tr '\n' ' ')"
        [[ -z "${pids// }" ]] && return 0
        sleep 0.1; waited=$((waited + 1))
    done
    # shellcheck disable=SC2086
    warn "Still running after TERM, sending KILL: $(ps -o pid=,comm= -p "$(echo $pids | tr ' ' ',')" 2>/dev/null | tr -s ' ' | tr '\n' ';')"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 0.2
    pids="$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done | tr '\n' ' ')"
    [[ -z "${pids// }" ]] || { warn "Could not stop: $pids"; return 1; }
}

cmd_stop() {
    [[ "${1:-}" == "--idle" ]] && info "Idle for $(cat "$IDLE_FILE" 2>/dev/null)s; stopping the nested shell."
    # Take the watchdog down first so it does not race this stop -- unless this
    # stop IS the watchdog, which exec'd into it.
    if pid_alive "$WATCH_PID_FILE"; then
        local wpid
        wpid="$(cat "$WATCH_PID_FILE")"
        [[ "$wpid" != "$$" ]] && { kill -TERM "-$wpid" 2>/dev/null || kill -TERM "$wpid" 2>/dev/null || true; }
    fi
    mirror_running && cmd_mirror off
    # Players and prefs windows first, while the bus they hang off is still up
    # to be named in their environment -- everything but the shell's own
    # process group, which is given its own time to exit below.
    local stranded=0 group
    group="$(cat "$PID_FILE" 2>/dev/null || true)"
    [[ -s "$BUS_FILE" ]] && { sweep_session "${group:-0}" || stranded=1; }
    if is_running; then
        local pid
        pid="$(cat "$PID_FILE")"
        info "Stopping nested shell (pid $pid)..."
        # setsid gave it its own process group; kill the group so the bus goes too.
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null && (( waited < 50 )); do
            sleep 0.1
            waited=$((waited + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "Did not exit on TERM; sending KILL."
            kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        fi
    else
        info "No nested shell running."
    fi
    kill_strays
    sweep_session || stranded=1
    [[ -e "$GUARD_OWNED_FILE" ]] && rm -f "$CRASH_GUARD"
    [[ -s "$XAUTH_FILE" ]] && rm -f "$(cat "$XAUTH_FILE")"
    [[ -s "$PROFILE_FILE" ]] && remove_clean_db
    rm -rf "$RUN_DIR"
    if (( stranded )) || [[ -n "$(session_pids)" ]]; then
        warn "Something of the nested session is still running:"
        ps -o pid=,args= -p "$(session_pids | sort -u | paste -sd,)" 2>/dev/null >&2 || true
        return 1
    fi
    ok "Nested shell stopped; nothing of its session is left running."
}

# SessionEnd hook: stop the nested shell only if the ending session started it.
# Reads the hook's JSON from stdin.
cmd_session_end() {
    [[ -s "$OWNER_FILE" ]] || return 0
    local ending
    ending="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)"
    [[ -n "$ending" && "$ending" == "$(cat "$OWNER_FILE")" ]] || return 0
    cmd_stop >/dev/null 2>&1
}

cmd_do() {
    require_running
    [[ $# -gt 0 ]] || die "Usage: ./scripts/nested.sh do \"say Showing the bar\" \"move 800 450\" \"wait 0.5\" shot"
    driver batch "$@"
}

cmd_step() {
    require_running
    driver step "$@"
}

# dev.sh's reload, pointed at the nested bus: the same disable/enable dance,
# with the same wait for the disable to land.
cmd_reload() {
    require_running
    info "Reloading $UUID inside the nested shell..."
    nested_env "$REPO_DIR/scripts/dev.sh" reload \
        || die "Not ACTIVE after the reload -- check './scripts/nested.sh logs' for a JS error."
}

# What `make preview` runs: the bar over the test clip, in one shot.
cmd_preview() {
    cmd_start --clean
    cmd_player
    local shot="$REPO_DIR/dist/preview.png"
    cmd_do "say Media Controls preview" "move 700 400" "move 760 430" "wait 0.6" "shot $shot" >/dev/null
    ok "Screenshot: $shot"
}

# The clip `player` plays by default: ten minutes of SMPTE bars with the
# running time burned in (so a screenshot shows where playback really is), two
# silent audio tracks (Japanese, English), two subtitle tracks (English
# "Second N", Spanish "Segundo N", one a second, so timing shows at a glance)
# and a chapter every two minutes — everything the tracks pop-out can show.
# Static bars compress to a few MB.
ensure_test_video() {
    [[ -s "$TEST_VIDEO" ]] && return 0
    command -v ffmpeg >/dev/null || die "'ffmpeg' not found; pass a video file to 'player' instead."
    mkdir -p "$(dirname "$TEST_VIDEO")"
    info "Generating $TEST_VIDEO (10 min, two audio and two subtitle tracks, chapters)..."
    local work
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    python3 - "$work" <<'PY'
import sys
work = sys.argv[1]
stamp = lambda s: f'{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d},000'
for lang, word in (('eng', 'Second'), ('spa', 'Segundo')):
    with open(f'{work}/{lang}.srt', 'w') as f:
        for i in range(600):
            f.write(f'{i + 1}\n{stamp(i)} --> {stamp(i + 1)}\n{word} {i}\n\n')
with open(f'{work}/chapters', 'w') as f:
    f.write(';FFMETADATA1\n')
    for i in range(5):
        f.write(f'[CHAPTER]\nTIMEBASE=1/1\nSTART={i * 120}\nEND={(i + 1) * 120}\ntitle=Part {i + 1}\n')
PY
    ffmpeg -loglevel error -y -f lavfi -i "smptehdbars=size=1280x720:rate=24:duration=600" \
        -f lavfi -t 600 -i "anullsrc=r=48000:cl=stereo" -f lavfi -t 600 -i "anullsrc=r=48000:cl=stereo" \
        -i "$work/eng.srt" -i "$work/spa.srt" -i "$work/chapters" \
        -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s -map_chapters 5 \
        -vf "drawtext=text='%{pts\\:hms}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=80" \
        -c:v libx264 -preset veryfast -crf 30 -c:a libopus -b:a 16k -c:s srt \
        -metadata title="Media Controls test pattern" \
        -metadata:s:a:0 language=jpn -metadata:s:a:0 title=Japanese \
        -metadata:s:a:1 language=eng -metadata:s:a:1 title=English \
        -metadata:s:s:0 language=eng -metadata:s:s:0 title=English \
        -metadata:s:s:1 language=spa -metadata:s:s:1 title=Spanish \
        "$TEST_VIDEO" || die "ffmpeg could not make the test video."
}

cmd_player() {
    require_running
    local qt=0 fullscreen=1 plain=0 file="" extra=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --qt) qt=1 ;;
            --windowed) fullscreen=0 ;;
            --plain) plain=1 ;;
            --) shift; extra=("$@"); break ;;
            *) file="$1" ;;
        esac
        shift
    done
    # The test clip's sound is silence, so it goes to the real sound server,
    # the one output VLC gives a volume for (its dummy output reports 0 and
    # ignores a new one). Any other file plays with no audio at all.
    local audio=(--no-audio)
    if [[ -z "$file" ]]; then
        ensure_test_video
        file="$TEST_VIDEO"
        audio=(--aout=pulse)
    fi
    [[ -e "$file" ]] || die "No such file: $file"
    # The headless shell has no GPU for Xwayland: VLC's GL outputs fail there
    # and leave it playing with no window, so it draws with plain X11 and
    # decodes in software.
    local args=("${audio[@]}" --dbus --qt-continue=0 --no-qt-fs-controller --no-video-title-show --loop
                --vout=xcb_x11 --avcodec-hw=none)
    (( fullscreen )) && args+=(--fullscreen)
    local vlc=cvlc
    (( qt )) && vlc=vlc
    # setsid so the player outlives this command; 'stop' finds it again by the
    # nested bus address in its environment. Its config and data go under the
    # run directory: VLC's Qt interface otherwise puts the file at the top of
    # the user's own recent-media list, and remembers the volume it was left at.
    mkdir -p "$RUN_DIR/vlc/config" "$RUN_DIR/vlc/data"
    if (( ! plain )); then
        # The socket path is the real one ($XDG_RUNTIME_DIR is shared), and
        # the first VLC to start holds it: a VLC on the real desktop would
        # leave this one without a tracks button.
        [[ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/media-controls-vlc.sock" ]] \
            && warn "Another VLC already holds the tracks socket; this one will have no tracks button."
        XDG_CONFIG_HOME="$RUN_DIR/vlc/config" gjs -m "$REPO_DIR/scripts/vlc-setup.js" on >/dev/null \
            || warn "Could not write the throwaway VLC settings; no tracks socket."
    fi
    # Waited for as one more VLC on the bus than before, so a second player
    # (the two-player check) is waited for as the first was.
    local before waited=0
    before="$(vlc_count)"
    nested_env XDG_CONFIG_HOME="$RUN_DIR/vlc/config" XDG_DATA_HOME="$RUN_DIR/vlc/data" \
        setsid "$vlc" "${args[@]}" "${extra[@]}" "$file" \
        >>"$RUN_DIR/player-log" 2>&1 < /dev/null &
    until (( $(vlc_count) > before )); do
        (( waited >= 100 )) && { warn "VLC did not appear on the nested bus. Its output:"; tail -5 "$RUN_DIR/player-log" >&2; return 1; }
        sleep 0.1; waited=$((waited + 1))
    done
    ok "$vlc is playing $(basename "$file") in the nested shell."
}

# How many MPRIS names VLCs hold on the nested bus (one or two each; what
# matters is that a new VLC adds to it).
vlc_count() {
    nested_env gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.ListNames 2>/dev/null \
        | grep -o "'org\.mpris\.MediaPlayer2\.vlc[^']*'" | wc -l
}

# The first MPRIS player on the nested bus -- enough for checking what a click
# on the bar did to it.
cmd_mpris() {
    require_running
    local dest
    dest="$(nested_env gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.ListNames | grep -oE "org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.-]+" | head -1 || true)"
    [[ -n "$dest" ]] || die "No MPRIS player on the nested bus. Start one with: ./scripts/nested.sh player"
    local call=(nested_env gdbus call --session --dest "$dest" --object-path /org/mpris/MediaPlayer2)
    local iface=org.mpris.MediaPlayer2.Player
    case "${1:-}" in
        "")
            for prop in PlaybackStatus Position Volume Rate; do
                printf '%-15s %s\n' "$prop" "$("${call[@]}" --method org.freedesktop.DBus.Properties.Get $iface "$prop")"
            done
            printf '%-15s %s\n' Title "$("${call[@]}" --method org.freedesktop.DBus.Properties.Get $iface Metadata \
                | grep -oE "'xesam:title': <'[^']*'>" || true)"
            ;;
        get) "${call[@]}" --method org.freedesktop.DBus.Properties.Get $iface "$2" ;;
        Quit|Raise) "${call[@]}" --method "org.mpris.MediaPlayer2.$1" ;;
        set) "${call[@]}" --method org.freedesktop.DBus.Properties.Set $iface "$2" "$3" ;;
        *)   "${call[@]}" --method "$iface.$1" "${@:2}" ;;
    esac
}

# A virtual pad is a kernel device, so the REAL session sees it too -- harmless
# for the shell, which does nothing with a pad unless this extension is enabled
# there and a player is focused full screen.
cmd_pad() {
    require_running
    local hold=1.5
    [[ "${1:-}" =~ ^[0-9.]+$ ]] && { hold="$1"; shift; }
    [[ $# -gt 0 ]] || die "Usage: ./scripts/nested.sh pad [HOLD] south [dpad-right west ...]"
    python3 -c 'import evdev' 2>/dev/null || die "A virtual pad needs python-evdev (the python-evdev package)."
    python3 "$FAKEPAD" "$hold" "$@"
}

# The live mirror: the driver screencasts the nested monitor to a PipeWire node
# and keeps the session alive while a GStreamer viewer, running against the REAL
# desktop, plays it in an ordinary window. Cursor is embedded, so clicks can be
# followed. Closing the window ends the cast; 'mirror off', 'stop', or the nested
# shell going away all close the window.
cmd_mirror() {
    case "${1:-}" in
        on)
            require_running
            if mirror_running; then
                info "Mirror already open (pid $(cat "$MIRROR_PID_FILE"))."
                return 0
            fi
            command -v gst-launch-1.0 >/dev/null || die "'gst-launch-1.0' not found; install gstreamer and gst-plugin-pipewire."
            local geom w h
            geom="$(geometry)"
            w="${geom%x*}"; h="${geom#*x}"
            : > "$MIRROR_LOG"
            # Not through nested_env: a function call in the background forks a
            # subshell, and $! would be that short-lived subshell rather than the
            # stream, so 'mirror off' and 'stop' could never find the window.
            env DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" WAYLAND_DISPLAY="$WL_DISPLAY" \
                setsid python3 "$DRIVER" stream "$w" "$h" \
                env WAYLAND_DISPLAY="$HOST_WAYLAND_DISPLAY" DBUS_SESSION_BUS_ADDRESS="$HOST_BUS" \
                    gst-launch-1.0 -q pipewiresrc path='{node}' ! videoconvert ! autovideosink \
                >>"$MIRROR_LOG" 2>&1 < /dev/null &
            echo $! > "$MIRROR_PID_FILE"
            local waited=0
            while (( waited < 50 )) && ! grep -q "pipewire node" "$MIRROR_LOG" 2>/dev/null; do
                if ! mirror_running; then
                    warn "Mirror failed to start:"; tail -5 "$MIRROR_LOG" >&2; rm -f "$MIRROR_PID_FILE"; return 1
                fi
                sleep 0.1; waited=$((waited + 1))
            done
            ok "Mirror window open on the desktop ($geom)."
            ;;
        off)
            if ! mirror_running; then
                rm -f "$MIRROR_PID_FILE"
                return 0
            fi
            local pid waited=0
            pid="$(cat "$MIRROR_PID_FILE")"
            kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
            while kill -0 "$pid" 2>/dev/null && (( waited < 30 )); do
                sleep 0.1; waited=$((waited + 1))
            done
            kill -0 "$pid" 2>/dev/null && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
            rm -f "$MIRROR_PID_FILE"
            ok "Mirror closed."
            ;;
        *) die "Usage: ./scripts/nested.sh mirror on|off" ;;
    esac
}

cmd_run() {
    require_running
    [[ $# -gt 0 ]] || die "Nothing to run. Usage: ./scripts/nested.sh run gnome-extensions list"
    # The driver's own variables go too, so `run python3 scripts/nested_driver.py …`
    # behaves as `do` does — without NESTED_RUN_DIR it cannot see the
    # "overview wanted" flag, and its first screenshot dismisses the overview.
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" "$@"
}

# The shell's log is mostly the bus daemon announcing service activations and the
# portal complaining about services a throwaway session does not have. None of it
# is about Media Controls, and it buries the lines that are.
filtered_log() {
    grep -Ev "^\s*$|Activating (via systemd: )?service name=|Successfully activated service|Activated service 'org.freedesktop.systemd1' failed|RealtimeKit|AT-SPI|atk-bridge|discover_other_daemon|gnome-shell-calendar-server|libecal|Error loading calendars|No entry for geolocation" \
        "$LOG_FILE" | tail -n "$1"
}

cmd_logs() {
    [[ -f "$LOG_FILE" ]] || die "No nested shell log at $LOG_FILE."
    local n=40 all=0 arg
    for arg in "$@"; do
        case "$arg" in
            --all) all=1 ;;
            *[!0-9]*|"") die "Usage: ./scripts/nested.sh logs [N] [--all]" ;;
            *) n="$arg" ;;
        esac
    done
    if (( all )); then tail -n "$n" "$LOG_FILE"; else filtered_log "$n"; fi
}

cmd_status() {
    if is_running; then
        local state idle="" secs
        state="$(nested_state || true)"
        secs="$(cat "$IDLE_FILE" 2>/dev/null || echo 0)"
        pid_alive "$WATCH_PID_FILE" && (( secs > 0 )) && idle=", stops after ${secs}s idle"
        echo "nested:    running (pid $(cat "$PID_FILE")), $(geometry)$idle"
        echo "mirror:    $(mirror_running && echo "open on the desktop" || echo "closed -- 'mirror on' to watch")"
        echo "extension: ${state:-not registered in the nested shell}"
        echo "x11:       $(cat "$X11_FILE" 2>/dev/null || true) $(cat "$XAUTH_FILE" 2>/dev/null || true)"
        echo "settings:  $([[ -s "$PROFILE_FILE" ]] && echo "its own (--clean): only $UUID enabled" || echo "shared with the real session")"
        echo "log:       $LOG_FILE"
    else
        echo "nested:    not running"
        local left
        left="$(session_pids | sort -u | paste -sd, || true)"
        [[ -n "$left" ]] && echo "strays:    $left -- './scripts/nested.sh stop' sweeps them"
    fi
    return 0
}

usage() {
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    start|stop|session-end|""|-h|--help|help) ;;
    *) touch_activity ;;
esac

case "$cmd" in
    start)       cmd_start "$@" ;;
    stop)        cmd_stop "$@" ;;
    session-end) cmd_session_end ;;
    do)          cmd_do "$@" ;;
    shot|click|move|key|overview|say)
                 cmd_step "$cmd" "$@" ;;
    player)      cmd_player "$@" ;;
    mpris)       cmd_mpris "$@" ;;
    pad)         cmd_pad "$@" ;;
    mirror)      cmd_mirror "${1:-}" ;;
    reload)      cmd_reload ;;
    preview)     cmd_preview ;;
    run)         cmd_run "$@" ;;
    logs)        cmd_logs "$@" ;;
    status)      cmd_status ;;
    ""|-h|--help|help) usage ;;
    *)           die "Unknown command '$cmd'. Run './scripts/nested.sh help'." ;;
esac
