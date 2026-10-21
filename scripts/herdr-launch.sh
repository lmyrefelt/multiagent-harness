#!/usr/bin/env bash
# herdr-launch.sh — create a Herdr pane, labeled by role (+ change/name),
# running one of this repo's launch-*.sh scripts inside it.
#
# WHY THIS EXISTS
# scripts/launch-worker.sh/launch-planner.sh/launch-integrator.sh all exec
# into `docker run -it`, so every pane Herdr watches looks identically like
# agent "pi" - fine for state detection, useless for telling three worker
# panes apart at a glance. This wrapper sets a descriptive label (e.g.
# pi-worker-CHANGE-0050) on the pane AT CREATION rather than guessing which
# already-running "pi" to rename after the fact, which is ambiguous the
# moment more than one is running - the normal case here.
#
# HERDR_AGENT (exported by the launch-*.sh scripts themselves) must stay
# exactly "pi" or "antigravity-cli" - it selects Herdr's detection manifest,
# not a display name. This script only ever touches the separate label/name
# mechanism (`herdr pane rename`), never HERDR_AGENT.
#
#   scripts/herdr-launch.sh worker CHANGE-0050 [launch-worker.sh args...]
#   scripts/herdr-launch.sh planner my-planner [launch-planner.sh args...]
#   scripts/herdr-launch.sh integrator my-integrator [pi|antigravity] [args...]
#
# HERDR_BIN=<path>   resolved in this order: (1) HERDR_BIN if already set in
#                     the environment, (2) the path bootstrap.sh persisted to
#                     ~/.harness/config/herdr/bin_path the first time it asked
#                     where Herdr lives (shared across every project on this
#                     machine, same convention as scripts/harness-config-lib.sh
#                     uses for backend credentials - Herdr itself is one
#                     install per machine, not per project), (3) a bare
#                     `herdr` lookup on PATH as the last resort.
#
# Falls back to printing the plain command (no pane, no label) if no step
# above resolves to an executable file - every launch-*.sh script works
# identically without this wrapper; it is a labeling convenience, not a new
# dependency.
#
# RESPONSE SHAPE (confirmed 2026-10-07 against a real split/rename pair,
# not assumed): every command prints one JSON-RPC-style object -
# {"id":"cli:pane:split","result":{"pane":{"pane_id":"w6:p2",...}}} on
# success, {"id":"cli:pane:rename","error":{"code":"...","message":"..."}}
# on failure. The pane id lives at .result.pane.pane_id, NOT as bare stdout -
# an earlier version of this script assumed a bare token, which fed the
# entire minified JSON blob to `pane rename` as if it were a pane id and
# failed with pane_not_found. jq is used when available (robust); a regex
# fallback handles the common case without it. Every call's response is
# checked for an .error key rather than assumed to have succeeded.
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
DIRECTION="${HERDR_SPLIT_DIRECTION:-right}"
HARNESS_CONFIG_ROOT="${HARNESS_CONFIG_ROOT:-$HOME/.harness/config}"
HERDR_BIN_POINTER="$HARNESS_CONFIG_ROOT/herdr/bin_path"
if [ -z "${HERDR_BIN:-}" ] && [ -f "$HERDR_BIN_POINTER" ]; then
  HERDR_BIN="$(cat "$HERDR_BIN_POINTER" 2>/dev/null || true)"
fi
HERDR_BIN="${HERDR_BIN:-herdr}"

slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g'; }

# Extract a field from a herdr JSON-RPC response without requiring jq, but
# prefer jq (robust against nesting/escaping) when it's on PATH.
json_field() {  # $1=json $2=jq-filter $3=sed-fallback-key (bare key name)
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r "$2 // empty" 2>/dev/null
  else
    printf '%s' "$1" | sed -n "s/.*\"$3\":\"\([^\"]*\)\".*/\1/p"
  fi
}

# Fail loud on a {"error":{"message":...}} response instead of treating a
# truncated/garbled result as success.
check_herdr_error() {  # $1=json $2=operation label for the message
  local err
  err="$(json_field "$1" '.error.message' "message")"
  if [ -n "$err" ]; then
    echo "herdr $2 failed: $err" >&2
    echo "  raw: $1" >&2
    exit 1
  fi
}

