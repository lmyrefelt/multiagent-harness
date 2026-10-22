#!/usr/bin/env bash
# launch-integrator.sh — launch a guarded PI integrator/controller agent.
#
# WHY THIS IS SHAPED DIFFERENTLY FROM launch-worker.sh / launch-planner.sh
# Workers and the planner each get their OWN worktree because they must run in
# PARALLEL without fighting over one HEAD. The integrator is the opposite case
# BY DESIGN: COORDINATION.md's model is "reviews are lock-free, only main-writes
# serialize" - review happens by reading a CHANGE's OWN worktree (already
# created when its worker ran), and only the brief moment of landing a merge
# touches the one shared resource that must be serialized: this repo's primary
# checkout. So this script mounts the WHOLE repo with cwd AT the repo root (not
# a `.worktrees/*` subpath) - the agent can `cd .worktrees/harness-change-NNNN` to
# review a change lock-free, and operates at the root to actually merge.
#
# THE GUARD, not a prompt, is what makes "mostly autonomous, escalates on
# anything complex or risky" true: compile-integrator-guards.mjs's
# integrator_merge_gate check reads the TARGET change's own risk.tier and
# reviewer_required before letting a `git merge` through, and refuses unless
# this agent's name is the current holder of scripts/integrator-lock.sh's
# lock. The agent must still run `scripts/integrator-lock.sh claim <name>`
# itself before merging and `release <name>` after - exactly what a human
# integrator is asked to do (see integrator-lock.sh's own header) - the guard
# only refuses to let the merge through if it did not.
#
# SEPARATE IMAGE from the worker/planner's pi-contracts:latest, because this
# role is meant to use pi-subagents (launch sub-workers/sub-reviewers) and a
# more capable model - see Dockerfile.pi-integrator in pi-contracts-research
# for why that package is scoped to THIS role rather than folded into the
# shared image.
#
#   scripts/launch-integrator.sh <name> [pi|antigravity|claude|codex|copilot] [--dry-run]
#
# Example: scripts/launch-integrator.sh claude-integrator
#          scripts/launch-integrator.sh gemini-integrator antigravity
#          -> compiles guards.json with holder=<name>, so the agent must
#             `scripts/integrator-lock.sh claim <name>` before any merge is
#             allowed through - same guard engine, same guards.json, two
#             different protocol adapters onto it (see BACKENDS below).
#
# BACKENDS
#   pi          implemented. pi's own --extension hook, in-process.
#   antigravity implemented (agy is an alias). Antigravity CLI's hook system
#               is an EXTERNAL-PROCESS protocol (JSON on stdin/stdout per
#               tool call, antigravity.google/docs/hooks/) - a different
#               shape than pi's, so scripts/antigravity-guard-adapter.mjs
#               translates it onto the SAME checks.mjs evaluateDuring() pi
#               itself uses. integrator_merge_gate is not reimplemented, only
#               its protocol wrapper differs. See that file's header for what
#               is verified vs assumed about Antigravity's hook runtime.
#   claude      implemented. Reuses harness-claude:latest (the SAME image
#               launch-worker.sh builds) and scripts/claude-guard-adapter.mjs
#               unmodified - REPO_ROOT=/repo directly (not a worktree
#               subpath), matching this role's own "shares the one main
#               checkout" design, unlike the worker/planner. --settings
#               <path>, --dangerously-skip-permissions (hooks confirmed to
#               keep firing under it - see docs/changes/CLAUDE-WORKER.md).
#   codex       implemented. Reuses harness-codex:latest + scripts/codex-guard-
#               adapter.mjs, same REPO_ROOT=/repo reasoning.
#               --dangerously-bypass-approvals-and-sandbox --no-daemon. See
#               docs/changes/CODEX-WORKER.md for the real, open upstream bug
#               (apply_patch deny not always enforced) - less of a concern
#               for this role specifically (the integrator's own guards don't
#               compile file_boundary at all), but not nothing.
#   copilot     NOT YET IMPLEMENTED. Its hook/extension schema has not been
#               verified against this project's guard engine - skipping that
#               and launching anyway would mean an integrator with zero
#               mechanical enforcement, not a smaller version of the real
#               guard. Refuses rather than guess.
#   NOTE: for claude/codex, the /change-review panel (CHANGE-REVIEW.md) is
#   NOT wired up - it's dispatched via pi-subagents, a pi-only mechanism.
#   Those backends are seeded to review against the same criteria directly
#   and record the verdict with scripts/record-review-verdict.mjs instead.
#
# Env overrides (all optional):
#   INTEGRATOR_MODEL=local/<id>  a more capable model than the worker's default
#   LOCAL_LLM_BASE_URL=...         default http://host.docker.internal:8001/v1
#   IMAGE=pi-integrator:latest      (or harness-agy:latest for antigravity - see below)
#   EXTENSION=/opt/contracts/extensions/contract-guard.ts
#   REPO=<path>                    default: the git top-level of this checkout
#   ALLOW_TIERS="low,medium,high"  risk tiers this agent may merge without escalating
#   PI_CONFIG_DIR=<path>           if set, bind-mounts <path>/.pi/agent/auth.json onto
#                                  /home/node/.pi/agent/auth.json (shares credentials
#                                  across launches/roles). Deliberately NOT a whole-.pi
#                                  mount: settings.json (and ITS packages array - what a
#                                  role's image actually installed, e.g. pi-subagents on
#                                  this integrator/planner images but not the worker's)
#                                  and models.json stay image-local, baked in at build
#                                  time. Sharing the whole directory would let this
#                                  integrator's pi-subagents registration leak into a
#                                  worker container that never installed the package -
#                                  mounting only auth.json makes that impossible by
#                                  construction.
#   MODELS_JSON=<path>             optional, separate from PI_CONFIG_DIR for the same
#                                  leakage reasoning (one file, not settings.json's
#                                  package list). The image's baked-in models.json
#                                  ships with an empty `models: []` and is never
#                                  regenerated per run - mount a freshly PROBED file
#                                  (node /opt/contracts/make-models-json.mjs
#                                  --base-url ...) here instead. pi backend only.
#   TASK="..."                     appended to the orientation seed as the session's
#                                  first message (see SEED below) - skips retyping the
#                                  reminder every launch; omit to get just the reminder
#                                  and type the task yourself once the session opens.
#   HERDR_AGENT=pi|antigravity-cli  default derives from the chosen backend. See the
#                                  export near LLM below for why.
#   REVIEW_MODEL_LIGHT/_MEDIUM/_HEAVY  optional, pi backend only - model= overrides
#                                  for the /change-review reviewer panel
#                                  (docs/changes/CHANGE-REVIEW.md). No default forced.
#   PI_SUBAGENTS_AGENT_SCOPE        pi backend only - default "both" (forced, not left
#                                  to whatever the installed pi-subagents build
#                                  defaults to), so .pi/agents/review-*.md are
#                                  discoverable without disabling user-level agents.
#                                  Override if a specific value is confirmed needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .pi/worker.env ]; then set -a; . ./.pi/worker.env; set +a; fi

