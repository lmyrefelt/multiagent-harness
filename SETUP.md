# Setup — from zero to a running planner

This assumes you already have this `agent-harness-export/` directory on the
new machine (copy/tar/rsync it over however you like), plus Docker and git
installed.

## 1. Create the project folder

```bash
mkdir -p ~/projects/my-new-project
```

(You can also point at an existing, empty repo.)

## 2. Run bootstrap.sh

```bash
cd agent-harness-export
./bootstrap.sh
```

It asks for a target directory, a title, and then how you want to provide
the planner's first assignment:

1. **a file you already wrote** — give its path, it gets copied in as-is
2. **paste or type it right there** — any length, any formatting (markdown,
   numbered sections, whatever), terminated by a line containing only `EOF`
3. **skip** — write `MISSION.md` yourself later, in your own editor

None of these parse or reformat what you give it — it lands verbatim in
`MISSION.md` at the project root. There is no length limit and no required
structure; a multi-section brief with headers and numbered lists works
exactly as well as one sentence.

Before any of that, it also asks for a **project slug** (defaulted from your
title, e.g. "Edu Sandbox Game" → `edu-sandbox-game`). It then:

- copies `scripts/`, `docker/`, `.githooks/`, `.pi/agents/` into the target,
  and copies `pi-contracts-research/` in as `contracts/` (that name made
  sense for a standalone research repo; inside your project it's just "the
  thing that builds the base image")
- rewrites every image tag and container-name prefix across those copied
  files to start with your slug — `pi-contracts:latest` becomes
  `<slug>-pi-contracts:latest`, `harness-claude:latest` becomes
  `<slug>-claude:latest`, worker/planner/integrator container names become
  `<slug>-worker-...` etc. — so a second project bootstrapped with a
  different slug on the same machine never shares an image tag or fights
  over a container name. The one thing left un-namespaced, on purpose, is
  `~/.harness/config/` (persisted logins) — see step 5.
- seeds `docs/changes/` with the methodology docs (`README.md`,
  `HOW-TO-ADD-A-FEATURE.md`, `COORDINATION.md`, `WORKER-GUARDRAILS.md`,
  `CHANGE-REVIEW.md`, `change.template.yaml`, `tasks.template.md`, the
  per-backend `*-WORKER.md` notes)
- writes a starter `AGENTS.md` with the worker/planner/integrator dispatch
  table (edit section 2, "product invariants", once you know what they are)
- writes `.pi/worker.env` with `PI_CONTRACTS_DIR` already pointed at
  `contracts/`, so `launch-worker.sh`/`launch-planner.sh`/`launch-integrator.sh`
  never print the "PI_CONTRACTS_DIR unset" staleness-check warning
- runs `git init` if needed, adds `.worktrees/`, `.pi/worker.env`,
  `.contract-guards*.json`, `models.local.json` to `.gitignore`, and creates
  a real **initial commit on `main`** — `launch-worker.sh`/`launch-planner.sh`
  both hardcode `main` as the branch a worktree branches from, and a bare
  `git init` has no commits yet, so without this the very first launch would
  fail with `fatal: invalid reference: main`. If no git identity is
  configured on the machine yet, it sets a placeholder one LOCAL to this
  repo only (never touching any real global identity) just so that commit
  can succeed — set your real one with `git config --global user.email/name`
  whenever you like.
- only AFTER that commit exists, runs `git config core.hooksPath .githooks`
  (wires up the boundary + test-first pre-commit/pre-push hooks) — in that
  order specifically, because `check-boundary.mjs` (the pre-commit hook)
  calls `git rev-parse HEAD`, which throws on a repo with zero commits

Confirm the hooks are healthy:

```bash
cd ~/projects/my-new-project
node scripts/check-boundary.mjs --selftest
node scripts/verify-change.mjs  --selftest
```

## 3. Write your contract (or start from the generic one as-is)

`contracts/prototype/contracts/worker.contract.yaml` is the single source of
truth for what gets enforced — test-first, boundaries, etc. It's already
generic (no project-specific rules baked in); edit it once you know your own
project's invariants, or leave it as-is to start.

Delete `contracts/prototype/contracts/warroom.contract.yaml` — it's a worked
example from the project this harness came from, not something your project
needs.

## 4. Build the images

`bootstrap.sh` already offered to do this for you in step 2, right after
scaffolding (it checks for Docker, asks once, then runs the exact commands
below, already namespaced to your slug — nothing about a build needs a
human, it's just slow). If you said no there, or Docker wasn't installed
yet, run it manually (`<slug>` below is whatever you entered, or re-run
`bootstrap.sh` to be reminded):

```bash
cd ~/projects/my-new-project/contracts
./build.sh            # -> <slug>-pi-contracts:latest   (compiles your contract, runs its self-tests)
./build.sh planner     # -> <slug>-pi-planner:latest
./build.sh integrator  # -> <slug>-pi-integrator:latest
```

No host Node required — the contract compile + guard self-tests run inside
the Docker build itself, so a bad contract fails the build, not a later
launch.

Then the per-CLI images for whichever backends you'll actually use:

```bash
cd ~/projects/my-new-project
docker build -f docker/Dockerfile.claude   -t <slug>-claude:latest .
docker build -f docker/Dockerfile.codex    -t <slug>-codex:latest .
docker build -f docker/Dockerfile.opencode -t <slug>-opencode:latest .
docker build -f docker/Dockerfile.agy      -t <slug>-agy:latest .
```

(`pi` itself needs no separate build — `<slug>-pi-contracts:latest` above
*is* its image.)

A second project bootstrapped with a different slug builds its own
`<other-slug>-...` set and never touches these — check what actually got
built any time with `docker images | grep <slug>-`.

## 5. First login per backend (one-time)

The very first launch of each backend you use will prompt you to log in
interactively inside the container. After that, `scripts/harness-config-lib.sh`
persists the credentials under `~/.harness/config/` on this machine, so every
later launch skips the login — no env var to set yourself. Antigravity is the
one exception (not covered — see `harness-config-lib.sh`'s header for why).

**That very first login swallows the seeded `TASK`/mission message.** The
backend stops to ask you to log in before it ever processes the message
`launch-<role>.sh` queued as the session's first turn, and once you've logged
in it just sits idle — the message isn't replayed. This is a one-time
annoyance (every launch after this one, on this backend, on this machine,
skips the login and the seed message goes through normally) — just resend it
by hand once, e.g. for a planner: `Confirm your role (planner) per AGENTS.md's
dispatch table, then read MISSION.md at the repo root and begin working from
it.`

Unlike the image tags above, this directory is **shared across every
bootstrapped project on this machine, deliberately** — you log in once per
backend per machine, not once per project. If you ever want a project's
credentials kept separate instead, set `HARNESS_CONFIG_ROOT` to a
project-specific path before launching (see the script's header for the
full per-backend mechanism).

## 6. Start with the planner, not the worker

There is nothing to implement yet, so the planner is the right starting
point: it's docs-only (`docs/changes/**`, `docs/decisions/**`), so there's
nothing for it to break. Feed it the brief you wrote into `MISSION.md`
during bootstrap (or wrote yourself afterward) by reading the file whole at
launch time — this works regardless of how long or how structured it is:

```bash
cd ~/projects/my-new-project
TASK="$(cat MISSION.md)" scripts/launch-planner.sh planner-1 pi
```

(If you'd rather hand it a short one-liner instead, that works too —
`TASK="..."` is just an environment variable; a file is only needed once the
brief is longer than fits comfortably on one command line.)

If `bootstrap.sh` linked a Herdr plugin for you (see "Optional: Herdr" below),
it already printed this same command through `scripts/herdr-launch.sh`
instead — same `TASK=` prefix, just opened in a labeled pane that
auto-advances to the integrator once it settles, rather than running in the
foreground.

What happens next:

1. The planner reserves a change id (`node scripts/next-change-id.mjs
   --reserve <slug>`), which creates `docs/changes/CHANGE-0001-<slug>/` with
   a draft `change.yaml`.
2. It researches and writes `specification.md` (+ `discovery.md` if the
   mission needed real investigation first), and fills in `change.yaml`:
   `owned_paths`, `requirements`, `tests.command`, `risk`, `open_questions`.
3. If anything is genuinely ambiguous, it asks you — one blocking question at
   a time, not a dump of twenty (see `docs/changes/COORDINATION.md`).
4. Once you're happy with the spec, set `status: approved` and `branch:
   feature/CHANGE-0001-<slug>` in `change.yaml` yourself (or have the planner
   do it as its last step) and launch a worker against it:

```bash
scripts/launch-worker.sh CHANGE-0001 worker-1 pi
```

5. When the worker reaches `status: review` or `complete` with `handover`
   filled in, launch an integrator to review and merge:

```bash
scripts/launch-integrator.sh integrator-1 pi
```

`docs/changes/HOW-TO-ADD-A-FEATURE.md` is the detailed walkthrough of steps
2–5 if you want the full reasoning behind each field.

## Optional: Herdr — labeled panes, and auto-launching the next role

[Herdr](https://herdr.dev) is a separate, external pane-manager binary — not
part of this harness, and **install it once centrally on the machine**, like
you would tmux or a terminal emulator, never per project. Everything in this
harness works identically without it; both pieces below are optional
conveniences on top.

### Where `bootstrap.sh` finds the binary

In order: (1) already on `PATH`, (2) a path remembered from a *previous*
`bootstrap.sh` run, at `~/.harness/config/herdr/bin_path` — shared across
every project on this machine, same convention
`scripts/harness-config-lib.sh` uses for backend credentials — (3) it asks
you directly. If you give it a working, executable path, that path gets
remembered for step (2) on every future project. If you don't have Herdr
installed yet and say so, it offers to create a place for it:

```
~/.harness/herdr/bin/       drop the herdr binary here, named 'herdr'
~/.harness/herdr/plugins/   a staging spot for plugin sources before
                            'herdr plugin link'ing them — this project's
                            own herdr-plugin/ doesn't need moving here,
                            herdr plugin link works on it in place
```

and remembers `~/.harness/herdr/bin/herdr` as the path for next time, so
once you actually put the binary there, every project bootstrapped
afterward (this one included, if you re-run `bootstrap.sh`) finds it with
no further questions.

### `scripts/herdr-launch.sh` — labeled panes (manual)

A wrapper that labels a terminal pane per role/change when launching under
Herdr, so three worker panes don't all look like an identical "pi" process.
Resolves `HERDR_BIN` the same three-step way described above (so a human
running it directly, without `bootstrap.sh`, still benefits from the
remembered path), and falls back to just printing the plain command if none
of those three steps finds an executable file. If you run it directly with
`TASK` set (e.g. for the planner), it bakes `TASK` into the command it runs
inside the new pane — a pane is a fresh process, not a child of this script,
so it wouldn't otherwise inherit your shell's environment. Swap:

```bash
scripts/herdr-launch.sh worker CHANGE-0001 worker-1 pi
scripts/herdr-launch.sh planner planner-1 pi
scripts/herdr-launch.sh integrator integrator-1 pi
```

in place of the direct `scripts/launch-*.sh` calls — the role name comes
first, then exactly the same arguments you'd give that role's own
`launch-*.sh` script.

### `herdr-plugin/` — auto-launching the next role (no human needed to notice)

This is the other half: without it, a human still has to *notice* a
worker/integrator pane go idle and manually run the next `launch-*.sh`.
`herdr-plugin/lifecycle-watcher.mjs` reacts to Herdr's own
`pane.agent_status_changed` event and launches the next role itself — a
deterministic state machine (a regex match against the pane label + a read
of that change's `change.yaml` status field), never an LLM guessing. See
`docs/changes/COORDINATION.md`'s "Auto-launching the next role" section for
the full reasoning, and `herdr-plugin/lifecycle-watcher.mjs`'s own header
for exactly what's confirmed against Herdr's real docs vs. what the first
real launch is the actual test of (it couldn't be verified end-to-end before
now — Herdr runs on your machine, not in any sandbox this was built in).

**The binary is central; the plugin is per-project.** Herdr itself is one
shared installation. The plugin is different — it reads *this* project's
`docs/changes/` and spawns *this* project's `scripts/herdr-launch.sh`, so
`bootstrap.sh` already gave it an id namespaced to your slug
(`<slug>.lifecycle-watcher`) specifically so linking a second project's
plugin later doesn't collide with or disable this one. If you said yes when
`bootstrap.sh` asked, it's already linked and enabled. **If you skipped
that, or (the common case) installed Herdr *after* bootstrapping, run:**

```bash
scripts/herdr-setup.sh            # finds/asks for Herdr, links + enables the plugin
scripts/herdr-setup.sh --status   # just check whether it's linked/enabled already
```

This is safe to run any number of times — it's the one bootstrap.sh step
that's also its own standalone script, specifically so there's a way back to
it later instead of having to re-read bootstrap.sh's source or remember the
raw `herdr plugin link`/`enable` commands yourself.

Bounded by design: a per-change counter
(`.pi-session/herdr-lifecycle/<CHANGE-NNNN>.json`) stops auto-relaunching
after 5 attempts and sends a Herdr notification to you instead of looping
forever on a change that keeps bouncing.
