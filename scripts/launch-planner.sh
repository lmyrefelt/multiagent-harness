#!/usr/bin/env bash
# launch-planner.sh — launch a guarded PI planner (docs-only) IN ITS OWN worktree.
#
# The planner's twin of launch-worker.sh. It fences a pi planner to the spec
# surface and blocks repo-global git ops, AND — like the worker — runs in its own
# git worktree so it never fights the integrator or the workers over a shared HEAD.
# A non-pi planner (Gemini/Astra/Codex) is fenced by the host-side pre-commit
# (check-boundary.mjs planning/* lane); it should still work in its own checkout.
#
#   scripts/launch-planner.sh [name] [pi|antigravity|claude|codex|opencode] [--dry-run]   (agy = antigravity)
#   scripts/launch-planner.sh --name=<name> <backend>   (explicit name form)
#
# Examples:
#   scripts/launch-planner.sh            -> branch planning/pi,    worktree .worktrees/harness-planner-pi
#   scripts/launch-planner.sh astra      -> branch planning/astra
#   scripts/launch-planner.sh astra claude
#
# BACKENDS
#   pi      implemented (default). pi's own --extension hook, in-process.
#   claude  implemented. Reuses harness-claude:latest (the SAME image launch-worker.sh
#           builds - the Dockerfile is role-agnostic, just "this CLI + hooks wiring
#           pointed at whatever guards.json is mounted") and scripts/claude-guard-
#           adapter.mjs unmodified - the planner's compiled guards.json is the SAME
#           shape (file_boundary + command_forbidden) the adapter already translates
#           for the worker, just docs-only params. REPO_ROOT is the planner's OWN
#           worktree root (like the worker, unlike the integrator, which shares /repo
#           directly) - a planner's file_boundary (docs/changes/**, docs/decisions/**)
#           is matched relative to its own worktree.
#   codex   implemented. Same reasoning, harness-codex:latest + scripts/codex-guard-
#           adapter.mjs, --dangerously-bypass-approvals-and-sandbox --no-daemon (see
#           docs/changes/CODEX-WORKER.md for what's confirmed vs not about this CLI).
#   antigravity   implemented (agy is an alias). Ported from launch-worker.sh's
#           antigravity branch: harness-agy:latest + scripts/antigravity-guard-
#           adapter.mjs (PreToolUse), permissions baseline + usage statusLine in a
#           dir-mounted settings.json. NO Stop/completion gate - same as this script's
#           claude/codex planners (that gate checks implementation/test evidence, which
#           a docs-only planner turn never has). REPO_ROOT = own worktree, like the worker.
#   opencode      implemented (2026-10-16). Ported from launch-worker.sh's opencode
#           branch: harness-opencode:latest, the in-process guard plugin in
#           the worktree's .opencode/plugins/ (scripts/opencode-guard-adapter.mjs,
#           same guards.json), --auto, seed via --prompt. Login: OPENCODE_CONFIG_DIR
#           (dir with auth.json) if set, else a per-launch opencode-home.
#   Any other backend word (gemini, copilot) is REFUSED instead of silently
#   becoming the planner's NAME - that is how `launch-planner.sh antigravity` used to
#   start a pi planner called "antigravity".
#
# Env overrides (all optional):
#   PLANNER_MODEL=local/<id>    planning may want a bigger model
#   LOCAL_LLM_BASE_URL=...        default http://host.docker.internal:8001/v1
#   IMAGE / EXTENSION / REPO
#   PI_CONFIG_DIR=<path>         if set, bind-mounts <path>/.pi/agent/auth.json onto
#                                /home/node/.pi/agent/auth.json (shares credentials across
#                                launches/roles). Deliberately NOT a whole-.pi mount:
#                                settings.json (and ITS packages array - what a role's
#                                image actually installed, e.g. pi-subagents on this
#                                planner/integrator images but not the worker's) and
#                                models.json stay image-local, baked in at build time.
#                                Sharing the whole directory would let this planner's
#                                pi-subagents registration leak into a worker container
#                                that never installed the package - mounting only
#                                auth.json makes that impossible by construction.
#   WORKTREES_DIR=<path>          default <repo>/.worktrees  (STABLE path; never /workspace)
#   TASK="..."                   appended to the orientation seed as the session's first
#                                message (see SEED below) - skips retyping the reminder
#                                every launch; omit to get just the reminder and type the
#                                task yourself once the interactive session opens.
#   HERDR_AGENT=pi               default. Exported before the docker run so a Herdr
#                                pane watching this script's own (host-side) process
#                                tree can tell it's pi, even though the visible
#                                command is `docker run`, not `pi` - Herdr cannot look
#                                inside the container to detect that itself. No-op,
#                                harmless, if Herdr isn't running this pane at all.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .pi/worker.env ]; then set -a; . ./.pi/worker.env; set +a; fi