NAME="${1:-}"
case "$NAME" in
  ""|--*) echo "usage: scripts/launch-integrator.sh <name> [pi|antigravity|claude|codex|copilot] [--dry-run]" >&2; exit 1 ;;
esac
shift

# Auto-suffix if that name's container already exists. MEASURED: "docker:
# Error response from daemon: Conflict... already in use" - a container
# from a session that wasn't shut down cleanly (--rm only removes one that
# actually EXITED; a pane closed without stopping the agent leaves it
# running). Resolves NAME itself, not just --name below, since NAME also
# drives the guards filename, session dir, and lock-holder identity
# (scripts/integrator-lock.sh claim $NAME) - keeping all of those
# consistent with the container matters more than keeping the bare name
# typed on the command line. Never removes the existing container; it may
# still be in active use - this only ever adds a new one alongside it.
BASE_NAME="$NAME"; N=1
while docker container inspect "harness-integrator-${NAME}" >/dev/null 2>&1; do
  N=$((N + 1))
  if [ "$N" -gt 99 ]; then
    echo "REFUSING: 99 containers already named harness-integrator-${BASE_NAME}[-NN] - clean up stale ones first: docker ps -a | grep harness-integrator-${BASE_NAME}" >&2
    exit 1
  fi
  NAME="$(printf '%s-%02d' "$BASE_NAME" "$N")"
done
[ "$NAME" = "$BASE_NAME" ] || echo "NOTE: '$BASE_NAME' container name already in use - using '$NAME' instead (existing container left running, not removed)." >&2

BACKEND="pi"
case "${1:-}" in
  pi|antigravity|agy|claude|codex|copilot) BACKEND="$1"; shift ;;
esac
[ "$BACKEND" = "agy" ] && BACKEND="antigravity"

# MEASURED (2026-10-10): `scripts/launch-integrator.sh codex` silently
# launched a PI-backed integrator NAMED "codex" - the calling convention is
# `<name> [backend]`, so a single reserved-word arg is read entirely as
# NAME, with BACKEND defaulting to pi with no warning at all. Nobody
# intentionally names their lock-holder identity "codex" while ALSO meaning
# to request the codex backend - this is virtually always the two-arg form
# typed as one. Refuse rather than silently do the wrong thing, same
# fail-loud principle as everywhere else in this guard system.
case "$NAME" in
  pi|antigravity|agy|claude|codex|copilot)
    if [ "$BACKEND" = "pi" ]; then
      echo "REFUSING: '$NAME' is both a reserved backend name and your <name> argument, with" >&2
      echo "  no backend token after it - this almost certainly means you meant the backend," >&2
      echo "  not a holder name literally called '$NAME'. Use two args:" >&2
      echo "    scripts/launch-integrator.sh <your-name> $NAME" >&2
      echo "  e.g.: scripts/launch-integrator.sh my-integrator $NAME" >&2
      exit 1
    fi
    ;;
esac

case "$BACKEND" in
  copilot)
    echo "REFUSING: backend '$BACKEND' is not yet implemented - its hook/extension schema" >&2
    echo "  has not been verified against this project's guard engine. Launching anyway" >&2
    echo "  would mean an integrator with NO mechanical enforcement, not a smaller version" >&2
    echo "  of the real guard. pi/antigravity/claude/codex are implemented; ask for $BACKEND" >&2
    echo "  to be researched first (see this script's header for what 'implemented' requires)." >&2
    exit 1
    ;;
esac

DRY=0
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    --*) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

