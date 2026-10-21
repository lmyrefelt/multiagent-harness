# Claude Code CLI as a worker backend

`scripts/launch-worker.sh CHANGE-NNNN [label] claude` runs a Claude Code CLI session
as a guarded worker, alongside the existing pi (default) and antigravity backends.
Reuses the same `pi-contracts:latest` base and the same `checks.mjs` evaluation core
as both of those - `Dockerfile.claude`, `scripts/claude-guard-adapter.mjs`.

## What's simpler here than the antigravity backend

Two real bugs hit the antigravity backend in practice: a bind-mount target
root-owned because `Dockerfile.agy` never pre-created it, and an EBUSY atomic-rename
failure because a single-file bind mount pins the container path to a fixed host
inode. Both are sidestepped here **by construction**, not by being more careful:

- **No bind mount for the hook config at all.** Claude Code's `--settings <path>`
  flag (confirmed: `code.claude.com/docs/en/cli-reference`, fetched directly) reads
  a plain file and layers its keys over the session's other settings. The file is
  generated straight into the worktree's session dir, already on the whole-repo
  `/repo` mount - no separate mount, no directory-vs-file decision to get wrong.
- **`--dangerously-skip-permissions` is used directly.** Unlike Antigravity (where
  the equivalent flag disables the `PreToolUse` hook layer entirely, forcing the
  permissions-preset workaround in the antigravity backend), Claude Code's own docs
  confirm (`code.claude.com/docs/en/hooks`, fetched directly): "The
  `--dangerously-skip-permissions` flag bypasses the permission system but does not
  disable hooks." The hook still enforces everything; the flag only removes the now-
  redundant interactive prompts for an unattended container session.

## The adapter is closer to a pass-through than a translation

`antigravity-guard-adapter.mjs` had to rename several fields (`CommandLine` ->
`command`, `TargetFile` -> `path`, etc.) because Antigravity's own tool-call shape
doesn't match `checks.mjs`'s expectations. Claude Code's native `tool_input` field
names - `file_path`, `old_string`/`new_string`, `edits: [...]` - turned out to
**already be accepted by `checks.mjs` itself** as synonyms (confirmed by reading
`checks.mjs` directly, not assumed): `file_boundary`/`path_protected` accept
`input.path ?? input.file_path ?? input.filePath`, and the edit-diff simulator
accepts `oldText ?? old_string` / `newText ?? new_string`, with `multiedit` already
expecting an `edits` array of exactly that shape. So `claude-guard-adapter.mjs`
barely renames anything - verified end-to-end against the real `checks.mjs` (not a
copy), both a `file_boundary` deny and a `command_forbidden` deny, before this was
ever wired into `launch-worker.sh`.

## Verified vs. not yet verified

**Verified in this sandbox** (no docker here): `bash -n`; `--dry-run` for all three
backends (pi unchanged, antigravity unchanged, claude produces correct banner +
docker args); a real non-dry run against a faked `docker` binary for the pi/
antigravity paths in earlier work; the claude branch's generated `settings.json`
content was verified directly (valid JSON, correctly interpolated absolute
`CONTRACT_GUARDS`/`CONTRACT_EVIDENCE`/`REPO_ROOT` paths) via a standalone
reproduction of its heredoc, since no existing approved change had a free branch to
launch a full non-dry run against without colliding with real in-progress worktrees.
`claude-guard-adapter.mjs`'s own `--selftest` passes, and its `main()` path was
exercised directly (stdin envelope in, decision out) against the real `checks.mjs`
for both a deny and an allow case, for both an `Edit` (`file_boundary`) and a `Bash`
(`command_forbidden`) tool call.

**NOT yet verified - check on the first real launch:**
- That `npm`'s alternative install path isn't needed - `Dockerfile.claude` uses the
  native curl installer (`claude.ai/install.sh`, confirmed official, same shape as
  Antigravity's install in `Dockerfile.agy`), not `npm install -g @anthropic-ai/claude-code`
  (also confirmed official, but not what's wired in).
- That the hook subprocess actually receives the env vars embedded in its command
  string - the same open question already flagged for the antigravity backend's own
  adapter; same mitigation (fails closed if `CONTRACT_GUARDS` doesn't resolve).
- `NotebookEdit`'s exact path field name (guessed `notebook_path`, falls back to
  `file_path`) - the fetched docs only detailed Bash/Write/Edit/Read, not this one.
- `HERDR_AGENT_DEFAULT="claude"` - no Herdr detection manifest for this backend has
  been confirmed (unlike `pi`/`antigravity-cli`, which came from this project's own
  earlier testing). Override with `HERDR_AGENT=` if Herdr doesn't recognize it.
- Authentication in the container: `ANTHROPIC_API_KEY` is passed through if set in
  the host shell (matching the docs: "If you've set the `ANTHROPIC_API_KEY`
  environment variable and you approve the key when Claude Code asks," which may
  mean a one-time interactive approval on first run - not a blocker for an
  interactive `docker run -it` session, but not exercised here either).

First real test to run once a real launch happens: same methodology as the earlier
codemode guard-visibility test - write to a path outside `owned_paths`, confirm it's
denied and the file never lands, via `.contract-evidence.jsonl`, not via trusting
what the model reports happened.

## Also used by the planner and integrator roles (2026-10-10)

`scripts/launch-planner.sh [name] claude` and `scripts/launch-integrator.sh <name> claude`
reuse this SAME image (`harness-claude:latest`) and `claude-guard-adapter.mjs` unmodified -
only `REPO_ROOT` differs per role (the planner's own worktree root, like the worker;
`/repo` directly for the integrator, which shares the one main checkout). One real gap:
the integrator's `/change-review` panel (`CHANGE-REVIEW.md`) is dispatched via
pi-subagents, a pi-only mechanism - a claude-backed integrator is seeded to review
against the same criteria directly and record the verdict with
`scripts/record-review-verdict.mjs` instead, not through the panel.