NAME_IN=""
BACKEND="pi"
DRY=0
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    pi|antigravity|agy|claude|codex|opencode) BACKEND="$a" ;;
    gemini|copilot)
      echo "REFUSING: backend '$a' is not wired into launch-planner.sh (supported: pi, antigravity|agy, claude, codex, opencode)." >&2
      exit 2 ;;
    --name=*) NAME_IN="${a#--name=}" ;;
    --*) echo "unknown flag: $a" >&2; exit 1 ;;
    *) NAME_IN="$a" ;;
  esac
done
[ "$BACKEND" = "agy" ] && BACKEND="antigravity"
# No name given -> name after the backend, so e.g. an antigravity planner gets
# planning/antigravity instead of colliding with the pi planner on planning/pi.
NAME_IN="${NAME_IN:-$BACKEND}"
LABEL="$(printf '%s' "$NAME_IN" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
case "$BACKEND" in
  pi)     IMAGE="${IMAGE:-pi-planner:latest}" ;;
  antigravity) IMAGE="${IMAGE:-harness-agy:latest}" ;;
  opencode) IMAGE="${IMAGE:-harness-opencode:latest}" ;;
  claude) IMAGE="${IMAGE:-harness-claude:latest}" ;;
  codex)  IMAGE="${IMAGE:-harness-codex:latest}" ;;
esac
EXTENSION="${EXTENSION:-/opt/contracts/extensions/contract-guard.ts}"
# Backend-aware default - see launch-worker.sh's own comment for why this
# matters to Herdr. "claude"/"codex" are unverified Herdr manifest names,
# same caveat as the worker backend - override with HERDR_AGENT= if wrong.
case "$BACKEND" in
  pi)     HERDR_AGENT_DEFAULT="pi" ;;
  antigravity) HERDR_AGENT_DEFAULT="antigravity-cli" ;;
  opencode) HERDR_AGENT_DEFAULT="opencode" ;;
  claude) HERDR_AGENT_DEFAULT="claude" ;;
  codex)  HERDR_AGENT_DEFAULT="codex" ;;
esac
export HERDR_AGENT="${HERDR_AGENT:-$HERDR_AGENT_DEFAULT}"  # see header; inherited by `exec docker run` below
LLM="${LOCAL_LLM_BASE_URL:-http://host.docker.internal:8001/v1}"
MODEL="${PLANNER_MODEL:-}"
WORKTREES_DIR="${WORKTREES_DIR:-$REPO/.worktrees}"
# Baked-in, zero-env-var auth/model persistence under ~/.harness/config/ -
# see scripts/harness-config-lib.sh's own header for the full rationale.
# shellcheck source=scripts/harness-config-lib.sh
source "$REPO/scripts/harness-config-lib.sh"

# Only reachable now for an EXPLICIT PI_CONFIG_DIR (the lib leaves it alone
# when the caller set it); harness-config-lib.sh already pre-creates the
# default-case file, so this REFUSING check remains a real misconfiguration
# signal, not something papered over.
if [ "$BACKEND" = "pi" ] && [ -n "$PI_CONFIG_DIR" ] && [ ! -f "$PI_CONFIG_DIR/.pi/agent/auth.json" ]; then
  # Checked explicitly: docker silently CREATES an empty FILE for a missing bind-mount
  # source, which would mount an empty auth.json rather than failing loudly.
  echo "REFUSING: PI_CONFIG_DIR is set but '$PI_CONFIG_DIR/.pi/agent/auth.json' does not exist." >&2
  exit 1