REPO="${REPO:-$(git rev-parse --show-toplevel)}"
case "$BACKEND" in
  pi)          IMAGE="${IMAGE:-pi-integrator:latest}" ;;
  antigravity) IMAGE="${IMAGE:-harness-agy:latest}" ;;
  claude)      IMAGE="${IMAGE:-harness-claude:latest}" ;;
  codex)       IMAGE="${IMAGE:-harness-codex:latest}" ;;
esac
EXTENSION="${EXTENSION:-/opt/contracts/extensions/contract-guard.ts}"
# Exported before the final exec so a Herdr pane watching this script's own
# (host-side) process tree can tell which agent it is, even though the
# visible command is `docker run`, not pi/antigravity directly - Herdr cannot
# look inside the container to detect that itself. No-op if Herdr isn't
# running this pane. Backend-aware: Herdr's recognized identifiers differ
# (pi vs antigravity-cli); "claude"/"codex" are unverified Herdr manifest
# names, same caveat as the worker/planner backends - override with
# HERDR_AGENT= if wrong. copilot never reaches here, refused above.
case "$BACKEND" in
  pi)          HERDR_AGENT_DEFAULT="pi" ;;
  antigravity) HERDR_AGENT_DEFAULT="antigravity-cli" ;;
  claude)      HERDR_AGENT_DEFAULT="claude" ;;
  codex)       HERDR_AGENT_DEFAULT="codex" ;;
esac
export HERDR_AGENT="${HERDR_AGENT:-$HERDR_AGENT_DEFAULT}"
LLM="${LOCAL_LLM_BASE_URL:-http://host.docker.internal:8001/v1}"
MODEL="${INTEGRATOR_MODEL:-}"
ALLOW_TIERS="${ALLOW_TIERS:-low,medium,high}"   # owner 2026-10-19: the integrator merges everything below critical

# PI_CONFIG_DIR is pi's own auth-sharing convention (~/.pi/agent/auth.json) -
# only meaningful for the pi backend. Antigravity's equivalent auth location
# is not yet verified, so this is deliberately NOT wired up for it rather
# than guessed at.
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

# Same reasoning as PI_CONFIG_DIR above - pi backend only. The image's baked-in
# models.json ships with an empty `models: []` and is NOT regenerated per run;
# a real local model needs a freshly PROBED file (node
# /opt/contracts/make-models-json.mjs --base-url ...) mounted over it. baseUrl
# there is NOT env-interpolated, so LOCAL_LLM_BASE_URL alone never fixes it.
MODELS_JSON="${MODELS_JSON:-}"
# Auto-detect so no export is needed every run - same convention as
# launch-worker.sh: fall back to a freshly-probed file at the repo root if
# one exists there and nothing was explicitly passed.
if [ "$BACKEND" = "pi" ] && [ -z "$MODELS_JSON" ] && [ -f "$REPO/models.local.json" ]; then
  MODELS_JSON="$REPO/models.local.json"
fi
if [ "$BACKEND" = "pi" ] && [ -n "$MODELS_JSON" ] && [ ! -f "$MODELS_JSON" ]; then
  echo "REFUSING: MODELS_JSON is set but '$MODELS_JSON' does not exist." >&2
  exit 1
fi

# No model chosen but a probed registry IS mounted - offer to pick one
# interactively instead of silently falling through to pi's default provider.
# Only prompts with a real TTY attached; non-interactive runs are unaffected.
if [ "$BACKEND" = "pi" ] && [ -z "$MODEL" ] && [ -n "$MODELS_JSON" ] && [ -t 0 ] && [ -t 1 ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "WARN: MODELS_JSON is set but jq is not installed - cannot list models for selection. Set INTEGRATOR_MODEL explicitly." >&2
  else
    AVAILABLE_MODELS=()
    while IFS= read -r m; do [ -n "$m" ] && AVAILABLE_MODELS+=("$m"); done \
      < <(jq -r '.providers.local.models[]?.id // empty' "$MODELS_JSON" 2>/dev/null)
    if [ "${#AVAILABLE_MODELS[@]}" -gt 0 ]; then
      echo ""
      echo "INTEGRATOR_MODEL is unset. $MODELS_JSON declares ${#AVAILABLE_MODELS[@]} local model(s):"
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

# --- images: build / refresh automatically ------------------------------------
# scripts/ensure-image.sh builds the image if it is missing and rebuilds it when
# its build inputs (guards, contracts, Dockerfiles) or its base image changed -
# so a launch never stops at "image is stale, rebuild it". HARNESS_AUTO_BUILD=0
# turns this off and the checks below apply as before.
HARNESS_IMAGES_ENSURED=""
if [ "${DRY:-0}" != 1 ] && [ "${HARNESS_AUTO_BUILD:-1}" != 0 ]; then
  bash "$REPO/scripts/ensure-image.sh" integrator "$BACKEND" "$IMAGE" || exit 1
  HARNESS_IMAGES_ENSURED=1
fi

# --- image freshness (fails BEFORE touching any git state) --------------------
if [ "$BACKEND" = "pi" ]; then
  # Same check as launch-worker.sh/launch-planner.sh - see launch-worker.sh's
  # comment for the full rationale. $IMAGE is built in the separate
  # pi-contracts-research repo (Dockerfile.pi-integrator, FROM pi-contracts:latest).
  if [ -n "$HARNESS_IMAGES_ENSURED" ]; then
    :  # ensure-image.sh just built/verified it
  elif [ -n "${PI_CONTRACTS_DIR:-}" ] && [ -d "$PI_CONTRACTS_DIR" ]; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && DOCKERFILE=Dockerfile.pi-integrator IMAGE=$IMAGE ./build.sh)" >&2
      exit 1
    fi
    PCD="$PI_CONTRACTS_DIR"
    CURRENT_FP=$(
      { [ -f "$PCD/Dockerfile.pi-integrator" ] && cat "$PCD/Dockerfile.pi-integrator"
        [ -f "$PCD/Dockerfile.pi-contracts" ] && cat "$PCD/Dockerfile.pi-contracts"
        find "$PCD/prototype" -type f 2>/dev/null | sort | while IFS= read -r f; do cat "$f"; done
        [ -f "$PCD/models.json" ] && cat "$PCD/models.json"
        [ -f "$PCD/settings.defaults.json" ] && cat "$PCD/settings.defaults.json"
      } | cksum | awk '{print $1}'
    )
    RECORDED_FP=$(awk -v img="$IMAGE" '$2==img{print $1}' "$PCD/.pi-contracts-build.fingerprint" 2>/dev/null)
    if [ "$CURRENT_FP" != "$RECORDED_FP" ]; then
      echo "REFUSING: '$IMAGE' is stale - its build inputs changed since the last build. Rebuild:" >&2
      echo "  (cd \"$PI_CONTRACTS_DIR\" && DOCKERFILE=Dockerfile.pi-integrator IMAGE=$IMAGE ./build.sh)" >&2
      exit 1
    fi
  else
    echo "WARN: PI_CONTRACTS_DIR unset or not found - skipping the image-staleness check (a stale '$IMAGE' would go unnoticed). Set PI_CONTRACTS_DIR=/path/to/pi-contracts-research in .pi/worker.env to enable it." >&2
  fi
