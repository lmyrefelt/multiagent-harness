#!/usr/bin/env bash
# build.sh — check the image inputs, then build.
#
# Four Dockerfile bugs in a row came from two causes: a COPY source that
# .dockerignore excluded or that did not exist, and a RUN whose continuation
# lines were not backslash-escaped. Both cost a build cycle to discover.
#
# NO HOST NODE REQUIRED. The contract gate (compile, lint, 65 guard tests)
# already runs INSIDE the image, in the Dockerfile's build-time RUN layer.
# Re-running it on the host was redundant and only added a dependency: an
# earlier version died with `node: command not found` when run from a Mac
# shell, where nvm/Homebrew node is not on a non-interactive script's PATH.
#
# BASH 3.2 SAFE. macOS ships /bin/bash 3.2, so no mapfile/readarray, no
# associative arrays, no ${var,,}. An earlier version used mapfile and would
# have failed on a stock Mac.
#
#   ./build.sh                  build the worker/base image (pi-contracts:latest)
#   ./build.sh --no-cache       same, without cache
#   ./build.sh planner          build the role's derived image instead - shorthand
#   ./build.sh integrator       for the DOCKERFILE=/IMAGE= pairing below. Any
#   ./build.sh worker           remaining arg (e.g. --no-cache) still passes through:
#                               `./build.sh planner --no-cache` works.
#   DOCKERFILE=Dockerfile.pi-integrator IMAGE=pi-integrator:latest ./build.sh
#                               the explicit form - still works, still wins over
#                               the role shorthand if you set BOTH (an exported
#                               DOCKERFILE/IMAGE is never overridden by a role
#                               argument), and is the only way to build a
#                               Dockerfile with no role keyword of its own.
#
# On success, writes .pi-contracts-build.fingerprint (local only, not
# committed) - the host project's launch-worker.sh/launch-planner.sh/
# launch-integrator.sh read it to refuse a launch against a stale image
# instead of silently running it. One line per IMAGE ever built.
set -eu
cd "$(dirname "$0")"

# Role shorthand for the DOCKERFILE=/IMAGE= pairing every launch-*.sh script
# already expects by convention (scripts/launch-<role>.sh <-> Dockerfile.pi-<role>
# <-> pi-<role>:latest, worker being the exception: pi-contracts.*). Consumed
# BEFORE the ${VAR:-default} lines below, so an explicitly exported
# DOCKERFILE/IMAGE still wins - this only supplies the fallback default.
# --- what to build -------------------------------------------------------------
#   ./build.sh [worker|planner|integrator|all] [docker build flags]  always build
#   ./build.sh ensure [worker|planner|integrator|all]                build only if the
#       image is missing or out of date (what the launchers call - see
#       scripts/ensure-image.sh). planner/integrator are built FROM the worker
#       image, so ensure builds/refreshes that first and rebuilds them when it changed.
MODE=build
if [ "${1:-}" = "ensure" ]; then MODE=ensure; shift; fi
if [ "${1:-}" = "all" ]; then
  shift
  for r in worker planner integrator; do
    if [ "$MODE" = ensure ]; then bash "$0" ensure "$r" || exit 1; else bash "$0" "$r" "$@" || exit 1; fi
  done
  exit 0
fi
ROLE_DOCKERFILE="Dockerfile.pi-contracts"
ROLE_IMAGE="pi-contracts:latest"
case "${1:-}" in
  worker)     ROLE_DOCKERFILE="Dockerfile.pi-contracts";  ROLE_IMAGE="pi-contracts:latest";   shift ;;
  planner)    ROLE_DOCKERFILE="Dockerfile.pi-planner";    ROLE_IMAGE="pi-planner:latest";     shift ;;
  integrator) ROLE_DOCKERFILE="Dockerfile.pi-integrator"; ROLE_IMAGE="pi-integrator:latest";  shift ;;
esac

