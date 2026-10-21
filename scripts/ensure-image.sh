#!/usr/bin/env bash
# ensure-image.sh <worker|planner|integrator> <backend> <image>
#
# Called by launch-worker.sh / launch-planner.sh / launch-integrator.sh before
# they start a container. Makes sure the image exists AND is built from the
# current guard/contract sources - building or rebuilding it if not - so a
# launch never fails with "image is stale, rebuild it" and nobody has to
# remember to run build.sh after a guard fix.
#
#   pi backend          -> contracts/build.sh ensure <role>  (fingerprint of the
#                          build inputs; planner/integrator images are rebuilt
#                          when their base image changed too)
#   claude/codex/        -> docker/Dockerfile.<x>, built FROM the worker base
#   opencode/antigravity   image; rebuilt whenever that base image changed
#                          (tracked with a harness.base-id label)
#
# HARNESS_AUTO_BUILD=0  turns this off (the launcher's old "refuse if stale"
#                       check applies instead).
# Builds are serialised with a lock, so two launches at once never build the
# same image twice in parallel.
set -euo pipefail

ROLE="${1:?role}"; BACKEND="${2:?backend}"; IMAGE="${3:?image}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${PI_CONTRACTS_DIR:-}" ] && [ -d "$PI_CONTRACTS_DIR" ]; then PCD="$PI_CONTRACTS_DIR"
elif [ -d "$REPO/contracts" ]; then PCD="$REPO/contracts"
else PCD="$REPO/pi-contracts-research"; fi
[ -f "$PCD/build.sh" ] || { echo "ensure-image: no build.sh in $PCD - set PI_CONTRACTS_DIR" >&2; exit 1; }

# While this runs (a first build can take minutes), leave a marker so the Herdr
# lifecycle watcher waits instead of declaring the launch failed.
MARK_DIR="$REPO/.pi-session/herdr-lifecycle"
mkdir -p "$MARK_DIR" 2>/dev/null && date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK_DIR/image-build-running" 2>/dev/null || true
trap 'rm -f "$MARK_DIR/image-build-running" 2>/dev/null || true' EXIT

if ! docker info >/dev/null 2>&1; then
  echo "REFUSING: Docker is not running - start Docker Desktop, then launch again." >&2
  exit 1
fi

# Always let build.sh pick the names (from contracts/.harness-slug), never an
# IMAGE/DOCKERFILE that happens to be set in this shell.
build() { (cd "$PCD" && env -u IMAGE -u DOCKERFILE bash ./build.sh "$@"); }

if [ "$BACKEND" = "pi" ]; then
  echo "images    : checking $IMAGE (rebuilt automatically if missing or out of date)"
  build ensure "$ROLE"
  exit 0
fi

# --- non-pi backends: derived from the worker base image ---------------------
build ensure worker
SLUG=""; [ -f "$PCD/.harness-slug" ] && SLUG="$(tr -d '[:space:]' < "$PCD/.harness-slug")"
BASE="${SLUG:+$SLUG-}pi-contracts:latest"
case "$BACKEND" in
  antigravity|agy) DF="Dockerfile.agy" ;;
  claude)          DF="Dockerfile.claude" ;;
  codex)           DF="Dockerfile.codex" ;;
  opencode)        DF="Dockerfile.opencode" ;;
  *) echo "ensure-image: unknown backend '$BACKEND'" >&2; exit 1 ;;
esac
[ -f "$REPO/docker/$DF" ] || { echo "ensure-image: docker/$DF not found" >&2; exit 1; }

WANT="$(docker image inspect -f '{{.Id}}' "$BASE" 2>/dev/null || true)"
HAVE="$(docker image inspect -f '{{index .Config.Labels "harness.base-id"}}' "$IMAGE" 2>/dev/null || true)"
if docker image inspect "$IMAGE" >/dev/null 2>&1 && [ -n "$WANT" ] && [ "$WANT" = "$HAVE" ]; then
  echo "images    : $IMAGE is up to date"
  exit 0
fi
echo "images    : $IMAGE is missing or older than $BASE - building it now"
docker build --label "harness.base-id=$WANT" -f "$REPO/docker/$DF" -t "$IMAGE" "$REPO"
