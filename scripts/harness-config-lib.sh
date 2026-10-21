# harness-config-lib.sh — shared "baked-in, zero-env-var" persistent
# auth/model-selection config for pi/claude/codex/opencode, sourced (not
# executed) by launch-worker.sh, launch-planner.sh, and launch-integrator.sh.
#
# WHY THIS EXISTS
# pi and opencode already HAD the mechanism for this (PI_CONFIG_DIR/
# OPENCODE_CONFIG_DIR) but it was OFF by default - nothing used it unless
# the owner explicitly exported it every shell session. The owner asked
# (2026-10-13) for zero manual env-var setup: one login anywhere should
# persist for every future launch. This gives every backend a baked-in
# default host path under ~/.harness/config/<backend>/ - owner's own
# explicit choice of root directory.
#
# SECURITY NOTE, stated plainly, not buried: this persists LIVE, LONG-LIVED
# credentials (Claude's OAuth refresh token sk-ant-ort-..., Codex's
# auth.json, pi's own auth.json) to host disk at a FIXED, predictable path,
# bind-mounted into every future container launch. Anyone with read access
# to ~/.harness/config can reuse these sessions. This directory must NEVER
# be inside a git-tracked repo or committed - it lives under $HOME,
# deliberately outside this project's own tree.
#
# WHY GRANULAR FILE MOUNTS, NOT A WHOLE-HOME-DIRECTORY RELOCATION
# Claude Code's CLAUDE_CONFIG_DIR and Codex's CODEX_HOME both relocate the
# tool's ENTIRE home config directory, not just the credential file - doing
# that here would also relocate where session logs land, breaking the
# ALREADY-WORKING /home/node/.claude/projects and /home/node/.codex/sessions
# mounts these scripts already use (they hardcode the tool's DEFAULT path).
# Mounting just the credential file directly onto its own real default path
# avoids that ripple entirely - same minimal-footprint reasoning PI_CONFIG_DIR
# already used (mounts only auth.json, never the whole ~/.pi directory).
#
# VERIFIED (fetched directly, 2026-10-13, not training memory):
#   - Claude: on Linux, credentials live at ~/.claude/.credentials.json
#     (accessToken/refreshToken/expiresAt/scopes). A SEPARATE, genuinely
#     top-level ~/.claude.json (NOT nested under .claude/) holds account
#     identity (oauthAccount, userID) - "the other half of a working
#     session." Default model: ANTHROPIC_MODEL env var, or a "model" field
#     in settings.json.
#   - Codex: $CODEX_HOME/auth.json (default ~/.codex/auth.json), confirmed
#     independently both from this project's own earlier source-reading of
#     a Herdr plugin's codex/auth.go AND official Codex env-var docs.
#     Default model: config.toml's `model = "..."` field.
#   - pi/opencode: this project's own existing PI_CONFIG_DIR/
#     OPENCODE_CONFIG_DIR convention, unchanged, just defaulted now instead
#     of requiring an export.
# NOT INDEPENDENTLY VERIFIED: antigravity is deliberately NOT included here
# - see WORKER-GUARDRAILS.md for why (possible Linux keyring dependency,
# conflicting candidate credential paths across every source checked).

HARNESS_CONFIG_ROOT="${HARNESS_CONFIG_ROOT:-$HOME/.harness/config}"

# Creates an empty JSON object at $1 if nothing exists there yet, so a
# subsequent bind-mount attaches to a REAL file (docker refuses - or worse,
# silently creates a DIRECTORY - when the host side of a single-file mount
# doesn't exist) and the FIRST interactive login inside the container
# writes straight through the mount into the persistent host path, not
# into the container's own throwaway filesystem (which would silently
# defeat the entire point of this file).
harness_ensure_json_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    mkdir -p "$(dirname "$path")"
    printf '{}' > "$path"
  fi
}

