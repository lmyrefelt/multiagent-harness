#!/usr/bin/env bash
# herdr-setup.sh — link + enable this project's lifecycle-watcher plugin.
#
# WHY THIS IS A SEPARATE SCRIPT, NOT JUST A BOOTSTRAP.SH STEP
# bootstrap.sh only runs this ONCE, at project-creation time - if Herdr isn't
# installed yet (the common case: most people install Herdr separately,
# after scaffolding the project), bootstrap.sh prints the two manual
# commands needed and moves on. That printed note is easy to miss or lose
# track of (REAL incident: an owner installed Herdr afterward, assumed
# "auto-advance" would just start working, and had no way to come back to
# this step short of re-reading bootstrap.sh's own source) - there was no
# standalone way to retry it later. This script IS that retry path: run it
# any time, as many times as you like, and it does exactly what bootstrap.sh
# would have done at this point, using the same persisted Herdr-binary
# location (~/.harness/config/herdr/bin_path) and this project's own
# contracts/.harness-slug for the plugin id - nothing to type by hand.
#
#   scripts/herdr-setup.sh              find Herdr, link + enable the plugin
#   scripts/herdr-setup.sh --status     just report whether it's linked/enabled already
#   scripts/herdr-setup.sh --sidebar    add the role/change/branch/model sidebar layout to Herdr's config
#
# BASH 3.2 SAFE — same discipline as bootstrap.sh/build.sh.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SLUG_FILE="$REPO/contracts/.harness-slug"
if [ -f "$SLUG_FILE" ]; then
  SLUG="$(cat "$SLUG_FILE")"
else
  # Pre-existing projects bootstrapped before .harness-slug was introduced
  # won't have this file - fall back to asking once, and write it so every
  # later run (this script, build.sh's role shorthand) stops having to ask.
  echo "contracts/.harness-slug not found (this project predates it)." >&2
  printf 'Project slug (used to namespace the plugin id, e.g. "my-project"): ' >&2
  read -r SLUG
  [ -n "$SLUG" ] || { echo "no slug given - aborting." >&2; exit 1; }
  printf '%s' "$SLUG" > "$SLUG_FILE"
  echo "-> wrote $SLUG_FILE" >&2
fi
PLUGIN_ID="${SLUG}.lifecycle-watcher"

HARNESS_CONFIG_ROOT="${HARNESS_CONFIG_ROOT:-$HOME/.harness/config}"
HERDR_BIN_POINTER="$HARNESS_CONFIG_ROOT/herdr/bin_path"

resolve_herdr_bin() {
  if [ -n "${HERDR_BIN:-}" ] && [ -x "${HERDR_BIN:-}" ]; then
    printf '%s' "$HERDR_BIN"; return 0
  fi
  if command -v herdr >/dev/null 2>&1; then
    command -v herdr; return 0
  fi
  if [ -f "$HERDR_BIN_POINTER" ]; then
    saved="$(cat "$HERDR_BIN_POINTER" 2>/dev/null || true)"
    if [ -n "$saved" ] && [ -x "$saved" ]; then printf '%s' "$saved"; return 0; fi
  fi
  return 1
}

# --sidebar: put the harness sidebar layout (role / change / round / turn / branch /
# model / context / cache / limit per agent row; pipeline + account usage per space)
# into Herdr's config. Replaces the block from an earlier install, keeps everything
# else, writes a backup, and refuses if those tables hold someone else's settings.
if [ "${1:-}" = "--sidebar" ]; then
  node "$REPO/scripts/herdr-sidebar-merge.mjs" || exit 1
  if HERDR_BIN_RESOLVED="$(resolve_herdr_bin)"; then "$HERDR_BIN_RESOLVED" server reload-config >/dev/null 2>&1 && echo "-> herdr config reloaded." >&2; fi
  echo "-> push the values now with: node scripts/handoff.mjs sidebar" >&2
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  if HERDR_BIN_RESOLVED="$(resolve_herdr_bin)"; then
    echo "herdr binary : $HERDR_BIN_RESOLVED"
    "$HERDR_BIN_RESOLVED" plugin list 2>&1 | grep -F "$PLUGIN_ID" || echo "plugin '$PLUGIN_ID' : NOT linked/enabled"
  else
    echo "herdr binary : not found (PATH, \$HERDR_BIN, or $HERDR_BIN_POINTER)"
  fi
  exit 0
fi

HERDR_BIN_RESOLVED="$(resolve_herdr_bin || true)"
if [ -z "$HERDR_BIN_RESOLVED" ]; then
  printf 'Path to your Herdr binary: ' >&2
  read -r ANSWER
  if [ -z "$ANSWER" ] || [ ! -x "$ANSWER" ]; then
    echo "'$ANSWER' doesn't exist or isn't executable - nothing to do." >&2
    exit 1
  fi
  HERDR_BIN_RESOLVED="$ANSWER"
  mkdir -p "$(dirname "$HERDR_BIN_POINTER")"
  printf '%s' "$HERDR_BIN_RESOLVED" > "$HERDR_BIN_POINTER"
  echo "-> remembered at $HERDR_BIN_POINTER for every project on this machine." >&2
fi

echo "-> linking $REPO/herdr-plugin" >&2
"$HERDR_BIN_RESOLVED" plugin link "$REPO/herdr-plugin"
echo "-> enabling $PLUGIN_ID" >&2
"$HERDR_BIN_RESOLVED" plugin enable "$PLUGIN_ID"
echo "-> done. Confirm with: $HERDR_BIN_RESOLVED plugin list" >&2
