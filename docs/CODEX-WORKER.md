# OpenAI Codex CLI as a worker backend

`scripts/launch-worker.sh CHANGE-NNNN [label] codex` runs an OpenAI Codex CLI
session as a guarded worker, alongside pi (default), antigravity, and claude.
Reuses the same `pi-contracts:latest` base and the same `checks.mjs` evaluation
core as all three - `Dockerfile.codex`, `scripts/codex-guard-adapter.mjs`.

## Read this before trusting this backend with anything real

Codex's own hook system is genuinely newer and less mature than Claude Code's or
Antigravity's. Researching it surfaced a **real, open, confirmed bug** that doesn't
exist on the other two backends:

**`github.com/openai/codex#27833` (OPEN as of this writing):** a `PreToolUse` hook's
`deny` decision for `apply_patch` (Codex's one tool for all file creates/edits/
deletes) is not always enforced - the hook fires, correctly returns deny, and the
write proceeds anyway. Reported as platform-dependent: a macOS 0.147.0 comment says
deny IS enforced there; Windows reports (PowerShell hook wrapper) say it still fails
on 0.154+. This container runs Linux, which is architecturally closer to the working
macOS path than the broken Windows/PowerShell one - but Linux itself is **not**
confirmed either way in that thread.

Concretely: **this adapter can correctly compute "deny" and Codex can still write the
file anyway.** `file_boundary` is the single most important guard a worker has - it's
what keeps it from touching anything outside its `owned_paths`. Do not treat this
backend as equivalent to the other two until a real launch confirms otherwise. The
first real test MUST check the actual filesystem and `.contract-evidence.jsonl` after
attempting an out-of-bounds write, not just trust what this adapter's own JSON said.

## apply_patch sends a raw patch string, not a clean path - this adapter parses it

Unlike Claude Code (separate Write/Edit/MultiEdit tools with clean `file_path` fields)
or Antigravity (`TargetFile`), Codex has **one** tool, `apply_patch`, for every file
create/edit/delete, and its `tool_input.command` field holds a raw OpenAI-format patch
string (`*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:`
/ `*** Move to:` / `*** End Patch`), confirmed structurally via
`platform.openai.com/docs/guides/tools-apply-patch`, not independently verified
against a captured real envelope from this exact Codex version.

`codex-guard-adapter.mjs`'s `extractPatchPaths()` parses every touched path out of
that text. A single `apply_patch` call can touch **several different files** in one
patch - unlike Claude Code's MultiEdit (many edits, one file) - so this adapter
evaluates every extracted path through `file_boundary`, denying the whole call if
**any** path violates. The first path uses the real, persisted tool-call counters (the
one genuine tool-call-budget event this Codex call represents); additional paths in
the same patch use a disposable counters clone, so a 3-file patch still counts as one
call for `tool_call_limit` purposes while every file still gets a real boundary check.
An unparseable patch (marker syntax doesn't match) fails closed - denied via a
synthetic path that matches nothing, not silently allowed. Verified end-to-end against
the real `checks.mjs` (not a copy): single-file inside bounds (allow), multi-file with
one path outside bounds (deny, names the actual violating path), unparseable patch
(deny), and a `Bash` `command_forbidden` deny.

## Where the hook config lives, and why

`~/.codex/hooks.json` (user-level), **not** `<repo>/.codex/hooks.json` (project-level).
Confirmed: project-level hooks only load once that project's `.codex/` layer is
explicitly trusted via Codex's own in-session `/hooks` command - a freshly-launched,
unattended container has no human present to grant that. User-level hooks load
unconditionally. Mounted as a **single file** (no `--settings`-style flag exists for
Codex, unlike Claude Code) - `Dockerfile.codex` pre-creates `~/.codex/` as the `node`
user so the bind-mount target isn't root-owned (the ownership bug the antigravity
backend hit). The EBUSY/atomic-rename class of bug (the antigravity backend's *other*
real bug) is believed not to apply here, because hooks.json is config Codex reads, not
state it rewrites at runtime - **unverified either way**; if a real launch proves
otherwise, the fix is the same one already used twice: move to a dedicated
subdirectory mount.

`--dangerously-bypass-approvals-and-sandbox` is used directly, for the same reason as
Claude Code's `--dangerously-skip-permissions`: Codex's docs state hooks and the
approval/sandbox layer are separate systems. Weaker confidence than the claude
backend's equivalent claim, though - that was one direct sentence ("bypasses the
permission system but does not disable hooks"); this is an **inference** from two
separately-confirmed facts, not one statement tying the specific flag to hooks
explicitly.

## Verified vs. not yet verified

