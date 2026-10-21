#!/bin/sh
# open-dashboard.sh - the "dashboard" action: open the [[panes]] entrypoint as a split
# next to the focused pane. Falls back to scripts/herdr-dashboard.sh on Herdr versions
# without plugin panes.
HERE="$(cd "$(dirname "$0")" && pwd)"
HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
PLUGIN_ID="$(sed -n 's/^id = "\(.*\)"$/\1/p' "$HERE/herdr-plugin.toml" | head -1)"
"$HERDR_BIN" plugin pane open --plugin "$PLUGIN_ID" --entrypoint dashboard \
  --placement split --direction right --no-focus >/dev/null 2>&1 && exit 0
exec bash "$HERE/../scripts/herdr-dashboard.sh" right
