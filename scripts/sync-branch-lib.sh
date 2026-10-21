# shellcheck shell=bash
# sync-branch-lib.sh - shared "bring this worktree's branch up to date with its
# base" step for launch-planner.sh and launch-worker.sh. Source it, then call:
#
#   sync_branch_to_base <base> <branch> <worktree> [prefer-base-glob]
#
# Run INSIDE the worktree. Exits non-zero (with a clear message) only when a
# human really has to decide something. Fixes the failure loop of 2026-10-15:
#   1. Uncommitted edits blocked the merge ("would be overwritten") and the
#      launcher reported it as a conflict. -> they are stashed and restored.
#   2. A failed merge was LEFT IN PROGRESS, so every later relaunch failed with
#      "unmerged files" instead of retrying. -> a failed merge is always
#      aborted, and a stale one from an older run is aborted before starting.
#   3. The integrator approving a plan rewrites change.yaml on main, which
#      conflicts with the planner's copy on every approval. -> conflicts ONLY
#      in files matching prefer-base-glob are resolved to the base's version
#      (planner only: main's approval is authoritative there; a worker's
#      change.yaml carries its own progress, so the worker never passes a glob).
#   4. Approving a plan COPIES the planner's files onto main, so a later sync
#      sees add/add conflicts whose contents are identical (only the file mode
#      differs). -> those always take the base's version, for every role.
#   5. An UNTRACKED file at a path the base adds blocks the merge outright
#      ("untracked working tree files would be overwritten") - stash (1) only
#      covers tracked edits. Seen on every planner relaunch (2026-10-20): a
#      stale, never-committed change.yaml stub from an earlier session, while
#      main meanwhile holds the real one. -> identical to the base's copy:
#      removed (the merge brings it straight back, nothing is lost); different:
#      MOVED to .pi-session/sync-parked/<timestamp>/<path> (git-ignored) and
#      reported, never deleted. If the merge still fails, they are moved back.

sync_branch_to_base() {
  local base="$1" branch="$2" wt="$3" prefer="${4:-}"
  local stashed=0 f unmerged other parked="" park=""

  # (2) a merge left behind by an earlier failed launch
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "NOTE: aborting a merge left unfinished in $wt by an earlier launch." >&2
    git merge --abort >/dev/null 2>&1 || git reset -q --merge
  fi

  git merge-base --is-ancestor "$base" HEAD 2>/dev/null && return 0   # already contains base

  # (1) park uncommitted tracked edits for the duration of the merge
  if ! git diff --quiet HEAD -- 2>/dev/null; then
    git stash push -q -m "launcher autostash before syncing $branch with $base" && stashed=1
  fi

  # (5) untracked files sitting where the base adds a file
  park=".pi-session/sync-parked/$(date +%Y%m%d-%H%M%S)"
  while IFS= read -r f; do
    [ -n "$f" ] && git cat-file -e "$base:$f" 2>/dev/null || continue
    if [ "$(git hash-object -- "$f")" = "$(git rev-parse "$base:$f")" ]; then
      rm -f -- "$f"
    else
      mkdir -p "$park/$(dirname -- "$f")" && mv -- "$f" "$park/$f" && parked="$parked $f"
    fi
  done < <(git ls-files --others --exclude-standard)

  if git merge-base --is-ancestor HEAD "$base" 2>/dev/null; then
    git merge -q --ff-only "$base" >/dev/null 2>&1 || true
  elif ! git merge --no-edit "$base" >/dev/null 2>&1; then
    unmerged="$(git diff --name-only --diff-filter=U)"
    other=""
    for f in $unmerged; do
      # (4) same content on both sides (the integrator lands planning files on main
      # as a COPY, not a merge -> add/add "conflicts" that differ only in the
      # executable bit). Safe for every role: nothing can be lost.
      if [ "$(git rev-parse -q ":2:$f" 2>/dev/null)" = "$(git rev-parse -q ":3:$f" 2>/dev/null)" ] && [ -n "$(git rev-parse -q ":3:$f" 2>/dev/null)" ]; then
        continue
      fi
      # shellcheck disable=SC2254
      case "$f" in $prefer) [ -n "$prefer" ] || other="$other $f" ;; *) other="$other $f" ;; esac
    done
    if [ -n "$unmerged" ] && [ -z "$other" ]; then
      # (3) only base-authoritative files conflicted: take the base's version
      for f in $unmerged; do git checkout --theirs -- "$f" && git add -- "$f"; done
      git commit -q --no-edit
      echo "NOTE: merge conflict in$(printf ' %s' $unmerged) resolved to $base's version (base is authoritative for these)." >&2
    else
      git merge --abort >/dev/null 2>&1 || git reset -q --merge
      [ "$stashed" = 1 ] && git stash pop -q >/dev/null 2>&1
      for f in $parked; do mkdir -p "$(dirname -- "$f")" && mv -- "$park/$f" "$f"; done   # put parked files back: nothing half-done
      echo "REFUSING: merging $base into $branch conflicts in $wt." >&2
      if [ -n "$other" ]; then
        echo "  conflicting files:$other" >&2
      else
        git merge --no-edit "$base" 2>&1 | grep -E 'error|overwritten|^\s' | head -8 | sed 's/^/  /' >&2
        git merge --abort >/dev/null 2>&1 || true
      fi
      echo "  The merge was aborted (nothing half-done is left behind). Resolve it with:" >&2
      echo "    cd \"$wt\" && git merge $base   # fix the files, git add, git commit" >&2
      echo "  then relaunch." >&2
      return 1
    fi
  fi

  if [ -n "$parked" ]; then
    echo "NOTE: untracked file(s) in the way of $base's version were moved aside, not deleted:$(printf ' %s' $parked)" >&2
    echo "      -> $wt/$park/  (compare with the merged copy; delete the folder once you no longer need it)" >&2
  fi

  # restore the parked edits; if they clash with what base brought in, keep base
  # and leave the edits safely in the stash rather than half-applied
  if [ "$stashed" = 1 ] && ! git stash pop -q >/dev/null 2>&1; then
    git reset -q --hard HEAD
    echo "NOTE: your uncommitted edits in $wt clashed with $base's changes; $base's version is checked out and your edits are kept in 'git stash list' (stash@{0})." >&2
  fi
  return 0
}

