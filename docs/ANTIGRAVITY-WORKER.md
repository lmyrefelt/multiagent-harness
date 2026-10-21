# Antigravity as a worker backend

`scripts/launch-worker.sh CHANGE-NNNN [label] antigravity` runs an Antigravity CLI
session as a guarded worker, alongside the existing pi backend (default, unchanged).
Reuses infrastructure the integrator backend already proved out, rather than building
a second one: `scripts/antigravity-guard-adapter.mjs`, `Dockerfile.agy` (→
`harness-agy:latest`, itself `FROM pi-contracts:latest` — same dev toolchain, Python/Node/
uv/pytest/pyright and the real project dependencies, just with the Antigravity binary
added on top, so "does it have what it needs to build and code" was already true before
this change).

## What's different from the integrator backend

The integrator operates on the main checkout directly (`-w /repo`, not path-fenced — its
real guard is `integrator_merge_gate`, which inspects the actual `git merge` command).
A worker is fenced to `owned_paths` via `file_boundary`, and runs in its own worktree
(`-w /repo/$WT_REL`), so the hook's `REPO_ROOT` must be the **worktree root**
(`/repo/$WT_REL`), not `/repo` — otherwise `file_boundary`'s path normalization would be
relative to the wrong root and every path would look out-of-bounds (or none would,
depending on which way the mismatch breaks). `CONTRACT_GUARDS`/`CONTRACT_EVIDENCE` must
be absolute paths too — `antigravity-guard-adapter.mjs` reads them directly with no
`resolve()`, confirmed by reading its source, not assumed from the integrator's version.

## The permissions settings.json (new, not something the integrator wiring had)

Generated fresh per launch alongside the hooks file, mounted to
`/home/node/.gemini/antigravity-cli/settings.json`. Exists to reduce interactive
approval prompts for routine operations (file writes under `apps/`/`docs/changes/`,
common build/test commands, basic git) without weakening enforcement — confirmed
(agenticcontrolplane.com/blog/antigravity-permissions-reference): the `PreToolUse` hook
runs **before** the permission-preset layer and is not bypassed by it; "your three lists
still apply to whatever the hook allows through." Only `--dangerously-skip-permissions`
bypasses the hook itself (confirmed separately, same research pass: Antigravity's docs
state the hook layer is "completely bypassed" by that flag, unlike Claude Code, where
hooks survive it) — which is exactly why that flag is deliberately not used anywhere in
this wiring, even though it was the original ask that prompted this whole investigation.

The shipped `allow`/`ask`/`deny` lists are a starting point, not a tuned final list —
expect to adjust the `allow` patterns as real use shows what still prompts unnecessarily.

**Update (2026-10-10): moved to a shared, version-controlled baseline, and a real finding
about how `regex:` matching actually behaves.** The list used to be embedded directly in
`launch-worker.sh`'s heredoc, generated fresh (but identical) every launch. It now lives in
`scripts/antigravity-permissions-baseline.json` - a single source of truth copied as-is into
every launch (the content is fully static, nothing in it is per-worktree) - specifically so
it can be curated over time without touching the launcher script, and so it reflects what
**real sessions actually needed**, not just what seemed reasonable to write by hand.

Inspecting two real completed sessions' own `settings.json` (CHANGE-0063, CHANGE-0073 -
Antigravity itself appends an `allow` entry there whenever the agent approves a prompt, plus
a `trustedWorkspaces` key - confirms the directory-mount fix from the earlier EBUSY incident
holds up under real, repeated rewrites) surfaced a real, unflattering finding: **the `regex:`
pattern already present and active, `command(regex:uv run .*)`, did NOT reliably suppress
prompts for a real multi-token command** - the agent still had to get five separate *exact*
`uv run --frozen --project apps/api pytest <specific file> -q`/`-v` invocations individually
approved, each one differing only by a trailing flag. A single trailing `.*` does not appear
to swallow an arbitrary number of trailing tokens the way the third-party reference I'd
fetched earlier claimed ("prefix matching... command(git) matches git status, git log
--oneline"). Real evidence beats a fetched summary - the regex entries in the baseline file
now are a low-cost secondary attempt, not something to trust as the primary fix.

The baseline's actually-proven-to-work half is the **literal, harvested entries** -
`scripts/harvest-antigravity-permissions.mjs` scans every real `.pi-session/*/gemini-
antigravity-cli/settings.json` under `.worktrees/`, diffs their `allow[]` against the current
baseline, and prints what's new for a human to review (never auto-merges - a session's
one-off noise, like an exact test file path or a hardcoded DB connection string, must not
silently become a standing "always allow" for every future change). Run it periodically as
more real sessions accumulate:

```
node scripts/harvest-antigravity-permissions.mjs
```

Also confirmed real and genuinely gap-closing: this repo's actual `tests.command` values are
shaped `pnpm --filter harness-web test ...` / `corepack pnpm --filter harness-web test ...` (grepped
across `docs/changes/*/change.yaml`, not guessed) - the original `pnpm (run|install|test) .*`
pattern never matched either of those, since `--filter` sits where it expected `run`/
`install`/`test` as the very next token. That's likely the single biggest source of
unnecessary prompts this fixed, bigger than the `git diff` case that prompted looking at this
at all.

**Update (2026-10-10, same day): the curated-baseline approach itself was the wrong strategy,
not just under-tuned - abandoned in favor of maximal `allow` + a narrow `deny`.** Re-running
`scripts/harvest-antigravity-permissions.mjs` after the above fixes landed showed the problem
hadn't actually gone away: the harvested `allow[]` entries included `command(*)` and
`command(*.*)` themselves (an agent had to get a WILDCARD individually approved), plus dozens
more one-off exact commands (`git fetch`, `git branch`, `ls`, `grep`, `ps`, `which`, ...) across
just two real sessions. Every attempt at a curated or regex-pattern allow-list - narrow, then
widened, twice - kept missing real invocations, because guessing how the matcher works had
already been shown wrong once (the `uv run .*` finding above) and evidently still was.

The actual fix: stop trying to out-guess the matcher. The REAL enforcement for a worker has
never been this file - it's the `PreToolUse` hook (`antigravity-guard-adapter.mjs` →
`checks.mjs`'s `file_boundary`/`command_forbidden`), confirmed repeatedly to run before this
permission layer and not be bypassed by it. This file has only ever controlled whether a
prompt appears, not what's actually permitted to execute. So the baseline is now just:

```json
{
  "permissions": {
    "allow": ["command(*)", "write_file(*)"],
    "deny": [
      "command(rm -rf)", "command(sudo)",
      "command(regex:git (push|reset|rebase|merge).*)",
      "write_file(.git/)"
    ]
  }
}
```

Everything not explicitly denied is now allowed without a prompt. The small `deny` list is
defense-in-depth on top of the hook, not the primary safety boundary - same role the `deny`
list already played even in the old, narrower design. The one real, unverified assumption this
now leans on harder than before: that the hook genuinely fires regardless of this permission
layer's contents, for every tool call, not just the ones this project happened to test. That
was confirmed via Antigravity's own docs, not independently stress-tested against an
adversarial case - worth keeping an eye on, same honesty standard as everything else in this
file.

`scripts/harvest-antigravity-permissions.mjs` still exists and still works, but its usefulness
shifts: there's no longer an `allow` list to grow by curation, since `command(*)`/`write_file(*)`
already covers everything. It'd mainly be useful again if the `deny` list is ever tightened and
something legitimate starts getting denied instead of just prompted.

## Verified vs. not yet verified

