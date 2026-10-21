# OpenCode CLI as a worker backend

`scripts/launch-worker.sh CHANGE-NNNN [label] opencode` runs an OpenCode CLI session as
a guarded worker, alongside pi (default), antigravity, claude, and codex. The motivating
reason for this one specifically: **OpenCode Zen**, a hosted model marketplace with a
genuine free tier (several free models, rate-limited, no card required) - this backend
exists to make those usable the same guarded way every other backend already is.

## This backend is architecturally different from the other three - read this first

Antigravity/Claude Code/Codex's hook systems are all an **external-process protocol**:
the host CLI spawns a fresh `node adapter.mjs` per tool call, feeds it a JSON envelope
on stdin, reads a JSON decision off stdout. OpenCode's hook system is an **in-process
plugin** instead (confirmed: `opencode.ai/docs/build/plugins`, fetched directly): a
JS/TS module loaded by the `opencode` binary itself at startup, auto-discovered from
`.opencode/plugins/` in the project directory. A `tool.execute.before` hook fires before
a tool runs and can block it by **throwing an Error** - there is no decision-object
schema to get wrong, which sidesteps the exact class of bug that hit the codex backend
(`permissionDecision:"allow"` rejected outright - see `docs/changes/CODEX-WORKER.md`).

Consequence: **no bind mount at all** for the guard wiring. `scripts/opencode-guard-
adapter.mjs` holds the reusable translation logic (`toCanonicalEvent`, `makeGuardHook`),
committed once; `launch-worker.sh` generates a tiny per-launch file
(`<worktree>/.opencode/plugins/harness-guard.mjs`) that imports it directly off the
already-mounted `/repo` volume and bakes in the two things that differ per launch
(the compiled `guards.json` path, `repoRoot`). No `Dockerfile.opencode` mount-target
pre-creation is needed for the guard itself, unlike every other backend.

## Field-name translation - confirmed via real bug reports, not a schema dump

OpenCode's own docs don't publish a field-by-field schema for its built-in tools the way
Claude Code's do. The `edit` tool's real fields - **`filePath`, `oldString`, `newString`**
- were confirmed instead by cross-referencing real GitHub issue titles against
`anomalyco/opencode` ("oldString not found", "empty oldString", `EditTool` at
`packages/opencode/src/tool/edit.ts`), not a single authoritative dump. `filePath` is
already one of `checks.mjs`'s existing accepted synonyms (`input.path ?? input.file_path
?? input.filePath`) - no rename needed there, same lucky situation Claude Code had. But
`oldString`/`newString` (camelCase, no underscore) are **not** already recognised
(`checks.mjs` only accepts `oldText`/`old_string`) - this adapter explicitly renames
those two. Verified against the real `checks.mjs` engine directly, not just the
adapter's own unit test: an `edit` call outside `owned_paths` throws with the real
violation reason; one inside does not throw.

`write`/`read`/`bash`'s exact field names (`content`, `command`) are ecosystem-standard
high-confidence guesses, not individually confirmed the way `edit`'s were.

## Why there's no custom `opencode.json` permissions file

Antigravity needed a hand-curated `allow`/`ask`/`deny` baseline to reduce interactive
prompts for routine ops (see `docs/changes/ANTIGRAVITY-WORKER.md` and
`scripts/antigravity-permissions-baseline.json`). OpenCode's own `--auto` flag
("auto-approve permissions that are not explicitly denied," confirmed:
`opencode.ai/docs/cli/`) already does the same job at the CLI level, no config file
needed. OpenCode's actual permission-JSON schema (nested per-tool vs a flat
pattern-string map - sources disagreed) was not confirmed cleanly enough during research
to risk shipping a guessed one anyway - a malformed config could fail `opencode`'s own
startup outright, a harder failure than a few extra prompts would be. `--auto` plus the
real plugin-level enforcement (which blocks regardless, same hook-vs-permission-layer
separation inferred for Codex) is the whole story for this backend's "reduce prompts"
layer.

## Auth - `OPENCODE_CONFIG_DIR`, mirroring `PI_CONFIG_DIR`

OpenCode stores credentials at `~/.local/share/opencode/auth.json`, written by its own
interactive `opencode auth login` / `/connect` flow - something an unattended container
has no one present to run. `OPENCODE_CONFIG_DIR=<path>` **directory**-mounts that path
onto `/home/node/.local/share/opencode` (not a single-file mount - the same EBUSY lesson
the antigravity backend already paid for once: a token refresh rewriting `auth.json`
atomically would hit the identical failure a single-file mount did there). Losing other
state under that directory (session history, logs) across launches is not a regression -
no other backend persists that across its own `--rm` containers either. To set up: run
`opencode auth login` once anywhere (a throwaway container is fine), point
`OPENCODE_CONFIG_DIR` at the directory holding the resulting `auth.json`.

## Verified vs. not yet verified

**Verified in this sandbox** (no docker here): `bash -n`; `--dry-run` for all five
backends (pi/antigravity/claude/codex unchanged, opencode produces correct banner +
docker args); the generated plugin file's syntax (`node --check`) and its full logic
exercised end-to-end against the real `checks.mjs` engine (not a copy, not a mock) using
locally-resolvable path substitutes for the container-only `/repo` paths - an `edit`
inside `owned_paths` doesn't throw, one outside does, naming the real violation.
`opencode-guard-adapter.mjs`'s own `--selftest` passes, including the defensive dual-read
of `.args` (see below).

**NOT yet verified - check on the first real launch, roughly in priority order:**
- **Which parameter carries `.args`.** Two independently fetched sources disagreed - one
  said `output.args` (mutable), a community gist claimed `input.args.command`. The
  adapter reads both defensively (`output?.args ?? input?.args ?? {}`), so it should work
  either way, but this is the single most important thing to confirm on a real launch -
  if OpenCode uses some THIRD shape neither source described, the guard would see empty
  args for every call and nothing would ever match a path-based guard.
- Whether `tool.execute.before` actually fires regardless of `--auto` or a tool that a
  static (absent, here) `opencode.json` rule would otherwise auto-allow - inferred from
  the same hook/permission-layer separation pattern confirmed for Claude Code and codex,
  not independently confirmed for OpenCode specifically.
- Whether Bun (OpenCode's own runtime) can dynamically `import()` a plain Node ESM file
  (`checks.mjs`) with no Bun-specific syntax required - high confidence (Bun's Node-API
  compatibility is extensive and well-established) but not run here.
- `write`/`read`/`bash`'s exact field names, as noted above.
- `HERDR_AGENT_DEFAULT="opencode"` - no Herdr detection manifest for this backend has
  been confirmed, same caveat as every other non-pi backend.
- The exact OpenCode Zen provider slug for `opencode auth login --provider <id>` - not
  pinned down during research; the login flow's own prompts should make this obvious
  either way.

First real test to run once a real launch happens: same methodology as the other three -
attempt a write outside `owned_paths`, confirm it's denied **and the file never lands**,
via both `.contract-evidence.jsonl` and the actual filesystem.