else
  # antigravity/claude/codex: each Dockerfile lives HERE (the host project), not
  # pi-contracts-research - FROM pi-contracts:latest (for the already-baked-in
  # checks.mjs engine) plus that CLI's install, no COPY from either repo's
  # build context needed. Existence-only check, same as the worker/planner
  # backends use for these - no fingerprint-staleness mechanism for them yet.
  DOCKERFILE="Dockerfile.agy"
  [ "$BACKEND" = "claude" ] && DOCKERFILE="Dockerfile.claude"
  [ "$BACKEND" = "codex" ] && DOCKERFILE="Dockerfile.codex"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "REFUSING: image '$IMAGE' does not exist. Build it first:" >&2
    echo "  docker build -f $DOCKERFILE -t $IMAGE ." >&2
    exit 1
  fi
fi

# Namespaced by $NAME: unlike a worker/planner's own worktree, every integrator
# agent shares this ONE repo root, so two concurrent integrators (reviews are
# lock-free - COORDINATION.md) must not clobber each other's compiled guards
# or evidence log.
GUARDS=".contract-guards.integrator-${NAME}.json"
SESSION_REL=".pi-session/integrator-${NAME}"
EVIDENCE="$SESSION_REL/evidence.jsonl"
# See launch-worker.sh's env-override header for the full rationale - same
# OUTPUT-only directory, same mount. pi-cache-optimizer is baked into
# pi-contracts:latest (which this role's image is built FROM), so its shards
# exist here too and die with the --rm container unless persisted.
CACHE_STATS_OUT="${CACHE_STATS_OUT:-1}"
CACHE_STATS_REL="$SESSION_REL/cache-optimizer-stats.d"
# See launch-worker.sh's env-override header for the full rationale. UNLIKE the
# worker backend, this script's antigravity branch mounts ONLY hooks.json
# (.gemini/config/hooks.json), not the whole antigravity-cli directory - so
# antigravity does NOT get free persistence here the way the worker does, and
# needs its own mount below (brain/, narrow - not the whole antigravity-cli dir,
# which also holds settings.json/oauth-token this must not shadow).
SESSION_LOG_OUT="${SESSION_LOG_OUT:-1}"
CLAUDE_PROJECTS_REL="$SESSION_REL/claude-projects"
CODEX_SESSIONS_REL="$SESSION_REL/codex-sessions"
ANTIGRAVITY_BRAIN_REL="$SESSION_REL/antigravity-brain"
IFS=',' read -r -a TIER_ARR <<< "$ALLOW_TIERS"

if [ "$DRY" -eq 0 ]; then
  node scripts/compile-integrator-guards.mjs --holder "$NAME" --allow-tiers "$ALLOW_TIERS" --out "$GUARDS"
  mkdir -p "$SESSION_REL" "$CACHE_STATS_REL" "$CLAUDE_PROJECTS_REL" "$CODEX_SESSIONS_REL" "$ANTIGRAVITY_BRAIN_REL"
fi

