#!/bin/sh
# run-dashboard.sh - the [[panes]] entrypoint "dashboard": the harness dashboard as a
# Herdr plugin pane. Finds node the same way run-watcher.sh does (Herdr's launchd PATH
# on macOS is minimal).
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARNESS_REPO_ROOT:-$(/usr/bin/git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || dirname "$HERE")}"
NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1)"
NODE=""
for c in "${HARNESS_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node \
         "$HOME/.local/bin/node" "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" \
         "$HOME/.local/share/fnm/aliases/default/bin/node" "$NVM_NODE"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || { echo "harness dashboard: node not found - set HARNESS_NODE"; sleep 30; exit 1; }
PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH HARNESS_REPO_ROOT="$ROOT"
exec "$NODE" "$ROOT/scripts/harness-dashboard.mjs"