# Image names come from ONE place: .harness-slug (written by bootstrap.sh) -
# never from search-and-replace on this file. 2026-10-15 REAL INCIDENT: text
# substitution left this file un-namespaced (it built pi-contracts:latest while
# the launchers expected <slug>-pi-contracts:latest) and the role Dockerfiles
# double-namespaced, so "rebuild" could never satisfy the staleness check.
# ns() prefixes the slug exactly once, whatever the input already looks like.
SLUG=""; [ -f .harness-slug ] && SLUG="$(tr -d '[:space:]' < .harness-slug)"
ns() {
  local n="$1"
  if [ -n "$SLUG" ]; then while case "$n" in "$SLUG-"*) true ;; *) false ;; esac; do n="${n#"$SLUG-"}"; done; n="$SLUG-$n"; fi
  printf '%s' "$n"
}
ROLE_IMAGE="$(ns "$ROLE_IMAGE")"
BASE_IMAGE="$(ns "pi-contracts:latest")"
IMAGE="${IMAGE:-$ROLE_IMAGE}"
DOCKERFILE="${DOCKERFILE:-$ROLE_DOCKERFILE}"
IS_DERIVED=0; [ "$DOCKERFILE" != "Dockerfile.pi-contracts" ] && IS_DERIVED=1

# Fingerprint of everything that goes into the image (a derived image also
# depends on the base Dockerfile).
build_fp() {
  { [ -f "$DOCKERFILE" ] && cat "$DOCKERFILE"
    [ "$IS_DERIVED" = 1 ] && [ -f Dockerfile.pi-contracts ] && cat Dockerfile.pi-contracts
    find prototype -type f 2>/dev/null | sort | while IFS= read -r f; do cat "$f"; done
    [ -f models.json ] && cat models.json
    [ -f settings.defaults.json ] && cat settings.defaults.json
  } | cksum | awk '{print $1}'
}