**Verified in this sandbox** (no docker here): `bash -n`; `--dry-run` for all four
backends (pi/antigravity/claude unchanged, codex produces correct banner + docker
args); the generated `hooks.json` content verified directly (valid JSON, correct
absolute paths) via a standalone reproduction, since every approved change already has
a live worktree from real in-progress work. `codex-guard-adapter.mjs`'s `--selftest`
passes, and its full `main()` path was exercised against the real `checks.mjs` for
single-file allow, multi-file deny (naming the actual violating path), unparseable
patch (fail-closed deny), and a `Bash` deny.

**Confirmed by a real build attempt (2026-10-09):** `npm install -g @openai/codex` fails
EACCES when run as the `node` user - `pi-contracts:latest`'s global npm prefix
(`/usr/local/lib/node_modules`) is root-owned, same as any stock node image. Fixed:
install as `root` (global packages don't need to be owned by whoever runs them later,
only readable), then switch to `node` for the `~/.codex/` mount-target pre-creation,
which DOES need to be node-owned.

**Confirmed by a real launch attempt (2026-10-10), past the build:** past guard
compilation and worktree setup, `codex` itself failed to start - it tries to launch a
background "app-server" process and track its PID via `ps`, which isn't installed in
this minimal image (`procps` is not part of `pi-contracts:latest`): `"failed to invoke
ps for pid-managed app server: No such file or directory"`. Codex's own error names
`--no-daemon` as the fix. Added it to the launch args rather than installing `procps` -
this container is a single foreground session per launch (`--rm`, no resume/background-
session use from this launcher), so there's no reason to want the daemon at all.

**Confirmed by a real launch attempt (2026-10-10), past the daemon fix - the hook schema
question resolved:** `Hook failed: PreToolUse hook returned unsupported
permissionDecision:allow`. This settles an ambiguity flagged but not resolved during
research: the FIRST pass on Codex's hooks (agenticcontrolplane.com) found "only
`permissionDecision: 'deny'` is operational... parses but rejects allow and ask"; a
LATER, more detailed fetch (developers.openai.com/codex/hooks) listed `allow` as
documented too, so the adapter went with Claude Code's explicit-allow shape for both.
The real error confirms the FIRST source was right for Codex specifically. Fixed:
`toDecision()` now returns `null` for "not blocked", and `done()` prints nothing at all
in that case (exit 0, empty stdout) - the same convention both vendors' own example hook
scripts use for "no opinion, continue normally," rather than an explicit allow decision.
Claude Code's own first-party docs DO explicitly support `allow` as a value, so
`claude-guard-adapter.mjs` is untouched - this was a Codex-only quirk, not a shared one.

**NOT yet verified - check on the first real launch, roughly in priority order:**
- **The apply_patch deny-enforcement bug (#27833) on Linux specifically** - this is
  the one that matters most. If deny isn't enforced here either, this backend cannot
  be trusted for file_boundary until upstream fixes it, no matter how correct this
  adapter's own logic is.
- The exact `apply_patch` patch marker syntax (`Add/Update/Delete File`, `Move to`) -
  inferred/cross-referenced, not confirmed against a real captured envelope. If wrong,
  `extractPatchPaths()` returns zero paths and this adapter fails closed (denies
  everything), which is at least the safe failure direction.
- That `--dangerously-bypass-approvals-and-sandbox` really does leave hooks running -
  inferred, not a single direct statement (see above).
- `HERDR_AGENT_DEFAULT="codex"` - no Herdr detection manifest for this backend has been
  confirmed. Override with `HERDR_AGENT=` if Herdr doesn't recognize it.
- `unified_exec` mapping to `bash` - seen named in a GitHub issue thread as a second
  shell-exec tool alongside `Bash`, not in any schema dump.
- The hooks.json-is-read-only-not-rewritten assumption behind using a single-file
  mount at all (see above).
- Authentication: `OPENAI_API_KEY` is passed through if set in the host shell: not
  exercised here.

First real test to run once a real launch happens: same methodology as the earlier
codemode guard-visibility test - write to a path outside `owned_paths` via a real
`apply_patch` call, confirm it's denied **and the file never lands**, via both
`.contract-evidence.jsonl` and the actual filesystem - not via trusting what the model
or this adapter reports happened. Given #27833, checking the filesystem directly is
not optional caution here, it is the actual open question.

## Also used by the planner and integrator roles (2026-10-10)

`scripts/launch-planner.sh [name] codex` and `scripts/launch-integrator.sh <name> codex`
reuse this SAME image (`harness-codex:latest`) and `codex-guard-adapter.mjs` unmodified -
only `REPO_ROOT` differs per role, same reasoning as the claude backend. The apply_patch
deny-enforcement concern (#27833) matters less for the integrator specifically - its own
compiled guards don't include `file_boundary` at all, only `integrator_merge_gate`/
`lock_required_for_write`, both keyed on `bash` - but it's still not nothing. The
`/change-review` panel gap is the same as claude's: pi-subagents-only, so a codex-backed
integrator reviews directly and records the verdict with
`scripts/record-review-verdict.mjs` instead.