fi

# The image bakes in /home/node/.pi/agent/models.json with an empty `models: []` -
# it is NOT regenerated per run. A real local model is only resolvable if a
# freshly PROBED models.json (node /opt/contracts/make-models-json.mjs
# --base-url ...) is mounted over it - baseUrl there is NOT env-interpolated,
# so LOCAL_LLM_BASE_URL alone never fixes a stale/empty models.json.
# pi backend only - claude/codex have their own, entirely separate auth/model
# mechanisms (ANTHROPIC_API_KEY / OPENAI_API_KEY passthrough, below).
MODELS_JSON=""
if [ "$BACKEND" = "pi" ]; then
  MODELS_JSON="${MODELS_JSON:-}"
  # Auto-detect so no export is needed every run - same convention as
  # launch-worker.sh: fall back to a freshly-probed file at the repo root if
  # one exists there and nothing was explicitly passed.
  if [ -z "$MODELS_JSON" ] && [ -f "$REPO/models.local.json" ]; then
    MODELS_JSON="$REPO/models.local.json"
  fi
  if [ -n "$MODELS_JSON" ] && [ ! -f "$MODELS_JSON" ]; then
    echo "REFUSING: MODELS_JSON is set but '$MODELS_JSON' does not exist." >&2
    exit 1
  fi

  # No model chosen but a probed registry IS mounted - offer to pick one
  # interactively instead of silently falling through to pi's default provider.
  # Only prompts with a real TTY attached; non-interactive runs are unaffected.
  if [ -z "$MODEL" ] && [ -n "$MODELS_JSON" ] && [ -t 0 ] && [ -t 1 ]; then
    if ! command -v jq >/dev/null 2>&1; then
      echo "WARN: MODELS_JSON is set but jq is not installed - cannot list models for selection. Set PLANNER_MODEL explicitly." >&2
    else
      AVAILABLE_MODELS=()
      while IFS= read -r m; do [ -n "$m" ] && AVAILABLE_MODELS+=("$m"); done \
        < <(jq -r '.providers.local.models[]?.id // empty' "$MODELS_JSON" 2>/dev/null)
      if [ "${#AVAILABLE_MODELS[@]}" -gt 0 ]; then
        echo ""
        echo "PLANNER_MODEL is unset. $MODELS_JSON declares ${#AVAILABLE_MODELS[@]} local model(s):"
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
  bash "$REPO/scripts/ensure-image.sh" planner "$BACKEND" "$IMAGE" || exit 1
  HARNESS_IMAGES_ENSURED=1
fi

# --- image freshness (fails BEFORE touching any git state) --------------------
if [ "$BACKEND" = "pi" ]; then
  # Same check as launch-worker.sh - see its comment for the full rationale.
  # $IMAGE is built in the separate pi-contracts-research repo, so this script
  # cannot tell on its own whether it is missing or stale.
  if [ -n "$HARNESS_IMAGES_ENSURED" ]; then
    :  # ensure-image.sh just built/verified it
  elif [ -n "${PI_CONTRACTS_DIR:-}" ] && [ -d "$PI_CONTRACTS_DIR" ]; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && DOCKERFILE=Dockerfile.pi-planner IMAGE=$IMAGE ./build.sh)" >&2
      exit 1
    fi
    PCD="$PI_CONTRACTS_DIR"
    CURRENT_FP=$(
      { [ -f "$PCD/Dockerfile.pi-planner" ] && cat "$PCD/Dockerfile.pi-planner"
        [ -f "$PCD/Dockerfile.pi-contracts" ] && cat "$PCD/Dockerfile.pi-contracts"
        find "$PCD/prototype" -type f 2>/dev/null | sort | while IFS= read -r f; do cat "$f"; done
        [ -f "$PCD/models.json" ] && cat "$PCD/models.json"
        [ -f "$PCD/settings.defaults.json" ] && cat "$PCD/settings.defaults.json"
      } | cksum | awk '{print $1}'
    )
    RECORDED_FP=$(awk -v img="$IMAGE" '$2==img{print $1}' "$PCD/.pi-contracts-build.fingerprint" 2>/dev/null)
    if [ "$CURRENT_FP" != "$RECORDED_FP" ]; then
      echo "REFUSING: '$IMAGE' is stale - its build inputs changed since the last build. Rebuild:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && DOCKERFILE=Dockerfile.pi-planner IMAGE=$IMAGE ./build.sh)" >&2
      exit 1
    fi
  else
    echo "WARN: PI_CONTRACTS_DIR unset or not found - skipping the image-staleness check (a stale '$IMAGE' would go unnoticed). Set PI_CONTRACTS_DIR=/path/to/pi-contracts-research in .pi/worker.env to enable it." >&2
  fi
