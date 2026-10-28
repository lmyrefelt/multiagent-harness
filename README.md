# multiagent-harness

My multi-agent harness: a planner -> integrator -> worker pipeline for pi, Herdr and coding agents (Claude Code, Codex, OpenCode, Antigravity, Jules) with routing, usage limits and contract guards.

## Portable export

This is the multi-backend agentic dev-pipeline harness extracted from the
original project so it can run against a different codebase on a
different machine. All project-specific naming inside these files has been
rewritten to the generic "harness" (image tags, container-name prefixes,
plugin names) so nothing here assumes the originating project. A few things
still can't be made generic automatically — see "What you must adapt" below.

**Starting a new project from this export? Read [`SETUP.md`](./SETUP.md)
and run `./bootstrap.sh`** — it scaffolds a target project (scripts, docker
images, `.githooks/`, `docs/changes/`, a starter `AGENTS.md`), renames
`pi-contracts-research/` to `contracts/` inside that project, namespaces
every image tag and container-name prefix to a slug you choose (so two
bootstrapped projects on the same machine never collide), and walks you
through building the images and launching the first planner. The rest of
this file describes the export package **as it ships**, i.e. before
`bootstrap.sh` applies that rename/namespacing — read it as the blueprint,
not what you'll see in your actual generated project.

## Two things get built, in order

1. **`pi-contracts-research/`** (→ `contracts/` in your generated project)
   — builds the base image(s) that actually contain the guard engine. This
   is NOT a copy-paste of the whole research repo it came from, only the
   files its own `Dockerfile.pi-contracts` `COPY`s (confirmed by reading the
   Dockerfile, not guessed from comments).
   - `./pi-contracts-research/build.sh` → `pi-contracts:latest` (worker/base
     image; `<slug>-pi-contracts:latest` once `bootstrap.sh` has namespaced it)
   - `./pi-contracts-research/build.sh planner` → `pi-planner:latest`
   - `./pi-contracts-research/build.sh integrator` → `pi-integrator:latest`
   - Needs no host Node — the contract compile + guard tests run inside the
     Docker build itself.
   - `prototype/contracts/worker.contract.yaml` is the generic, reusable
     agent contract (compiled into `guards.json`/`AGENTS.md`/eval cases at
     build time — see `prototype/compile.mjs`). **This is the file you edit**
     to define your new project's own rules; it is already designed to be a
     per-project input (`--contract <path>`), not a hardcoded constant.
   - `prototype/contracts/warroom.contract.yaml` is a worked EXAMPLE from the
     original project (an earlier "War Room" prototype).
     Keep it for reference, delete it once you've written your own contract.

2. **`docker/`** — one Dockerfile per backend CLI (pi, claude, codex,
   opencode, antigravity/agy). Each is `FROM pi-contracts:latest` except
   `Dockerfile.pi` itself, which *is* what gets tagged `pi-contracts:latest`
   (`<slug>-pi-contracts:latest` after namespacing). Build these after step 1:
   ```
   docker build -f docker/Dockerfile.pi       -t pi-contracts:latest .   # if not already built by build.sh
   docker build -f docker/Dockerfile.claude   -t harness-claude:latest .
   docker build -f docker/Dockerfile.codex    -t harness-codex:latest .
   docker build -f docker/Dockerfile.opencode -t harness-opencode:latest .
   docker build -f docker/Dockerfile.agy      -t harness-agy:latest .
   ```
   `docker/fetch-models.sh` / `docker/models.Dockerfile` are optional —
   they pre-fetch local Ollama models into a shared cache (see
   `HARNESS_MODEL_CACHE` env var inside the script) and are unrelated to the
   guard engine.

## `scripts/` — the three launch scripts and their dependencies

- `launch-worker.sh`, `launch-planner.sh`, `launch-integrator.sh` — create a
  git worktree (worker/planner) or use `/repo` directly (integrator), start
  the right container, and wire up that backend's hook/plugin so every tool
  call is checked against `guards.json` (compiled in step 1) before it runs.
  Read the big comment block at the top of each file — it documents every
  env var, and the design reasoning for each backend's hook mechanism
  (Claude Code's `--settings`, Codex's `~/.codex/hooks.json`, OpenCode's
  in-process plugin, Antigravity's bind-mounted hook config).
- `harness-config-lib.sh` — sourced (not executed) by all three launch
  scripts. Persists one login per backend under `~/.harness/config/` so you
  authenticate once and never set an env var or re-login on later launches.
  See its own header comment for the full per-backend mechanism and the
  security tradeoff (live credentials persisted to a fixed host path).
- `*-guard-adapter.mjs` (claude/codex/antigravity/opencode) — translate each
  CLI's own hook protocol into calls against
  `/opt/contracts/extensions/checks.mjs` (baked into the image in step 1).
- `*-completion-gate.mjs` + `completion-gate-core.mjs` — decide whether a
  role's run is actually "done" per the compiled contract.
- `compile-change-guards.mjs` / `compile-planner-guards.mjs` /
  `compile-integrator-guards.mjs` — compile the per-role guard config each
  launch script mounts in.
- `check-boundary.mjs`, `verify-change.mjs`, `preflight-change.mjs`,
  `check-change-overlap.mjs`, `check-qualification-env.mjs`,
  `check-qualification-evidence.mjs`, `record-review-verdict.mjs` — the
  mechanical checks the contract's `check:` blocks call into (file
  boundaries, test-first ordering, review verdicts, etc). Their self-tests
  use `apps/api/src/harness/war_room/**`-style example paths; those are just
  fixtures, not a dependency on any real path existing.