ROLE="${1:-}"; shift || true
case "$ROLE" in
  worker)
    CHANGE="${1:-}"
    case "$CHANGE" in
      CHANGE-*) ;;
      *) echo "usage: scripts/herdr-launch.sh worker CHANGE-NNNN [launch-worker.sh args...]" >&2; exit 1 ;;
    esac
    # launch-worker.sh now accepts pi|antigravity|agy|claude|codex|opencode as
    # a trailing backend token (any position after CHANGE-NNNN) - scan for it
    # so the label reflects which one is actually running, not always
    # "pi-worker-...".
    WORKER_BACKEND="pi"
    for a in "$@"; do
      case "$a" in
        antigravity|agy) WORKER_BACKEND="antigravity" ;;
        claude) WORKER_BACKEND="claude" ;;
        codex) WORKER_BACKEND="codex" ;;
        opencode) WORKER_BACKEND="opencode" ;;
      esac
    done
    LABEL="${WORKER_BACKEND}-worker-$CHANGE"
    CMD=(bash "$REPO/scripts/launch-worker.sh" "$@")  # via bash: a missing execute bit / macOS ACL on the script cannot block a launch
    ;;
  planner)
    NAME="${1:-pi}"
    # launch-planner.sh now accepts pi|claude|codex as a trailing backend
    # token too (any position after the name) - same backend-token scan as
    # the worker case above, so the label reflects which one is running.
    PLANNER_BACKEND="pi"
    for a in "$@"; do
      case "$a" in antigravity|agy) PLANNER_BACKEND="antigravity" ;; claude|codex|opencode) PLANNER_BACKEND="$a" ;; esac
    done
    LABEL="${PLANNER_BACKEND}-planner-$(slug "$NAME")"
    CMD=(bash "$REPO/scripts/launch-planner.sh" "$@")  # via bash: a missing execute bit / macOS ACL on the script cannot block a launch
    ;;
  integrator)
    NAME="${1:-}"
    [ -n "$NAME" ] || { echo "usage: scripts/herdr-launch.sh integrator <name> [pi|antigravity|claude|codex] [args...]" >&2; exit 1; }
    # Same backend-token scan as the worker/planner cases - launch-integrator.sh
    # now implements claude/codex too, not just pi/antigravity. Scans "${@:2}",
    # NOT "$@" - MEASURED: scanning "$@" includes $1 (NAME) itself, so a name
    # that happens to equal a reserved backend word (exactly the trap
    # launch-integrator.sh itself now refuses outright) would be misread as a
    # backend token too, producing a misleading pane label even though the
    # actual launch would then correctly refuse.
    INTEGRATOR_BACKEND="pi"
    for a in "${@:2}"; do
      case "$a" in
        antigravity|agy) INTEGRATOR_BACKEND="antigravity" ;;
        claude|codex) INTEGRATOR_BACKEND="$a" ;;
      esac
    done
    LABEL="${INTEGRATOR_BACKEND}-integrator-$(slug "$NAME")"
    CMD=(bash "$REPO/scripts/launch-integrator.sh" "$@")  # via bash: a missing execute bit / macOS ACL on the script cannot block a launch
    ;;
  *)
    echo "usage: scripts/herdr-launch.sh <worker|planner|integrator> ..." >&2
    exit 1
    ;;
esac

CMDSTR="$(printf '%q ' "${CMD[@]}")"

# A new pane is a fresh process tree, not a child of this script, so it does
# NOT inherit TASK from `TASK="..." scripts/herdr-launch.sh ...` the way a
# direct `TASK="..." scripts/launch-planner.sh ...` call would.
#
# Route the CONTENT through a temp file, never through argv/env directly -
# a real-world mission brief (Norwegian, in this case: æ/ø/å) triggered
# `error: argument N is not valid UTF-8` from herdr's own (Rust) CLI parser,
# on `pane split`/`pane rename` calls that don't even reference TASK in their
# own arguments - meaning the problem was TASK sitting in this script's
# AMBIENT ENVIRONMENT (inherited by every "$HERDR_BIN" call below, not just
# the final `pane run`), not a quoting bug in how CMDSTR was built. Writing
# the content to a file and `unset`ting TASK from this script's own
# environment means every herdr invocation below - split, rename, AND run -
# only ever sees plain-ASCII argv (script paths, a mktemp path), regardless
# of what the mission brief itself contains or how it's encoded.
if [ -n "${TASK:-}" ]; then
  TASKFILE="$(mktemp "${TMPDIR:-/tmp}/herdr-task.XXXXXX")"
  printf '%s' "$TASK" > "$TASKFILE"
  CMDSTR="TASK=\"\$(cat '$TASKFILE')\"; rm -f '$TASKFILE'; $CMDSTR"
  unset TASK