else
  # claude/codex: same bare existence check launch-worker.sh uses for these
  # backends - no fingerprint mechanism (the Dockerfiles live in
  # the host project, not pi-contracts-research).
  DOCKERFILE="Dockerfile.claude"
  [ "$BACKEND" = "codex" ] && DOCKERFILE="Dockerfile.codex"
  [ "$BACKEND" = "antigravity" ] && DOCKERFILE="Dockerfile.agy"
  [ "$BACKEND" = "opencode" ] && DOCKERFILE="docker/Dockerfile.opencode"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
    echo "  docker build -f $DOCKERFILE -t $IMAGE ." >&2
    exit 1
  fi
fi

BRANCH="planning/${LABEL}"
NAME="harness-planner-${LABEL}"

# Auto-suffix if that name's container already exists (a session that
# wasn't shut down cleanly - --rm only removes a container that actually
# EXITED). Resolves NAME itself, not just --name below, since NAME also
# drives the worktree path and session dir. Never removes the existing
# container; it may still be in active use.
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
case "$WT" in
  "$REPO"/*) ;;
  *) echo "REFUSING: WORKTREES_DIR must be under the repo ($REPO) so the container mount covers .git." >&2; exit 1 ;;
esac
WT_REL="${WT#"$REPO"/}"
GUARDS=".contract-guards.json"
SESSION_REL=".pi-session/${NAME}"
EVIDENCE="$SESSION_REL/evidence.jsonl"
# See launch-worker.sh's env-override header for the full rationale - same
# OUTPUT-only directory, same mount, same reason: pi-cache-optimizer is baked
# into pi-contracts:latest (which this role's image is built FROM), so its
# shards exist here too and die with the --rm container unless persisted.
CACHE_STATS_OUT="${CACHE_STATS_OUT:-1}"
CACHE_STATS_REL="$SESSION_REL/cache-optimizer-stats.d"
# See launch-worker.sh's env-override header for the full rationale (claude/codex
# session logs otherwise die with the --rm container; antigravity persists its
# sessions for free via the gemini-antigravity-cli directory mount below).
SESSION_LOG_OUT="${SESSION_LOG_OUT:-1}"
CLAUDE_PROJECTS_REL="$SESSION_REL/claude-projects"
CODEX_SESSIONS_REL="$SESSION_REL/codex-sessions"
OPENCODE_HOME_REL="$SESSION_REL/opencode-home"

if [ "$DRY" -eq 0 ]; then
  mkdir -p "$WORKTREES_DIR"
  # The planner gets its OWN worktree on its planning/* branch — never the main
  # checkout. Branch setup is the launch script's job, not the model's.
  if [ -d "$WT" ]; then
    echo "reusing worktree $WT"
  elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    if git worktree list --porcelain | grep -qx "branch refs/heads/$BRANCH"; then
      inwt=$(git worktree list --porcelain | awk -v b="branch refs/heads/$BRANCH" '$0==b{print p} /^worktree /{p=$2}')
      echo "REFUSING: $BRANCH is already checked out at $inwt." >&2
      exit 1
    fi
    git worktree add --lock --reason "HARNESS planner worktree - cross-environment absolute path, do not prune" "$WT" "$BRANCH" >/dev/null
    echo "worktree $WT -> $BRANCH"
  else
    git worktree add --lock --reason "HARNESS planner worktree - cross-environment absolute path, do not prune" -b "$BRANCH" "$WT" main >/dev/null
    echo "worktree $WT -> new $BRANCH (from main)"
  fi
  # CRITICAL: rewrite the worktree's absolute gitdir to a RELATIVE path, or git is
  # unusable in the container (the recorded path is the Mac host's /Users/...). See
  # launch-worker.sh for the full rationale.
  if [ -f "$WT/.git" ]; then
    up=$(printf '%s\n' "$WT_REL" | awk -F/ '{s="";for(i=1;i<=NF;i++)s=s"../";print s}')
    tail=$(sed -E 's#^gitdir: .*/(\.git/worktrees/.*)$#\1#' "$WT/.git")
    printf 'gitdir: %s%s\n' "$up" "$tail" > "$WT/.git"
  fi
  ( cd "$WT"
    # Sync to main on EVERY launch, not just at branch creation. Without this a
    # reused planner branch drifts further behind main every session — it did,
    # unnoticed, until the planner ended up specifying a change (CHANGE-0046)
    # against a 26+-commit-stale view of main and collided with a change that
    # had been allocated the same id in the meantime. Same pattern as
    # launch-worker.sh's sync-to-base; here the base is always main.
    # scripts/sync-branch-lib.sh: stashes uncommitted edits, aborts stale/failed
    # merges, and lets main win change.yaml conflicts (the integrator's approval
    # rewrites it on main) - see that file's header for the 2026-10-15 incident.
    # shellcheck source=scripts/sync-branch-lib.sh
    source "$REPO/scripts/sync-branch-lib.sh"
    sync_branch_to_base main "$BRANCH" "$WT" 'docs/changes/*/change.yaml' || exit 1
    # Compile the docs-only boundary + repo-global-git block INSIDE the worktree.
    node "$REPO/scripts/compile-planner-guards.mjs" --out "$GUARDS"
    mkdir -p "$SESSION_REL" "$CACHE_STATS_REL" "$CLAUDE_PROJECTS_REL" "$CODEX_SESSIONS_REL" "$OPENCODE_HOME_REL"
  ) || exit 1
