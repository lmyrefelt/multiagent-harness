#!/usr/bin/env bash
# launch-worker.sh — launch a guarded PI worker for a change IN ITS OWN git worktree.
#
# WHY A WORKTREE: many workers must be able to implement different changes at the
# SAME TIME. The old version checked the branch out in the one shared checkout, so
# every launch hijacked its HEAD and workers (and the integrator, and the planner)
# tripped over each other. Now each worker gets a dedicated worktree under
# .worktrees/ — a STABLE path inside the repo, never a volatile mount like
# /workspace — and the container is mounted on THAT. The main checkout is never
# touched, so the integrator keeps it on `main`.
#
#   scripts/launch-worker.sh CHANGE-0003 [label] [pi|antigravity|claude|codex|opencode] [--dry-run]
#     backend defaults to pi. antigravity reuses the SAME translation layer
#     the integrator already uses (scripts/antigravity-guard-adapter.mjs,
#     Dockerfile.agy -> harness-agy:latest, itself FROM pi-contracts:latest -
#     same dev toolchain, Antigravity binary added on top). Unlike the
#     integrator, REPO_ROOT for the hook is the WORKTREE root, not /repo -
#     a worker's owned_paths are matched relative to its own worktree.
#     A permissions settings.json is also generated+mounted to reduce
#     interactive approval prompts for routine ops - the PreToolUse hook
#     runs BEFORE that permission layer and is not bypassed by it (only
#     --dangerously-skip-permissions bypasses the hook itself, which is
#     deliberately not used here - see docs/changes/ANTIGRAVITY-WORKER.md.
#     claude (Claude Code CLI) uses the SAME checks.mjs engine via its own
#     translation layer (scripts/claude-guard-adapter.mjs, Dockerfile.claude
#     -> harness-claude:latest). Simpler than antigravity: no bind mount for the
#     hook config at all (--settings <path> reads a plain file off the
#     already-mounted /repo volume), and --dangerously-skip-permissions IS
#     used directly, because Claude Code's PreToolUse hooks are CONFIRMED to
#     keep firing under it (code.claude.com/docs/en/hooks, fetched directly)
#     - unlike Antigravity, where the equivalent flag disables hooks outright.
#     codex (OpenAI Codex CLI) uses the SAME checks.mjs engine too
#     (scripts/codex-guard-adapter.mjs, Dockerfile.codex -> harness-codex:latest).
#     Codex's hooks.json is single-file-mounted onto the USER-level
#     ~/.codex/hooks.json (repo-level hooks there require interactive /hooks
#     trust approval, unavailable to an unattended container). FLAGGED: a
#     real, OPEN upstream bug (github.com/openai/codex#27833) means a hook's
#     deny for apply_patch (file edits) is not always enforced on every
#     platform - unconfirmed on Linux either way. Verify against the
#     filesystem + evidence.jsonl on first real use of this backend, not
#     just this adapter's own JSON output - see docs/changes/CODEX-WORKER.md.
#     opencode (OpenCode CLI) is ARCHITECTURALLY DIFFERENT from the other
#     three: its hook is an IN-PROCESS plugin (a JS module opencode itself
#     loads, auto-discovered from .opencode/plugins/), not an external
#     process reading stdin/stdout JSON - so there is NO bind mount at all
#     for the guard wiring, just a generated file written straight into the
#     worktree. Throwing an Error in the hook blocks the call - no decision-
#     object schema to get wrong (see scripts/opencode-guard-adapter.mjs's
#     header for what's confirmed vs inferred - OpenCode's docs don't dump a
#     full schema the way Claude Code's do). The motivating reason for this
#     backend: OpenCode Zen's free tier (several free models, no card
#     required) - OPENCODE_CONFIG_DIR mirrors pi's PI_CONFIG_DIR convention
#     for reusing a pre-authenticated auth.json across launches.
#

# Env overrides (all optional):
#   WORKER_MODEL=local/<id>     the local model (else pi uses its default provider)
#   LOCAL_LLM_BASE_URL=...       default http://host.docker.internal:8001/v1
#   IMAGE=pi-contracts:latest
#   EXTENSION=/opt/contracts/extensions/contract-guard.ts
#   REPO=<path>                  default: the git top-level of this checkout
#   WORKTREES_DIR=<path>         where per-worker worktrees live (default <repo>/.worktrees)
#   PI_CONFIG_DIR=<path>         if set, bind-mounts <path>/.pi/agent/auth.json onto
#                                /home/node/.pi/agent/auth.json (shares credentials across
#                                launches/roles). Deliberately NOT a whole-.pi mount:
#                                settings.json (and ITS packages array - what a role's
#                                image actually installed, e.g. pi-subagents on the
#                                planner/integrator images but not the worker's) and
#                                models.json stay image-local, baked in at build time.
#                                Sharing the whole directory would let the planner's
#                                pi-subagents registration leak into a worker container
#                                that never installed the package - mounting only
#                                auth.json makes that impossible by construction.
#   MODELS_JSON=<path>           optional, separate from PI_CONFIG_DIR on purpose (same
#                                leakage reasoning above - this is one file, not the
#                                settings.json that carries package registrations).
#                                The image's baked-in models.json ships with an
#                                intentionally empty `models: []` and is NEVER
#                                regenerated per run - a real local model is only
#                                resolvable if a freshly PROBED file (node
#                                /opt/contracts/make-models-json.mjs --base-url ...)
#                                is bind-mounted here. baseUrl in that file is NOT
#                                env-interpolated, so LOCAL_LLM_BASE_URL alone never
#                                fixes a stale/empty models.json. If WORKER_MODEL is
#                                unset and this is mounted, an interactive TTY gets a
#                                numbered pick list instead of silently falling through
#                                to pi's default provider (needs jq; non-interactive
#                                runs are unaffected).
#   TASK="..."                   appended to the orientation seed as the session's first
#                                message (see SEED below) - skips retyping the reminder
#                                every launch; omit to get just the reminder and type the
#                                task yourself once the interactive session opens.
#   PI_EXTRA_TOOLS="+codemode"   optional, no default forced - passed to pi's own
#                                --tools flag. For one-off verification runs where a
#                                flag like this is needed without hand-editing a
#                                copy-pasted docker command.
#   SESSION_LOG_OUT=1            default on for claude/codex/opencode (antigravity
#                                already persists its own transcripts as a side effect
#                                of the existing gemini-antigravity-cli directory mount -
#                                confirmed by inspection, nothing to add there). Each of
#                                the other three backends keeps its own session transcript
#                                outside /repo entirely, so it dies with the --rm container
#                                same as pi-cache-optimizer did before CACHE_STATS_OUT below -
#                                this persists it the same way, one NARROW subdirectory
#                                mount per backend (never the whole ~/.claude or ~/.codex,
#                                which also hold settings/credentials this must not shadow):
#                                  claude -> /home/node/.claude/projects      (confirmed
#                                    directly: this very harness's own session files live
#                                    at ~/.claude/projects/<escaped-cwd>/<uuid>.jsonl)
#                                  codex  -> /home/node/.codex/sessions       (confirmed via
#                                    web search, multiple independent sources: rollout-*.jsonl
#                                    under sessions/YYYY/MM/DD/, not verified against a real
#                                    codex container directly - no docker available here)
#                                  opencode -> /home/node/.local/share/opencode, but ONLY
#                                    when OPENCODE_CONFIG_DIR is unset (when it IS set, that
#                                    mount already covers this directory, including session
#                                    history, per that mount's own existing comment below)
#   CACHE_STATS_OUT=1            default on for the pi backend. Persists
#                                pi-cache-optimizer's stats shards (it IS installed
#                                in Dockerfile.pi-contracts) by bind-mounting
#                                $SESSION_REL/cache-optimizer-stats.d onto
#                                /home/node/.pi/agent/pi-cache-optimizer-stats.d -
#                                an OUTPUT-only directory the package creates
#                                itself, never pre-baked into the image, so unlike
#                                a whole-.pi mount this cannot shadow settings.json/
#                                models.json or leak another role's packages (see
#                                PI_CONFIG_DIR above). Without this the shards die
#                                with the --rm container and there is nothing to
#                                audit after the fact (see docs/changes/COORDINATION.md
#                                and pi-agentic-setup-research/07-context-discipline.md).
#                                Dockerfile.pi-contracts ALSO installs pi-usage-ledger
#                                and pi-prefix-cache-compaction - both plausibly as
#                                relevant to the same audit, but their on-disk output
#                                paths are UNCONFIRMED (no docker available to this
#                                script's author to check), so they are deliberately
#                                NOT mounted here yet rather than guessed at - mounting
#                                an empty dir at the wrong path would silently collect
#                                nothing and look like it worked. Confirm the real path
#                                first (e.g. run the image once, then `find /home/node/.pi
#                                -maxdepth 3 -newer /home/node/.pi/agent/models.json`
#                                inside the container) and add the same pattern below.
#   HERDR_AGENT=pi               default. Exported before the final exec so a Herdr
#                                pane watching this script's own (host-side) process
#                                tree can tell it's pi, even though the visible
#                                command is `docker run`, not `pi` - Herdr cannot look
#                                inside the container to detect that itself. No-op,
#                                harmless, if Herdr isn't running this pane at all.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .pi/worker.env ]; then set -a; . ./.pi/worker.env; set +a; fi