if [ "$MODE" = ensure ]; then
  # one build at a time per project (two launches at once must not both build)
  if [ -z "${HARNESS_BUILD_LOCK_HELD:-}" ]; then
    waited=0
    until mkdir .build.lock 2>/dev/null; do
      if [ -n "$(find .build.lock -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir .build.lock 2>/dev/null || true; continue; fi
      [ "$waited" = 0 ] && echo "==> another image build is running - waiting for it"
      sleep 5; waited=$((waited + 5))
    done
    LOCK_OWNED=1
    trap 'rmdir .build.lock 2>/dev/null || true' EXIT
    export HARNESS_BUILD_LOCK_HELD=1
  fi
  [ "$IS_DERIVED" = 1 ] && { bash "$0" ensure worker || exit 1; }
  CUR="$(build_fp)"
  REC="$(awk -v img="$IMAGE" '$2==img{print $1}' .pi-contracts-build.fingerprint 2>/dev/null || true)"
  STALE_BASE=0
  if [ "$IS_DERIVED" = 1 ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    want="$(docker image inspect -f '{{.Id}}' "$BASE_IMAGE" 2>/dev/null || true)"
    have="$(docker image inspect -f '{{index .Config.Labels "harness.base-id"}}' "$IMAGE" 2>/dev/null || true)"
    [ -n "$want" ] && [ "$want" != "$have" ] && STALE_BASE=1
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1 && [ "$CUR" = "$REC" ] && [ "$STALE_BASE" = 0 ]; then
    echo "images    : $IMAGE is up to date"
    exit 0
  fi
  echo "==> $IMAGE is missing or out of date - building it now (this can take a few minutes)"
elif [ "$IS_DERIVED" = 1 ] && ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "==> base image $BASE_IMAGE missing - building it first"
  bash "$0" worker || exit 1
fi
SRCFILE=$(mktemp)
trap 'rm -f "$SRCFILE"; [ -n "${LOCK_OWNED:-}" ] && rmdir .build.lock 2>/dev/null; true' EXIT

# Extract COPY sources: on each COPY line drop the flags and the final token
# (the destination). Two passes so the file is built outside any subshell.
grep -iE '^[[:space:]]*COPY[[:space:]]' "$DOCKERFILE" \
  | sed -E 's/^[[:space:]]*[Cc][Oo][Pp][Yy][[:space:]]+//' \
  | sed -E 's/--[a-z-]+=[^[:space:]]+//g' \
  | awk '{ n = NF; if (n < 2) next; for (i = 1; i < n; i++) print $i }' \
  > "$SRCFILE"

echo "==> 1/2  copy-source check (bash only)"
problems=0

# Skip anything that is clearly a destination: quoted, an env var, or absolute.
is_source() {
  case "$1" in
    ''|*'"'*|*'$'*|*' '*|/*) return 1 ;;
    *) return 0 ;;
  esac
}

while IFS= read -r src; do
  is_source "$src" || continue
  if [ ! -e "$src" ]; then
    echo "  FAIL  $src  MISSING ON DISK"
    problems=$((problems + 1))
  elif [ -f .dockerignore ] && grep -qxF -- "$src" .dockerignore; then
    echo "  FAIL  $src  EXCLUDED BY .dockerignore"
    problems=$((problems + 1))
  else
    echo "  ok    $src"
  fi
done < "$SRCFILE"

if [ -f .dockerignore ]; then
  for need in models.json settings.defaults.json; do
    if grep -qxF -- "$need" .dockerignore; then
      echo "  FAIL  .dockerignore excludes required file: $need"
      problems=$((problems + 1))
    fi
  done
fi

if [ "$problems" -gt 0 ]; then
  echo ""
  echo "$problems problem(s) - not building."
  exit 1
fi

echo ""
echo "==> 2/2  build"

# The deeper static analysis is a bonus, not a requirement. If node is on the
# PATH, run it; if not, say so plainly and carry on - the image's own build
# gate is the authoritative check.
if command -v node >/dev/null 2>&1; then
  echo "      node $(node --version) found - running the full Dockerfile check"
  node check-dockerfile.mjs --dockerfile "$DOCKERFILE" | tail -n 4
else
  echo "      node not on PATH - skipping the deeper static check."
  echo "      The contract gate still runs inside the image."
  echo "      To run it here: nvm use 24 && node check-dockerfile.mjs --dockerfile $DOCKERFILE"
fi

echo ""
if [ "$IS_DERIVED" = 1 ]; then
  BASE_ID="$(docker image inspect -f '{{.Id}}' "$BASE_IMAGE" 2>/dev/null || true)"
  docker build ${1:-} --build-arg BASE_IMAGE="$BASE_IMAGE" ${BASE_ID:+--label harness.base-id=$BASE_ID} -f "$DOCKERFILE" -t "$IMAGE" .
else
  docker build ${1:-} -f "$DOCKERFILE" -t "$IMAGE" .
fi

# Fingerprint the build inputs so launch-worker.sh/launch-planner.sh (in the
# the host project repo) can detect a STALE image - one that exists but predates
# a source fix - and refuse instead of silently running the old behaviour. No
# date parsing (macOS/BSD and GNU stat/date flags disagree); cksum is POSIX
# and identical on both. Marker is local only, never committed.
#
# ONE LINE PER IMAGE, not one line total: building worker, then planner, then
# integrator (the normal sequence - see bootstrap.sh/SETUP.md) must leave all
# three images recorded as fresh, not just whichever was built LAST. A plain
# `> .pi-contracts-build.fingerprint` here was overwriting the whole file on
# every build, silently erasing every other role's line - REGRESSION found
# the hard way: `./build.sh && ./build.sh planner && ./build.sh integrator`
# left ONLY the integrator's line, so the very next `launch-planner.sh`
# refused with "is stale" even though the planner image had just been built
# correctly. Fix: drop any existing line for THIS image first, then append.
FP_FILE=".pi-contracts-build.fingerprint"
touch "$FP_FILE"
FP_TMP="$(mktemp "${TMPDIR:-/tmp}/pi-contracts-fp.XXXXXX")"
awk -v img="$IMAGE" '$2!=img' "$FP_FILE" > "$FP_TMP" 2>/dev/null || true
echo "$(build_fp) $IMAGE" >> "$FP_TMP"
mv "$FP_TMP" "$FP_FILE"

echo ""
echo "built: $IMAGE"
echo ""
echo "next: everything runs through ONE entrypoint. No paths, no --entrypoint:"
echo ""
echo "  docker run --rm -it --entrypoint /opt/contracts/pc \\"
echo "    -v ~/pi-contracts-results:/results \\"
echo "    -v \"$PWD/models.generated.json:/opt/contracts/models.json\" \\"
echo "    $IMAGE ls              # what this image contains"
echo ""
echo "  ... generate   http://host.docker.internal:8001/v1"
echo "  ... harness    local/Qwen3-Coder-30B-A3B-Instruct-MLX-6bit unverified 5"
echo "  ... aggregate"
echo ""
echo "  (the host has no node, so always go through the image)"