fi

if [ ! -x "$HERDR_BIN" ]; then
  echo "HERDR_BIN '$HERDR_BIN' is not an executable file - run this instead (label '$LABEL' is for your own reference only):" >&2
  echo "  $CMDSTR" >&2
  exit 1
fi

# HERDR_SPLIT_TARGET: set by herdr-plugin/lifecycle-watcher.mjs. A plugin hook
# runs outside any pane, so `--current` has no pane to split there - split a
# named pane instead, without stealing focus from whatever the owner is doing.
#
# HERDR_WORKER_LAYOUT=tab (default) | split. 2026-10-16: workers each split a
# pane in the owner's view and the screen filled up. A worker now gets its OWN
# TAB (labelled like the pane) in the same workspace the split would have used;
# planner/integrator still split. If tab creation fails, fall back to a split.
PANE_ID=""
LAYOUT="${HERDR_WORKER_LAYOUT:-tab}"
# HERDR_ROLE_LAYOUT=tab: the watcher launches planner/integrator in their own tab from a background
# pass (2026-10-18: a split's shell showed the command but never ran it).
[ "$ROLE" = "worker" ] || LAYOUT="${HERDR_ROLE_LAYOUT:-split}"
if [ "$LAYOUT" = "tab" ]; then
  WS="${HERDR_WORKSPACE:-}"
  [ -z "$WS" ] && [ -n "${HERDR_SPLIT_TARGET:-}" ] && WS="${HERDR_SPLIT_TARGET%%:*}"
  RAW="$("$HERDR_BIN" tab create ${WS:+--workspace "$WS"} --cwd "$REPO" --label "$LABEL" --no-focus 2>&1)" || true
  PANE_ID="$(json_field "$RAW" '.result.root_pane.pane_id' "pane_id")"
  if [ -z "$PANE_ID" ] || printf '%s' "$PANE_ID" | grep -q '[[:space:]]'; then
    echo "NOTE: herdr tab create did not return a pane (${RAW:0:200}) - splitting a pane instead." >&2
    PANE_ID=""
  fi
fi
if [ -z "$PANE_ID" ]; then
  if [ -n "${HERDR_SPLIT_TARGET:-}" ]; then
    RAW="$("$HERDR_BIN" pane split "$HERDR_SPLIT_TARGET" --direction "$DIRECTION" --cwd "$REPO" --no-focus)"
  else
    RAW="$("$HERDR_BIN" pane split --current --direction "$DIRECTION" --cwd "$REPO")"
  fi
  check_herdr_error "$RAW" "pane split"
  PANE_ID="$(json_field "$RAW" '.result.pane.pane_id' "pane_id")"
fi
if [ -z "$PANE_ID" ] || printf '%s' "$PANE_ID" | grep -q '[[:space:]]'; then
  echo "could not extract .result.pane.pane_id from herdr pane split's response - got:" >&2
  echo "  $RAW" >&2
  echo "Not guessing further - report this output back so the parsing gets fixed." >&2
  exit 1
fi

RAW="$("$HERDR_BIN" pane rename "$PANE_ID" "$LABEL")"
check_herdr_error "$RAW" "pane rename"
# Register pane -> role (+ change for a worker) so the lifecycle watcher never
# has to parse labels (see scripts/handoff.mjs). Best-effort: a failure here
# only means the watcher falls back to the label.
REG_CHANGE=""
[ "$ROLE" = "worker" ] && REG_CHANGE="$CHANGE"
node "$REPO/scripts/handoff.mjs" register-pane --pane "$PANE_ID" --role "$ROLE" \
  ${REG_CHANGE:+--change "$REG_CHANGE"} --label "$LABEL" >/dev/null 2>&1 \
  || echo "WARN: could not register $PANE_ID in .pi-session/herdr-lifecycle/panes.json (label fallback still works)" >&2
RAW="$("$HERDR_BIN" pane run "$PANE_ID" "$CMDSTR")"
check_herdr_error "$RAW" "pane run"
echo "herdr     : pane $PANE_ID labeled '$LABEL', running: $CMDSTR"