CHANGE="${1:-}"
case "$CHANGE" in
  CHANGE-*) ;;
  *) echo "usage: scripts/launch-worker.sh CHANGE-NNNN [label] [--dry-run]" >&2; exit 1 ;;
esac
shift

BACKEND="pi"
LABEL=""
DRY=0
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    pi|antigravity|agy|claude|codex|opencode) BACKEND="$a" ;;
    --*) echo "unknown flag: $a" >&2; exit 1 ;;
    *) LABEL="$a" ;;
  esac
done
[ "$BACKEND" = "agy" ] && BACKEND="antigravity"

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
case "$BACKEND" in
  pi)          IMAGE="${IMAGE:-pi-contracts:latest}" ;;
  antigravity) IMAGE="${IMAGE:-harness-agy:latest}" ;;
  claude)      IMAGE="${IMAGE:-harness-claude:latest}" ;;
  codex)       IMAGE="${IMAGE:-harness-codex:latest}" ;;
  opencode)    IMAGE="${IMAGE:-harness-opencode:latest}" ;;
esac
EXTENSION="${EXTENSION:-/opt/contracts/extensions/contract-guard.ts}"
LLM="${LOCAL_LLM_BASE_URL:-http://host.docker.internal:8001/v1}"
MODEL="${WORKER_MODEL:-}"
WORKTREES_DIR="${WORKTREES_DIR:-$REPO/.worktrees}"   # STABLE path; never /workspace
# Backend-aware default, matching launch-integrator.sh's own pattern for the
# same reason: HERDR_AGENT selects Herdr's detection manifest, and "pi" would
# be wrong for an antigravity-backed worker (Herdr's recognized identifier
# for it is "antigravity-cli", not "antigravity"). "claude" for the claude
# backend is UNVERIFIED - no Herdr manifest for it has been confirmed (unlike
# "pi"/"antigravity-cli", which came from this project's own earlier testing)
# - override with HERDR_AGENT= if Herdr doesn't recognize it.
case "$BACKEND" in
  pi)          HERDR_AGENT_DEFAULT="pi" ;;
  antigravity) HERDR_AGENT_DEFAULT="antigravity-cli" ;;
  claude)      HERDR_AGENT_DEFAULT="claude" ;;
  codex)       HERDR_AGENT_DEFAULT="codex" ;;
  opencode)    HERDR_AGENT_DEFAULT="opencode" ;;
esac
export HERDR_AGENT="${HERDR_AGENT:-$HERDR_AGENT_DEFAULT}"  # see header; inherited by `exec docker run` below

# 2026-10-13: baked-in, zero-env-var auth/model persistence under
# ~/.harness/config/ - see scripts/harness-config-lib.sh's own header for
# the full design (why granular file mounts, the security note, what's
# verified vs not). Sets PI_CONFIG_DIR/OPENCODE_CONFIG_DIR defaults (if
# unset) and the HARNESS_CLAUDE_*/HARNESS_CODEX_* variables used in the
# claude/codex docker-run blocks below.
source "$REPO/scripts/harness-config-lib.sh"

# Model picked by the router (scripts/route-worker.mjs via the Herdr watcher) wins
# over .pi/worker.env and ~/.harness/config/claude/model.txt for this launch.
if [ -n "${HARNESS_ROUTED_MODEL:-}" ]; then
  case "$BACKEND" in
    pi)     MODEL="$HARNESS_ROUTED_MODEL" ;;
    claude) HARNESS_CLAUDE_MODEL="$HARNESS_ROUTED_MODEL" ;;
    opencode) OPENCODE_MODEL="$HARNESS_ROUTED_MODEL" ;;
    codex)  CODEX_MODEL="$HARNESS_ROUTED_MODEL" ;;
  esac
  echo "routing   : $HARNESS_ROUTED_MODEL on $BACKEND - ${HARNESS_ROUTED_WHY:-picked by the router}"
fi
# Thinking effort (router: medium for ordinary work, high for L/XL/high-risk/visual/struggling;
# WORKER_EFFORT in .pi/worker.env when not routed). pi --thinking, codex model_reasoning_effort,
# claude CLAUDE_CODE_EFFORT_LEVEL; OpenCode keeps its model default.
EFFORT="${HARNESS_ROUTED_EFFORT:-${WORKER_EFFORT:-}}"
case "$EFFORT" in ""|low|medium|high) ;; *) echo "WARN: unknown effort '$EFFORT' - ignored" >&2; EFFORT="" ;; esac
[ -n "$EFFORT" ] && echo "effort    : $EFFORT"

if [ -n "$PI_CONFIG_DIR" ] && [ ! -f "$PI_CONFIG_DIR/.pi/agent/auth.json" ]; then
  # Checked explicitly: docker silently CREATES an empty FILE for a missing bind-mount
  # source, which would mount an empty auth.json rather than failing loudly.
  # (Only reachable for an EXPLICIT PI_CONFIG_DIR now - the library above
  # already guarantees the file exists for its own default.)
  echo "REFUSING: PI_CONFIG_DIR is set but '$PI_CONFIG_DIR/.pi/agent/auth.json' does not exist." >&2
  exit 1
fi

MODELS_JSON=""
if [ "$BACKEND" = "pi" ]; then
  # The image bakes in /home/node/.pi/agent/models.json with an empty `models: []` -
  # it ships deliberately unpopulated (see Dockerfile.pi-contracts comments) and is
  # NOT regenerated per run. A real local model is only resolvable if a freshly
  # PROBED models.json (node /opt/contracts/make-models-json.mjs --base-url ...)
  # is mounted over it here - baseUrl in that file is NOT env-interpolated, so
  # LOCAL_LLM_BASE_URL alone never fixes a stale/empty models.json.
  # Pi-only: antigravity has its own, entirely separate model/auth mechanism.
  MODELS_JSON="${MODELS_JSON:-}"
  # Auto-detect so no export is needed every run: if nothing was passed, fall
  # back to a freshly-probed file sitting at the repo root by convention - but
  # only if it actually exists. An explicit MODELS_JSON that points nowhere
  # still REFUSES below; this default never silently points at a missing file.
  if [ -z "$MODELS_JSON" ] && [ -f "$REPO/models.local.json" ]; then
    MODELS_JSON="$REPO/models.local.json"
  fi
  if [ -n "$MODELS_JSON" ] && [ ! -f "$MODELS_JSON" ]; then
    echo "REFUSING: MODELS_JSON is set but '$MODELS_JSON' does not exist." >&2
    exit 1
  fi

  # No model chosen but a probed registry IS mounted - offer to pick one
  # interactively instead of silently falling through to pi's default provider
  # (the WORKER_MODEL-unset WARN below is easy to miss). Only prompts with a
  # real TTY attached; a non-interactive run just keeps the existing WARN
  # behavior unchanged, so this cannot break scripted/background launches.
  if [ -z "$MODEL" ] && [ -n "$MODELS_JSON" ] && [ -t 0 ] && [ -t 1 ]; then
    if ! command -v jq >/dev/null 2>&1; then
      echo "WARN: MODELS_JSON is set but jq is not installed - cannot list models for selection. Set WORKER_MODEL explicitly." >&2
    else
      AVAILABLE_MODELS=()
      while IFS= read -r m; do [ -n "$m" ] && AVAILABLE_MODELS+=("$m"); done \
        < <(jq -r '.providers.local.models[]?.id // empty' "$MODELS_JSON" 2>/dev/null)
      if [ "${#AVAILABLE_MODELS[@]}" -gt 0 ]; then
        echo ""
        echo "WORKER_MODEL is unset. $MODELS_JSON declares ${#AVAILABLE_MODELS[@]} local model(s):"
        i=1
        for m in "${AVAILABLE_MODELS[@]}"; do
          echo "  $i) local/$m"
          i=$((i + 1))
        done
        echo "  0) none - use pi's default provider"
        read -r -p "Select a model [0]: " CHOICE
        CHOICE="${CHOICE:-0}"
        if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#AVAILABLE_MODELS[@]}" ]; then
          MODEL="local/${AVAILABLE_MODELS[$((CHOICE - 1))]}"
        fi
      fi
    fi
  fi