fi

[ "$BACKEND" = "pi" ] && [ -z "$MODEL" ] && echo "WARN: PLANNER_MODEL unset — pi will use its default provider (set PLANNER_MODEL=local/<id>)." >&2

# Seed the FIRST turn - see launch-worker.sh for the full rationale. TASK is
# optional; set it to go straight to the actual ask instead of retyping the
# orientation reminder every launch. The pi-subagents sentence is PI-SPECIFIC
# (a pi ecosystem package, not something claude/codex have) - only added for
# that backend, not guessed at for the others.
SEED="Confirm your role (planner) and follow AGENTS.md's dispatch table for it before doing anything else - don't start work until you have."
[ "$BACKEND" = "pi" ] && SEED="$SEED Prefer foreground pi-subagents delegation over background until that routing is verified (see COORDINATION.md)."
# Handoff protocol (scripts/handoff.mjs + herdr-plugin/pipeline.json): the agent
# reports its outcome; the Herdr lifecycle watcher starts the next role.
SEED="$SEED When a plan or a plan revision is ready for the integrator, commit it on your planning branch, write your handoff from the standard template (node /repo/scripts/handoff.mjs new --change CHANGE-NNNN --role planner - fill every section) and, as your LAST action, run: node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role planner --verdict plan-ready --file <that handoff file> --note '<what changed>'. If you need a DECISION the integrator can make (contract or save-format ownership, which change owns what, sequencing, conflicting ADRs, boundaries), write the proposal down and use --verdict needs-decision --file <that proposal> --note '<the decision needed>' - the integrator is started for you. Use --verdict question ONLY for what only the owner can decide (scope, priorities, money, people outside the harness). The integrator is started for you - never ask the owner to relay it."
[ -n "${TASK:-}" ] && SEED="$SEED $TASK"