# Seed text is shared across backends - see launch-worker.sh for the full
# rationale on why it exists at all. TASK is optional; set it to go straight
# to the actual ask instead of retyping the orientation reminder every launch.
# The /change-review panel clause is BACKEND-AWARE: the real panel
# (.pi/agents/review-*.md dispatched via pi-subagents, FOREGROUND calls only)
# is a pi ecosystem mechanism - claude/codex have their own, entirely
# different native subagent dispatch (claude's --agent/--agents, codex's
# spawn_agent) that nothing here wires up or verifies. Rather than reference
# a panel this backend cannot actually run, those backends are told to apply
# the SAME review criteria directly and record the verdict themselves.
SEED="Confirm your role (integrator) and follow AGENTS.md's dispatch table for it before doing anything else - don't start work until you have."
if [ "$BACKEND" = "pi" ]; then
  SEED="$SEED Before merging a change, run the /change-review panel (.pi/agents/review-light.md, review-medium.md, review-heavy.md via pi-subagents, FOREGROUND calls only - see docs/changes/CHANGE-REVIEW.md) rather than an ad-hoc reviewer subagent - it folds its verdict into the change's own risk.tier/reviewer_required, which is what integrator_merge_gate actually reads."
else
  SEED="$SEED Before merging a change, review it against the SAME criteria docs/changes/CHANGE-REVIEW.md describes (light/medium/heavy severity) and record the verdict yourself with scripts/record-review-verdict.mjs so it folds into the change's own risk.tier/reviewer_required, which is what integrator_merge_gate actually reads - the pi-subagents-dispatched review panel is pi-only and not wired up for this backend."
fi
SEED="$SEED Before attempting any Gate-D / full-regression PostgreSQL+Redis qualification yourself, run 'node scripts/check-qualification-env.mjs' first - if it reports unavailable, this container cannot do it (true for every backend, not just this one; see the script's own header), so stop immediately and tell the owner to run that change's run-qualification.sh on their real Docker host instead of spending a review round re-discovering the same missing-Docker finding."
SEED="$SEED Claim scripts/integrator-lock.sh claim $NAME yourself before any merge; integrator_merge_gate will refuse one otherwise."
# Handoff protocol (scripts/handoff.mjs + herdr-plugin/pipeline.json): the agent
# reports its outcome; the Herdr lifecycle watcher starts the next role.
SEED="$SEED Write every review from the standard template (node /repo/scripts/handoff.mjs new --change CHANGE-NNNN --role integrator - fill every section, stable finding IDs F1, F2...) and end with exactly one handoff as your LAST action: node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role integrator --verdict <plan-approved|plan-changes-requested|impl-changes-requested|merged|needs-human|needs-qualification|question> --file <that review file> --note '<one line>'. After a merged verdict, if the roadmap names the next change, reserve it (allocate the CHANGE id, commit its folder on main) and start its planning yourself with one more report: node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role integrator --verdict plan-requested --file <the brief or research doc the planner must read> --note \"<scope in one line>\". Never ask the owner to paste a prompt to the planner. Before plan-approved, set status: approved and branch: in change.yaml, add routing: {complexity: S|M|L|XL, visual: true|false, reason: ...} (your size estimate - it picks the worker's model; visual = SVG/CSS/canvas/sprites/UI art), and land the planning docs on main. The planner/worker is started for you - never ask the owner to relay it. Changes touching godot-project/: report needs-qualification (no --file) before merging and wait for the runner's qualified/qualification-failed result - see AGENTS.md 'Godot engine work'."
[ -n "${TASK:-}" ] && SEED="$SEED $TASK"

# Token frugality & anti-overthinking (from upstream llmtrim research; HARNESS_FRUGAL_SEED=0 reverts)
if [ "${HARNESS_FRUGAL_SEED:-1}" != "0" ]; then
  SEED="$SEED Use the fewest tool-use turns: run independent tool calls together in one turn, take all you need from each result, and never repeat a call you've already made. When your reasoning reaches an answer, commit to it immediately (avoid restarting with 'Wait' or 'Actually')."
fi

# Never start pi with a model it cannot resolve ("Model local/<id> not found").
# scripts/resolve-model.mjs asks the local server what it serves when no mounted
# models file declares the model, registers it, or falls back to
# INTEGRATOR_MODEL_FALLBACKS / HARNESS_MODEL_FALLBACKS, or to pi's default provider.
# HARNESS_MODEL_RESOLVE=0 turns this off.
if [ "$BACKEND" = "pi" ] && [ "${HARNESS_MODEL_RESOLVE:-1}" != 0 ] && [ -f "$REPO/scripts/resolve-model.mjs" ]; then
  RESOLVED="$(node "$REPO/scripts/resolve-model.mjs" --role integrator --model "$MODEL" --llm "$LLM" \
      --models-json "$MODELS_JSON" --repo "$REPO" \
      --fallbacks "${INTEGRATOR_MODEL_FALLBACKS:-${HARNESS_MODEL_FALLBACKS:-}}" || true)"
  if printf '%s\n' "$RESOLVED" | grep -q '^MODEL='; then
    MODEL="$(printf '%s\n' "$RESOLVED" | sed -n 's/^MODEL=//p')"
    MODELS_JSON="$(printf '%s\n' "$RESOLVED" | sed -n 's/^MODELS_JSON=//p')"
    LLM="$(printf '%s\n' "$RESOLVED" | sed -n 's/^LLM=//p')"
  fi
fi