fi

# --- images: build / refresh automatically ------------------------------------
# scripts/ensure-image.sh builds the image if it is missing and rebuilds it when
# its build inputs (guards, contracts, Dockerfiles) or its base image changed -
# so a launch never stops at "image is stale, rebuild it". HARNESS_AUTO_BUILD=0
# turns this off and the checks below apply as before.
HARNESS_IMAGES_ENSURED=""
if [ "${DRY:-0}" != 1 ] && [ "${HARNESS_AUTO_BUILD:-1}" != 0 ]; then
  bash "$REPO/scripts/ensure-image.sh" worker "$BACKEND" "$IMAGE" || exit 1
  HARNESS_IMAGES_ENSURED=1
fi

# --- image freshness (fails BEFORE touching any git state) --------------------
if [ "$BACKEND" = "pi" ]; then
  # $IMAGE is built in a SEPARATE repo (pi-contracts-research), so this script
  # cannot know on its own whether it is missing or stale. If PI_CONTRACTS_DIR
  # points at that repo, check the fingerprint build.sh writes on success; if it
  # does not match the one computed now, a source file changed since the image
  # was built (this is exactly how a guard-engine fix - e.g. the checks.mjs
  # testsRanAndPassed fix - can silently NOT take effect: the image still has the
  # old code). Set PI_CONTRACTS_DIR once in .pi/worker.env to enable this.
  if [ -n "$HARNESS_IMAGES_ENSURED" ]; then
    :  # ensure-image.sh just built/verified it
  elif [ -n "${PI_CONTRACTS_DIR:-}" ] && [ -d "$PI_CONTRACTS_DIR" ]; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && ./build.sh)" >&2
      exit 1
    fi
    PCD="$PI_CONTRACTS_DIR"
    CURRENT_FP=$(
      { [ -f "$PCD/Dockerfile.pi-contracts" ] && cat "$PCD/Dockerfile.pi-contracts"
        find "$PCD/prototype" -type f 2>/dev/null | sort | while IFS= read -r f; do cat "$f"; done
        [ -f "$PCD/models.json" ] && cat "$PCD/models.json"
        [ -f "$PCD/settings.defaults.json" ] && cat "$PCD/settings.defaults.json"
      } | cksum | awk '{print $1}'
    )
    RECORDED_FP=$(awk -v img="$IMAGE" '$2==img{print $1}' "$PCD/.pi-contracts-build.fingerprint" 2>/dev/null)
    if [ "$CURRENT_FP" != "$RECORDED_FP" ]; then
      echo "REFUSING: '$IMAGE' is stale - its build inputs changed since the last build. Rebuild:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && ./build.sh)" >&2
      exit 1
    fi
  else
    echo "WARN: PI_CONTRACTS_DIR unset or not found - skipping the image-staleness check (a stale '$IMAGE' would go unnoticed). Set PI_CONTRACTS_DIR=/path/to/pi-contracts-research in .pi/worker.env to enable it." >&2
  fi
else
  # antigravity/claude: no fingerprint mechanism (Dockerfile.agy/Dockerfile.claude
  # live in the host project, not pi-contracts-research) - same bare existence
  # check launch-integrator.sh already uses for antigravity, for consistency.
  DOCKERFILE="Dockerfile.agy"
  [ "$BACKEND" = "claude" ] && DOCKERFILE="Dockerfile.claude"
  [ "$BACKEND" = "codex" ] && DOCKERFILE="Dockerfile.codex"
  [ "$BACKEND" = "opencode" ] && DOCKERFILE="Dockerfile.opencode"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
    echo "  docker build -f $DOCKERFILE -t $IMAGE ." >&2
    exit 1
  fi
fi

# --- resolve the change + its approval (NEVER touches the main checkout) -------
CDIR=$(ls -d "docs/changes/${CHANGE}"-* 2>/dev/null | head -1 || true)
if [ -z "$CDIR" ]; then
  echo "REFUSING: no docs/changes/${CHANGE}-*/ folder." >&2
  echo "  $CHANGE may exist only as a branch (drift), or not at all. A worker launches a" >&2
  echo "  CHANGE that has a change folder with owned_paths; create/own it first." >&2
  exit 1
fi
CY="$CDIR/change.yaml"
# Authoritative copy: main's if the change is integrated there (so a stale feature-
# branch copy can't misreport approval — the CHANGE-0005 failure), else the working-
# tree copy (a branch-only / stacked planner spec). `|| true`: an absent field would
# otherwise trip set -e.
if git cat-file -e "main:$CY" 2>/dev/null; then
  read_cy() { git show "main:$CY" 2>/dev/null; }
else
  read_cy() { cat "$CY" 2>/dev/null; }
fi
field() { read_cy | grep -m1 "^$1:" | sed -E "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*//" | tr -d "\"'" || true; }
STATUS=$(field status); BRANCH=$(field branch); BASE=$(field base_branch); BASE="${BASE:-main}"

# Gate on APPROVAL STATE, not just the branch field: a draft/specified change may
# carry a stray branch (chain drift) yet not be approved for implementation. Only
# approved (start) or in_progress (resume) are worker-launchable.
case "$STATUS" in
  approved|in_progress) ;;
  complete|rejected) echo "REFUSING: $CHANGE is '$STATUS' — nothing to implement." >&2; exit 1 ;;
  review) echo "REFUSING: $CHANGE is 'review' — awaiting integrator review/merge, not a worker relaunch." >&2; exit 1 ;;
  *) echo "REFUSING: $CHANGE is '${STATUS:-unset}' — not approved for implementation. Finish specifying + approve it first (status: approved + branch set)." >&2; exit 1 ;;
esac
if [ -z "$BRANCH" ] || [ "$BRANCH" = "null" ]; then
  echo "REFUSING: $CHANGE is approved but change.yaml 'branch' is unset — set branch: feature/$(basename "$CDIR")." >&2
  exit 1
fi

# docker-safe, lowercased name: harness-<change>[-<label>]
raw="${CHANGE}${LABEL:+-$LABEL}"
NAME="harness-$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"

# Auto-suffix if that name's container already exists (a session that
# wasn't shut down cleanly - --rm only removes a container that actually
# EXITED). Resolves NAME itself, not just --name below, since NAME also
# drives the worktree path and session dir. Never removes the existing
# container; it may still be in active use. If a worker IS still genuinely
# running this change, git itself will refuse a second worktree on the same
# branch at the worktree-creation step below - a clearer failure than this
# docker conflict was, not a new risk introduced by suffixing.
BASE_NAME="$NAME"; N=1
while docker container inspect "$NAME" >/dev/null 2>&1; do
  N=$((N + 1))
  if [ "$N" -gt 99 ]; then
    echo "REFUSING: 99 containers already named ${BASE_NAME}[-NN] - clean up stale ones first: docker ps -a | grep $BASE_NAME" >&2
    exit 1
  fi
  NAME="$(printf '%s-%02d' "$BASE_NAME" "$N")"
done
[ "$NAME" = "$BASE_NAME" ] || echo "NOTE: '$BASE_NAME' container name already in use - using '$NAME' instead (existing container left running, not removed)." >&2