# Token frugality & anti-overthinking (from upstream llmtrim research; HARNESS_FRUGAL_SEED=0 reverts)
if [ "${HARNESS_FRUGAL_SEED:-1}" != "0" ]; then
  SEED="$SEED Use the fewest tool-use turns: run independent tool calls together in one turn, take all you need from each result, and never repeat a call you've already made. When your reasoning reaches an answer, commit to it immediately (avoid restarting with 'Wait' or 'Actually')."
fi

# Never start pi with a model it cannot resolve ("Model local/<id> not found").
# scripts/resolve-model.mjs asks the local server what it serves when no mounted
# models file declares the model, registers it, or falls back to
# PLANNER_MODEL_FALLBACKS / HARNESS_MODEL_FALLBACKS, or to pi's default provider.
# HARNESS_MODEL_RESOLVE=0 turns this off.
if [ "$BACKEND" = "pi" ] && [ "${HARNESS_MODEL_RESOLVE:-1}" != 0 ] && [ -f "$REPO/scripts/resolve-model.mjs" ]; then
  RESOLVED="$(node "$REPO/scripts/resolve-model.mjs" --role planner --model "$MODEL" --llm "$LLM" \
      --models-json "$MODELS_JSON" --repo "$REPO" \
      --fallbacks "${PLANNER_MODEL_FALLBACKS:-${HARNESS_MODEL_FALLBACKS:-}}" || true)"
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
    -e PI_ROLE=planner
    -e CONTRACT_GUARDS="$GUARDS"
    -e CONTRACT_EVIDENCE="$EVIDENCE"
    -e LOCAL_LLM_BASE_URL="$LLM")
  [ -n "$PI_CONFIG_DIR" ] && args+=(-v "$PI_CONFIG_DIR/.pi/agent/auth.json:/home/node/.pi/agent/auth.json")
  [ -n "$MODELS_JSON" ] && args+=(-v "$MODELS_JSON:/home/node/.pi/agent/models.json")
  # Machine-wide pi keybindings (e.g. a second key for "restore queued messages",
  # since Herdr itself takes alt+up): ~/.harness/config/pi/.pi/agent/keybindings.json
  [ -f "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json" ] && args+=(-v "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json:/home/node/.pi/agent/keybindings.json:ro")
  [ "$CACHE_STATS_OUT" = "1" ] && args+=(-v "$REPO/$WT_REL/$CACHE_STATS_REL:/home/node/.pi/agent/pi-cache-optimizer-stats.d")
  args+=("$IMAGE"
    --session-dir "/repo/$WT_REL/$SESSION_REL")
  [ -n "$MODEL" ] && args+=(--model "$MODEL")
  args+=(--extension "$EXTENSION")
  args+=("$SEED")

elif [ "$BACKEND" = "antigravity" ]; then
  # Ported from launch-worker.sh's antigravity branch - see its comments for
  # the full rationale (absolute CONTRACT_* paths, REPO_ROOT = this worktree,
  # DIRECTORY mounts because agy's write-temp-then-rename() hits EBUSY on a
  # single-file bind mount, permissions baseline is prompts-only and never
  # bypasses the PreToolUse hook). Deliberate difference: NO Stop hook - the
  # completion gate checks implementation/test evidence, which a docs-only
  # planner turn never produces; the claude/codex planners above don't wire
  # it either. handoff.mjs report already refuses an incomplete planner report.
  HOOKS_DIR="$SESSION_REL/gemini-config"
  PERMS_DIR="$SESSION_REL/gemini-antigravity-cli"
  HOOKS_JSON="$HOOKS_DIR/hooks.json"
  PERMS_JSON="$PERMS_DIR/settings.json"
  if [ "$DRY" -eq 0 ]; then
    mkdir -p "$WT/$HOOKS_DIR" "$WT/$PERMS_DIR"
    cat > "$WT/$HOOKS_JSON" <<EOF
{
  "harness-planner-guard": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$WT_REL/$GUARDS CONTRACT_EVIDENCE=/repo/$WT_REL/$EVIDENCE REPO_ROOT=/repo/$WT_REL node /repo/scripts/antigravity-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ]
  }
}
EOF
    if [ ! -f "$REPO/scripts/antigravity-permissions-baseline.json" ]; then
      echo "REFUSING: scripts/antigravity-permissions-baseline.json is missing - the antigravity planner would start with NO routine-command allowlist (everything prompts)." >&2
      exit 1
    fi
    cp "$REPO/scripts/antigravity-permissions-baseline.json" "$WT/$PERMS_JSON"
    node "$REPO/scripts/preaccept-startup.mjs" agy "$WT/$PERMS_JSON" "/repo/$WT_REL"   # folder-trust prompt pre-answered
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
    -e PI_ROLE=planner
    "$IMAGE"
    -i "$SEED")

