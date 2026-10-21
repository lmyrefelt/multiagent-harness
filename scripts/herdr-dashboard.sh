#!/usr/bin/env bash
# herdr-dashboard.sh - open the harness dashboard in its own Herdr pane.
#
#   bash scripts/herdr-dashboard.sh            split the current pane (to the right)
#   bash scripts/herdr-dashboard.sh down       split downwards instead
#   bash scripts/herdr-dashboard.sh here       run it in THIS terminal
#
# Also used by the watcher plugin's "open the dashboard" action (no terminal there):
# then it splits the focused pane, and never runs headless.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIRECTION="${1:-right}"
CMD="node \"$REPO/scripts/harness-dashboard.mjs\""

HERDR_BIN="${HERDR_BIN_PATH:-$(command -v herdr 2>/dev/null || true)}"
run_here() {
  if [ -t 1 ]; then exec env HARNESS_REPO_ROOT="$REPO" node "$REPO/scripts/harness-dashboard.mjs"; fi
  echo "herdr-dashboard: could not open a Herdr pane ($1) and there is no terminal to run in" >&2
  exit 1
}
if [ "$DIRECTION" = "here" ] || [ -z "$HERDR_BIN" ]; then run_here "here/no herdr"; fi

pane_id() {
  if command -v jq >/dev/null 2>&1; then jq -r '.result.pane.pane_id // empty'
  else sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1; fi
}
# Preferred: the plugin pane (herdr-plugin.toml [[panes]] "dashboard").
PLUGIN_ID="$(sed -n 's/^id = "\(.*\)"$/\1/p' "$REPO/herdr-plugin/herdr-plugin.toml" | head -1)"
if [ "$DIRECTION" != "down" ] && "$HERDR_BIN" plugin pane open --plugin "$PLUGIN_ID" --entrypoint dashboard \
     --placement split --direction "$DIRECTION" --no-focus >/dev/null 2>&1; then
  echo "dashboard opened as a plugin pane"; exit 0
fi
RAW="$("$HERDR_BIN" pane split --current --direction "$DIRECTION" --cwd "$REPO" 2>/dev/null || true)"
PANE_ID="$(printf '%s' "$RAW" | pane_id)"
if [ -z "$PANE_ID" ]; then
  # No "current" pane (e.g. run from a plugin action): split the focused one.
  FOCUSED="$("$HERDR_BIN" pane list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const ps=j.result?.panes??j.panes??j;const f=(Array.isArray(ps)?ps:[]).find(p=>p.focused);process.stdout.write(f?.pane_id??"")}catch{}})' || true)"
  if [ -n "$FOCUSED" ]; then
    RAW="$("$HERDR_BIN" pane split "$FOCUSED" --direction "$DIRECTION" --cwd "$REPO" 2>/dev/null || true)"
    PANE_ID="$(printf '%s' "$RAW" | pane_id)"
  fi
fi
[ -n "$PANE_ID" ] || run_here "herdr said: ${RAW:-nothing}"
"$HERDR_BIN" pane rename "$PANE_ID" "harness-dashboard" >/dev/null 2>&1 || true
"$HERDR_BIN" pane run "$PANE_ID" "HARNESS_REPO_ROOT=\"$REPO\" $CMD" >/dev/null
echo "dashboard opened in pane $PANE_ID"