- `next-change-id.mjs`, `integrator-lock.sh` — change-ID allocation and the
  integrator's mutual-exclusion lock, referenced in
  `docs/COORDINATION.md`'s multi-agent protocol.
- `fleet-status.mjs`, `session-cost.mjs`, `*-usage-statusline.mjs`,
  `harvest-antigravity-permissions.mjs`, `antigravity-permissions-baseline.json`
  — monitoring/cost tooling, optional.
- `cost-ledger.mjs` + `list-prices.json` — per-turn cost ledger across pi, Claude Code,
  Codex and Antigravity, by role and change, with $ per subscription-meter point
  (peak vs off-peak). See `docs/COST-LEDGER.md`.
- `repo-health.mjs`, `board.mjs`, `change-diff.mjs`, `herdr-launch.sh` —
  supporting CLI utilities referenced by the docs below.

## `.githooks/` and `pi-agents/`

- `.githooks/pre-commit` and `.githooks/pre-push` are the harness-independent
  net for non-PI agents (and for you, working by hand): the same boundary
  check (`check-boundary.mjs`) and test-first check (`verify-change.mjs`)
  the PI runtime enforces live, but as git hooks. `bootstrap.sh` installs
  them (`git config core.hooksPath .githooks`); they're no-ops on any branch
  that isn't `feature/CHANGE-NNNN-*`.
- `pi-agents/review-{light,medium,heavy}.md` — the three review-severity
  prompts `launch-integrator.sh`'s pi backend dispatches via `pi-subagents`
  before a merge (see `docs/CHANGE-REVIEW.md`). `bootstrap.sh` copies these
  to `.pi/agents/` in the new project, where pi expects to find them.

## `herdr-plugin/`

A [Herdr](https://herdr.dev) plugin that routes the planner -> integrator ->
worker loop so you don't relay turns by hand. Each role ends its turn with
`node scripts/handoff.mjs report --change CHANGE-NNNN --role <role> --verdict
<verdict>`; `lifecycle-watcher.mjs` reacts to Herdr's
`pane.agent_status_changed` event, reads that handoff ledger from every
checkout, and per `pipeline.json` prompts the live planner/integrator session
(`herdr agent prompt`), launches a worker pane (`scripts/herdr-launch.sh`), or
notifies you (questions, merges, high-risk gates, 5 rejected rounds). It ships
in `"mode": "dry-run"` - it only logs what it would do to
`.pi-session/herdr-lifecycle/events.log` until you set `"live"`. Full protocol:
`docs/COORDINATION.md`, "Handoffs between roles". Owner commands:
`node scripts/handoff.mjs status | panes | reconcile`.

Imports `../scripts/verify-change.mjs` and `../scripts/fleet-status.mjs`
directly (reusing their change-status reading and fleet-quota aggregation
rather than re-deriving either), so it must stay a sibling of `scripts/` —
`bootstrap.sh` preserves that layout automatically.

**Install the binary once per machine; link the plugin once per project.**
`bootstrap.sh` namespaces the plugin's id to your slug
(`<slug>.lifecycle-watcher`) so a second bootstrapped project's plugin never
collides with or disables this one in Herdr's shared plugin registry, and
offers to run `herdr plugin link`/`herdr plugin enable` for you if Herdr is
already on `PATH`.

## `docs/`

The methodology docs, seeded into the new project's own `docs/changes/` by
`bootstrap.sh`:

- `README.md` — the `change.yaml` schema, field by field
- `HOW-TO-ADD-A-FEATURE.md` — the detailed walkthrough of running one change
  end to end (this is the doc `SETUP.md` step 6 summarizes)
- `change.template.yaml` / `tasks.template.md` — copy these to start a new
  change folder
- `COORDINATION.md` — the planner/worker/integrator protocol, parallel
  integration, auth-persistence design
- `WORKER-GUARDRAILS.md` — how the guard engine works per backend
- `CHANGE-REVIEW.md` — review severity criteria (light/medium/heavy)
- `CLAUDE-WORKER.md` / `CODEX-WORKER.md` / `OPENCODE-WORKER.md` /
  `ANTIGRAVITY-WORKER.md` — confirmed-vs-unconfirmed facts and known
  reliability caveats per backend

They were written inside the project this harness came from, so some
illustrative examples still say things like `apps/api/src/.../war_room` or
reference that project's own change numbers (`CHANGE-0077`, etc.) — read
those as worked examples of the mechanism, not as paths that need to exist
in your new project.

## What you must adapt for a new project

`bootstrap.sh` already handles #2 and #5 below (directory rename + full
image/container-name namespacing). They're listed here because they're
things a from-scratch manual setup (not using `bootstrap.sh`) would still
need to do.