if [ "$BACKEND" = "pi" ]; then
  [ -z "$MODEL" ] && echo "WARN: INTEGRATOR_MODEL unset — pi will use its default provider, not a more-capable model (set INTEGRATOR_MODEL=local/<id>)." >&2

  # Mounts the WHOLE repo, cwd AT the root - see header. The guard, not the
  # mount, is what prevents an unreviewed or high-risk merge; this agent
  # genuinely needs reach across the repo that a worker must not have.
  args=(docker run --rm -it --network host
    --name "harness-integrator-${NAME}"
    -v "$REPO:/repo" -w "/repo"
    -e PI_ROLE=integrator
    -e CONTRACT_GUARDS="$GUARDS"
    -e CONTRACT_EVIDENCE="$EVIDENCE"
    -e LOCAL_LLM_BASE_URL="$LLM")
  [ -n "$PI_CONFIG_DIR" ] && args+=(-v "$PI_CONFIG_DIR/.pi/agent/auth.json:/home/node/.pi/agent/auth.json")
  [ -n "$MODELS_JSON" ] && args+=(-v "$MODELS_JSON:/home/node/.pi/agent/models.json")
  # Machine-wide pi keybindings (e.g. a second key for "restore queued messages",
  # since Herdr itself takes alt+up): ~/.harness/config/pi/.pi/agent/keybindings.json
  [ -f "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json" ] && args+=(-v "$HARNESS_CONFIG_ROOT/pi/.pi/agent/keybindings.json:/home/node/.pi/agent/keybindings.json:ro")
  [ "$CACHE_STATS_OUT" = "1" ] && args+=(-v "$REPO/$CACHE_STATS_REL:/home/node/.pi/agent/pi-cache-optimizer-stats.d")
  # /change-review panel (docs/changes/CHANGE-REVIEW.md) - optional, no
  # defaults forced here. REVIEW_MODEL_* let the integrator pass a real
  # model= override per reviewer tier instead of guessing one at runtime.
  [ -n "${REVIEW_MODEL_LIGHT:-}" ] && args+=(-e "REVIEW_MODEL_LIGHT=$REVIEW_MODEL_LIGHT")
  [ -n "${REVIEW_MODEL_MEDIUM:-}" ] && args+=(-e "REVIEW_MODEL_MEDIUM=$REVIEW_MODEL_MEDIUM")
  [ -n "${REVIEW_MODEL_HEAVY:-}" ] && args+=(-e "REVIEW_MODEL_HEAVY=$REVIEW_MODEL_HEAVY")
  # PI_SUBAGENTS_AGENT_SCOPE: forced to "both" by default rather than left
  # to whatever the installed pi-subagents build defaults to - two
  # different forks in this ecosystem were found to document two different
  # defaults (one "user"-only, one "both") for the exact same env var, and
  # it's not confirmed which one npm:pi-subagents (installed here) matches.
  # "both" is explicit and inclusive either way: it adds project-level
  # .pi/agents/review-*.md discovery without turning off user-level agents,
  # regardless of which default would otherwise have applied silently.
  args+=(-e "PI_SUBAGENTS_AGENT_SCOPE=${PI_SUBAGENTS_AGENT_SCOPE:-both}")
  args+=("$IMAGE"
    --session-dir "/repo/$SESSION_REL")
  [ -n "$MODEL" ] && args+=(--model "$MODEL")
  args+=(--extension "$EXTENSION")
  # pi's own CLI: a trailing positional message seeds the first turn without
  # forcing one-shot mode (verified against pi's cli.md, see launch-worker.sh).
  args+=("$SEED")

elif [ "$BACKEND" = "antigravity" ]; then
  # Antigravity has no pi-style --extension/--session-dir/--model flags, and
  # its CLI syntax for seeding an initial message is NOT verified (unlike
  # pi's), so SEED is shown in the banner below for manual paste, not wired
  # into the launch. What IS wired in: the hook that makes integrator_merge_gate
  # real for this backend - generated fresh per launch (guards.json is
  # per-NAME/per-launch already; this makes the hook command reference it
  # by an ABSOLUTE, hardcoded path rather than relying on env-var
  # inheritance into the hook's subprocess, which antigravity's own docs do
  # not confirm - see antigravity-guard-adapter.mjs's header for the full
  # verified-vs-assumed breakdown).
  HOOKS_JSON="$SESSION_REL/antigravity-hooks.json"
  if [ "$DRY" -eq 0 ]; then
    cat > "$HOOKS_JSON" <<EOF
{
  "harness-integrator-guard": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$GUARDS CONTRACT_EVIDENCE=/repo/$EVIDENCE REPO_ROOT=/repo node /repo/scripts/antigravity-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ]
  }
}
EOF
  fi

  args=(docker run --rm -it --network host
    --name "harness-integrator-${NAME}"
    -v "$REPO:/repo" -w "/repo"
    -v "$REPO/$HOOKS_JSON:/home/node/.gemini/config/hooks.json"
    -e PI_ROLE=integrator
    -e LOCAL_LLM_BASE_URL="$LLM")
  [ "$SESSION_LOG_OUT" = "1" ] && args+=(-v "$REPO/$ANTIGRAVITY_BRAIN_REL:/home/node/.gemini/antigravity-cli/brain")
  args+=("$IMAGE")