elif [ "$BACKEND" = "opencode" ]; then
  # Ported from launch-worker.sh's opencode branch - see its comments. OpenCode
  # loads its guard as an IN-PROCESS plugin auto-discovered from the project's
  # .opencode/plugins/, so the plugin is written into THIS worktree (already on
  # the /repo mount). REPO_ROOT = own worktree, matching the planner's
  # docs-only file_boundary. .opencode/ is a planner-lane-external path: it is
  # session wiring, never committed (see the pre-commit boundary check).
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
  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -e PI_ROLE=planner)
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
  args+=("$IMAGE" --auto --prompt "$SEED")

elif [ "$BACKEND" = "claude" ]; then
  # Same translation layer the worker backend already uses
  # (scripts/claude-guard-adapter.mjs) - REPO_ROOT is THIS worktree's root
  # (like the worker, unlike the integrator), since the planner's own
  # file_boundary (docs/changes/**, docs/decisions/**) is matched relative
  # to its own worktree. --settings <path> reads a plain file off the
  # already-mounted /repo volume - no bind mount needed at all (see
  # Dockerfile.claude / docs/changes/CLAUDE-WORKER.md).
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
    ]
  }
}
EOF
  fi
  args=(docker run --rm -it --network host
    --name "$NAME"
    -v "$REPO:/repo" -w "/repo/$WT_REL"
    -e PI_ROLE=planner
    -v "$HARNESS_CLAUDE_CREDENTIALS:/home/node/.claude/.credentials.json"
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
  args+=("$SEED")

else
  # codex - same translation layer the worker backend uses
  # (scripts/codex-guard-adapter.mjs). hooks.json mounted at the USER-level
  # ~/.codex/hooks.json (not <repo>/.codex/hooks.json, which needs
  # interactive /hooks trust this container has no one present to grant -
  # see docs/changes/CODEX-WORKER.md). --no-daemon: this image has no
  # procps, same gap found on the worker backend's real launch.
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
    -e PI_ROLE=planner)
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
  # Compact at HARNESS_COMPACT_AT. A -c override, not config.toml: that file is the
  # user's own shared login config (~/.harness/config/codex) and stays untouched.
  harness_compact_enabled && args+=(-c "model_auto_compact_token_limit=$HARNESS_COMPACT_AT")
  args+=("$SEED")
fi

echo "herdr     : HERDR_AGENT=$HERDR_AGENT exported (no-op unless a Herdr pane is watching this process)"
echo "role      : planner (docs-only)"
echo "backend   : $BACKEND"
echo "branch    : $BRANCH"
echo "worktree  : $WT"
echo "container : $NAME"
if [ "$BACKEND" = "pi" ]; then
  if [ -n "$MODEL" ]; then
    echo "model     : $MODEL   (from PLANNER_MODEL - sticky across launches in this shell until changed/unset)"
  else
    echo "model     : pi's default provider (PLANNER_MODEL unset)"
  fi
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
  echo "hook      : $HOOKS_DIR/ -> /home/node/.gemini/config/   (hooks.json; dir-mounted - EBUSY otherwise)"
  echo "            PreToolUse -> scripts/antigravity-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "            Stop gate  -> NOT wired (docs-only planner; same as claude/codex planners)"
  echo "perms     : $PERMS_DIR/ -> /home/node/.gemini/antigravity-cli/   (settings.json + sessions, persisted)"
  echo "            statusLine -> scripts/antigravity-usage-statusline.mjs (quota.* -> evidence.jsonl)"
  echo "seed      : -i \"\$SEED\" (agy --prompt-interactive). If the session doesn't open with it, paste:"
  echo "  $SEED"