1. **Write your own contract.** Copy
   `contracts/prototype/contracts/worker.contract.yaml` and edit
   `requires`/`invariant`/`limits` for your repo's own boundaries and rules,
   or point `compile.mjs --contract <your-file>` at a new one.
2. **`PI_CONTRACTS_DIR`.** `launch-worker.sh` (and planner/integrator) can
   check the built image isn't stale if you set
   `PI_CONTRACTS_DIR=/path/to/contracts` — point it at wherever this
   directory ended up on the new machine.
3. **Credentials.** First launch of each backend (pi/claude/codex/opencode)
   still needs one interactive login; after that `harness-config-lib.sh`
   persists it under `~/.harness/config/` on the new machine automatically —
   **shared across every bootstrapped project on that machine, on purpose**
   (log in once per backend per machine, not once per project). Antigravity
   is deliberately NOT covered by this (unverified credential path/possible
   keyring dependency) — see `harness-config-lib.sh`'s header.
4. **REPO root / worktrees.** All three launch scripts default
   `REPO=$(git rev-parse --show-toplevel)` and
   `WORKTREES_DIR=$REPO/.worktrees` — just run them from inside your new
   project's own git repo and these resolve correctly with no edits.
5. **Image tags and container-name prefixes** (`harness-claude:latest`,
   `harness-worker-...`, etc.) are namespaced to a project slug you pick
   during `bootstrap.sh` (e.g. `my-game-claude:latest`,
   `my-game-worker-CHANGE-0001`), so two bootstrapped projects on one
   machine never share an image tag or fight over a container name. If you
   skip `bootstrap.sh` and copy things by hand instead, do this renaming
   yourself across `scripts/launch-*.sh`, `docker/Dockerfile.*`,
   `contracts/build.sh`, and `contracts/Dockerfile.pi-{planner,integrator}`
   — every occurrence of a given tag/prefix must change together or the
   `FROM`/`IMAGE=` references go stale.

## Not included on purpose

- `check-tenant-scoping.mjs` — enforces a domain-specific invariant
  (tenant isolation), not a generic harness mechanism.
- `Dockerfile.copilot` — a standalone GitHub Copilot CLI container, never
  wired into `launch-worker.sh`'s backend list; unrelated to this harness.
- Research-only artifacts from `pi-contracts-research` (`prototype/evidence/`,
  `prototype/sandbox/`, `prototype/generated/`, `pi-contracts-results/`) —
  excluded by that repo's own `.dockerignore` as results, not build inputs.

## Added 2026-10-21

- **`scripts/secrets.mjs`** - API keys from the macOS Keychain (`harness.<name>`: openai, openai_metrics, aistudio, vertex, opencode, openrouter, jules); env vars and `~/.config/harness/secrets.env` as fallbacks. Keys never live in a repo.
- **Native notifications with buttons** - `tools/harness-notify/build.sh` builds a small Swift app; `scripts/notify.mjs` turns watcher messages into notifications with Approve / Reply / Run / Open / Show in Finder / Dismiss. Buttons only run fixed commands written by the harness, never agent text.
- **Jules worker** - `scripts/jules-worker.mjs` (+ `herdr-plugin/jules.json`): the router can hand a change to Google Jules; its pull request is fast-forwarded into the change branch and reported to the integrator like any worker. Needs a GitHub remote, the Jules GitHub app and a `source`.
- **Usage**: OpenAI admin usage/costs (free data-sharing allowance + monthly spend), Antigravity per-model quotas and unknown buckets, stale readings marked; `openai-free/*` catalog models.
- **`scripts/art-gen.mjs`** (+ `herdr-plugin/art.config.json`, `art.env.example`) - image candidates from prompt cards via OpenAI / Gemini under monthly budgets, owner approval before anything enters the game. Written for a Godot project's art pipeline; adapt the prompt source and paths.