elif [ "$BACKEND" = "claude" ]; then
  # Same translation layer the worker/planner backends use
  # (scripts/claude-guard-adapter.mjs) - REPO_ROOT is /repo directly (NOT a
  # worktree subpath), matching the antigravity branch above: the integrator
  # shares the ONE main checkout, unlike the worker/planner's own worktree.
  SETTINGS_JSON="$SESSION_REL/claude-settings.json"
  if [ "$DRY" -eq 0 ]; then
    cat > "$SETTINGS_JSON" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$GUARDS CONTRACT_EVIDENCE=/repo/$EVIDENCE REPO_ROOT=/repo node /repo/scripts/claude-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "/bin/sh -c 'CONTRACT_EVIDENCE=/repo/$EVIDENCE node /repo/scripts/claude-usage-statusline.mjs'"
  }
}
EOF
  fi
  args=(docker run --rm -it --network host
    --name "harness-integrator-${NAME}"
    -v "$REPO:/repo" -w "/repo"
    -e PI_ROLE=integrator
    -v "$HARNESS_CLAUDE_CREDENTIALS:/home/node/.claude/.credentials.json"
    -v "$HARNESS_CLAUDE_ACCOUNT:/home/node/.claude.json")
  # pre-answer Claude's startup questions (folder trust, onboarding, bypass-mode warning) - scripts/preaccept-startup.mjs
  if [ "$DRY" -eq 0 ]; then node "$REPO/scripts/preaccept-startup.mjs" claude "$HARNESS_CLAUDE_ACCOUNT" "/repo"; fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] && args+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
  [ -n "$HARNESS_CLAUDE_MODEL" ] && args+=(-e "ANTHROPIC_MODEL=$HARNESS_CLAUDE_MODEL")
  # Compact at HARNESS_COMPACT_AT instead of Claude Code's default (~967K on 1M-context
  # models). Env var = documented highest-precedence setting for scripts/containers.
  harness_compact_enabled && args+=(-e "CLAUDE_CODE_AUTO_COMPACT_WINDOW=$HARNESS_COMPACT_AT")
  [ "$SESSION_LOG_OUT" = "1" ] && args+=(-v "$REPO/$CLAUDE_PROJECTS_REL:/home/node/.claude/projects")
  args+=("$IMAGE"
    --settings "/repo/$SETTINGS_JSON"
    --dangerously-skip-permissions)
  args+=("$SEED")

else
  # codex - same translation layer the worker/planner backends use
  # (scripts/codex-guard-adapter.mjs). hooks.json at the USER-level
  # ~/.codex/hooks.json, same reasoning as the worker/planner backends
  # (project-level hooks need interactive /hooks trust this container has no
  # one present to grant). --no-daemon: this image has no procps, same gap
  # found on the worker backend's real launch.
  HOOKS_JSON="$SESSION_REL/codex-hooks.json"
  if [ "$DRY" -eq 0 ]; then
    cat > "$HOOKS_JSON" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/bin/sh -c 'CONTRACT_GUARDS=/repo/$GUARDS CONTRACT_EVIDENCE=/repo/$EVIDENCE REPO_ROOT=/repo node /repo/scripts/codex-guard-adapter.mjs'", "timeout": 30 }
        ]
      }
    ]
  }
}
EOF
  fi
  args=(docker run --rm -it --network host
    --name "harness-integrator-${NAME}"
    -v "$REPO:/repo" -w "/repo"
    -v "$REPO/$HOOKS_JSON:/home/node/.codex/hooks.json"
    -v "$HARNESS_CODEX_AUTH:/home/node/.codex/auth.json"
    -e PI_ROLE=integrator)
  [ -n "${OPENAI_API_KEY:-}" ] && args+=(-e "OPENAI_API_KEY=$OPENAI_API_KEY")
  # pre-trust this workdir in config.toml (creates the file) - scripts/preaccept-startup.mjs
  if [ "$DRY" -eq 0 ]; then node "$REPO/scripts/preaccept-startup.mjs" codex "$HARNESS_CODEX_CONFIG_TOML" "/repo"; fi
  [ -f "$HARNESS_CODEX_CONFIG_TOML" ] && args+=(-v "$HARNESS_CODEX_CONFIG_TOML:/home/node/.codex/config.toml")
  [ "$SESSION_LOG_OUT" = "1" ] && args+=(-v "$REPO/$CODEX_SESSIONS_REL:/home/node/.codex/sessions")
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
echo "role      : integrator (holder: $NAME, backend: $BACKEND)"
echo "allow     : risk.tier in [${TIER_ARR[*]}], reviewer_required: false — else ESCALATE"
echo "repo      : $REPO   (mounted at /repo, cwd /repo — the shared primary checkout)"
echo "container : harness-integrator-${NAME}"
if [ "$BACKEND" = "pi" ]; then
  echo "review    : light=${REVIEW_MODEL_LIGHT:-unset} medium=${REVIEW_MODEL_MEDIUM:-unset} heavy=${REVIEW_MODEL_HEAVY:-unset}  agent_scope=${PI_SUBAGENTS_AGENT_SCOPE:-both}"
