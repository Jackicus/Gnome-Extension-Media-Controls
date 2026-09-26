#!/usr/bin/env bash
#
# Media Controls development helper.
#
#   ./scripts/dev.sh link       symlink src/ into the extensions dir (dev mode)
#   ./scripts/dev.sh install    copy src/ into the extensions dir (real install)
#   ./scripts/dev.sh reload     recompile schemas and disable/enable the extension
#   ./scripts/dev.sh logs [since]  shell logs; follows unless given e.g. '5 min ago'
#   ./scripts/dev.sh pack       build a distributable .shell-extension.zip
#   ./scripts/dev.sh devices    list the media players on the session bus and the
#                               game controllers plugged in, as the extension sees them
#   ./scripts/dev.sh uninstall  remove the extension
#   ./scripts/dev.sh status     show what is currently installed and enabled
#   ./scripts/dev.sh stalls [LOG]  watch for desktop freezes: shell main-loop
#                                  stalls and processes stuck in the kernel,
#                                  with timestamps
#   ./scripts/dev.sh clean      remove the compiled schema and what the scripts
#                               put in dist/ (the zip, the test clip, shots, logs)
#
set -euo pipefail

UUID="media-controls@jackt"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_DIR/src"
EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"
EXT_DIR="$EXT_ROOT/$UUID"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH."
}

compile_schemas() {
    require glib-compile-schemas
    info "Compiling GSettings schemas..."
    glib-compile-schemas "$SRC_DIR/schemas"
}

remove_installed() {
    # -e misses a symlink whose target is gone, so test -L as well.
    if [[ -e "$EXT_DIR" || -L "$EXT_DIR" ]]; then
        rm -rf "$EXT_DIR"
    fi
}

is_enabled() {
    gnome-extensions list --enabled 2>/dev/null | grep -qx "$UUID"
}

cmd_link() {
    compile_schemas
    remove_installed
    mkdir -p "$EXT_ROOT"
    ln -s "$SRC_DIR" "$EXT_DIR"
    ok "Linked $EXT_DIR → $SRC_DIR"
    warn "Dev mode: edits in src/ are live. Run './scripts/dev.sh reload' to apply them."
    enable_extension
}

cmd_install() {
    compile_schemas
    remove_installed
    mkdir -p "$EXT_DIR"
    cp -r "$SRC_DIR"/. "$EXT_DIR"/
    ok "Installed to $EXT_DIR"
    enable_extension
}

enable_extension() {
    require gnome-extensions
    if is_enabled; then
        cmd_reload
    else
        info "Enabling $UUID..."
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            ok "Enabled."
        else
            warn "The running GNOME Shell does not know about $UUID yet."
            warn "Log out and back in (Wayland) or Alt+F2 'r' (X11), then: make reload"
        fi
    fi
}

# Poll until the shell reports the wanted state, up to ~6s.
wait_for_state() {
    local want="$1" tries=0
    while (( tries < 60 )); do
        [[ "$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p')" == "$want" ]] && return 0
        sleep 0.1
        tries=$((tries + 1))
    done
    return 1
}

cmd_reload() {
    require gnome-extensions
    compile_schemas
    info "Reloading $UUID..."
    gnome-extensions disable "$UUID" 2>/dev/null || true
    # The shell applies disable asynchronously. Calling enable before it lands is
    # a silent no-op -- the shell still believes the extension is enabled, so it
    # never re-runs enable(), and you are left with State: INACTIVE, Enabled: Yes
    # and nothing at all in the log.
    wait_for_state INACTIVE || warn "Extension did not report INACTIVE; enabling anyway."
    gnome-extensions enable "$UUID"
    if wait_for_state ACTIVE; then
        ok "Reloaded. extension.js cache-busts the module import, so no shell restart needed."
    else
        warn "Extension is enabled but not ACTIVE. Check './scripts/dev.sh logs' for a JS error."
        return 1
    fi
}

# With no argument, follow the journal. With one (any systemd time spec, e.g.
# "5 min ago" or "today"), print what is already there and exit -- which is what
# non-interactive callers such as the .claude slash commands need.
cmd_logs() {
    require journalctl
    if [[ -n "${1:-}" ]]; then
        info "Media Controls log output since '$1':"
        journalctl -o cat /usr/bin/gnome-shell --since "$1" 2>/dev/null \
            | grep -iE 'media.controls' || info "(nothing logged in that window)"
    else
        info "Following GNOME Shell logs (Ctrl+C to stop)..."
        journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -iE 'media.controls'
    fi
}

cmd_pack() {
    require gnome-extensions
    compile_schemas
    local out="$REPO_DIR/dist"
    mkdir -p "$out"
    info "Packing extension..."
    # src/ is exactly what ships; pack picks the schema up itself and leaves
    # the compiled one out.
    ( cd "$SRC_DIR" && gnome-extensions pack --force --extra-source=lib -o "$out" . )
    ok "Packed to $out/$UUID.shell-extension.zip"
}

# What the extension would see: every MPRIS player on the bus (read-only
# property reads, never a method call) and every pad libmanette opens. Runs
# against whichever session bus the environment names, so under
# `./scripts/nested.sh run` it lists the nested session's players.
cmd_devices() {
    require gjs
    gjs -m "$REPO_DIR/scripts/devices.js"
}

cmd_uninstall() {
    remove_installed
    ok "Removed $EXT_DIR"
}

# Only what the scripts make: dist/ also holds hand-made films for the README
# screenshots, which nothing can regenerate.
cmd_clean() {
    rm -f "$SRC_DIR/schemas/gschemas.compiled"
    rm -f "$REPO_DIR"/dist/*.shell-extension.zip "$REPO_DIR/dist/test-video.mkv" \
        "$REPO_DIR/dist/stalls.log" "$REPO_DIR"/dist/nested-*.png "$REPO_DIR/dist/preview.png"
    ok "Cleaned the compiled schema and the scripts' files in dist/."
}

# A freeze is over by the time anyone looks; this leaves a log of what stalled.
cmd_stalls() {
    require python3
    info "Watching for freezes (Ctrl+C to stop); reproduce one, then read the log."
    python3 "$REPO_DIR/scripts/stallwatch.py" "$@"
}

cmd_status() {
    if [[ -L "$EXT_DIR" ]]; then
        echo "install:  symlink → $(readlink -f "$EXT_DIR")"
    elif [[ -d "$EXT_DIR" ]]; then
        echo "install:  copy at $EXT_DIR"
    else
        echo "install:  not installed"
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        local state
        # pipefail would abort the script when the extension is not registered yet
        state="$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p' || true)"
        echo "state:    ${state:-unknown to the running shell (log out and back in)}"
    fi
    if gjs -c 'imports.gi.versions.Manette = "0.2"; imports.gi.Manette;' >/dev/null 2>&1; then
        echo "pads:     libmanette available"
    else
        echo "pads:     libmanette missing -- game controllers will not work"
    fi
}

usage() {
    # Print the comment header (everything after the shebang, up to the first blank
    # non-comment line), stripping the leading '#'.
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

case "${1:-}" in
    link)       cmd_link ;;
    install)    cmd_install ;;
    reload)     cmd_reload ;;
    logs)       cmd_logs "${2:-}" ;;
    pack)       cmd_pack ;;
    devices)    cmd_devices ;;
    uninstall)  cmd_uninstall ;;
    status)     cmd_status ;;
    stalls)     shift; cmd_stalls "$@" ;;
    clean)      cmd_clean ;;
    ""|-h|--help|help) usage ;;
    *)          die "Unknown command '$1'. Run './scripts/dev.sh help'." ;;
esac
