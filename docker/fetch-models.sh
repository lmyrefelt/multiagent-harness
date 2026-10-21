#!/usr/bin/env bash
# CHANGE-0004 — provision local models ONCE, on the host.
#
# Models are never downloaded during `docker build` and never at container start.
# They are fetched here, into a shared cache directory that compose mounts
# read-only into each runtime container.
#
# Why this is a separate step: a multi-GB pull inside the image build would make
# every rebuild slow, and the runtimes must be unable to download at all (the
# store is mounted read-only and the runtime network has no egress).
#
# Usage:
#   bash docker/fetch-models.sh
#   HARNESS_MODEL_CACHE=/srv/models bash docker/fetch-models.sh
#
# Requires only docker. No Ollama CLI is installed on the host: provisioning runs
# inside a throwaway container of the same pinned image the runtimes use, so the
# bytes are produced by exactly the runtime that will serve them.
set -euo pipefail

# One directory per function. Each runtime mounts only its own, so the copilot
# container cannot serve the triage model.
MODEL_CACHE="${HARNESS_MODEL_CACHE:-./.models}"
OLLAMA_IMAGE="${HARNESS_OLLAMA_IMAGE:-ollama/ollama:0.12.11}"
COPILOT_MODEL="${HARNESS_COPILOT_MODEL:-mistral:latest}"
COPILOT_DIGEST="${HARNESS_COPILOT_MODEL_DIGEST:-6577803aa9a0}"
TRIAGE_MODEL="${HARNESS_TRIAGE_MODEL:-phi3:latest}"
TRIAGE_DIGEST="${HARNESS_TRIAGE_MODEL_DIGEST:-4f2222927938}"

MARKER_DIR="${MODEL_CACHE}/.harness-provisioned"

die() { echo "fetch-models: $*" >&2; exit 1; }

# --- pinning rules ---------------------------------------------------------
# An unpinned tag silently changes what runs between machines and between days.
# ollama/ollama#13039 is the cautionary case.
require_pinned_model() {
  local name="$1" value="$2"
  case "$value" in
    *:*) ;;
    *) die "model '${value}' is not pinned to a version. Pin it explicitly, e.g. '${name}:latest', or a fixed tag." ;;
  esac
}

require_pinned_image() {
  local value="$1"
  case "$value" in
    *:latest|*:latest-*|*:latest.*) die "image '${value}' is not pinned to an explicit version." ;;
    *:*) ;;
    *) die "image '${value}' has no tag at all; pin it to an explicit version." ;;
  esac
}

require_pinned_model copilot "$COPILOT_MODEL"
require_pinned_model triage "$TRIAGE_MODEL"
require_pinned_image "$OLLAMA_IMAGE"

command -v docker >/dev/null 2>&1 || die "docker is required to provision models. No host Ollama install is needed."

# --- cache layout ----------------------------------------------------------
mkdir -p "$MARKER_DIR"

marker_for() { echo "${MARKER_DIR}/$(echo "$1" | tr '/:' '__')"; }

# Pull inside a throwaway container of the pinned runtime image, writing straight
# into the per-function store that one runtime later mounts read-only. Network
# access is needed HERE and only here — provisioning is the one sanctioned download.
#
# `ollama pull` is a CLIENT command in this version: it refuses to run unless a
# server is already listening. So provisioning starts a temporary server against
# the store, waits for it to answer, execs the pull into it, and removes it.
# Leaving that server up would occupy a port and hold a model in memory.
#
# HOME is set to a writable path: we run as the invoking uid, which has no passwd
# entry in the image, and a server with nowhere writable for its own state never
# starts listening. On failure the container logs are printed before cleanup, so
# the cause is visible instead of guessed at.
#
# blobs/ and manifests/ must exist beforehand: Ollama creates them at startup, and
# against a read-only mount that mkdir is fatal rather than a no-op.
provision() {
  local function="$1" model="$2" digest="$3"
  local store="${MODEL_CACHE}/${function}"
  local marker container
  marker="$(marker_for "$model")"

  if [ -f "$marker" ] && grep -qx "$digest" "$marker" 2>/dev/null; then
    echo "  ${model} already provisioned (${digest}) - skipping"
    return 0
  fi

  echo "  provisioning ${model} for ${function} (${digest}) ..."
  mkdir -p "${store}/blobs" "${store}/manifests"

  container="$(
    docker run -d \
      --user "$(id -u):$(id -g)" \
      --name "harness-fetch-${function}-$$" \
      -e HOME=/tmp \
      -v "${store}:/models" \
      -e OLLAMA_MODELS=/models \
      "$OLLAMA_IMAGE" \
      serve
  )"

  cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }

  # Wait for the server to answer before asking the client to talk to it.
  local attempt=0
  until docker exec "$container" ollama list >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "fetch-models: the temporary runtime for ${function} never became ready." >&2
      echo "fetch-models: --- container logs ---" >&2
      docker logs --tail 40 "$container" >&2 2>&1 || true
      cleanup
      exit 1
    fi
    sleep 1
  done

  if ! docker exec "$container" ollama pull "$model"; then
    echo "fetch-models: --- container logs ---" >&2
    docker logs --tail 40 "$container" >&2 2>&1 || true
    cleanup
    die "failed to pull ${model}"
  fi

  # Verify what was ACTUALLY pulled against the pinned digest, while the server
  # is still up. `ollama list` reports the installed tag with a short digest in
  # its ID column. A moved tag (ollama/ollama#13039) surfaces here as a mismatch
  # and must fail loudly, not silently serve the wrong weights. Recording the
  # expected digest alone (the previous behaviour) verified nothing.
  local actual
  actual="$(docker exec "$container" ollama list 2>/dev/null \
            | awk -v m="$model" '$1 == m { print $2; exit }')"
  if [ -z "$actual" ]; then
    docker logs --tail 40 "$container" >&2 2>&1 || true
    cleanup
    die "could not read the installed digest for ${model} after pull."
  fi
  if [ "${actual:0:${#digest}}" != "$digest" ]; then
    cleanup
    die "digest mismatch for ${model}: pinned '${digest}', runtime installed '${actual}'. The tag may have moved (ollama/ollama#13039); update the pinned digest or tag before provisioning."
  fi

  cleanup

  # Record the VERIFIED digest. A later change to the expected digest no longer
  # matches this marker, so the model is re-provisioned and re-verified rather
  # than silently served from the old weights.
  echo "$digest" > "$marker"
}

echo "Provisioning local models into ${MODEL_CACHE}"
echo "  runtime image: ${OLLAMA_IMAGE}"
provision copilot "$COPILOT_MODEL" "$COPILOT_DIGEST"
provision triage "$TRIAGE_MODEL" "$TRIAGE_DIGEST"

echo "Done. Start the runtimes with:  docker compose --profile models up -d"