# --- pi: only applies the baked-in default if the caller left PI_CONFIG_DIR
# completely unset. An EXPLICIT PI_CONFIG_DIR pointing at a missing
# auth.json still REFUSES loudly in the calling script - unchanged from
# before this file existed; that remains a real misconfiguration signal,
# not something to paper over.
if [ -z "${PI_CONFIG_DIR:-}" ]; then
  PI_CONFIG_DIR="$HARNESS_CONFIG_ROOT/pi"
  harness_ensure_json_file "$PI_CONFIG_DIR/.pi/agent/auth.json"
fi

# --- opencode: identical reasoning to pi above.
if [ -z "${OPENCODE_CONFIG_DIR:-}" ]; then
  OPENCODE_CONFIG_DIR="$HARNESS_CONFIG_ROOT/opencode"
  harness_ensure_json_file "$OPENCODE_CONFIG_DIR/auth.json"
fi

# --- claude: two separate real files, mounted directly onto their own
# default container paths (see header for why this avoids CLAUDE_CONFIG_DIR).
HARNESS_CLAUDE_CREDENTIALS="$HARNESS_CONFIG_ROOT/claude/credentials.json"
HARNESS_CLAUDE_ACCOUNT="$HARNESS_CONFIG_ROOT/claude/claude.json"
harness_ensure_json_file "$HARNESS_CLAUDE_CREDENTIALS"
harness_ensure_json_file "$HARNESS_CLAUDE_ACCOUNT"
# Optional, owner-supplied, NEVER forced: a one-line model id baked in once
# via a file instead of an env var set every session. Absent by default -
# claude's own built-in default model applies until the owner creates this.
HARNESS_CLAUDE_MODEL=""
if [ -f "$HARNESS_CONFIG_ROOT/claude/model.txt" ]; then
  HARNESS_CLAUDE_MODEL="$(tr -d '[:space:]' < "$HARNESS_CONFIG_ROOT/claude/model.txt")"
fi

# --- codex: same direct-file-mount approach, layered under the ALREADY-
# mounted /home/node/.codex/ tree (hooks.json and sessions/ already live
# there as separate mounts under that same implicit parent - this adds a
# third, same pattern, no relocation of CODEX_HOME needed or wanted).
HARNESS_CODEX_AUTH="$HARNESS_CONFIG_ROOT/codex/auth.json"
harness_ensure_json_file "$HARNESS_CODEX_AUTH"
# Optional, owner-supplied config.toml (model default, etc.) - mounted only
# if the owner actually created one; codex's own built-in default applies
# otherwise, same "never force a choice the owner hasn't made" rule as claude.
HARNESS_CODEX_CONFIG_TOML="$HARNESS_CONFIG_ROOT/codex/config.toml"

# --- context compaction ------------------------------------------------------
# Every call re-reads the whole context, so a session left to grow to a 1M
# window re-pays everything above ~200K on every later call. MEASURED with
# scripts/token-audit.mjs (2026-10-20, Johannas_verden, 131 sessions): context
# above 200K was >=22.5% of Claude's weighted tokens (default compaction on
# 1M models ~967K), 12% of Codex's and 9% of pi's; OpenCode and Antigravity
# already stay under it. One trigger for every backend that needs one:
#   claude -> CLAUDE_CODE_AUTO_COMPACT_WINDOW (launch-*.sh)
#   codex  -> -c model_auto_compact_token_limit (launch-*.sh)
#   pi     -> compaction.modelOverrides, generated by
#             scripts/gen-compaction-overrides.mjs into settings.defaults.json
#             (baked into the image - re-run it, then rebuild, after changing this)
# Set HARNESS_COMPACT_AT=0 to leave every backend on its own default.
# Claude Code accepts 100K..1M, so anything below 100000 also means "off".
HARNESS_COMPACT_AT="${HARNESS_COMPACT_AT:-200000}"
harness_compact_enabled() { [ "${HARNESS_COMPACT_AT:-0}" -ge 100000 ] 2>/dev/null; }