WT="$WORKTREES_DIR/$NAME"
# The WHOLE repo is mounted at /repo so the worktree's git metadata (../../.git/...)
# resolves in the container; the worker's cwd is its worktree subpath. Worktrees must
# therefore live UNDER $REPO.
case "$WT" in
  "$REPO"/*) ;;
  *) echo "REFUSING: WORKTREES_DIR must be under the repo ($REPO) so the container mount covers .git." >&2; exit 1 ;;
esac
WT_REL="${WT#"$REPO"/}"
GUARDS=".contract-guards.json"          # relative to the worktree (the container cwd)
SESSION_REL=".pi-session/$NAME"
EVIDENCE="$SESSION_REL/evidence.jsonl"
CACHE_STATS_OUT="${CACHE_STATS_OUT:-1}"
CACHE_STATS_REL="$SESSION_REL/cache-optimizer-stats.d"
SESSION_LOG_OUT="${SESSION_LOG_OUT:-1}"
CLAUDE_PROJECTS_REL="$SESSION_REL/claude-projects"
CODEX_SESSIONS_REL="$SESSION_REL/codex-sessions"
OPENCODE_HOME_REL="$SESSION_REL/opencode-home"

if [ "$DRY" -eq 0 ]; then
  mkdir -p "$WORKTREES_DIR"
  # Create (or reuse) the worker's OWN worktree. The branch is checked out here,
  # never in the main checkout — that is what lets many workers run at once.
  if [ -d "$WT" ]; then
    echo "reusing worktree $WT"
  elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    if git worktree list --porcelain | grep -qx "branch refs/heads/$BRANCH"; then
      inwt=$(git worktree list --porcelain | awk -v b="branch refs/heads/$BRANCH" '$0==b{print p} /^worktree /{p=$2}')
      echo "REFUSING: $BRANCH is already checked out at $inwt — one worker per change." >&2
      exit 1
    fi
    git worktree add --lock --reason "HARNESS worker worktree - cross-environment absolute path, do not prune" "$WT" "$BRANCH" >/dev/null
    echo "worktree $WT -> $BRANCH"
  else
    git worktree add --lock --reason "HARNESS worker worktree - cross-environment absolute path, do not prune" -b "$BRANCH" "$WT" "$BASE" >/dev/null
    echo "worktree $WT -> new $BRANCH (from $BASE)"
  fi

  # CRITICAL: `git worktree add` records the gitdir as an ABSOLUTE host path, which
  # does not exist inside the container (it is the Mac's /Users/... path) — so git,
  # the pre-commit hook and red_commit verification all break in the container.
  # Rewrite it RELATIVE to the worktree so git works wherever the repo is mounted.
  if [ -f "$WT/.git" ]; then
    up=$(printf '%s\n' "$WT_REL" | awk -F/ '{s="";for(i=1;i<=NF;i++)s=s"../";print s}')
    tail=$(sed -E 's#^gitdir: .*/(\.git/worktrees/.*)$#\1#' "$WT/.git")
    printf 'gitdir: %s%s\n' "$up" "$tail" > "$WT/.git"
  fi

  # Everything below runs INSIDE the worktree, so nothing here moves main's HEAD.
  ( cd "$WT"
    # Sync to the change's base so the worker sees the approved spec + latest base.
    if git merge-base --is-ancestor HEAD "$BASE" 2>/dev/null; then
      git merge --ff-only "$BASE" >/dev/null 2>&1 || true
    else
      # scripts/sync-branch-lib.sh: stashes uncommitted edits and never leaves a
      # failed merge behind. No prefer-base glob: a worker's change.yaml holds its
      # own progress, so every conflict goes to a human.
      # shellcheck source=scripts/sync-branch-lib.sh
      source "$REPO/scripts/sync-branch-lib.sh"
      sync_branch_to_base "$BASE" "$BRANCH" "$WT" || exit 1
    fi
    node "$REPO/scripts/preflight-change.mjs" "$CHANGE"
    node "$REPO/scripts/compile-change-guards.mjs" "$CHANGE" --out "$GUARDS"
    mkdir -p "$SESSION_REL" "$CACHE_STATS_REL" "$CLAUDE_PROJECTS_REL" "$CODEX_SESSIONS_REL" "$OPENCODE_HOME_REL"
  ) || exit 1
fi

[ "$BACKEND" = "pi" ] && [ -z "$MODEL" ] && echo "WARN: WORKER_MODEL unset — pi will use its default provider, not your local model (set WORKER_MODEL=local/<id>)." >&2

# Seed the FIRST turn of the (still fully interactive) session, for either backend.
# AGENTS.md already contains the full role-dispatch table; this exists only to make
# the agent actually ACT on it before diving in, since this project's own research
# found that a correct, present, even compaction-immune prompt rule is not reliably
# followed on its own (docs/postmortems/LOG.md). TASK is optional - set it to skip
# retyping the orientation reminder every launch and go straight to the actual ask.
SEED="Confirm your role (worker) and follow AGENTS.md's dispatch table for it before doing anything else - don't start work until you have."
# Project context (scripts/build-context.mjs): read it instead of re-exploring the repo (owner 2026-10-20)
[ -f "$REPO/.pi-session/CONTEXT.md" ] && SEED="$SEED Then read /repo/.pi-session/CONTEXT.md - the project's layout, autoload/class APIs, tests and decisions - and do NOT re-explore the repository to learn what it already tells you; open source files only to change them or read a body you need."

# MEASURED gap (2026-10-12): this SEED used to be identical for a fresh approved
# launch and a bounce-back relaunch after an integrator's "returned to worker"
# verdict - a relaunched worker had no mechanical way to know a round even
# happened unless a human manually copied the feedback into TASK. Surface the
# most recently modified review verdict in this change's own folder automatically
# instead - `ls -t` across both naming conventions seen in real reviews
# (review-feedback*.md, integrator-review-*.md), newest first. Deliberately a
# dumb file-glob, not a judgment call: if more than one exists, the newest is
# the one that matters: an older one was already acted on.
REVIEW_FEEDBACK=$(ls -t "$CDIR"/review-feedback*.md "$CDIR"/integrator-review-*.md 2>/dev/null | head -1 || true)
if [ -n "$REVIEW_FEEDBACK" ]; then
  SEED="$SEED A review verdict exists at $REVIEW_FEEDBACK - read it FIRST, before anything else. It names exactly what must change and in what order; do not re-derive that from the diff yourself."
fi

# Handoff protocol (scripts/handoff.mjs + herdr-plugin/pipeline.json): the agent
# reports its outcome; the Herdr lifecycle watcher starts the next role.
SEED="$SEED When the change is in status review with handover filled, write your handoff from the standard template (node /repo/scripts/handoff.mjs new --change CHANGE-NNNN --role worker - fill every section), then as your LAST action run: node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role worker --verdict impl-ready --file <that handoff file> --note '<one line>'. Use --verdict blocked (text in --note) when you cannot continue. If you need a DECISION the integrator can make (contract or save-format ownership, which change owns what, sequencing, conflicting ADRs, boundaries), write the proposal down and use --verdict needs-decision --file <that proposal> --note '<the decision needed>' - the integrator is started for you. Use --verdict question ONLY for what only the owner can decide (scope, priorities, money, people outside the harness). The integrator is started for you - never ask the owner to relay it."
[ -n "${TASK:-}" ] && SEED="$SEED $TASK"

# Mount the WHOLE repo (so ../../.git resolves + git is usable in the container) and
# run in the worktree subpath. The file boundary still fences writes to owned_paths.
# Never start pi with a model it cannot resolve ("Model local/<id> not found").
# scripts/resolve-model.mjs asks the local server what it serves when no mounted
# models file declares the model, registers it, or falls back to
# WORKER_MODEL_FALLBACKS / HARNESS_MODEL_FALLBACKS, or to pi's default provider.
# HARNESS_MODEL_RESOLVE=0 turns this off.
if [ "$BACKEND" = "pi" ] && [ "${HARNESS_MODEL_RESOLVE:-1}" != 0 ] && [ -f "$REPO/scripts/resolve-model.mjs" ]; then
  RESOLVED="$(node "$REPO/scripts/resolve-model.mjs" --role worker --model "$MODEL" --llm "$LLM" \
      --models-json "$MODELS_JSON" --repo "$REPO" \
      --fallbacks "${WORKER_MODEL_FALLBACKS:-${HARNESS_MODEL_FALLBACKS:-}}" || true)"
  if printf '%s\n' "$RESOLVED" | grep -q '^MODEL='; then
    MODEL="$(printf '%s\n' "$RESOLVED" | sed -n 's/^MODEL=//p')"
    MODELS_JSON="$(printf '%s\n' "$RESOLVED" | sed -n 's/^MODELS_JSON=//p')"
    LLM="$(printf '%s\n' "$RESOLVED" | sed -n 's/^LLM=//p')"
  fi