elif [ "$BACKEND" = "opencode" ]; then
  echo "plugin    : $PLUGIN_REL   (in-process guard, no bind mount)"
  echo "            tool.execute.before -> scripts/opencode-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "mode      : --auto, seed via --prompt"
  if [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then
    echo "auth      : $OPENCODE_CONFIG_DIR -> /home/node/.local/share/opencode (persisted login)"
  else
    echo "auth      : none persisted (OPENCODE_CONFIG_DIR unset) - $WT/$OPENCODE_HOME_REL per launch"
  fi
elif [ "$BACKEND" = "claude" ]; then
  echo "settings  : $SETTINGS_JSON -> --settings flag (no bind mount at all)"
  echo "            PreToolUse -> scripts/claude-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "mode      : --dangerously-skip-permissions (hooks confirmed to still fire under it)"
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
else
  echo "hook      : $HOOKS_JSON -> /home/node/.codex/hooks.json   (single-file mount - see Dockerfile.codex)"
  echo "            PreToolUse -> scripts/codex-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "auth      : $HARNESS_CODEX_AUTH -> /home/node/.codex/auth.json (baked-in, persists across launches)"
  if [ -f "$HARNESS_CODEX_CONFIG_TOML" ]; then
    echo "config    : $HARNESS_CODEX_CONFIG_TOML -> /home/node/.codex/config.toml"
  else
    echo "config    : not mounted (no ~/.harness/config/codex/config.toml) - codex's own default model/config applies"
  fi
  echo "mode      : --dangerously-bypass-approvals-and-sandbox --no-daemon"
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $WT/$CODEX_SESSIONS_REL -> /home/node/.codex/sessions (persisted; path CONFIRMED via web"
    echo "            search only, not against a real codex container - verify on first real launch)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - codex's own rollout logs die with the container"
  fi
fi
# Diff context optimization: default 2 lines instead of standard 3 (HARNESS_DIFF_CONTEXT=3 reverts, 0 disables)
DIFF_CTX="${HARNESS_DIFF_CONTEXT:-2}"
if [ "$DIFF_CTX" -gt 0 ] 2>/dev/null; then
  git -C "$WT" config diff.context "$DIFF_CTX" 2>/dev/null || true
  args+=(-e "GIT_DIFF_OPTS=-u${DIFF_CTX}")
fi

if [ "$DRY" -eq 1 ]; then
  echo "(dry-run: worktree not created)"
  printf 'DRY RUN — would exec:\n'; printf '  %q' "${args[@]}"; printf '\n'
  exit 0
fi
# 2026-10-20: the session runs as a CHILD, not via exec, so the launcher gets
# control back when it ends and commits the planner's uncommitted docs
# (planner_autosave in scripts/sync-branch-lib.sh: docs/changes + docs/decisions
# only, planning branch only, never merged into main). The HUP/TERM traps cover a
# closed Herdr pane (best effort). PLANNER_AUTOSAVE=0 restores the old behaviour.
if [ "${PLANNER_AUTOSAVE:-1}" != "1" ]; then exec "${args[@]}"; fi
# shellcheck source=scripts/sync-branch-lib.sh
source "$REPO/scripts/sync-branch-lib.sh"
autosave_planner() { ( cd "$WT" && planner_autosave "$BRANCH" ) || true; }
trap 'autosave_planner; exit 129' HUP
trap 'autosave_planner; exit 143' TERM
"${args[@]}"; rc=$?
trap - HUP TERM
autosave_planner
exit "$rc"