fi
if [ "$BACKEND" = "pi" ]; then
  echo "session   : $SESSION_REL/   (check: grep -c no_guards_loaded must be 0)"
  if [ -n "$MODEL" ]; then
    echo "model     : $MODEL   (from INTEGRATOR_MODEL - sticky across launches in this shell until changed/unset)"
  else
    echo "model     : pi's default provider (INTEGRATOR_MODEL unset)"
  fi
  echo "pi config : $PI_CONFIG_DIR/.pi/agent/auth.json -> /home/node/.pi/agent/auth.json (auth only; baked-in default under ~/.harness/config unless PI_CONFIG_DIR was set explicitly)"
  if [ -n "$MODELS_JSON" ]; then
    echo "models    : $MODELS_JSON -> /home/node/.pi/agent/models.json"
  else
    echo "models    : not mounted (MODELS_JSON unset) - image's baked-in empty registry will be used, local/<id> WILL fail"
  fi
  if [ "$CACHE_STATS_OUT" = "1" ]; then
    echo "cache-opt : $REPO/$CACHE_STATS_REL -> /home/node/.pi/agent/pi-cache-optimizer-stats.d (persisted; CACHE_STATS_OUT=0 to disable)"
  else
    echo "cache-opt : not mounted (CACHE_STATS_OUT=0) - pi-cache-optimizer shards will die with the container"
  fi
elif [ "$BACKEND" = "antigravity" ]; then
  echo "hook      : $SESSION_REL/antigravity-hooks.json -> /home/node/.gemini/config/hooks.json"
  echo "            PreToolUse -> scripts/antigravity-guard-adapter.mjs (same guards.json, checks.mjs)"
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $REPO/$ANTIGRAVITY_BRAIN_REL -> /home/node/.gemini/antigravity-cli/brain (persisted;"
    echo "            SESSION_LOG_OUT=0 to disable - UNLIKE the worker backend, this script mounts only"
    echo "            hooks.json, not the whole antigravity-cli dir, so this needed its own mount)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - antigravity's own transcripts die with the container"
  fi
  echo ""
  echo "NOT auto-injected for this backend (unverified CLI syntax) - paste as your first message:"
  echo "  $SEED"
elif [ "$BACKEND" = "claude" ]; then
  echo "settings  : $SESSION_REL/claude-settings.json -> --settings flag (no bind mount at all)"
  echo "            PreToolUse -> scripts/claude-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "            statusLine -> scripts/claude-usage-statusline.mjs (logs rate_limits.five_hour/seven_day to evidence.jsonl; subscription-only, absent on API-key auth)"
  echo "mode      : --dangerously-skip-permissions (hooks confirmed to still fire under it)"
  echo "auth      : $HARNESS_CLAUDE_CREDENTIALS -> /home/node/.claude/.credentials.json (baked-in, persists across launches)"
  echo "            $HARNESS_CLAUDE_ACCOUNT -> /home/node/.claude.json"
  if [ -n "$HARNESS_CLAUDE_MODEL" ]; then
    echo "model     : $HARNESS_CLAUDE_MODEL (from ~/.harness/config/claude/model.txt)"
  else
    echo "model     : claude's own default (no ~/.harness/config/claude/model.txt)"
  fi
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $REPO/$CLAUDE_PROJECTS_REL -> /home/node/.claude/projects (persisted; SESSION_LOG_OUT=0 to disable)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - claude's own session transcript dies with the container"
  fi
else
  echo "hook      : $SESSION_REL/codex-hooks.json -> /home/node/.codex/hooks.json   (single-file mount)"
  echo "            PreToolUse -> scripts/codex-guard-adapter.mjs (same guards.json, checks.mjs)"
  echo "mode      : --dangerously-bypass-approvals-and-sandbox --no-daemon"
  echo "auth      : $HARNESS_CODEX_AUTH -> /home/node/.codex/auth.json (baked-in, persists across launches)"
  if [ -f "$HARNESS_CODEX_CONFIG_TOML" ]; then
    echo "config    : $HARNESS_CODEX_CONFIG_TOML -> /home/node/.codex/config.toml"
  else
    echo "config    : not mounted (no ~/.harness/config/codex/config.toml) - codex's own default model/config applies"
  fi
  if [ "$SESSION_LOG_OUT" = "1" ]; then
    echo "sessions  : $REPO/$CODEX_SESSIONS_REL -> /home/node/.codex/sessions (persisted; path CONFIRMED via"
    echo "            web search only, not against a real codex container - verify on first real launch)"
  else
    echo "sessions  : not mounted (SESSION_LOG_OUT=0) - codex's own rollout logs die with the container"
  fi
  echo ""
  echo "WARNING: github.com/openai/codex#27833 (OPEN) - a hook's deny for apply_patch is not always"
  echo "         enforced on some platforms. The integrator's own guards don't compile file_boundary"
  echo "         (only integrator_merge_gate/lock_required_for_write, both keyed on bash), so this is"
  echo "         less of a concern here than for the worker - but verify before trusting it blind."
fi
echo "lock      : $(scripts/integrator-lock.sh status 2>&1)"
echo "            (the agent must claim it itself before merging: scripts/integrator-lock.sh claim $NAME)"

# Diff context optimization: default 2 lines instead of standard 3 (HARNESS_DIFF_CONTEXT=3 reverts, 0 disables)
DIFF_CTX="${HARNESS_DIFF_CONTEXT:-2}"
if [ "$DIFF_CTX" -gt 0 ] 2>/dev/null; then
  git -C "$REPO" config diff.context "$DIFF_CTX" 2>/dev/null || true
  args+=(-e "GIT_DIFF_OPTS=-u${DIFF_CTX}")
fi

if [ "$DRY" -eq 1 ]; then
  echo "(dry-run: guards not compiled)"
  printf 'DRY RUN — would exec:\n'; printf '  %q' "${args[@]}"; printf '\n'
  exit 0
fi

exec "${args[@]}"
