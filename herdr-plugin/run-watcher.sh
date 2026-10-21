#!/bin/sh
# run-watcher.sh - how Herdr starts lifecycle-watcher.mjs.
#
# WHY: Herdr's server is socket-activated by launchd on macOS, so plugin
# commands inherit launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) -
# a bare `node` (Homebrew, nvm, volta, mise...) is not found and the hook
# dies silently: no log line anywhere, nothing happens. This wrapper finds
# node itself, puts the usual tool dirs on PATH (the watcher also spawns
# herdr-launch.sh -> docker), and leaves a heartbeat so "did the hook even
# run?" is a one-line check:
#
#   cat .pi-session/herdr-lifecycle/hook-last-run
#
# Override with HARNESS_NODE=/path/to/node in Herdr's environment if needed.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARNESS_REPO_ROOT:-$(/usr/bin/git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || dirname "$HERE")}"
LOGDIR="$ROOT/.pi-session/herdr-lifecycle"
mkdir -p "$LOGDIR" 2>/dev/null

NODE=""
NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1)"
for c in "${HARNESS_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node \
         "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" \
         "$HOME/.local/share/fnm/aliases/default/bin/node" "$NVM_NODE"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done

STATUS="$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | sed -n 's/.*"agent_status":"\([a-z]*\)".*/\1/p')"
PANE="$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p')"
NODEV="$([ -n "$NODE" ] && "$NODE" --version 2>/dev/null)"
# Raw copy of the last event Herdr sent, so the payload shape can be checked directly.
printf '%s\n' "${HERDR_PLUGIN_EVENT_JSON:-}" > "$LOGDIR/hook-last-event.json" 2>/dev/null
printf '%s event=%s pane=%s status=%s node=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${HERDR_PLUGIN_EVENT:-manual}" "${PANE:--}" "${STATUS:--}" "${NODE:-NOT-FOUND}" "$NODEV" > "$LOGDIR/hook-last-run" 2>/dev/null

if [ -z "$NODE" ]; then
  printf '%s ERROR hook could not find node (PATH=%s) - set HARNESS_NODE for Herdr or install node in /opt/homebrew/bin\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PATH" >> "$LOGDIR/events.log" 2>/dev/null
  exit 0
fi

PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
export PATH HARNESS_REPO_ROOT="$ROOT"
# Keep the watcher's stderr (a crash before it can log - e.g. an import error on an
# old node - would otherwise vanish). Capped at ~200 KB.
ERRLOG="$LOGDIR/hook-errors.log"
[ -f "$ERRLOG" ] && [ "$(wc -c < "$ERRLOG" 2>/dev/null || echo 0)" -gt 204800 ] && : > "$ERRLOG"
exec "$NODE" "$HERE/lifecycle-watcher.mjs" "$@" 2>>"$ERRLOG"
