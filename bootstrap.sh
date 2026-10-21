#!/usr/bin/env bash
# bootstrap.sh — turn this exported harness into a working project.
#
# Run this FROM the agent-harness-export/ directory you were given (or wherever
# you extracted it). It asks a few questions, then creates/updates a target
# project directory with everything the launch scripts expect to find:
#   scripts/, docker Dockerfiles, a sibling contracts/ (base image build),
#   .githooks/ wired up, .pi/agents/ + worker.env.example, and docs/changes/
#   seeded with the methodology docs + change.template.yaml.
#
# Image tags and container-name prefixes are rewritten to start with YOUR
# project's slug (pi-contracts:latest -> <slug>-pi-contracts:latest, etc.) so
# two bootstrapped projects on the same machine never fight over the same
# Docker image tag or container name. The one thing deliberately NOT
# namespaced is ~/.harness/config/ (scripts/harness-config-lib.sh) — that's
# the persisted-login directory, and it's shared ACROSS projects on purpose:
# log in once per backend per machine, not once per project. Override
# HARNESS_CONFIG_ROOT yourself later if you ever want per-project isolation
# there instead.
#
# BASH 3.2 SAFE (no mapfile, no associative arrays) — same discipline as
# contracts/build.sh, so this also runs on a stock Mac shell.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"

ask() {  # $1=prompt $2=default -> echoes the answer
  prompt="$1"; default="${2:-}"
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r ans || true
  if [ -z "$ans" ]; then ans="$default"; fi
  printf '%s' "$ans"
}