**Verified in this sandbox** (no docker here, so this is as far as it goes without a
real launch): `bash -n` syntax check; `--dry-run` for both backends, confirming the `pi`
path is byte-for-byte unchanged (regression check) and the `antigravity` path produces
correct banner output and docker args; a full non-dry run against a faked `docker`
binary (image-inspect and container-inspect stubbed), confirming the worktree is created
correctly (`--lock`'d), `preflight-change.mjs` passes once on the right branch, guards.json
compiles, and the generated `antigravity-hooks.json`/`antigravity-permissions.json` have
exactly the expected absolute paths and content.

**Confirmed by a real launch attempt (2026-10-09), superseding some of the above:**
`harness-agy:latest` does build, and the Antigravity binary does install and start up far
enough to try writing its own files - which is how a real, concrete bug surfaced:
`Dockerfile.agy`'s existing `RUN mkdir -p /home/node/.gemini/config` (for the hooks.json
mount) was never extended to the NEW `antigravity-cli/` mount target added for the
permissions settings.json. Docker auto-creates a missing bind-mount parent directory as
**root** before the container's own user ever runs - so `antigravity-cli/` ended up
root-owned, and the `node` user (who runs the actual `agy` process) couldn't write its
own `log/`, `crashes/`, or `installation_id` inside it. Permission denied on all three,
exactly the gotcha the file's own comment already named for the *other* mount target,
just not re-applied when this one was added. Fixed: added the matching
`RUN mkdir -p /home/node/.gemini/antigravity-cli` (as the `node` user, same place).

**Second real bug, same relaunch session:** past the ownership fix, Antigravity failed
writing `settings.json` with `atomic rename ...settings.json.<uuid>.tmp -> setti[ngs.json]`
/ "Nothing has been written to your file yet." A different, more structural problem -
Antigravity writes its config via write-temp-then-`rename()`-over-target, a normal and
otherwise-correct atomic-write pattern, but `launch-worker.sh` was bind-mounting
`hooks.json`/`settings.json` as **single files**. A single-file bind mount pins the
container path to the host file's specific inode at mount time, and Linux refuses
`rename()` onto an active mount point (`EBUSY`) - confirmed as a well-documented Docker
limitation via multiple independent real-world GitHub issues hitting the exact same
failure with other CLIs that write config the same way (vllm-project/semantic-router#4027,
stacklok/toolhive#3979, SolidActions/solidactions-cli#129, markokajzer/discord-soundbot#186,
agent-lore/lithos-loom#406, noogram/cosmon#113), not guessed. Fixed: each file now gets its
own per-launch subdirectory (`$SESSION_REL/gemini-config/hooks.json`,
`$SESSION_REL/gemini-antigravity-cli/settings.json`), and the **subdirectory** - not the
file - is what's bind-mounted onto `/home/node/.gemini/config` and
`/home/node/.gemini/antigravity-cli` respectively. A directory mount tracks entries, not a
fixed inode, so `rename()`-within-the-mounted-directory works normally. Verified (faked
`docker`, non-dry run): the two subdirectories and files are created with the expected
content, and the generated `docker run` args show directory mounts, not file mounts - real
docker/Antigravity startup still needed to confirm this closes the EBUSY error itself.

## Seeding the first turn (`-i`/`--prompt-interactive`)

Same orientation message pi gets as a trailing positional arg, passed instead as
`agy -i "$SEED"` - confirmed only via two independent third-party sources (a dev.to
hands-on guide and agy cheat-sheet references), explicitly NOT by reading `agy --help`
directly (no docker in this sandbox). If real usage shows the flag name or behavior is
wrong, the banner still prints the seed text so it can be pasted by hand as a fallback.

**Still not yet verified:**
- That `-i`'s real behavior matches what the third-party docs describe (initial prompt,
  then stays interactive) - first real launch should confirm the session actually opens
  with the seed message already asked, not silently ignored or treated as one-shot.
- That the `PreToolUse` hook subprocess actually receives the env vars set in its command
  string (this is the exact thing `antigravity-guard-adapter.mjs`'s own header already
  flags as assumed-not-verified for the integrator backend too - the same open question,
  not a new one introduced here).
- That `file_boundary` actually fires correctly end-to-end for a worker-shaped tool call
  (write/edit outside `owned_paths` → denied) - the integrator never exercised this path,
  since its own guard set deliberately has no `file_boundary` at all.
- That the permissions settings.json actually reduces prompting the way its cited source
  describes, in practice, for this specific CLI version.

First real test to run once a real launch happens: same methodology as the codemode
guard-visibility test earlier - write to a path outside `owned_paths`, confirm it's
denied and the file never lands, via `.contract-evidence.jsonl`, not via trusting what the
model reports happened.
