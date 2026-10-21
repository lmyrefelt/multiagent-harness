#!/usr/bin/env bash
# integrator-lock.sh — one WRITER of `main` at a time (not one integrator total).
#
# WHY THIS EXISTS
# The "integrator" is a ROLE, not a name: it may be Claude, Gemini, Astra or a
# human, and SEVERAL can integrate at once. They collide on exactly one thing —
# writing to the single `main` checkout — so this lock guards only that: integrate
# a spec, approve-commit, merge, mark complete, and repo-global git (worktree
# prune/remove, branch -D/-m, gc). REVIEWS ARE LOCK-FREE: review a change in its own
# worktree (read + run tests) with NO lock, in parallel with other integrators.
# Claim right before a main-write, release right after — never hold it across a
# review or while you think. See docs/changes/COORDINATION.md "Parallel integration".
#
# The lock lives in the SHARED git dir (git-common-dir), so every worktree —
# the planner's, each worker's, yours — sees the same lock. It is never committed.
#
#   scripts/integrator-lock.sh status
#   scripts/integrator-lock.sh claim  <who>     # e.g. claim claude
#   scripts/integrator-lock.sh release <who>
#   scripts/integrator-lock.sh claim  <who> --force   # steal a stale/wrong lock
#
# Advisory by design: it cannot physically stop a merge, but it makes "am I
# allowed to act right now?" a one-line check every integrator agent must run
# first. See docs/changes/COORDINATION.md.
set -euo pipefail

CMD="${1:-status}"
WHO="${2:-}"
FORCE=0
[ "${3:-}" = "--force" ] && FORCE=1

GITDIR="$(git rev-parse --git-common-dir)"
# git-common-dir can be relative to cwd; make it absolute.
case "$GITDIR" in /*) ;; *) GITDIR="$(git rev-parse --show-toplevel)/$GITDIR" ;; esac
LOCK="$GITDIR/integrator.lock"

read_holder() { [ -f "$LOCK" ] && sed -n 's/^holder=//p' "$LOCK" || true; }
read_since()  { [ -f "$LOCK" ] && sed -n 's/^since=//p'  "$LOCK" || true; }

STALE_SECONDS=7200   # 2h: a lock older than this is assumed abandoned

now_epoch() { date +%s; }

case "$CMD" in
  status)
    if [ -f "$LOCK" ]; then
      age=$(( $(now_epoch) - $(read_since) ))
      echo "integrator: HELD by '$(read_holder)' for ${age}s (lock: $LOCK)"
      [ "$age" -ge "$STALE_SECONDS" ] && echo "  (stale: older than ${STALE_SECONDS}s — claim --force to take it)"
    else
      echo "integrator: FREE (no holder)"
    fi
    ;;

  claim)
    [ -n "$WHO" ] || { echo "usage: integrator-lock.sh claim <who> [--force]" >&2; exit 1; }
    if [ -f "$LOCK" ]; then
      cur="$(read_holder)"
      age=$(( $(now_epoch) - $(read_since) ))
      if [ "$cur" = "$WHO" ]; then
        : # re-claim by the same holder: refresh below
      elif [ "$FORCE" -eq 1 ] || [ "$age" -ge "$STALE_SECONDS" ]; then
        echo "integrator: taking lock from '$cur' (age ${age}s, force=${FORCE})" >&2
      else
        echo "integrator: REFUSED — held by '$cur' (age ${age}s)." >&2
        echo "  Coordinate, wait, or 'claim $WHO --force' only if you are sure it is abandoned." >&2
        exit 1
      fi
    fi
    printf 'holder=%s\nsince=%s\n' "$WHO" "$(now_epoch)" > "$LOCK"
    echo "integrator: CLAIMED by '$WHO'"
    ;;

  release)
    [ -n "$WHO" ] || { echo "usage: integrator-lock.sh release <who>" >&2; exit 1; }
    if [ ! -f "$LOCK" ]; then echo "integrator: already free"; exit 0; fi
    cur="$(read_holder)"
    if [ "$cur" != "$WHO" ] && [ "$FORCE" -eq 0 ]; then
      echo "integrator: REFUSED — lock held by '$cur', not '$WHO' (use --force to override)." >&2
      exit 1
    fi
    rm -f "$LOCK"
    echo "integrator: RELEASED by '$WHO'"
    ;;

  *)
    echo "usage: integrator-lock.sh {status|claim <who>|release <who>} [--force]" >&2
    exit 1
    ;;
esac
