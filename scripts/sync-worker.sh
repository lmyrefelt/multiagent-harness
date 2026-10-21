#!/usr/bin/env bash
# sync-worker.sh CHANGE-NNNN - bring a worker's branch up to date with its base (main)
# and regenerate its contract guards, from the HOST. Used by the Herdr lifecycle watcher
# (scripts/harness-supervisor.mjs) when a worker is blocked because its branch lacks main
# (the worker's own guard forbids git merge) or when its prerequisites have just merged.
#
# Same steps launch-worker.sh does before a launch: scripts/sync-branch-lib.sh (stashes
# uncommitted edits, never leaves a failed merge behind), preflight, compile-change-guards.
# Exit 0 = synced (prints "HEAD <sha>"), 1 = needs a human/integrator (conflict), 2 = usage.
set -uo pipefail
CHANGE="${1:-}"
case "$CHANGE" in CHANGE-[0-9]*) ;; *) echo "usage: sync-worker.sh CHANGE-NNNN" >&2; exit 2 ;; esac
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2
lc="$(printf '%s' "$CHANGE" | tr '[:upper:]' '[:lower:]')"
WT=""
for d in "$REPO/.worktrees/harness-$lc" "$REPO"/.worktrees/harness-"$lc"-*; do
  [ -d "$d" ] && [ -e "$d/.git" ] && { WT="$d"; break; }
done
[ -n "$WT" ] || { echo "no worker worktree for $CHANGE under .worktrees/ - nothing to sync (the next launch syncs)"; exit 0; }
CDIR="$(ls -d "docs/changes/${CHANGE}"-* 2>/dev/null | head -1 || true)"
BASE="main"
if [ -n "$CDIR" ] && [ -f "$CDIR/change.yaml" ]; then
  b="$(sed -nE 's/^base_branch:[[:space:]]*["'\'']?([^"'\'' #]+).*/\1/p' "$CDIR/change.yaml" | head -1)"
  [ -n "$b" ] && BASE="$b"
fi
cd "$WT" || exit 1
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
[ -n "$BRANCH" ] || { echo "worktree $WT is not on a branch - not touching it" >&2; exit 1; }
before="$(git rev-parse --short HEAD)"
# shellcheck source=scripts/sync-branch-lib.sh
source "$REPO/scripts/sync-branch-lib.sh"
sync_branch_to_base "$BASE" "$BRANCH" "$WT" || { echo "sync of $BRANCH with $BASE needs a decision (conflict) - left as it was" >&2; exit 1; }
node "$REPO/scripts/preflight-change.mjs" "$CHANGE" >/dev/null 2>&1 || echo "WARN: preflight-change reported problems (see a launch for details)" >&2
node "$REPO/scripts/compile-change-guards.mjs" "$CHANGE" --out .contract-guards.json >/dev/null || { echo "guard compile failed" >&2; exit 1; }
after="$(git rev-parse --short HEAD)"
echo "synced $BRANCH with $BASE: $before -> $after, guards regenerated ($WT)"
echo "HEAD $after"