fi

if [ "$BACKEND" = "pi" ]; then
  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -e PI_ROLE=worker
    -e LOOP_GUARD="${LOOP_GUARD:-shadow}"
    -e HARNESS_CHANGE="$CHANGE"
    -e CONTRACT_GUARDS="$GUARDS"
    -e CONTRACT_EVIDENCE="$EVIDENCE"
    -e LOCAL_LLM_BASE_URL="$LLM")
  [ -n "$PI_CONFIG_DIR" ] && args+=(-v "$PI_CONFIG_DIR/.pi/agent/auth.json:/home/node/.pi/agent/auth.json")
  [ -n "$MODELS_JSON" ] && args+=(-v "$MODELS_JSON:/home/node/.pi/agent/models.json")
  # openai-free/* workers: the OpenAI key from the Keychain goes into THIS container only, by name (not on the command line)
  if [[ "$MODEL" == openai/* ]] && [ -z "${OPENAI_API_KEY:-}" ]; then
    OPENAI_API_KEY="$(node "$REPO/scripts/secrets.mjs" get openai 2>/dev/null || true)"; export OPENAI_API_KEY
  fi
  [[ "$MODEL" == openai/* ]] && [ -n "${OPENAI_API_KEY:-}" ] && args+=(-e OPENAI_API_KEY)
  # Machine-wide pi keybindings (e.g. a second key for "restore queued messages",
  # since Herdr itself takes alt+up): ~/.harness/config/pi/.pi/agent/keybindings.json
  [ -f "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json" ] && args+=(-v "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json:/home/node/.pi/agent/keybindings.json:ro")
  [ "$CACHE_STATS_OUT" = "1" ] && args+=(-v "$REPO/$WT_REL/$CACHE_STATS_REL:/home/node/.pi/agent/pi-cache-optimizer-stats.d")
  args+=("$IMAGE"
    --session-dir "/repo/$WT_REL/$SESSION_REL")
  [ -n "$MODEL" ] && args+=(--model "$MODEL")
  [ -n "$EFFORT" ] && args+=(--thinking "$EFFORT")
  args+=(--extension "$EXTENSION")
  # Optional, no default forced - e.g. PI_EXTRA_TOOLS=+codemode for a one-off
  # verification run. Exists specifically so a flag like this never has to be
  # hand-edited into a copy-pasted docker command - that's error-prone (a real
  # attempt pasted the whole banner output, not just the command, and the
  # shell tried to execute every line of it).
  [ -n "${PI_EXTRA_TOOLS:-}" ] && args+=(--tools "$PI_EXTRA_TOOLS")

  # A trailing positional message arg seeds the first turn without --print,
  # which would make it one-shot instead (pi's cli.md).
  args+=("$SEED")

elif [ "$BACKEND" = "antigravity" ]; then
  # Same translation layer the integrator already uses (antigravity-guard-
  # adapter.mjs) - CONTRACT_GUARDS/CONTRACT_EVIDENCE must be ABSOLUTE (the
  # adapter reads them directly, no resolve()), and REPO_ROOT must be the
  # WORKTREE root, not /repo - unlike the integrator (which operates at
  # /repo directly), a worker's owned_paths are matched relative to its own
  # worktree, so file_boundary needs repoRoot = /repo/$WT_REL to normalize
  # paths correctly.
  # hooks.json/settings.json are each mounted as a DIRECTORY, not a single
  # file - Antigravity writes its own config via write-temp-then-rename()-
  # over-target (a normal, otherwise-correct atomic-write pattern), and a
  # single-file bind mount pins the container path to the HOST FILE'S INODE
  # at mount time, so that rename() lands on an active mount point and fails
  # EBUSY ("Nothing has been written to your file yet"). Confirmed as a real,
  # documented Docker limitation (multiple independent GitHub issues hit the
  # exact same failure with other CLIs that write config the same way), not
  # guessed - a directory bind mount tracks entries, not a fixed inode, so
  # rename()-within-the-mounted-directory works normally. Each file therefore
  # gets its OWN per-launch subdirectory, and that subdirectory - not the file
  # - is what gets mounted onto the target.
  # Stop hook (2026-10-12): antigravity-completion-gate.mjs ports pi's own
  # completion-gate logic onto Antigravity's own per-turn Stop hook, same
  # reasoning as the claude/codex equivalents - the PreToolUse adapter above
  # structurally cannot see "claimed done, tests not green" by itself. FAILS
  # OPEN on its own errors/unrecognised transcript schema (see the script's
  # own header - this backend's transcript schema is the LEAST confirmed of
  # the three, and its Stop envelope has no last_assistant_message field at
  # all, unlike claude/codex).
  HOOKS_DIR="$SESSION_REL/gemini-config"
  PERMS_DIR="$SESSION_REL/gemini-antigravity-cli"
  HOOKS_JSON="$HOOKS_DIR/hooks.json"
  PERMS_JSON="$PERMS_DIR/settings.json"
  if [ "$DRY" -eq 0 ]; then
    mkdir -p "$WT/$HOOKS_DIR" "$WT/$PERMS_DIR"
    cat > "$WT/$HOOKS_JSON" <<EOF
{
  "harness-worker-guard": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/antigravity-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/antigravity-completion-gate.mjs'", "timeout": 30 }
        ]
      }
    ]
  }
}
EOF
    # Reduces interactive approval prompts for ROUTINE operations only - the
    # hook above runs BEFORE this layer and is NOT bypassed by it (verified:
    # agenticcontrolplane.com/blog/antigravity-permissions-reference, "PreToolUse
    # hook runs before the permission layer" and "your three lists still apply
    # to whatever the hook allows through" - only --dangerously-skip-permissions
    # bypasses the hook itself, which is why that flag is not used here). Safe
    # to be generous: the hook is the REAL enforcement (file_boundary,
    # command_forbidden - branch-wander/ad-hoc-install/repo-mutation are still
    # blocked there regardless of what this file allows), so a wrong "allow"
    # here only skips a prompt for something the hook denies a moment later -
    # fail-safe, not a bypass.
    #
    # The content is fully static (nothing here is per-worktree, unlike the
    # hooks file above), so it's a straight COPY of
    # scripts/antigravity-permissions-baseline.json - a single, version-
    # controlled source of truth every launch reuses, instead of a list
    # embedded in this script that drifts out of sync with itself. That file
    # mixes hand-written command-family patterns with literal commands
    # harvested from real past sessions (scripts/harvest-antigravity-
    # permissions.mjs) - see its own header for what was measured and why
    # (2026-10-10: Antigravity's own regex matching did NOT reliably suppress
    # prompts for multi-token real commands even when a matching regex: entry
    # was already present and active - the harvested literal entries are the
    # proven-to-work half of this list, the regex ones a low-cost add-on).
    if [ ! -f "$REPO/scripts/antigravity-permissions-baseline.json" ]; then
      echo "REFUSING: scripts/antigravity-permissions-baseline.json is missing - the antigravity worker would start with NO routine-command allowlist (everything prompts)." >&2
      exit 1
    fi
    cp "$REPO/scripts/antigravity-permissions-baseline.json" "$WT/$PERMS_JSON"
    node "$REPO/scripts/preaccept-startup.mjs" agy "$WT/$PERMS_JSON" "/repo/$WT_REL"   # folder-trust prompt pre-answered
    #node "$REPO/scripts/preaccept-startup.mjs" antigravity "$WT/$PERMS_JSON" "/repo/$WT_REL"   # folder-trust prompt pre-answered
    # statusLine (2026-10-12): a SIBLING key in this SAME settings.json, not
    # the HOOKS_JSON file - confirmed via antigravity.google/docs/cli/statusline/,
    # fetched directly. Logs quota.* (Gemini subscription daily/weekly windows)
    # to evidence.jsonl, same shape every other adapter here uses. Patched in
    # after the cp (not baked into the baseline file) because the command needs
    # this launch's own absolute CONTRACT_EVIDENCE path.
    # UNVERIFIED ONE DETAIL: the exact key shape (plain {command:...} vs
    # Claude's {type:"command", command:...}) was not independently confirmed
    # with a second source the way the quota JSON schema itself was - using the
    # simpler shape here; if a real launch shows the status line never updates,
    # check this field first before the parsing script.
    node -e "
      const fs = require('node:fs');
      const p = '$WT/$PERMS_JSON';
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.statusLine = { command: \"/bin/sh -c 'CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE node /repo/scripts/antigravity-usage-statusline.mjs'\" };
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    "
  fi

  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -v "$REPO/$WT_REL/$HOOKS_DIR:/home/node/.gemini/config"
    -v "$REPO/$WT_REL/$PERMS_DIR:/home/node/.gemini/antigravity-cli"
    -e PI_ROLE=worker
    "$IMAGE"
    -i "$SEED")
  # -i/--prompt-interactive: runs an initial prompt, then stays in the session
  # (agy's equivalent of pi's trailing-positional seed above). Confirmed by two
  # independent third-party sources (dev.to's hands-on guide + agy cheat-sheet
  # references), NOT by reading agy's own --help output directly - no docker
  # here to run it. First real launch should double-check the seed actually
  # lands as the first turn; if agy's real syntax differs, this will surface
  # as a startup/arg-parsing error, not a silent miss.

elif [ "$BACKEND" = "claude" ]; then
  # Same translation layer idea as antigravity (scripts/claude-guard-adapter.mjs)
  # - CONTRACT_GUARDS/CONTRACT_EVIDENCE absolute, REPO_ROOT = the WORKTREE root,
  # same reasoning as the antigravity branch above.
  #
  # UNLIKE antigravity: no bind mount at all for the hook config. Claude Code's
  # `--settings <path>` flag (code.claude.com/docs/en/cli-reference, fetched
  # directly) reads a plain file and layers its keys over the session's other
  # settings - the file just needs to exist somewhere under the already-mounted
  # /repo volume, so it's generated straight into the worktree's session dir,
  # no separate mount/subdirectory dance needed (sidesteps the whole class of
  # bug the antigravity branch hit, by construction - see Dockerfile.claude).
  #
  # --dangerously-skip-permissions is safe to use directly here (unlike
  # antigravity's permissions-preset workaround): PreToolUse hooks are
  # CONFIRMED to keep firing under it (code.claude.com/docs/en/hooks,
  # "bypasses the permission system but does not disable hooks").
  # Stop hook (2026-10-12): claude-completion-gate.mjs ports pi's own
  # completion-gate logic (agent_before_settle/agent_settled, which see the
  # WHOLE turn) onto Claude Code's per-turn Stop hook - the PreToolUse
  # adapter above structurally cannot see "claimed done, tests not green" by
  # itself. FAILS OPEN on its own errors/unrecognised transcript schema (see
  # the script's own header) - a broken Stop hook must never hang the
  # session the way a broken PreToolUse hook correctly fails CLOSED instead.
  SETTINGS_JSON="$SESSION_REL/claude-settings.json"
  if [ "$DRY" -eq 0 ]; then
    cat > "$WT/$SETTINGS_JSON" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/claude-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'LOOP_GUARD=${LOOP_GUARD:-shadow} HARNESS_CHANGE=$CHANGE PI_ROLE=worker CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/loop-guard-hook.mjs claude'", "timeout": 30 }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'LOOP_GUARD=${LOOP_GUARD:-shadow} HARNESS_CHANGE=$CHANGE PI_ROLE=worker CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/loop-guard-hook.mjs claude'", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/claude-completion-gate.mjs'", "timeout": 30 }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "/bin/sh -c 'CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE node /repo/scripts/claude-usage-statusline.mjs'"
  }
}
EOF
  fi

  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -e PI_ROLE=worker
    -v "$HARNESS_CLAUDE_CREDENTIALS:/home/node/.claude/.credentials.json"
    -e "CLAUDE_CODE_EFFORT_LEVEL=${EFFORT:-}"
    -v "$HARNESS_CLAUDE_ACCOUNT:/home/node/.claude.json")
  # pre-answer Claude's startup questions (folder trust, onboarding, bypass-mode warning) - scripts/preaccept-startup.mjs
  if [ "$DRY" -eq 0 ]; then node "$REPO/scripts/preaccept-startup.mjs" claude "$HARNESS_CLAUDE_ACCOUNT" "/repo/$WT_REL"; fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] && args+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
  [ -n "$HARNESS_CLAUDE_MODEL" ] && args+=(-e "ANTHROPIC_MODEL=$HARNESS_CLAUDE_MODEL")
  # Compact at HARNESS_COMPACT_AT instead of Claude Code's default (~967K on 1M-context
  # models). Env var = documented highest-precedence setting for scripts/containers.
  harness_compact_enabled && args+=(-e "CLAUDE_CODE_AUTO_COMPACT_WINDOW=$HARNESS_COMPACT_AT")
  [ "$SESSION_LOG_OUT" = "1" ] && args+=(-v "$REPO/$WT_REL/$CLAUDE_PROJECTS_REL:/home/node/.claude/projects")
  args+=("$IMAGE"
    --settings "/repo/$WT_REL/$SETTINGS_JSON"
    --dangerously-skip-permissions)
  # A trailing positional message seeds the first turn without exiting - the
  # SAME mechanism as pi's own `claude "query"` (confirmed: cli-reference's own
  # table lists this as "Start interactive session with initial prompt",
  # distinct from -p/--print's one-shot headless mode).
  args+=("$SEED")

elif [ "$BACKEND" = "codex" ]; then
  # Same translation layer idea as the other two backends
  # (scripts/codex-guard-adapter.mjs) - CONTRACT_GUARDS/CONTRACT_EVIDENCE
  # absolute, REPO_ROOT = the WORKTREE root, same reasoning throughout.
  #
  # UNLIKE claude: Codex has no --settings-style flag, so hooks.json IS a
  # single-file bind mount onto ~/.codex/hooks.json (the USER-level path,
  # not <repo>/.codex/hooks.json - project-level hooks there require
  # explicit interactive trust via Codex's own /hooks command before they
  # load at all, which a freshly-launched unattended container has no one
  # present to grant - see scripts/codex-guard-adapter.mjs's header).
  #
  # --dangerously-bypass-approvals-and-sandbox is used for the same reason
  # as claude's --dangerously-skip-permissions: Codex's own docs state hooks
  # and the approval/sandbox layer are separate systems, so this should not
  # disable the hook - but that is an INFERENCE from two separately
  # confirmed facts, not one direct statement the way claude's equivalent
  # was. ALSO FLAGGED, more seriously: github.com/openai/codex#27833 is a
  # real, OPEN bug where a hook's deny decision for apply_patch (file
  # edits/writes) is not always enforced - reported platform-dependent,
  # unconfirmed on Linux either way. This backend's file_boundary guard may
  # not actually block even when this adapter correctly says deny - the
  # first real launch MUST verify against the filesystem and
  # .contract-evidence.jsonl, not just trust this adapter's own JSON output.
  # Stop hook (2026-10-12): codex-completion-gate.mjs ports pi's own
  # completion-gate logic onto Codex's per-turn Stop hook, same reasoning as
  # claude-completion-gate.mjs - the PreToolUse adapter above structurally
  # cannot see "claimed done, tests not green" by itself. FAILS OPEN on its
  # own errors/unrecognised rollout schema (see the script's own header).
  HOOKS_JSON="$SESSION_REL/codex-hooks.json"
  if [ "$DRY" -eq 0 ]; then
    cat > "$WT/$HOOKS_JSON" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/codex-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'LOOP_GUARD=${LOOP_GUARD:-shadow} HARNESS_CHANGE=$CHANGE PI_ROLE=worker CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/loop-guard-hook.mjs codex'", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/codex-completion-gate.mjs'", "timeout": 30 }
        ]
      }
    ]
  }
}
EOF
  fi

  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -v "$REPO/$WT_REL/$HOOKS_JSON:/home/node/.codex/hooks.json"
    -v "$HARNESS_CODEX_AUTH:/home/node/.codex/auth.json"
    -e PI_ROLE=worker)
  [ -n "${OPENAI_API_KEY:-}" ] && args+=(-e "OPENAI_API_KEY=$OPENAI_API_KEY")
  # pre-trust this workdir in config.toml (creates the file) - scripts/preaccept-startup.mjs
  if [ "$DRY" -eq 0 ]; then node "$REPO/scripts/preaccept-startup.mjs" codex "$HARNESS_CODEX_CONFIG_TOML" "/repo/$WT_REL"; fi
  [ -f "$HARNESS_CODEX_CONFIG_TOML" ] && args+=(-v "$HARNESS_CODEX_CONFIG_TOML:/home/node/.codex/config.toml")
  [ "$SESSION_LOG_OUT" = "1" ] && args+=(-v "$REPO/$WT_REL/$CODEX_SESSIONS_REL:/home/node/.codex/sessions")
  args+=("$IMAGE"
    --dangerously-bypass-approvals-and-sandbox
    --no-daemon)
  # 2026-10-18: Codex runs a user-level hook only after its exact definition was
  # trusted via /hooks - impossible unattended, so the guard hook was silently
  # skipped. This flag runs enabled hooks without persisted trust (per invocation).
  # CODEX_BYPASS_HOOK_TRUST=0 drops it if an older codex rejects the flag.
  [ "${CODEX_BYPASS_HOOK_TRUST:-1}" = "1" ] && args+=(--dangerously-bypass-hook-trust)
  # --no-daemon: MEASURED (2026-10-10, real launch) - codex tries to start a
  # background "app-server" process and track its PID via `ps`, which isn't
  # installed in this minimal image (procps is not part of pi-contracts:latest).
  # Fails startup entirely with "failed to invoke ps for pid-managed app
  # server". Codex's own error names --no-daemon as the fix. This container is
  # a single foreground session anyway (--rm, no resume/background-session use
  # from this launcher), so skipping the daemon is the right fit, not adding a
  # procps dependency to support a feature nothing here uses.
  # A trailing positional message seeds the first turn without exiting -
  # same convention as pi/claude (confirmed: `codex "prompt"` starts an
  # interactive session with that as the first message; `codex exec` is the
  # separate, one-shot headless subcommand this deliberately avoids).
  # routed model (scripts/route-worker.mjs); unset = codex's own default / config.toml
  [ -n "${CODEX_MODEL:-}" ] && args+=(--model "$CODEX_MODEL")
  # Compact at HARNESS_COMPACT_AT. A -c override, not config.toml: that file is the
  # user's own shared login config (~/.harness/config/codex) and stays untouched.
  harness_compact_enabled && args+=(-c "model_auto_compact_token_limit=$HARNESS_COMPACT_AT")
  [ -n "$EFFORT" ] && args+=(-c "model_reasoning_effort=\"$EFFORT\"")
  args+=("$SEED")

elif [ "$BACKEND" = "opencode" ]; then
  # ARCHITECTURALLY DIFFERENT from the other three: OpenCode's hook system is
  # an IN-PROCESS plugin (a JS module the opencode binary itself loads,
  # auto-discovered from .opencode/plugins/ in the project dir), not an
  # external process reading stdin/stdout JSON. So there is NO bind mount
  # for the guard wiring at all - the generated plugin file is written
  # straight into the worktree's own .opencode/plugins/, which is already on
  # the /repo mount. See scripts/opencode-guard-adapter.mjs's header for the
  # full verified-vs-assumed breakdown (notably: which tool_name/field-name
  # shapes are confirmed vs inferred - OpenCode's docs don't dump a full
  # schema the way Claude Code's do).
  #
  # No custom opencode.json is generated (unlike antigravity's permissions
  # baseline) - deliberately: --auto below already does "auto-approve
  # anything not explicitly denied," which is the same thing that baseline
  # exists to simulate for antigravity, and OpenCode's exact permission-JSON
  # schema (nested per-tool vs a flat pattern map) was NOT confirmed clearly
  # enough during research to risk shipping a guess that could fail config
  # parsing outright - a harder failure than a few extra prompts would be.
  PLUGIN_REL=".opencode/plugins/harness-guard.mjs"
  if [ "$DRY" -eq 0 ]; then
    mkdir -p "$WT/.opencode/plugins"
    cat > "$WT/$PLUGIN_REL" <<EOF
import { readFileSync } from "node:fs";
import { makeGuardHook } from "/repo/scripts/opencode-guard-adapter.mjs";

export const HarnessGuard = async () => {
  const { evaluateDuring, newCounters } = await import("/opt/contracts/extensions/checks.mjs");
  const guards = JSON.parse(readFileSync("/repo/$WT_REL/$GUARDS", "utf8")).guards;
  const hook = makeGuardHook({ guards, repoRoot: "/repo/$WT_REL", evaluateDuring, newCounters });
  return { "tool.execute.before": hook };
};
EOF
  fi

  # Stream timeouts (2026-10-20): an opencode-go request hung 23:14-07:48 on
  # 2026-10-19 with the pane showing "working". chunkTimeout aborts a stream that
  # sends nothing for 5 min (reasoning models still stream, so a healthy request
  # is not cut); headerTimeout bounds waiting for the first byte. Merged into
  # opencode's own config; override the whole JSON with OPENCODE_CONFIG_CONTENT.
  OC_TIMEOUTS='{"provider":{"opencode-go":{"options":{"chunkTimeout":300000,"headerTimeout":300000}},"opencode":{"options":{"chunkTimeout":300000,"headerTimeout":300000}}}}'
  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -e PI_ROLE=worker
    -e OPENCODE_CONFIG_CONTENT="${OPENCODE_CONFIG_CONTENT:-$OC_TIMEOUTS}")
  # OPENCODE_CONFIG_DIR: optional, mirrors pi's own PI_CONFIG_DIR convention -
  # auth.json (~/.local/share/opencode/auth.json) is written by opencode's own
  # `opencode auth login` / /connect flow, which this unattended container has
  # no one present to run interactively. Directory-mounted, not file-mounted -
  # same EBUSY lesson the antigravity backend already paid for once (a token
  # refresh rewriting auth.json atomically would hit the identical failure a
  # single-file mount did there). When set, this mount ALREADY covers session
  # history/logs too (same directory). 2026-10-11: when UNSET, that history
  # used to die with the container every launch - SESSION_LOG_OUT now mounts a
  # fresh per-launch dir at the same container path for that case, so session
  # history persists either way; only auth-sharing across launches still needs
  # OPENCODE_CONFIG_DIR explicitly set.
  OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-}"
  if [ -n "$OPENCODE_CONFIG_DIR" ]; then
    if [ ! -f "$OPENCODE_CONFIG_DIR/auth.json" ]; then
      echo "REFUSING: OPENCODE_CONFIG_DIR is set but '$OPENCODE_CONFIG_DIR/auth.json' does not exist." >&2
      exit 1
    fi
    args+=(-v "$OPENCODE_CONFIG_DIR:/home/node/.local/share/opencode")
  elif [ "$SESSION_LOG_OUT" = "1" ]; then
    args+=(-v "$REPO/$WT_REL/$OPENCODE_HOME_REL:/home/node/.local/share/opencode")
  fi
  # Model: the router's pick (HARNESS_ROUTED_MODEL) or OPENCODE_MODEL from .pi/worker.env.
  # Checked against `opencode models` first (cached a day in .pi-session/routing/): an id
  # opencode does not know falls back to opencode's own default instead of failing the launch.
  if [ -n "${OPENCODE_MODEL:-}" ] && [ "$DRY" -eq 0 ]; then
    OC_CACHE="$REPO/.pi-session/routing/opencode-models.txt"
    if [ ! -s "$OC_CACHE" ] || [ -n "$(find "$OC_CACHE" -mmin +1440 2>/dev/null)" ]; then
      mkdir -p "$(dirname "$OC_CACHE")"
      oc_list=(docker run --rm)
      [ -n "$OPENCODE_CONFIG_DIR" ] && oc_list+=(-v "$OPENCODE_CONFIG_DIR:/home/node/.local/share/opencode")
      if "${oc_list[@]}" "$IMAGE" models > "$OC_CACHE.tmp" 2>/dev/null && [ -s "$OC_CACHE.tmp" ]; then mv "$OC_CACHE.tmp" "$OC_CACHE"; else rm -f "$OC_CACHE.tmp"; fi
    fi
    if [ -s "$OC_CACHE" ] && ! awk -v m="$OPENCODE_MODEL" '{ for (i = 1; i <= NF; i++) if ($i == m) f = 1 } END { exit !f }' "$OC_CACHE"; then
      echo "WARN: opencode does not list '$OPENCODE_MODEL' (see $OC_CACHE) - using opencode's default model instead" >&2
      OPENCODE_MODEL=""
    fi
  fi
  args+=("$IMAGE")
  [ -n "${OPENCODE_MODEL:-}" ] && args+=(--model "$OPENCODE_MODEL")
  args+=(--auto)
  # --prompt, not a trailing positional: confirmed (opencode.ai/docs/cli/,
  # fetched directly) as the flag that seeds the FULL interactive TUI with an
  # initial message - `opencode run "msg"` looked similar but is the
  # separate, one-shot headless subcommand this deliberately avoids (same
  # distinction as codex exec / claude -p).
  args+=(--prompt "$SEED")
fi

echo "herdr     : HERDR_AGENT=$HERDR_AGENT exported (no-op unless a Herdr pane is watching this process)"
echo "change    : $CHANGE  ($BRANCH)"
echo "backend   : $BACKEND"
echo "worktree  : $WT   (mounted at /repo, cwd /repo/$WT_REL)"
echo "container : $NAME"
echo "session   : $WT/$SESSION_REL/   (check: grep -c no_guards_loaded must be 0)"
if [ "$BACKEND" = "pi" ]; then
  if [ -n "$MODEL" ]; then
    echo "model     : $MODEL   (from WORKER_MODEL - sticky across launches in this shell until changed/unset)"
  else
    echo "model     : pi's default provider (WORKER_MODEL unset)"
  fi
  [ -n "${PI_EXTRA_TOOLS:-}" ] && echo "tools     : $PI_EXTRA_TOOLS (PI_EXTRA_TOOLS, e.g. +codemode)"
  echo "pi config : $PI_CONFIG_DIR/.pi/agent/auth.json -> /home/node/.pi/agent/auth.json (auth only; baked-in default under ~/.harness/config unless PI_CONFIG_DIR was set explicitly)"
  if [ -n "$MODELS_JSON" ]; then
    echo "models    : $MODELS_JSON -> /home/node/.pi/agent/models.json"
  else
    echo "models    : not mounted (MODELS_JSON unset) - image's baked-in empty registry will be used, local/<id> WILL fail"
  fi
  if [ "$CACHE_STATS_OUT" = "1" ]; then
    echo "cache-opt : $WT/$CACHE_STATS_REL -> /home/node/.pi/agent/pi-cache-optimizer-stats.d (persisted; CACHE_STATS_OUT=0 to disable)"
  else
    echo "cache-opt : not mounted (CACHE_STATS_OUT=0) - pi-cache-optimizer shards will die with the container"
  fi
elif [ "$BACKEND" = "antigravity" ]; then
  echo "hook      : $HOOKS_DIR/ -> /home/node/.gemini/config/   (hooks.json; dir-mounted, not file-mounted - EBUSY otherwise)"
  echo "            PreToolUse -> scripts/antigravity-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "            Stop -> scripts/antigravity-completion-gate.mjs (completion-gate parity with pi; fails OPEN on its own errors; WEAKEST-confirmed transcript schema of the three backends - see the script's own header)"
  echo "perms     : $PERMS_DIR/ -> /home/node/.gemini/antigravity-cli/   (settings.json; dir-mounted, same reason)"
  echo "            statusLine -> scripts/antigravity-usage-statusline.mjs (logs quota.* to evidence.jsonl; integrator antigravity launches do NOT have this wired yet - no settings.json mount there)"
  echo "seed      : -i \"\$SEED\" (agy's -i/--prompt-interactive) - best-effort, confirmed only via"
  echo "            third-party docs, not agy --help directly. If the session doesn't open with"
  echo "            the orientation message below, agy's real flag syntax differs - paste it instead:"
  echo "  $SEED"
elif [ "$BACKEND" = "claude" ]; then
  echo "settings  : $SETTINGS_JSON -> --settings flag (no bind mount at all - see Dockerfile.claude)"
  echo "            PreToolUse -> scripts/claude-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "            Stop -> scripts/claude-completion-gate.mjs (completion-gate parity with pi; fails OPEN on its own errors)"
  echo "            statusLine -> scripts/claude-usage-statusline.mjs (logs rate_limits.five_hour/seven_day to evidence.jsonl; subscription-only, absent on API-key auth)"
  echo "mode      : --dangerously-skip-permissions (hooks confirmed to still fire under it)"
  echo "seed      : trailing positional arg (claude \"query\") - same mechanism as pi's own seed"
  echo "auth      : $HARNESS_CLAUDE_CREDENTIALS -> /home/node/.claude/.credentials.json (baked-in, persists across launches)"
  echo "            $HARNESS_CLAUDE_ACCOUNT -> /home/node/.claude.json"
  if [ -n "$HARNESS_CLAUDE_MODEL" ]; then
    echo "model     : $HARNESS_CLAUDE_MODEL (from ~/.harness/config/claude/model.txt)"
  else
    echo "model     : claude's own default (no ~/.harness/config/claude/model.txt)"
  fi
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $WT/$CLAUDE_PROJECTS_REL -> /home/node/.claude/projects (persisted; SESSION_LOG_OUT=0 to disable)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - claude's own session transcript dies with the container"
  fi
elif [ "$BACKEND" = "codex" ]; then
  echo "hook      : $HOOKS_JSON -> /home/node/.codex/hooks.json   (single-file mount - see Dockerfile.codex)"
  echo "            PreToolUse -> scripts/codex-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "            Stop -> scripts/codex-completion-gate.mjs (completion-gate parity with pi; fails OPEN on its own errors)"
  echo "mode      : --dangerously-bypass-approvals-and-sandbox (hooks INFERRED, not directly confirmed,"
  echo "            to still fire under it - see codex-guard-adapter.mjs header)"
  echo "seed      : trailing positional arg (codex \"query\") - same mechanism as pi/claude"
  echo "auth      : $HARNESS_CODEX_AUTH -> /home/node/.codex/auth.json (baked-in, persists across launches)"
  if [ -f "$HARNESS_CODEX_CONFIG_TOML" ]; then
    echo "config    : $HARNESS_CODEX_CONFIG_TOML -> /home/node/.codex/config.toml"
  else
    echo "config    : not mounted (no ~/.harness/config/codex/config.toml) - codex's own default model/config applies"
  fi
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $WT/$CODEX_SESSIONS_REL -> /home/node/.codex/sessions (persisted; path CONFIRMED via web"
    echo "            search only, not against a real codex container - verify on first real launch)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - codex's own rollout logs die with the container"
  fi
  echo ""
  echo "WARNING: github.com/openai/codex#27833 (OPEN) - a hook's deny for apply_patch is not always"
  echo "         enforced on some platforms. VERIFY against the filesystem + evidence.jsonl, not just"
  echo "         this adapter's own JSON output, before trusting file_boundary on this backend."
else
  echo "plugin    : $PLUGIN_REL   (in-process hook, no bind mount at all - see Dockerfile.opencode)"
  echo "            tool.execute.before -> scripts/opencode-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "mode      : --auto (auto-approve anything not explicitly denied; hooks INFERRED, not directly"
  echo "            confirmed, to fire regardless - see opencode-guard-adapter.mjs header)"
  echo "seed      : --prompt flag (opencode's own initial-message mechanism, not a trailing positional)"
  if [ -n "$OPENCODE_CONFIG_DIR" ]; then
    echo "auth      : $OPENCODE_CONFIG_DIR -> /home/node/.local/share/opencode (dir-mounted; also covers session history)"
  else
    echo "auth      : not mounted (OPENCODE_CONFIG_DIR unset) - opencode will have no stored credentials;"
    echo "            run 'opencode auth login' once somewhere and point OPENCODE_CONFIG_DIR at that dir"
    if [ "$SESSION_LOG_OUT" = "1" ]; then
      echo "sessions  : $WT/$OPENCODE_HOME_REL -> /home/node/.local/share/opencode (persisted anyway; SESSION_LOG_OUT=0 to disable)"
    else
      echo "sessions  : not mounted (SESSION_LOG_OUT=0) - opencode's own session history dies with the container"
    fi
  fi
  echo ""
  echo "NOTE: this backend's field-name mappings (edit's oldString/newString, write's filePath) were"
  echo "      cross-checked against real GitHub issue reports, not a full official schema dump - verify"
  echo "      the first real launch actually blocks an out-of-bounds edit, not just that it compiles."
fi
if [ "$DRY" -eq 1 ]; then
  echo "(dry-run: worktree not created)"
  printf 'DRY RUN — would exec:\n'; printf '  %q' "${args[@]}"; printf '\n'
  exit 0
fi
exec "${args[@]}"