# planner_autosave <branch> - run INSIDE the planner worktree when a planner
# session ENDS (launch-planner.sh calls it after the container exits, and from a
# HUP/TERM trap when the Herdr pane is closed). Commits uncommitted planner work
# so nothing is left loose for the next launch to trip over (2026-10-20: a stale
# never-committed change.yaml blocked every relaunch).
#   - ONLY the planner's own surface (docs/changes/**, docs/decisions/** - the
#     same boundary compile-planner-guards.mjs enforces); anything else is left
#     untouched and listed.
#   - Commits to the planning branch only. Never merges into main: landing work
#     on main stays the integrator's job.
#   - Skips (with a note) when HEAD is not the planning branch or a merge is in
#     progress. Never fails the caller.
#   PLANNER_AUTOSAVE=0 turns it off.
planner_autosave() {
  local branch="$1" files outside
  [ "${PLANNER_AUTOSAVE:-1}" = "1" ] || return 0
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" != "$branch" ]; then
    echo "NOTE: planner auto-save skipped - worktree is not on $branch." >&2; return 0
  fi
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "NOTE: planner auto-save skipped - a merge is in progress in $(pwd)." >&2; return 0
  fi
  git add -A -- docs/changes docs/decisions 2>/dev/null || true
  files="$(git diff --cached --name-only -- docs/changes docs/decisions)"
  if [ -n "$files" ]; then
    if git commit -q -m "planner: auto-save uncommitted work at session end" \
         -m "Committed by the launcher when the planner session ended, so nothing is left uncommitted. Not merged into main - the integrator lands planning work." \
         -m "$(printf '%s\n' "$files" | sed 's/^/- /')" >/dev/null 2>&1; then
      echo "NOTE: planner auto-saved $(printf '%s\n' "$files" | wc -l | tr -d ' ') uncommitted file(s) to $branch ($(git rev-parse --short HEAD)); not merged into main." >&2
    else
      git reset -q -- docs/changes docs/decisions 2>/dev/null || true
      echo "NOTE: planner auto-save could not commit (a git hook refused?); the files are still in $(pwd), uncommitted." >&2
    fi
  fi
  outside="$(git status --porcelain --untracked-files=all 2>/dev/null | grep -vE '^.. "?docs/(changes|decisions)/' || true)"
  [ -n "$outside" ] && { echo "NOTE: left uncommitted (outside the planner's docs/changes + docs/decisions):" >&2; printf '%s\n' "$outside" | head -10 | sed 's/^/  /' >&2; }
  return 0
}
