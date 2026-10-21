# Running a worker under tool-call guards

The git hooks (`pre-commit` boundary, `pre-push` evidence) only fire on a feature branch
at commit/push — a local worker that edits the working tree without committing dodges them
(as CHANGE-0003's first attempt did). This closes that gap: the boundary is also enforced
**inside PI, at the moment of the write (`tool_call`)**, where it cannot be dodged.

## How it works

`change.yaml` stays the single source of truth. Before launching a worker, compile its
boundary into the pi-contracts guard format:

```bash
node scripts/compile-change-guards.mjs CHANGE-0003 --out /tmp/CHANGE-0003.guards.json
```

Assert the worker will start on the right branch (hardening #8) — it exits non-zero unless
HEAD is the change's feature branch, refusing to start on `main` where a worker could edit the
tree and dodge the hooks:

```bash
node scripts/preflight-change.mjs CHANGE-0003 && <launch>
```

Then launch the worker inside the pi-contracts `contract-guard` harness (see
`pi-agentic` RUNBOOK — oMLX serves the model on the Mac; the container runs the guard)
with that `guards.json` loaded. The guard then enforces, at every `tool_call`:

- **`file_boundary`** — `write`/`edit` only inside the change's `owned_paths` (+ its own
  change folder). Everything else is blocked.
- **`path_protected`** — `forbidden_paths` are refused.
- **`command_forbidden`** — `bash` may not wander branches, rewrite history, push,
  install dependencies ad-hoc, or run destructive ops. Dependencies go through the change
  (a boundary update + justification), never a raw `pip install`.
  **Carved out (2026-10-10):** a worker hitting a genuinely missing SYSTEM tool (not a
  project dependency) can fix it itself - `npm install -g <tool>` / `pnpm add -g <tool>` /
  `yarn add -g <tool>` (anywhere `-g`/`--global` appears in the command), `uv tool install
  <cli>` (never blocked at all - uv's own isolated-venv tool installer, touches nothing in
  the project), and `corepack enable`/`corepack prepare` (also never blocked). The line is
  "does this touch the project's own dependency manifest" - `npm install lodash`, `pnpm add
  react`, `uv add requests`, `pip install`, `poetry add` all still fully block, since those
  silently add an unreviewed dependency to the change instead of going through a boundary
  update. See `scripts/compile-change-guards.mjs`'s `BLOCKED_CMD` comment and `--selftest`
  for the 17 cases this is verified against directly.
  **Real block hit the same day:** `corepack pnpm install --frozen-lockfile` (a lockfile
  sync, no new dependency) was blocked anyway - two bugs, both fixed: (1) `npm\s+install`
  had no leading word boundary, so it matched the TAIL of "pnpm install" (`pnpm` is
  literally `p` + `npm`); (2) a completely bare `npm install`/`npm i` (npm's own
  lockfile-sync form - it has no separate "add" verb) was still blocked even with no
  dangerous flag present. Bare installs and `--frozen-lockfile`/`--ci` are now also
  treated the same as `-g`/`--global` - none of them touch the project's dependency
  manifest, only `npm install <actual-package-name>` does.
  **Real block hit 2026-10-11:** `git show HEAD:path/to/foo.py > /tmp/foo.py` (a
  read-only dump of a committed file for inspection, not a write-bypass) was blocked
  anyway and exhausted the run's whole refusal budget on it - the redirect-into-a-
  source-file pattern matched the EXTENSION anywhere in the command with no path
  scoping at all, so any redirect ending in `.py`/`.ts`/etc. tripped it regardless of
  destination. Fixed: the pattern now excludes `/tmp/` destinations specifically - a
  redirect into the repo itself (`>> apps/api/src/harness/foo.py`) still blocks exactly as
  before; only `/tmp/` is exempted, since it has no `owned_paths` meaning at all.

- **`tool_call_budget`** (`tool_call_limit`, 400 calls — raised from 250 on 2026-10-10)
  — a hard ceiling on total tool calls per run, counting completion-gate continuations.
  This is an OOM/runaway backstop, not a loop detector: it was raised because `CHANGE-0075`
  and `CHANGE-0077` were both cut off mid-implementation at 250 with real, non-looping
  progress still uncommitted.
- **`no_progress_loop`** (added 2026-10-10, same day as the budget raise, as the actual
  loop detector the budget raise couldn't be) — blocks when the *identical* mutating call
  (same tool + path + before/after content) repeats more than 3 times within a trailing
  window of 20 mutating calls. Scoped to `edit`/`write` only: rerunning the same test
  command is the normal RED→GREEN loop and must never trip this. **Status: unit-tested
  (`pi-contracts-research/prototype/verify-guards.mjs`, 4 dedicated cases) but not yet
  replayed against a real stuck run** — unlike the three guards above, it has not fired
  live in production yet. Treat it the way `## Verified` below treats the settle gate: the
  logic is verified, confirming it fires live is still open.
- **`redundant_test_rerun`** (added 2026-10-12, a deliberately SEPARATE guard from
  `no_progress_loop`, not a variant of it) — blocks when the identical test/build
  command is rerun with **zero mutating calls** (no `edit`/`write`) since its last run.
  `no_progress_loop` exempts bash test reruns entirely, because the normal RED→GREEN
  loop always has an edit between two test runs; this catches the narrower case that
  exemption can't — rerunning the exact same command with nothing changed, which reruns
  the same inputs and learns nothing new. Inspired by a named red flag in a third-party
  agent-skills review ("running the same build/test command twice without intervening
  changes"). **Status: unit-tested (6 dedicated cases) but not yet replayed against a
  real stuck run**, same caveat as `no_progress_loop` above.

And at run end (`agent_before_settle`):

- **`evidence_captured`** — the worker may not settle claiming "done/complete" unless the
  change's `tests.command` actually ran and **passed**, read from the transcript — not from
  the model's word. A completion claim over un-run or failing tests sends the run back rather
  than letting it end. This is the gate that would have stopped CHANGE-0003's
  `IMPLEMENTATION_COMPLETE.md`-over-broken-code. (It fires only when the change names a
  runnable `tests.command`.)

Regenerate the guards.json before each launch; it is a build artifact, not committed —
`change.yaml` is authoritative.

## When a run gets stopped entirely (the hard stop)

Separate from the per-call guards above: `contract-guard.ts` (not a per-change guard —
hardcoded once, applies to every run) counts refusals and escalates from *refusing* to
*stopping the run outright* (`ToolCallEventResult.terminate`) once either cap is hit:

- **5 consecutive refusals** — the model flailed against the same wall without noticing.
- **10 refusals within a trailing window** (2026-10-11: now **windowed**, default 100
  calls — was a lifetime count with no reset, which punished a long, mostly-compliant
  session for being long: ten *incidental, unrelated* one-off corrections spread across
  400 calls used to trip the exact same cap a genuinely stuck run does. Windowing it the
  same way `no_progress_loop` already is means only *dense* refusals count.)

**What you'll see when it fires** (real transcript, 2026-10-11):
```
CONTRACT VIOLATION — invariant.no_progress_loop
Refusals: 11 total (11 recent), 1 in a row (11 refusals within the last 100 calls (cap 10)).
The run is being stopped. Report the blocker to the user; do not retry.
```
The session ends there — there is currently no automatic relaunch (see "Known gaps" below).

**A durable record is written before the run ends** (2026-10-11): `.contract-evidence.evidence.md`
(the same human-readable sidecar the completion gate already uses for captured test
output) gets a `## BLOCKED` entry — the guard, the exact refused command/path, the
refusal counts, and explicit next-step guidance for whoever resumes the session. This
exists so the blocker is readable in one file instead of scrolling a dead transcript or
grepping `.contract-evidence.jsonl`.

**Known gaps, not yet addressed:**
- No automatic relaunch. A stopped run requires a human to notice and manually restart
  the container — this is the actual pain point the windowing/artifact work above
  reduces the *frequency* of, not the mechanism itself.
- No push notification on stop. You find out by checking, not by being told.

## Disconnect recovery (2026-10-10) - `pi` backend only, needs an image rebuild

Owner-reported: free OpenRouter models sometimes drop the stream mid-turn ("Upstream idle
timeout exceeded" and similar) - the process doesn't die, `pi.dev` doesn't auto-retry this
itself, and the session just sits idle until a human manually types something to kick it
back into motion. Fixed in `contract-guard.ts` (the engine file, `/workspace/pi-contracts-
research/prototype/extensions/`, NOT version-controlled with git, baked into
`pi-contracts:latest` at build time): a new `turn_end` handler checks the turn's
`stopReason` (VERIFIED against `pi.dev`'s own `packages/ai/README.md` "Stop Reasons"
section: `"pending"|"stop"|"length"|"toolUse"|"error"|"aborted"` - `"error"` is the
documented catch-all for "an error occurred during generation," network drops included) and,
on `"error"`, injects a message telling the model it was interrupted, not it, and to continue
- the SAME `{entries, continue: true}` mechanism `evidence_captured`'s completion gate above
already uses, just a different trigger.

Bounded at 5 **consecutive** disconnects (not a lifetime budget - the counter resets on any
turn that didn't end in `"error"`, since free-tier flakiness is "frequent but individually
recoverable," not "persistently broken"); past that it gives up and lets the real error
surface, same as before this existed. `"aborted"` (a cancelled request) is deliberately NOT
treated as a disconnect - that's far more likely an intentional interruption than a
connection problem.

**This only works for the `pi` backend.** It relies on `pi.dev`'s own `turn_end`/`stopReason`
event system; Antigravity, Claude Code, Codex, and OpenCode each have their own, different
hook/event shapes with no equivalent signal wired up here. **Also: this requires rebuilding
`pi-contracts:latest`** (and anything `FROM` it) before it takes effect - editing
`contract-guard.ts` alone does nothing for an already-running or freshly-launched-from-the-
old-image container.

**Same-day addition:** a second, different-cause error also lands on `stopReason: "error"` -
`"Model output contains an unrecoverable tool call. Previously delivered tool calls must not
be executed again on retry."` This is NOT a network problem - it's this project's own
already-documented root cause (`AGENTS.md`'s "Start here" section: the model echoing its own
chat-template role/turn markers or tool-call tags as plain text corrupts the parser's
envelope boundary, forcing a retry that would re-execute an already-run tool call, which pi
correctly refuses to do). **HYPOTHESIS, not independently confirmed the way the plain
disconnect case is** - there is no live `pi` session available to test against here, but the
error text reads exactly like what the `stopReason` spec documents `errorMessage` for. The
recovery now detects this specific text and sends a MORE TARGETED message - naming the actual
rule that was violated and telling the model not to repeat it or the stale tool call - rather
than the generic "you were interrupted" text, which wouldn't stop the model from immediately
causing the same failure again. Safe to auto-continue past: the error itself IS pi correctly
refusing to double-execute, not pi accidentally doing so.

**Real incident, 2026-10-11 — the first live test of this mechanism, and it exposed four
bugs (one found on a second report after the first fix shipped).** A real session hit
`Provider finish_reason: error`; recovery fired and the message WAS shown (confirmed from
the transcript), but the session then did not resume - the owner had to manually copy the
text and press enter. Diagnosed and fixed:

1. **Confirmed bug — silent exhaustion.** After `MAX_DISCONNECT_RETRIES` (5) consecutive
   disconnects, the handler used to just log and `return undefined` - showing NOTHING to the
   model or the human. This reproduces, exactly, the original problem this whole mechanism
   exists to prevent ("the session just sits idle until a human manually types something"),
   just after 5 silent attempts instead of immediately. **Fixed:** exhaustion now returns a
   visible message telling the model to stop and report a connection problem (not retry), and
   writes a `## DISCONNECT RECOVERY EXHAUSTED` entry to `.evidence.md` naming the real last
   error and attempt count - so a human checking later can tell "still recovering" from "gave
   up" from "never had a problem."
2. **Fixed, separately** - `shouldRecoverFromDisconnect` returned on the exhaustion check
   BEFORE extracting `errorMessage`, so the exhaustion report could only ever say "unknown"
   instead of citing what was actually failing.
3. **Strengthened the recovery text** - "continue where you left off" assumed the model's own
   memory of its last action is complete, not a safe assumption if the interruption happened
   mid tool-call. Both recovery messages now tell the model to VERIFY actual state (re-read
   the file, re-check the last command's real output, re-read the change's
   `progress`/`checkpoints`) before deciding what to do, and state plainly that
   acknowledgment-only is not an acceptable response.
4. **The actual root cause, reported by the owner immediately after item 3 shipped: the
   message displayed but did NOT auto-continue the session at all** - the owner had to
   manually copy the displayed text and press enter themselves. The owner then pointed out
   that the completion gate's OWN recovery message (`agent_before_settle`, same `{entries,
   continue: true}` shape) DOES correctly auto-continue - which looked like a contradiction
   until traced precisely: **this is not the same situation.** The completion gate fires
   during a NORMAL settle (no error), where `continue: true` is honoured. Disconnect recovery
   fires from `turn_end` specifically because `stopReason` is `"error"`, and pi's own run
   loop treats an error the same as an abort - a HARD EXIT. Confirmed directly from pi's own
   issue tracker: *"Error and aborted responses remain hard exits"* and *"the only
   continuation hooks (`turn_end`/`agent_before_settle` returning `continue: true`) are
   skipped after an abort."* `continue: true` was never unreliable here - it is documented to
   be skipped on exactly this path, by design. **Fixed:** replaced the `{entries, continue:
   true}` return with a direct `pi.sendUserMessage(content, { deliverAs: "followUp" })` call,
   which sidesteps the hard-exit entirely by sending a genuinely NEW message rather than
   asking the already-exited run to continue - confirmed, from pi's own shipped example
   (`examples/extensions/send-user-message.ts`), to "always trigger a turn" when the agent is
   idle. Applied to BOTH the recover and exhausted paths - exhausted now also gets a real turn
   to acknowledge and report the failure, not just a passive display note. Falls back to the
   old display-only
   `entries` return if `sendUserMessage` itself throws (e.g. unavailable in some mode/version),
   so the signal is never silently lost even if this specific API isn't there.

Items 1-3 added as permanent coverage in `verify-guards.mjs` (`shouldRecoverFromDisconnect`
had ZERO test coverage before this incident, despite being real production logic). Item 4
lives in `contract-guard.ts` itself, which `verify-guards.mjs` does not cover (it only tests
`checks.mjs`) - verified instead with standalone throwaway harnesses (a fake `pi` object
invoking the real handler directly), including one confirming the fallback doesn't crash
when `sendUserMessage` itself throws.

## Verified

Replaying CHANGE-0003's real breaches through the guard engine: writes to `pyproject.toml`,
`Dockerfile.pi`, `IMPLEMENTATION_COMPLETE.md`, and edits to the forbidden `falkordb` adapter
are **blocked**; writes to owned paths pass; `pip install …` and `git … push --force` are
blocked.

The settle gate, replayed through the engine: a "complete" claim with **no** test run, or
with a **failing** pytest run, is **blocked**; a claim backed by a passing `… pytest …` run
settles; a worker still mid-task (no completion claim) is not nagged. (The engine logic is
verified here; confirming the gate fires live at `agent_before_settle` inside PI is the
prototype's one open item — SYNTHESIS §6.)

## Residual (reduced by #5, not fully sealed)

Hardening #5 now blocks the common `bash` write-bypasses — `sed -i`, `perl -i`, `tee`, `dd`,
`python -c` / `node -e` / `ruby -e`, and redirects into a source file — verified against the
engine (the test command and `git commit`/`add` still pass). A denylist still can't be
*complete*: a determined route (base64-decode into a file, write-then-run a script, an
env-indirected path) can't all be enumerated. The only full seal is removing `bash` and
providing compliant tools, which isn't feasible while the worker needs `pytest`/`git`. So the
guard now stops the realistic routes; the `pre-commit` hook and **mandatory frontier review
(re-running the tests)** remain the backstops.

**`evaluateTestFirst` verifies commit ORDER; `evaluateRedVerified` now corroborates it with
real RED evidence where one exists (flagged 2026-10-12, cheap path built 2026-10-12).**
`verify-change.mjs`'s `evaluateTestFirst` only ever checks that a test-touching commit lands
at or before the first implementation commit — a trivially-passing or no-op test committed
first satisfies that order check while never proving RED, the exact failure mode "a test that
passes before the implementation exists is not a test, it is a description" warns against.
Independently named by `addyosmani/agent-skills`' `test-engineer.md` persona as the
"Prove-It Pattern" (demonstrate the bug with a failing test, confirm the failure, then fix).

Closed the cheap way: `contract-guard.ts`'s `agent_settled` handler now logs **every** test
invocation it sees in the session's transcript (not just the final passing one
`evidence_captured` already recorded) as a `test_run` event — `{ev:"test_run", command,
passed, exited_nonzero}` — to the same `.pi-session/<name>/evidence.jsonl` CONTRACT_EVIDENCE
already writes to. `verify-change.mjs`'s new `evaluateRedVerified` reads every
`.pi-session/*/evidence.jsonl` under the worktree, merges them in actual chronological order
(sorted by each record's own timestamp, not directory name), and fails loud if the log shows
a pass before any recorded fail — proof the tests never actually went RED, not just an
ambiguous commit order.

This is **advisory, not a hard gate, when no evidence file exists** ("na", not "fail") — most
non-pi harnesses, and even a pi session that never wrote one, leave nothing to check. That
asymmetry is deliberate: it strengthens the common case without making an evidence file a
new hard requirement every change must satisfy.

**Still not built — the expensive path, kept for later:** actually replaying history (check
out the candidate RED commit, run `tests.command` against it, confirm failure, then do the
same at the implementation commit) so the check works even with no evidence file at all. That
needs a safe checkout/restore of `HEAD` and running the suite twice per check — real
engineering lift and runtime cost, deliberately deferred. `mandatory frontier review` remains
the backstop for the case this cheap path can't reach (no evidence file), same as the
bash-bypass residual above.

**Codex/claude adapters had no individually-attributable violation record at all until
2026-10-12 (parity with antigravity, not yet with pi).** `antigravity-guard-adapter.mjs` got
a `log()` function on 2026-10-11 (CHANGE-0077's own audit found antigravity's violations were
only ever a bare counter snapshot — "4 total_blocks" with no guard id, no command, no
timestamp — while pi's were individually attributable via `guard-stats.mjs`). `codex-guard-
adapter.mjs` and `claude-guard-adapter.mjs` had the exact same gap and now have the exact
same fix: the same `log()` shape (`{t, ev, ...}`), logging `violation`/`blocked` at
tool_call time, so `guard-stats.mjs`'s `correlate()` needs no backend-specific parsing for
any of the three.

**All four backends now have completion-gate parity with pi (2026-10-12).**
`scripts/claude-completion-gate.mjs`, `scripts/codex-completion-gate.mjs`, and
`scripts/antigravity-completion-gate.mjs`, each registered as a `Stop` hook in
`launch-worker.sh`'s settings alongside that backend's existing PreToolUse adapter, port pi's
`agent_before_settle` logic (claimed-done-but-tests-not-green detection, a bounded retry
budget, durable `completion_gate_fired/passed/exhausted` evidence) onto each backend's own
per-turn `Stop` hook. All three share the actual decision logic from
`scripts/completion-gate-core.mjs` (extracted once claude+codex existed, since the gating
decision itself has nothing backend-specific in it) and differ only in envelope/transcript/
decision-output shape.

The earlier doubt about Codex's own `Stop`-hook docs ("the fetch landed on content titled for
Claude Code") turned out to be a one-off mislabelled fetch SUMMARY, not a real content
mismatch — re-fetched and confirmed directly (the page's own first 200 words name Codex
throughout) before building this. Codex's shape is simpler than Claude's: `{"decision":
"block","reason":"..."}`, no `hookSpecificOutput` wrapper, and it additionally documents
`stop_hook_active` (Claude's docs don't) — not relied on anyway, for the same reason neither
adapter trusts an undocumented-semantics field: both use their own persisted attempt-counter
file instead, same pattern as every PreToolUse adapter's `tool_call_limit` state.

One real, called-out limitation on BOTH: the exact transcript schema (Claude's
`transcript_path` JSONL; Codex's `rollout.jsonl`) is **not documented as stable** by either
vendor — Claude's docs don't specify it at all; Codex's docs say outright "the transcript
format isn't a stable interface for hooks and may change over time." Codex's shape used here
(`{type:"response_item", payload:{type:"function_call"|"function_call_output", name,
arguments, call_id, output}}`, `arguments` as a JSON-encoded string, paired by `call_id`) is
cross-referenced from real published examples (a reverse-engineering writeup, an
`openai/codex` GitHub PR introducing a `RolloutLine` schema), not from Codex's own primary
docs — same confidence tier as `codex-guard-adapter.mjs`'s own `extractPatchPaths()`. Both
adapters are schema-tolerant by design: if either recognises **zero** tool-call/result pairs
anywhere in the whole transcript while the model claims completion, it logs
`completion_gate_schema_unrecognised` and **fails open** (lets the turn end, does not nag)
rather than risk harassing a worker that may have already passed its tests — the opposite
failure direction from the PreToolUse adapters, deliberately: a hung session (failing closed
on a Stop hook bug) is worse than missing one gate opportunity. Both verified end-to-end
against the REAL `evidence_captured` guard shape (pulled from a real compiled
`.contract-guards.json`, not invented) and a realistic transcript/rollout fixture each —
correctly fire with the actual test command named (mirroring pi's own `testCommands[0]`, not
a compiled-config field that doesn't exist in the real schema), and correctly stay silent once
tests pass.

**Antigravity's version is the weakest-grounded of the three, and said so in its own header
rather than implied to be equally reliable.** Its own docs DO document a `Stop` hook (checked
directly, not assumed absent as an earlier pass here guessed before investigating) - but with
two real differences from claude/codex: (1) its envelope has **no `last_assistant_message`
field at all**, so this adapter must derive the completion CLAIM from the transcript too, not
just the test EVIDENCE - compounding the schema-guess risk onto both halves of the gate
instead of one; (2) the tool_calls/results pairing in `transcript.jsonl` is cross-referenced
from a single GitHub issue's prose description (naming `PLANNER_RESPONSE.tool_calls[]` and
"GENERIC tool results") with **no verbatim JSON example anywhere found**, versus codex's
`rollout.jsonl` cross-referencing which had real quoted examples - so pairing here is
positional (FIFO: the Nth tool call is paired with the Nth GENERIC step that follows it), not
id-based like its siblings. It also uses a real, confirmed, backend-specific precondition
neither sibling has: `fullyIdle` - the gate never even evaluates a completion claim while
background tasks are still active, regardless of what the transcript says. All three fail
open the same way on an unrecognised schema; antigravity's adapter fails open MORE readily
given the compounded uncertainty (e.g. the moment it can't even extract a last assistant
message from the transcript, before asking whether it claims completion at all). Verified
end-to-end the same way as its siblings - a real compiled `evidence_captured` guard and a
realistic transcript fixture, firing with the actual test command named and staying silent
once tests pass - but "verified against a fixture I wrote" carries less weight here than for
codex, where the fixture's shape had real external corroboration.

**`hard_stop_engaged` parity built 2026-10-12 for claude/codex/antigravity - and it surfaced a
real, pre-existing bug bigger than the parity gap itself.** While adding the dedicated log
event (mirroring `contract-guard.ts`'s own `if (ctx.counters.stopped) log({ev:
"hard_stop_engaged", ...})`), it became clear `checks.mjs`'s hard-stop logic
(`checks.mjs:814-826`) reads `ctx.max_consecutive_blocks`/`max_total_blocks`/
`max_total_blocks_window` and **defaults EACH to `Infinity` when absent**. None of the three
PreToolUse adapters had EVER set these fields - only `contract-guard.ts` (pi) did
(`max_consecutive_blocks: 5, max_total_blocks: 10, max_total_blocks_window: 100`). That means
`counters.stopped` could never become `true` on claude, codex, or antigravity, on any session,
ever - **the entire hard-stop mechanism has been structurally unreachable on three of four
backends since those adapters were written**, not merely unlogged. A worker on one of those
backends that kept re-attempting the same blocked action would never have been forcibly
stopped by this engine at all; only `tool_call_limit`-style guards or a human noticing would
have caught it.

Fixed by adding the SAME three threshold values to all three adapters' `ctx` construction -
one hard-stop policy across every backend, not a per-backend one. Each adapter now also logs
a dedicated `hard_stop_engaged` event (same `{t, ev, blocks, streak, tool_calls}` shape pi's
own does), using edge-detection (`shouldLogHardStop`, duplicated per-adapter matching this
project's own convention for small utilities like `log()` itself) so it fires exactly once -
on the call where `counters.stopped` flips, not on every subsequent call while a hard stop
stays engaged (counters persist across each adapter's many separate-process invocations
within one session, unlike pi's single long-running process).

**Verified for real, not just unit-tested**: ran each adapter 6-7 times in a row against a
real compiled guard (`invariant.no_offboundary_or_destructive_bash`, blocking `git push`) with
a shared session/conversation id - confirmed the block actually engages at exactly 5
consecutive refusals (previously it never would have), `hard_stop_engaged` logs exactly once
at that point, and does NOT re-log on calls 6/7 as the streak keeps growing.

### Claude subscription rate-limit tracking (`rate_limits.five_hour`/`seven_day`)

`scripts/claude-usage-statusline.mjs`, registered as a `statusLine` command in claude's
settings.json (worker AND integrator - a sibling of `hooks`, not nested inside it) alongside
the existing PreToolUse/Stop hooks, logs a `rate_limit_snapshot` event to the same
evidence.jsonl every time Claude Code's own `statusLine` feature fires - automatically, once
per session start and again on every new assistant message/`/compact`/permission-mode change,
with **no extra prompt or token cost** ("runs locally and does not consume API tokens," per
`code.claude.com/docs/en/statusline`, fetched directly). An earlier idea (have the SEED tell a
worker to run `/usage` and parse its rendered output from the transcript) was rejected after
checking the real docs: `/usage`'s output is a TUI progress-bar widget with no stable text
format to regex, and a real GitHub issue (`anthropics/claude-code#78385`) shows conflicting
user reports about what it even displays across versions. The `statusLine` JSON gives the
exact same two numbers (`used_percentage`, `resets_at`) cleanly, with a fully quoted, verified
schema.

This is **subscription-only** - `rate_limits` is absent entirely on API-key auth, and absent
until the session's first API response even on a subscription. `guard-stats.mjs` now surfaces
the LATEST snapshot per session (`latestRateLimitSnapshot` - evidence.jsonl is append-only, so
the last matching line wins) as `latest Claude subscription usage (<model>): 5h=X% (in Yh) 7d=Z% (in Wd)`,
not a raw event-count tally - the number that answers "how close to the limit are we right
now," not "how many times did this fire." Verified end-to-end: real statusLine JSON in, real
evidence.jsonl record out, real `guard-stats.mjs` report reading it back correctly.

### Gemini subscription quota tracking (Antigravity's `quota.*`) - built; Codex's not buildable yet

Investigated OpenAI/Codex and Google/Gemini next, since the owner holds both subscriptions
privately. Very different outcomes:

**Antigravity: built, same pattern as Claude's.** `scripts/antigravity-usage-statusline.mjs`,
wired as a `statusLine` entry in the worker's `~/.gemini/antigravity-cli/settings.json` (a
SEPARATE file from `hooks.json` - confirmed via `antigravity.google/docs/cli/statusline/`,
fetched directly, with a real quoted JSON example: `"quota": {"gemini-weekly":
{"remaining_fraction": 0.9378, "reset_time": "2026-07-06T07:50:32Z", "reset_in_seconds":
560580}}`). Gemini's quota shape is structurally different from Claude's - a map keyed by
model/bucket id (daily and weekly windows, not a fixed `five_hour`/`seven_day` pair), and
expressed as `remaining_fraction` (inverted from Claude's `used_percentage`) - this adapter
converts to `used_pct` for a consistent vocabulary but does NOT hardcode which bucket keys
exist, so an unrecognised bucket is still captured under its real name, not dropped.
`guard-stats.mjs` got a matching `latestQuotaSnapshot`, printing `gemini-weekly=6.2% (in
6d11h)` the same way the Claude line does. Verified end-to-end with the real doc-quoted
example. **Not wired for the integrator's antigravity backend** - that launch path never
mounts `~/.gemini/antigravity-cli/settings.json` at all (only `hooks.json`, as a single-file
mount), and adding that mount is a separate, untested change left for later, not folded in
silently here.

**Codex: investigated, genuinely not buildable with confidence right now.** Confirmed directly
(a real `codex-statusline` project's own README, quoted verbatim): *"Codex does not currently
support a command-backed status line that reads session JSON from stdin"* - `tui.status_line`
only supports a fixed list of Codex's own built-in display items, nothing scriptable. The
fallback - reading `rate_limits` from Codex's own session file after each turn - exists in
principle (a `token_count` line with a `rate_limits` sub-object), but every source found gives
a DIFFERENT field name for the same thing (`used_percent` vs `percent_used` vs
`used_percentage`; `reset_at` vs `resets_at`; `five_hour`+`weekly` vs `rate_limit`+
`secondary_rate_limit`), and none is a verbatim-quoted example from Codex's own primary docs -
a real step below even antigravity's completion-gate confidence tier. Building against
genuinely conflicting information here would be guessing, not engineering it the way every
other piece in this file was built. Needs a real Codex session file to ground against before
this is worth building - not done.

Free-tier/local models are intentionally left at `$0` actual cost, per the owner's own call -
no equivalent-rate estimation was built, since reliable current pricing
for the specific free/stealth/local model identifiers in our real data (`nvidia/
nemotron-3-ultra-550b-a55b`, the anonymous `stealth/space-bunny-alpha` listing, a locally-run
Qwen3-Coder) could not be confirmed via fetch rather than guessed.

### `scripts/fleet-status.mjs` - one report combining all of the above

Built after the owner asked for "a status page or Herdr extension" using everything tracked
above - scoped down to a CLI aggregator FIRST (explicitly chosen over either UI option), since
it's the one piece fully testable without a real Herdr install, and either future UI would
need this exact aggregation underneath it anyway. Reuses `session-cost.mjs`'s and
`guard-stats.mjs`'s own exported readers rather than re-deriving any parsing - the only new
logic here is merging their separate `byModel` shapes across every session directory into one
view, and picking the GLOBALLY latest `rate_limit_snapshot`/`quota_snapshot` by real timestamp
(not "whichever directory got scanned last"). Verified against real repo data: 13 models,
13,251 turns, 1.5B tokens, $15.92 real spend, 311 violations, 26 hard stops, in one run.
A Herdr-plugin or static-HTML front end over this same data is still open, deliberately not
built yet - either is untestable by this agent (Herdr runs on the owner's machine; a browser
page has no selftest-able CLI surface), unlike everything else in this file.

## Where the pieces live

- **This repo** owns the change contracts (`change.yaml`) and the compiler
  (`scripts/compile-change-guards.mjs`).
- **The guard runtime** (`contract-guard` extension + the `checks.mjs` engine + the Docker
  image) currently lives in `pi-contracts-research`. Vendoring it into this repo so master
  is self-contained is a possible later step.

## Shared auth/model config under `~/.harness/config` (2026-10-13)

Before this, every container launch required the owner to log in interactively
(or re-export an env var) for every backend, every time. `scripts/harness-config-lib.sh`
— sourced by `launch-worker.sh`, `launch-planner.sh`, and `launch-integrator.sh` — gives
`pi`, `opencode`, `claude`, and `codex` a baked-in default host path under
`~/.harness/config/<backend>/`, so one interactive login persists for every future launch
with zero env vars the owner has to set themselves.

- **pi / opencode**: these already had `PI_CONFIG_DIR`/`OPENCODE_CONFIG_DIR` as a
  convention, just never defaulted — unchanged mechanism, now defaulted to
  `~/.harness/config/pi` and `~/.harness/config/opencode` unless the caller sets
  either explicitly (which still goes through the original REFUSING-on-missing-file
  check, now a real misconfiguration signal rather than a stale env var).
- **claude**: mounts `~/.harness/config/claude/credentials.json` onto the container's
  `/home/node/.claude/.credentials.json`, and `~/.harness/config/claude/claude.json` onto
  `/home/node/.claude.json` (a separate, genuinely top-level file holding account identity —
  NOT nested under `.claude/`). An optional `~/.harness/config/claude/model.txt` sets
  `ANTHROPIC_MODEL`; absent by default, claude's own default model applies.
- **codex**: mounts `~/.harness/config/codex/auth.json` onto `/home/node/.codex/auth.json`.
  An optional `~/.harness/config/codex/config.toml` is mounted onto
  `/home/node/.codex/config.toml` only if the owner created one; codex's own default
  model/config applies otherwise.
- **antigravity**: deliberately NOT covered. Multiple conflicting candidate credential
  paths were found (`~/.gemini/antigravity-cli`, `~/.gemini`, `~/.config/antigravity`),
  with signs antigravity may depend on a Linux keyring (libsecret) rather than a plain
  file — none of that was independently verified, so nothing was built on it rather than
  guessed at.

**Why granular file mounts, not `CLAUDE_CONFIG_DIR`/`CODEX_HOME` relocation**: both env
vars relocate the tool's *entire* home config directory, which would also relocate where
session logs land — breaking the already-working `/home/node/.claude/projects` and
`/home/node/.codex/sessions` mounts these scripts already use (they hardcode the tool's
default, unrelocated path). Mounting just the credential file(s) directly onto their own
real default container path avoids that ripple, coexisting as separate nested mounts under
the same implicit parent directory — the same pattern already proven safe for codex's
existing `hooks.json` + `sessions/` mounts.

**Security tradeoff, stated plainly**: this persists live, long-lived credentials (claude's
OAuth refresh token, codex's `auth.json`, pi's own `auth.json`) to a fixed, predictable host
path, bind-mounted into every future container launch. Anyone with read access to
`~/.harness/config` can reuse these sessions. This directory must never be inside a
git-tracked repo or committed — it lives under `$HOME`, deliberately outside this project's
own tree. The owner explicitly chose this tradeoff (2026-10-13) to avoid re-authenticating
for every launch.

## Known local-model reliability issues (not a security concern — tool-call fidelity)

Everything above is about the boundary guard refusing an *unauthorized* write. These are
different: a *weaker local model* (observed on `local/Qwen3-Coder-30B-A3B-Instruct-MLX-6bit`,
6-bit quantization, oMLX) producing *malformed or unreliable* tool calls that an authorized
worker would otherwise be allowed to make. The guard doesn't catch these because there's
nothing unauthorized about them — they just fail or misbehave.

**1. Multi-edit array schema malformation** (`Validation failed for tool "edit": edits.0:
must be object`). pi's edit tool already normalizes several known malformed shapes from
models (`edits` sent as a JSON string, as a single object instead of an array, field-name
variants like `old_string` vs `oldText`, a flat top-level `oldText`/`newText` shorthand that
skips the array entirely) — this error means the model produced some *other* malformed shape
not covered by that recovery logic, most often while batching multiple edits into one
`edits[]` call. An array-of-objects is a harder JSON structure to get exactly right than a
flat object, and that's a distinct skill from the single old_string/new_string case most
tool-calling probes test.
*Mitigation:* prefer one edit per call using the flat top-level `oldText`/`newText` shorthand
over batching multiple edits into a single `edits[]` array call. Related upstream fix: oMLX
PR [#844](https://github.com/jundot/omlx/pull/844) (merged 2026-09-15) fixed Qwen3-Coder
emitting a naked `<function=...>` block without its enclosing tool-call wrapper, which used
to leak raw markup into content with an empty parsed-calls array — a plausible contributor
to this family of symptoms. Worth checking the running oMLX version is ≥ the release that
includes it (merged before 0.7.0.dev4 / 2026-09-18, so any 0.7.0.dev4+ build should have it).

**2. Content-fidelity drift** (`Could not find the exact text in <file>. The old text must
match exactly including all whitespace and newlines.`). pi's edit tool tries an exact match
first, then a normalized fuzzy fallback (trailing whitespace, smart quotes, CRLF/Unicode
dashes) — if it still fails, the reproduction of `old_string` has drifted beyond
whitespace/quote-level noise. **Not a quantization/model issue** (corrected 2026-10-06 —
the original theory here, ~96.6% top-1 token agreement at 6-bit, was wrong): confirmed as
an oMLX server-side bug (`jundot/omlx` issue #4259, closed as *not planned*, no fix shipped)
in its own XML tool-call-argument detokenization/unquoting step, which drops quote and
whitespace characters at certain token boundaries (Qwen's tokenizer merges sequences like
`",` or `"]` into single tokens; oMLX's unquoter mishandles the split). The same model
through Ollama returns arguments byte-exact — proving the model itself isn't the source.
**`write` is not a safe alternative** — its `content` argument goes through the identical
unquoting path, and the linked issue's own repro is corruption delivered *through the
Write tool*. `write` just removes the one symptom that happens to fail loudly (`edit`'s "no
exact match"); it does not remove the underlying corruption risk, and a corrupted `write`
can land silently with no error at all.
*Mitigation:* no upstream fix exists (closed not-planned). Three backstops now, not one:
the existing `evidence_captured` test-must-pass gate (catches corruption in anything that
gets imported/run, via the syntax/runtime error a dropped quote or comma usually causes);
a new mechanical guard, `structured_file_validity` (added 2026-10-06, `checks.mjs` +
`compile-change-guards.mjs`), that reconstructs what a write/edit/multiedit would leave on
a `.json` file and blocks it before it lands if the result wouldn't parse — closing the gap
for JSON specifically, since JSON isn't test-covered the way code is; and manual review for
files neither of those two cover (YAML/config/docs — no YAML parser is wired into the guard
engine, see the house rule in `readChangeRiskMeta`'s own comment). Keeping `old_string`
short and narrowly-scoped per `edit` call still helps for a different reason: it reduces how
much generated text has to survive the unquoting path intact per call, and a failed match is
at least a loud, recoverable signal rather than a silent one.

**3. "Unrecoverable tool call" on retry** (`Model output contains an unrecoverable tool
call. Previously delivered tool calls must not be executed again on retry.`). Documented
upstream (oMLX issue tracking an "unclosed tool-call envelope from literal markers in
prose" bug): the model reproduces its own chat-template's role-boundary tokens (the
`im_start`/`im_end` turn markers) or its tool-call tags (`tool_call`/`function=`/
`parameter=`) as plain text inside its own prose or code output — showing an example tool
call in a comment, or quoting a previous call's format while reasoning about what it just
did. The parser mistakes that echoed syntax for a new envelope boundary, corrupting the
stream; pi retries the turn, the model re-emits the already-delivered tool call, and pi's
own duplicate-execution guard correctly refuses to run it a second time rather than risk
double-applying a write. Confirmed directly against Qwen3-Coder-30B's own
`chat_template.jinja` (2026-10-06): the turn markers and the nested XML-style tool-call tag
format are exactly what the template wraps every real turn/call in — so a model that
reproduces them in the wrong place isn't inventing new syntax, it's echoing syntax it has
seen constantly throughout its own context, which is exactly why it drifts into using it
unprompted. The same template also tells the model it may reason about a call only
*before* making it, never after — a model that violates that ordering is the likely
proximate trigger, since that's precisely where it would reference the call's own syntax.
*Mitigation (documented upstream workaround, applied in `AGENTS.md`):* instruct the model
to describe this syntax in its own words rather than reproducing it verbatim, including
inside code fences and quoted log lines, and to never add reasoning after a tool call —
only before. Deliberately not spelling out the literal markers here either, for the same
reason `AGENTS.md` doesn't: this file may end up in a worker's context too.

**On third-party reliability extensions** (`pi-apply-edits`, `pi-edit-guard`,
`pi-edit-safe`): inspected all three directly (actual source, not just descriptions) before
deciding against adopting any of them. `pi-edit-safe` is deprecated by its own author in
favor of pi's built-in tool. `pi-apply-edits` has no argument-normalization logic at all —
a strict schema that throws on malformed shapes, same failure class as issue #1. `pi-edit-guard`
has the right fix (`dropEmptyEditObjects`, directly on-point for issue #1) but it's wired into
a ~150-file framework (telemetry, undo store, its own loop-breaker) to get roughly 15 lines of
useful logic — disproportionate for what's needed here.

Building our own extension to fix issue #1 in-house turned out to not be the small change it
first looked like: pi's extension API has no "delegate to the original built-in tool" call —
overriding a built-in tool by name means reimplementing its entire `execute` logic (matching,
fuzzy fallback, diff generation, writing, UI-facing result shape) from scratch, which is exactly
why the third-party options above are as large as they are. A half-built from-scratch `edit`
replacement is a worse risk than the bug it would fix. Decided against: the instruction-level
mitigation in issue #1 above is the right-sized fix — it costs nothing, risks nothing, and
addresses the same root cause (the model choosing to batch edits into a harder-to-get-right
array shape) one level up, before a malformed tool call is ever generated.

**On two community Herdr plugins investigated for quota/capacity tracking** (2026-10-13):
`senna-lang/herdr-agent-usage`'s README claims Codex 5h/weekly quota and "pay-as-you-go"
provider (OpenRouter, DeepSeek, etc.) support — inspected its actual Go source
(`internal/providers/codex/{types,extract,provider,resolve,auth}.go`, the shared
`internal/ratelimit/types.go`) and found neither claim holds up: Codex's own provider code
only parses `token_count`/`last_token_usage` (context-window occupancy), never a `rate_limits`
field, and the shared notification state (`NotifyState{FiveHour,SevenDay}`) is explicitly
comment-labeled Claude-specific. The provider directory list (`antigravity, claude, codex,
cursor, grok, hermes, kilo, omp, opencode`) has no `openrouter`/`deepseek`/`together`/`bedrock`
entry at all, despite the README listing all of them under "Pay-as-you-go." Net: this plugin
hits the same Codex-quota wall we did, just doesn't say so as plainly as its README's bullet
points imply — a real example of why this project checks implementations, not READMEs, before
trusting a claim (an earlier turn in this same conversation initially took the README at face
value and had to self-correct once the source was actually read).

`ezcorp-org/herdr-pc-ram-and-cpu-usage-overlay`, by contrast, checked out on inspection (actual
Rust source: `model.rs`, `collect.rs`) — real per-pane CPU%/RAM-MB figures, `session.snapshot`
covering every workspace. It tracks no total system capacity itself, but didn't need to:
`node:os`'s own `freemem()`/`totalmem()` already give that directly, no plugin required. Used
as the basis for `herdr-plugin/lifecycle-watcher.mjs`'s `hasLocalCapacity()` - see
COORDINATION.md's routing section.

## Token budget: `read_budget` guard + `token-audit`

Every tool result is re-sent on every later call until compaction. Two pieces
keep that in check (adapted from tokenleak, MIT):

- **`efficiency.read_budget`** (emitted by `compile-change-guards.mjs` for every
  change). A whole-file read of a text file > 24 KB is stopped and the model
  gets an outline with line numbers instead. It runs at `on_violation:
  "redirect"`: never counted as a refusal, never a hard stop, and repeating the
  exact same read goes through. Works for every backend through the existing
  adapters: pi/OpenCode `read`, Claude `Read`, Antigravity `view_file`, and
  `cat`/`nl` (incl. `cd X && cat a b`) through bash, which is how Codex reads.
  Logic: `pi-contracts-research/prototype/extensions/read-budget.mjs`. Tune with
  `READ_BUDGET_BYTES`; disable with `READ_BUDGET=0`. Fails open.
- **`node scripts/token-audit.mjs`** from a repo root: scans `.pi-session/` and
  `.worktrees/*/.pi-session/` for every backend's transcripts (pi, Claude Code,
  Codex rollouts, Antigravity `transcript_full.jsonl`) plus OpenCode's SQLite
  store in `~/.harness/config/opencode/opencode.db` (read from a temp copy;
  needs Node >= 22.5). Pi review-panel subagents (`subagent-artifacts/`) and
  Antigravity child brains are counted and reported separately.
  Everything is in **weighted tokens** (fresh x1, cache read x0.1, cache write
  x1.25/2, output x5): what burns quota, not what a subscription bills. Per
  backend: context size per call (p50/p95/max, share over 128k/200k), cache-hit
  rate, weighted cost and calls per session, the share spent above 200k of
  context (a lower bound on what compaction there could save), subagent share,
  and avoidable leaks by kind/run/file/call.
  `--save-baseline <file>` stores the summary; `--compare <file>` prints
  per-backend deltas and only flags a change bigger than 30% (agent cost varies
  a lot between identical runs - treat even a flagged change as a lead).
  `--mark "<what changed>"` records a dated marker; the dashboard's **Tokens**
  view (`scripts/harness-dashboard.mjs`, key 7) splits every metric before /
  after each marker, draws daily sparklines with the marker on them, and only
  colours a change that beats the 30% noise band with 10+ sessions per side.
  It refreshes `.pi-session/token-audit/summary.json` itself (`--cache`).

## Context compaction: `HARNESS_COMPACT_AT`

Every call re-reads the whole context, so letting a session grow toward a 1M
window re-pays everything above ~200K on every later call. Measured
2026-10-20 (Johannas_verden, 131 sessions): context above 200K was >=22.5% of
Claude's weighted tokens (Claude Code's default on 1M models is ~967K), 12% of
Codex's and 9% of pi's; OpenCode and Antigravity already stay below it.

One knob in `scripts/harness-config-lib.sh`, default `200000`
(`HARNESS_COMPACT_AT=0` = every backend keeps its own default):

| backend | how it is applied |
|---|---|
| claude | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` passed by `launch-*.sh` (documented highest-precedence setting; 100K-1M) |
| codex | `-c model_auto_compact_token_limit=...` on the codex command line (`launch-*.sh`); your shared `~/.harness/config/codex/config.toml` is not touched |
| pi | `compaction.modelOverrides` in `pi-contracts-research/settings.defaults.json`, generated per catalog model by `node scripts/gen-compaction-overrides.mjs --write` (reserveTokens = window - target). Baked into the image: re-run + rebuild after changing the target or the catalog |
| opencode, antigravity | unchanged - already compact well below 200K |

Rolling it out: rebuild the images (pi picks up the new settings at build
time), then `node scripts/token-audit.mjs --mark "compaction at 200k"` so the
dashboard can show before/after. Expect a few more compactions per long
session (each costs one summarising call); judge the result only after 10+
sessions per backend on both sides of the marker.