ask_yn() {  # $1=prompt $2=default(y|n) -> 0 if yes, 1 if no
  prompt="$1"; default="${2:-n}"
  ans="$(ask "$prompt (y/n)" "$default")"
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

slugify() {  # $1=text -> lower-case-kebab
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'
}

# Portable in-place sed: GNU `sed -i 'script' file` vs BSD/macOS `sed -i '' 'script' file`.
sed_inplace() {  # $1=script $2=file
  if sed --version >/dev/null 2>&1; then
    sed -i "$1" "$2"
  else
    sed -i '' "$1" "$2"
  fi
}

echo "== Bootstrap a new project from the agent harness ==" >&2
echo >&2

TARGET="$(ask "Path to the new project directory (created if missing)" "$HOME/projects/my-new-project")"
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

TITLE="$(ask "Project title (one line, used in AGENTS.md)" "$(basename "$TARGET")")"

DEFAULT_SLUG="$(slugify "$TITLE")"
SLUG="$(ask "Project slug (prefixes every image tag + container name so this project never collides with another on the same machine)" "$DEFAULT_SLUG")"
SLUG="$(slugify "$SLUG")"
if [ -z "$SLUG" ]; then SLUG="project"; fi

echo >&2
echo "Target: $TARGET" >&2
echo "Slug:   $SLUG  (e.g. images will be '${SLUG}-claude:latest', not 'harness-claude:latest')" >&2
echo >&2

# --- 1. copy the harness itself ---------------------------------------------
echo "-> copying scripts/, docker/, contracts/, pi-agents/, herdr-plugin/" >&2
mkdir -p "$TARGET/scripts" "$TARGET/docker" "$TARGET/.githooks" "$TARGET/.pi/agents" "$TARGET/herdr-plugin"
cp "$HERE"/scripts/* "$TARGET/scripts/"
cp "$HERE"/docker/* "$TARGET/docker/"
cp "$HERE"/githooks/* "$TARGET/.githooks/"
cp "$HERE"/pi-agents/* "$TARGET/.pi/agents/"
cp "$HERE"/herdr-plugin/* "$TARGET/herdr-plugin/"
cp "$HERE/worker.env.example" "$TARGET/.pi/worker.env.example"
chmod +x "$TARGET"/scripts/*.sh "$TARGET"/.githooks/pre-commit "$TARGET"/.githooks/pre-push 2>/dev/null || true

# Renamed from the export's "pi-contracts-research" (that name made sense for
# a standalone research repo; inside YOUR project it's just "contracts/" —
# the thing that builds the base image + compiles your guard rules).
if [ -d "$TARGET/contracts" ]; then
  echo "   contracts/ already exists at target — leaving Dockerfiles/extensions alone." >&2
  # build.sh (and its dockerfile checker) are harness-maintained tooling, not
  # something a project customizes - unlike the Dockerfiles/extensions above,
  # which may have project-specific edits, these always refresh on a rerun so
  # a fix like .harness-slug support actually reaches an already-bootstrapped
  # project instead of silently going stale forever once contracts/ exists.
  cp "$HERE/pi-contracts-research/build.sh" "$TARGET/contracts/build.sh"
  cp "$HERE/pi-contracts-research/check-dockerfile.mjs" "$TARGET/contracts/check-dockerfile.mjs" 2>/dev/null || true
  chmod +x "$TARGET/contracts/build.sh"
  echo "   refreshed contracts/build.sh + check-dockerfile.mjs to the latest version." >&2
else
  cp -R "$HERE/pi-contracts-research" "$TARGET/contracts"
fi
# build.sh's role shorthand (`./build.sh planner`, `./build.sh integrator`)
# reads this to default IMAGE to "<slug>-pi-<role>:latest" instead of the
# bare "pi-<role>:latest" - without it, a bare `./build.sh <role>` run here
# (including bootstrap.sh's own build step below) builds and fingerprints
# the WRONG, unprefixed image name, and launch-<role>.sh then refuses the
# real namespaced image as "stale" even when it was just built correctly.
# Always (re)written, even when contracts/ already existed, so re-running
# bootstrap.sh on an existing project still fixes this up.
printf '%s' "$SLUG" > "$TARGET/contracts/.harness-slug"

# --- 2. seed docs/changes/ ---------------------------------------------------
echo "-> seeding docs/changes/ with the methodology docs" >&2
mkdir -p "$TARGET/docs/changes"
cp "$HERE"/docs/* "$TARGET/docs/changes/"

# --- 3. namespace every image tag + container-name prefix to this project ---
# Literal, non-overlapping tokens only (none of these match HARNESS_CONFIG_ROOT
# or ~/.harness/config, which stay shared across projects on purpose — see the
# header comment). Order doesn't matter: no token is a substring of another.
echo "-> namespacing image tags + container names + the Herdr plugin id to '$SLUG'" >&2
# Line-based (not word-split): a couple of these contain spaces (the plugin's
# human-readable `name =`), so each line is ONE token pair, "from=>to".
TOKENS="pi-contracts:latest=>${SLUG}-pi-contracts:latest
pi-planner:latest=>${SLUG}-pi-planner:latest
pi-integrator:latest=>${SLUG}-pi-integrator:latest
harness-claude:latest=>${SLUG}-claude:latest
harness-codex:latest=>${SLUG}-codex:latest
harness-opencode:latest=>${SLUG}-opencode:latest
harness-agy:latest=>${SLUG}-agy:latest
harness-worker-=>${SLUG}-worker-
harness-planner-=>${SLUG}-planner-
harness-integrator-=>${SLUG}-integrator-
harness-fetch-=>${SLUG}-fetch-
harness-guard=>${SLUG}-guard
harness.lifecycle-watcher=>${SLUG}.lifecycle-watcher
harness-lifecycle-watcher=>${SLUG}-lifecycle-watcher
Harness change-lifecycle watcher=>${SLUG} change-lifecycle watcher
pi-contracts-research=>contracts"
echo "$TOKENS" | while IFS= read -r pair; do
  [ -z "$pair" ] && continue
  from="${pair%%=>*}"; to="${pair#*=>}"
  grep -rlF -- "$from" "$TARGET/scripts" "$TARGET/docker" "$TARGET/contracts" "$TARGET/docs" "$TARGET/herdr-plugin" 2>/dev/null | \
  while IFS= read -r f; do
    # "to" is "from" with the slug prepended, so "from" is always a substring
    # of "to" - a file already containing "to" (this project was already
    # namespaced, or this one file was already rewritten on an earlier run)
    # would otherwise get matched AGAIN on "from" inside that "to" string,
    # double-prefixing it (<slug>-<slug>-pi-planner:latest). Checking for
    # "to" first, per file, makes re-running bootstrap.sh on an
    # already-bootstrapped project (or copying one un-namespaced file back
    # over an otherwise-namespaced tree) safe to repeat.
    if grep -qF -- "$to" "$f" 2>/dev/null; then
      continue
    fi
    sed_inplace "s|$from|$to|g" "$f"
  done
done

# --- 4. a starter AGENTS.md --------------------------------------------------
AGENTS_MD="$TARGET/AGENTS.md"
if [ -f "$AGENTS_MD" ]; then
  echo "-> AGENTS.md already exists at target — leaving it alone." >&2
else
  echo "-> writing a starter AGENTS.md" >&2
  cat > "$AGENTS_MD" <<EOF
# $TITLE — coding-agent entry point

## 0. Launching a role (for you, the human)

Prefer \`scripts/herdr-launch.sh\` over calling \`scripts/launch-<role>.sh\`
directly — it opens the role in its own labeled Herdr pane (and, if the
\`lifecycle-watcher\` plugin is linked, auto-advances to the next role once
one finishes) instead of blocking your current terminal:

\`\`\`bash
TASK="\$(cat MISSION.md)" scripts/herdr-launch.sh planner planner-1 pi
scripts/herdr-launch.sh worker CHANGE-0001 worker-1 pi
scripts/herdr-launch.sh integrator integrator-1 pi
\`\`\`

If Herdr isn't installed/linked yet, \`herdr-launch.sh\` itself detects that
and prints the equivalent plain \`scripts/launch-<role>.sh\` command instead —
you never need to remember both forms, just always reach for
\`herdr-launch.sh\` first. See SETUP.md's "Optional: Herdr" section for setup.

## 1. Start here: do not assume execution is authorized

Confirm your role (worker / planner / integrator) before doing anything else.
Each role's launch script prints this instruction as its first message —
follow it, don't skip ahead.

## 2. Product and architecture invariants

<-- Fill this in. These are the rules that apply to EVERY change, regardless
of which role or backend is working on it: non-negotiable architecture
decisions, forbidden patterns, required conventions. Leave it empty only if
none exist yet (unlikely once real work starts). -->

## 3. Role dispatch table

### worker
- Implements ONE change, inside its \`owned_paths\` only (mechanically enforced
  — see docs/changes/WORKER-GUARDRAILS.md).
- Read \`docs/changes/CHANGE-NNNN-<slug>/change.yaml\` + \`specification.md\`
  (+ \`tasks.md\` if present — read it FIRST on a resumed session) before doing
  anything else.
- Test-first: write the failing test, watch it fail for the right reason,
  then implement. See docs/changes/HOW-TO-ADD-A-FEATURE.md.
- Update \`change.yaml\`'s \`progress\` field as you go; commit at every
  \`checkpoints\` transition, not in one batch at the end.

### planner
- Docs-only: works inside \`docs/changes/**\`, \`docs/decisions/**\`. Never
  implements.
- Given a research/mission prompt, reserves a change id
  (\`node scripts/next-change-id.mjs --reserve <slug>\`), researches, and
  produces \`discovery.md\` (optional), \`specification.md\`, and a filled-in
  \`change.yaml\` (owned_paths, requirements, tests.command, risk tier).
- Ask the owner one blocking question at a time rather than guessing — see
  docs/changes/COORDINATION.md.

### integrator
- Reviews and merges approved changes. Holds \`scripts/integrator-lock.sh\`
  before any merge — the guard refuses one otherwise.
- Runs the review panel per docs/changes/CHANGE-REVIEW.md before merging;
  records the verdict with \`scripts/record-review-verdict.mjs\`.
- Is PROACTIVE, the owner does not chase you: read \`.pi-session/STATUS.md\`
  (every change: waiting on whom, for how long, next step) whenever you start.
  A worker's or runner's \`blocked\` comes to YOU - unblock it yourself (sync via
  \`scripts/sync-worker.sh CHANGE-NNNN\`, grants, decisions, re-qualification)
  before anything goes to the owner. Changes whose \`depends_on\` are not merged
  are parked by the harness and resume by themselves. A \`[handoff] ... watchdog\`
  prompt with a triage file means a change stopped moving: find the cause and
  act. After two failures of the same kind, diagnose (read the logs) before
  sending the worker another try. A merge your gate refuses goes to the owner as
  needs-human; once they run \`node scripts/handoff.mjs approve-merge --change
  CHANGE-NNNN\` you are prompted to merge it yourself.

### handoff (every role)
- End every turn of work on a change with exactly one report, as your LAST
  action (inside a harness container): \`node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role <role>
  --verdict <verdict> [--file <review/spec file>] --note "<one line>"\`.
  planner: plan-ready | needs-decision | question | blocked.
  integrator: plan-approved | plan-changes-requested | impl-changes-requested |
  merged | needs-human | needs-qualification | question | blocked | plan-requested.
  plan-requested starts the planner on a NEW change (after a merge, the next
  change on the roadmap): `--file` the brief/research doc, `--note` the scope.
  Never ask the owner to paste a prompt to another role.
  needs-decision (planner/worker -> integrator): a decision the integrator can
  make - ownership between changes, contracts, sequencing, conflicting ADRs.
  `--file` the written proposal. question goes to the OWNER and is only for
  what only the owner can decide (scope, priorities, money, outside people).
  On plan-approved the integrator also writes change.yaml `routing:` -
  `complexity: S|M|L|XL`, `visual: true|false`, `reason:` - which picks the
  worker's model (scripts/route-worker.mjs, herdr-plugin/models.catalog.json).
  `routing.model` (+ optional `routing.backend`) PINS the worker's model and
  wins over every routing rule - only when the owner asks for a specific model.
  worker: impl-ready | needs-qualification | needs-decision | question | blocked.
- Write that report from the standard template first: \`node /repo/scripts/handoff.mjs
  new --change CHANGE-NNNN --role <role>\` creates the next numbered file
  (planner-handoff-N.md / integrator-review-N.md / worker-handoff-N.md) in the
  change folder. Fill every section, replace every \`> TODO\` line, and give
  findings stable IDs (F1, F2, ...) that the next round answers one by one.
  \`report\` refuses a report that is incomplete; \`handoff.mjs check --file <f>\`
  tells you what is missing.
- You cannot reach Herdr from your container. What it shows right now (which
  panes run which role/change, and whether an agent is actually alive in them)
  is in \`/repo/.pi-session/herdr-lifecycle/panes-snapshot.json\`, refreshed on
  every idle event. The watcher never launches a second worker for a change
  that has a live one; it prompts the existing worker instead, and drops dead
  panes (no agent) by itself.
- Never ask the owner to relay work to another role: the Herdr lifecycle
  watcher reads the report and starts or prompts the next role (see
  docs/changes/COORDINATION.md, "Handoffs between roles").
- Waiting on the owner? Report \`question\` with the question in \`--note\`.

## Token discipline (every role, every backend)

Every tool result stays in context and is re-sent on every later call. Let in
only what the next decision needs. Correctness first: never guess a file's
contents or skip a test to save tokens.

1. **Locate, then read.** Search first (\`rg -n\`, \`grep -n\`), then read only the
   region you need (offset/limit, \`sed -n 'A,Bp'\`). Whole files only when short
   (< ~300 lines). Big whole-file reads are redirected to an outline by the
   \`read_budget\` guard; that is guidance, not a violation.
2. **Compute, don't read.** For counts, lookups or filters over data, logs,
   JSON, \`.tscn\`/\`.tres\`: run a one-liner that prints only the answer.
3. **Bound every command.** Quiet/failures-only test modes. Long jobs:
   \`cmd > /tmp/out.log 2>&1; echo "exit=\$?"; tail -n 40 /tmp/out.log\`, then
   \`grep -n -m 20 -E 'error|FAIL' /tmp/out.log\`. Never re-run a job just to see
   more output. Iterate on the one failing test; full suite once, at the end.
4. **Never re-read** a file you already read or wrote, unless it changed.
5. **Batch.** Independent reads/searches in one turn; chained shell steps in
   one command.
6. **Diffs over files.** \`git diff --stat\`, then \`git diff -- <path>\`.
7. **Edit, don't rewrite.** Targeted edits; never paste back code already on disk.
8. **Narrow searches.** Scope by path/type, cap results (\`| head -n 30\`, \`-l\`).
9. **Answer lean.** Handoff notes and replies lead with the result. No recap
   of steps, no restating diffs, no closing summary.

<!-- Adapted from tokenleak (github.com/Pazificateur69/tokenleak, MIT). -->

## 4. Where to look next

- docs/changes/README.md               — the change.yaml schema, field by field
- docs/changes/HOW-TO-ADD-A-FEATURE.md  — how to run one change end to end
- docs/changes/COORDINATION.md          — multi-agent protocol, parallel integration
- docs/changes/WORKER-GUARDRAILS.md     — how the guard engine + auth persistence work
- docs/changes/CHANGE-REVIEW.md         — review severity criteria
EOF
fi

# --- 5. the mission/assignment — no length or formatting limit -------------
# This is NOT squeezed into a single `read -r` line (that would truncate any
# multi-paragraph brief at its first newline). Whatever you provide ends up as
# plain text in $TARGET/MISSION.md, which the launch command below reads with
# `$(cat MISSION.md)` — so there's no limit on length, line breaks, numbered
# lists, quotes, or any other formatting in your prompt.
MISSION_FILE="$TARGET/MISSION.md"
echo "How do you want to provide the mission/assignment for the planner?" >&2
echo "  1) I already have it in a file — give its path" >&2
echo "  2) Paste or type it now (finish with a line containing only: EOF)" >&2
echo "  3) Skip for now — I'll write $MISSION_FILE myself later" >&2
MODE="$(ask "Choice" "1")"
case "$MODE" in
  1)
    SRC="$(ask "Path to your mission/brief file" "")"
    if [ -n "$SRC" ] && [ -f "$SRC" ]; then
      cp "$SRC" "$MISSION_FILE"
      echo "-> copied $SRC to $MISSION_FILE" >&2
    else
      echo "-> '$SRC' not found; skipping (write $MISSION_FILE yourself later)." >&2
    fi
    ;;
  2)
    : > "$MISSION_FILE"
    echo "-> paste/type your mission below. Any length, any formatting." >&2
    echo "   End with a line that contains ONLY: EOF" >&2
    while IFS= read -r line; do
      [ "$line" = "EOF" ] && break
      printf '%s\n' "$line" >> "$MISSION_FILE"
    done
    echo "-> saved to $MISSION_FILE" >&2
    ;;
  *)
    echo "-> skipped. Write $MISSION_FILE yourself (any format) whenever you're ready." >&2
    ;;
esac

# --- 6. .pi/worker.env — point PI_CONTRACTS_DIR at contracts/ automatically -
# launch-worker.sh/launch-planner.sh/launch-integrator.sh all source this file
# if present. Without it they still work, just with a WARN that the
# image-staleness check is skipped — pointing PI_CONTRACTS_DIR here from the
# start means that WARN never fires.
WORKER_ENV="$TARGET/.pi/worker.env"
if [ -f "$WORKER_ENV" ]; then
  echo "-> .pi/worker.env already exists — leaving it alone." >&2
else
  echo "-> writing .pi/worker.env (PI_CONTRACTS_DIR=$TARGET/contracts)" >&2
  cat > "$WORKER_ENV" <<EOF
# Written by bootstrap.sh. See worker.env.example for the other optional
# overrides (WORKER_MODEL, LOCAL_LLM_BASE_URL, etc).
PI_CONTRACTS_DIR=$TARGET/contracts
EOF
fi

# --- 7. git + an initial commit on 'main' + hooks + gitignore ---------------
# A bare `git init` creates NO commits, so "main" does not exist as a ref yet.
# launch-worker.sh/launch-planner.sh both hardcode "main" as the base branch
# a worker/planner worktree branches FROM (change.yaml's base_branch defaults
# to "main" too) — so without a real initial commit on a branch actually
# NAMED main, the very first launch fails with "fatal: invalid reference:
# main". `git init`'s own default branch name is NOT always "main" either
# (recent git defaults to "master" unless configured otherwise) hence `-b
# main` below, with a fallback for an older git that doesn't support it.
cd "$TARGET"
if [ ! -d .git ]; then
  if ask_yn "No git repo found at target. Run 'git init'?" "y"; then
    if ! git init -q -b main 2>/dev/null; then
      git init -q
      git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    fi
  fi
fi
GITIGNORE="$TARGET/.gitignore"
touch "$GITIGNORE"
for line in ".worktrees/" ".pi/worker.env" ".contract-guards*.json" "models.local.json"; do
  grep -qxF "$line" "$GITIGNORE" 2>/dev/null || echo "$line" >> "$GITIGNORE"
done

mkdir -p "$TARGET/.worktrees"

# State-checked, not "did .git exist before this run" - so RE-running
# bootstrap.sh against a project that already has a (commit-less, or
# main-less) .git from a PRIOR run of this script fixes it too, instead of
# silently skipping because .git already existed. Two distinct problems,
# checked separately:
if [ -d .git ]; then
  if ! git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    # No commits AT ALL yet - the root cause of "fatal: invalid reference:
    # main": launch-worker.sh/launch-planner.sh both hardcode "main" as the
    # branch a worktree branches FROM, and a bare `git init` makes no
    # commits, so that ref doesn't exist. Commit BEFORE wiring up
    # core.hooksPath below, not after: check-boundary.mjs (the pre-commit
    # hook) calls `git rev-parse --abbrev-ref HEAD` unconditionally, which
    # throws on a repo with zero commits - a real bug in that script,
    # triggered only on this very first commit, sidestepped by this
    # ordering rather than needing to touch shared hook logic.
    current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
    if [ "$current_branch" != "main" ]; then
      git symbolic-ref HEAD refs/heads/main 2>/dev/null || git checkout -q -b main 2>/dev/null || true
    fi
    git add -A
    # A brand-new machine with no global git identity set yet would
    # otherwise fail the commit below outright ("Please tell me who you
    # are"). Only set a LOCAL (this-repo-only) fallback, and only if
    # nothing — local or global — is configured already, so a real
    # identity is never overridden.
    if [ -z "$(git config user.email 2>/dev/null || true)" ]; then
      git config user.email "bootstrap@localhost"
      git config user.name "harness-bootstrap"
      echo "-> no git identity was configured on this machine yet, so a" >&2
      echo "   placeholder one (bootstrap@localhost) was set LOCAL to this repo" >&2
      echo "   only, just so the commit below succeeds. Set your real one with" >&2
      echo "   'git config --global user.email ...' / '--global user.name ...'" >&2
      echo "   whenever you like — it won't affect this commit retroactively," >&2
      echo "   but every commit after that will use it." >&2
    fi
    if git commit -q -m "Bootstrap: scaffold ${SLUG} agent harness"; then
      echo "-> created an initial commit on 'main' — launch-worker.sh/launch-planner.sh" >&2
      echo "   both need a real 'main' to branch a worktree from; without this commit" >&2
      echo "   the very first launch would fail with 'fatal: invalid reference: main'." >&2
    else
      echo "   'git commit' found nothing to commit or failed — if the first launch" >&2
      echo "   later fails with 'fatal: invalid reference: main', commit something" >&2
      echo "   (even just this scaffolding) on main yourself first." >&2
    fi
  elif ! git rev-parse --verify -q main >/dev/null 2>&1; then
    # Already has commits, just never on a branch literally named "main"
    # (e.g. this repo pre-existed bootstrap.sh and uses "master" or
    # something else). Add a "main" ref pointing at current HEAD without
    # switching branches or touching anything else - launch-worker.sh/
    # launch-planner.sh need the NAME to exist, not for it to be current.
    git branch main
    echo "-> created a 'main' ref pointing at current HEAD (launch-worker.sh/" >&2
    echo "   launch-planner.sh both need one to exist, by that exact name)." >&2
  fi
fi

if [ -d .git ]; then
  # Only wire up hooks once HEAD actually resolves to a real commit - if the
  # commit attempt above silently found nothing to commit (or failed), the
  # scripts are now defensive about unborn HEAD too (see check-boundary.mjs/
  # verify-change.mjs's symbolic-ref fallback), but there's still no "main"
  # for launch-*.sh to branch a worktree from, so setting the hook path here
  # anyway would just mask that problem instead of surfacing it. Skipping it
  # is also safe to re-run: this whole block is state-checked, not
  # did-.git-exist-before-this-run, so the next bootstrap.sh run (or a manual
  # commit) picks it back up automatically.
  if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    git config core.hooksPath .githooks
    echo "-> git config core.hooksPath .githooks (boundary/evidence hooks wired up)" >&2
  else
    echo "-> skipping 'git config core.hooksPath' for now - HEAD still has no commit" >&2
    echo "   (see the message above). Commit something yourself, then re-run" >&2
    echo "   bootstrap.sh or run 'git config core.hooksPath .githooks' by hand." >&2
  fi
fi

# --- 8. build the images --------------------------------------------------
# Everything here is a non-interactive shell/docker command — nothing about
# it actually requires a human. It's gated behind a prompt only because a
# Docker build is slow and resource-heavy, not because it needs your input.
BUILT_BASE=0
BUILT_BACKENDS=""
if ! command -v docker >/dev/null 2>&1; then
  echo >&2
  echo "-> docker not found on PATH — skipping image builds. Install Docker" >&2
  echo "   and re-run bootstrap.sh, or run the commands in the summary below" >&2
  echo "   yourself once it's installed." >&2
elif ask_yn "Build the base pi/planner/integrator images now? (several minutes, needs Docker)" "y"; then
  echo "-> building ${SLUG}-pi-contracts:latest (compiles your contract + runs its self-tests)" >&2
  if ( cd "$TARGET/contracts" && ./build.sh ); then
    BUILT_BASE=1
    echo "-> building ${SLUG}-pi-planner:latest" >&2
    ( cd "$TARGET/contracts" && ./build.sh planner ) || echo "   (planner image build failed — see output above)" >&2
    echo "-> building ${SLUG}-pi-integrator:latest" >&2
    ( cd "$TARGET/contracts" && ./build.sh integrator ) || echo "   (integrator image build failed — see output above)" >&2
  else
    echo "   base image build failed — fix the error above, then re-run" >&2
    echo "   'cd contracts && ./build.sh' yourself." >&2
  fi

  CHOICES="$(ask "Which CLI images should I also build? (space-separated: claude codex opencode agy, 'all', or blank to skip)" "")"
  if [ "$CHOICES" = "all" ]; then CHOICES="claude codex opencode agy"; fi
  for b in $CHOICES; do
    df="$TARGET/docker/Dockerfile.$b"
    if [ -f "$df" ]; then
      echo "-> building ${SLUG}-$b:latest" >&2
      if ( cd "$TARGET" && docker build -f "$df" -t "${SLUG}-$b:latest" . ); then
        BUILT_BACKENDS="$BUILT_BACKENDS $b"
      else
        echo "   ${SLUG}-$b:latest build failed — see output above." >&2
      fi
    else
      echo "   no Dockerfile for '$b' — skipping." >&2
    fi
  done
fi

# --- 9. find (or set up a place for) Herdr, then link the plugin ----------
# Herdr itself is ONE binary per machine (like tmux) — never per project. Only
# the PLUGIN is per-project, because it reads THIS project's docs/changes/ and
# spawns THIS project's scripts/herdr-launch.sh. Its id was namespaced to
# "$SLUG.lifecycle-watcher" above specifically so linking a second project's
# plugin later doesn't collide with or replace this one in Herdr's registry.
#
# This whole step is delegated to scripts/herdr-setup.sh (copied into the
# project in step 1) rather than duplicated inline - a REAL incident showed
# why: Herdr is commonly installed AFTER scaffolding a project, and a
# one-shot inline bootstrap.sh step has no way to be retried later short of
# re-reading this file's own source. herdr-setup.sh is that retry path -
# the owner (or anyone else) can just run it again, any time, once Herdr is
# actually installed.
HERDR_LINKED=0
if [ -x "$TARGET/scripts/herdr-setup.sh" ]; then
  if ask_yn "Link + enable the auto-launch plugin for this project now? (you can also run scripts/herdr-setup.sh any time later, e.g. after installing Herdr)" "y"; then
    if "$TARGET/scripts/herdr-setup.sh"; then
      HERDR_LINKED=1
    else
      echo "   plugin link/enable failed or Herdr isn't installed yet — see output" >&2
      echo "   above. Re-run 'scripts/herdr-setup.sh' any time once it is." >&2
    fi
  else
    echo "-> skipped — run 'scripts/herdr-setup.sh' any time later to link it." >&2
  fi
fi

echo >&2
echo "== Done. Project scaffolded at $TARGET ==" >&2
echo >&2
if [ "$BUILT_BASE" = "1" ]; then
  echo "Images built: ${SLUG}-pi-contracts:latest, ${SLUG}-pi-planner:latest, ${SLUG}-pi-integrator:latest$( [ -n "$BUILT_BACKENDS" ] && printf ', %s' "$(for b in $BUILT_BACKENDS; do printf '%s-%s:latest ' "$SLUG" "$b"; done)" )." >&2
else
  echo "Images NOT built yet (declined, or docker wasn't found). Build them with:" >&2
  echo "  cd contracts && ./build.sh && ./build.sh planner && ./build.sh integrator" >&2
  echo "  docker build -f docker/Dockerfile.claude -t ${SLUG}-claude:latest ." >&2
fi
echo >&2
echo "All of the above are namespaced to '$SLUG' — a second project" >&2
echo "bootstrapped with a different slug on this same machine will build its" >&2
echo "own '<other-slug>-...' images and never touch these. The one shared" >&2
echo "thing across projects, on purpose, is ~/.harness/config/ (persisted" >&2
echo "logins) — see scripts/harness-config-lib.sh's header if you want" >&2
echo "per-project credentials instead." >&2
echo >&2
if [ "$HERDR_LINKED" = "1" ]; then
  echo "Herdr plugin '${SLUG}.lifecycle-watcher' linked + enabled — a worker" >&2
  echo "pane settling with status: review now auto-launches the integrator" >&2
  echo "(and vice versa for a bounce-back), per docs/changes/COORDINATION.md's" >&2
  echo "\"Auto-launching the next role\" section. Up to 5 auto-relaunches per" >&2
  echo "change before it escalates to a Herdr notification instead of looping." >&2
else
  echo "Herdr plugin NOT linked (declined, or herdr wasn't found) — launch each" >&2
  echo "next role yourself for now. Link it any time later (including right" >&2
  echo "after installing Herdr) with:" >&2
  echo "  scripts/herdr-setup.sh" >&2
fi
echo >&2
echo "Optional, not automated here (there's nothing to generate — the default" >&2
echo "contract already works): edit" >&2
echo "contracts/prototype/contracts/worker.contract.yaml" >&2
echo "once you know your own project's test-first/boundary rules." >&2
echo >&2
echo "The one truly manual step: the FIRST launch of each backend needs one" >&2
echo "interactive login (OAuth/API key) inside the container — no script can" >&2
echo "do that for you. After that one time, scripts/harness-config-lib.sh" >&2
echo "persists it under ~/.harness/config/, so every later launch skips it." >&2
echo >&2

echo "Launch the planner — it's docs-only, so there's nothing to break yet," >&2
echo "making it the right starting point for brand-new work. Run this" >&2
echo "yourself in a real terminal (it execs 'docker run -it', which this" >&2
echo "script cannot do for you):" >&2
echo >&2
if [ "$HERDR_LINKED" = "1" ]; then
  # No explicit HERDR_BIN= needed here - herdr-launch.sh resolves it itself
  # from the same ~/.harness/config/herdr/bin_path herdr-setup.sh just wrote.
  LAUNCH_CMD="scripts/herdr-launch.sh planner planner-1 pi"
  LAUNCH_NOTE="   herdr-launch.sh opens this in a new, labeled Herdr pane ('pi-planner-planner-1') instead of a bare foreground 'docker run -it' — once it reaches status: review, the linked plugin auto-launches the integrator for you."
else
  LAUNCH_CMD="scripts/launch-planner.sh planner-1 pi"
  LAUNCH_NOTE="   (Herdr wasn't linked above, so this runs in the foreground directly — install/link Herdr and re-run bootstrap.sh if you'd rather it open in its own labeled pane and auto-advance to the integrator when it settles.)"
fi
if [ -s "$MISSION_FILE" ]; then
  echo "  cd \"$TARGET\"" >&2
  echo "  TASK=\"\$(cat MISSION.md)\" $LAUNCH_CMD" >&2
  echo >&2
  echo "   \$(cat MISSION.md) reads MISSION.md whole, verbatim, at launch time —" >&2
  echo "   no part of your brief was parsed, truncated, or reformatted by this" >&2
  echo "   script. Edit MISSION.md directly any time before launching." >&2
else
  echo "  cd \"$TARGET\"" >&2
  echo "  # write your brief to MISSION.md first (any length/format), then:" >&2
  echo "  TASK=\"\$(cat MISSION.md)\" $LAUNCH_CMD" >&2
fi
echo "$LAUNCH_NOTE" >&2
echo >&2
echo "Swap 'pi' for 'claude' or 'codex' if you'd rather use that backend for" >&2
echo "planning (both are implemented in launch-planner.sh)." >&2
echo >&2
