#!/usr/bin/env node
//
// claude-guard-adapter — a PROTOCOL adapter, not new enforcement logic.
//
// WHY THIS EXISTS
// checks.mjs (pi-contracts-research) was deliberately built "free of any pi
// import, so the same code can be exercised by verify-guards.mjs (plain
// node) and contract-guard.ts (under jiti)". Claude Code's own hook system
// is a DIFFERENT integration shape - an external command, spawned fresh per
// tool call, reading a JSON envelope on stdin and writing a decision on
// stdout (code.claude.com/docs/en/hooks, fetched directly) - but it is still
// just another consumer of the SAME pure evaluateDuring(guards, event, ctx).
// This file is the thin translation layer: Claude Code's envelope in,
// checks.mjs's event shape through, Claude Code's decision schema out.
//
// VERIFIED vs ASSUMED - read before trusting this in production:
//   VERIFIED (code.claude.com/docs/en/hooks + .../cli-reference, fetched
//   directly, 2026-10-09, not from training memory):
//     - PreToolUse stdin shape: {tool_name, tool_input, session_id, cwd, ...}
//     - stdout decision shape: {hookSpecificOutput:{hookEventName:
//       "PreToolUse", permissionDecision:"allow"|"deny"|"ask"|"defer",
//       permissionDecisionReason?}}, exit 0, JSON on stdout.
//     - --dangerously-skip-permissions does NOT bypass hooks (unlike
//       Antigravity, where the equivalent flag disables the hook layer
//       entirely - see antigravity-guard-adapter.mjs). Hooks keep firing and
//       can still deny. This is why this backend uses that flag directly
//       instead of Antigravity's permissions-preset workaround.
//   VERIFIED against checks.mjs itself (read directly, not assumed):
//     - file_boundary/test_integrity already accept `path`, `file_path`, OR
//       `filePath` for the target path, and `oldText`/`new_string` etc as
//       synonyms for edit payloads, and multiedit already expects
//       `input.edits` as an array of {old_string,new_string} - all of which
//       happen to be Claude Code's OWN native tool_input field names. So
//       Bash/Write/Edit/MultiEdit/Read map through with NO field renaming -
//       the mapping below is closer to a pass-through than a translation.
//   NOT VERIFIED, NOT ASSUMED EITHER WAY - check on the first real run:
//     - NotebookEdit's exact path field name (guessed: notebook_path, falls
//       back to file_path) - not confirmed against the real tool_input shape,
//       since the fetched docs only covered Bash/Write/Edit/Read in detail.
//     - That the hook subprocess inherits the parent container's env vars -
//       same open question antigravity-guard-adapter.mjs already flags for
//       its own backend. If it doesn't, this adapter has nothing to read and
//       FAILS CLOSED (see below), so the failure mode is "worker blocked
//       entirely", not "silently unguarded".
//
// FAIL CLOSED, not open: any unexpected error (bad JSON, missing
// CONTRACT_GUARDS, checks.mjs not found) returns a deny decision - a broken
// adapter must not become an open gate. Mirrors antigravity-guard-adapter.mjs.
//
// Counters (tool_call_limit) persist ACROSS invocations despite each one
// being a fresh process - Claude Code spawns the hook command per call, with
// no shared memory - by reading/writing a small state file keyed by the
// envelope's session_id, next to CONTRACT_EVIDENCE.
//
//   node scripts/claude-guard-adapter.mjs < envelope.json
//   node scripts/claude-guard-adapter.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadCounters } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

// 2026-10-12: brought up to the SAME evidence-logging floor as
// antigravity-guard-adapter.mjs got on 2026-10-11, for the identical reason -
// a claude-backed worker's violations/blocks had no individually-attributable
// record, only a bare counter snapshot. Same log() shape as contract-guard.ts's
// (t, ev, ...rec), so guard-stats.mjs's correlate() needs no claude-specific
// parsing. This is PARITY WITH ANTIGRAVITY (tool_call-time violation/blocked
// events), NOT parity with pi's own contract-guard.ts - pi additionally logs
// completion_gate_fired/passed/exhausted and hard_stop_engaged from its
// agent_before_settle/agent_settled hooks, which see the WHOLE turn/transcript.
// Claude Code's PreToolUse (what this adapter answers) cannot see that - it
// only ever gets one tool call at a time. Claude Code does have a `Stop` hook
// (code.claude.com/docs/en/hooks, fires once per turn with transcript_path/
// last_assistant_message, and CAN force continuation via decision:"block") that
// could carry the completion-gate-equivalent logic - deliberately NOT built
// here; that is a second, separate hook registration and a port of
// claimsCompletion/testsRanAndPassed from checks.mjs, not a one-line addition
// to this file. Fails silently on a write error, same fail-closed-for-
// enforcement-but-never-for-logging philosophy as every other log() here.
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

// Claude Code's tool_name/tool_input shape -> pi's canonical {toolName, input}
// shape, the one checks.mjs's evaluateDuring already understands. Field
// names mostly pass straight through - see the header's VERIFIED note on why
// renaming wasn't needed for Bash/Write/Edit/MultiEdit/Read.
export function toCanonicalEvent(toolName, toolInput) {
  const a = toolInput || {};
  switch (toolName) {
    case "Bash":
      return { toolName: "bash", input: { command: a.command } };
    case "Write":
      return { toolName: "write", input: { path: a.file_path, content: a.content } };
    case "Edit":
      return { toolName: "edit", input: { path: a.file_path, old_string: a.old_string, new_string: a.new_string } };
    case "MultiEdit":
      return { toolName: "multiedit", input: { path: a.file_path, edits: a.edits } };
    case "Read":
      return { toolName: "read", input: { path: a.file_path, offset: a.offset, limit: a.limit } }; // offset/limit: read_budget lets ranged reads through
    case "NotebookEdit":
      // UNVERIFIED path field name - see header. Falls back to file_path so
      // an unexpected shape still resolves to SOME path rather than none.
      return { toolName: "notebook_edit", input: { path: a.notebook_path ?? a.file_path } };
    default:
      // Unrecognised tool: pass the raw name through unmapped. No guard
      // compiled for the worker role keys on anything but bash/write/edit/
      // multiedit/notebook_edit (MUTATORS, checks.mjs), so this is inert
      // today, not a silent bypass of something that would otherwise have
      // fired.
      return { toolName, input: a };
  }
}

/**
 * True exactly on the call where counters.stopped FLIPS from false to true -
 * not on every subsequent call while it stays true. counters.stopped is set
 * internally by checks.mjs's evaluateDuring (checks.mjs:846, the moment
 * `terminate` fires) and PERSISTS across this adapter's many separate-process
 * invocations within one session (same counter-state-file mechanism as
 * tool_call_limit), so without edge-detection every tool call AFTER the hard
 * stop would re-log the same event.
 */
export function shouldLogHardStop(wasStopped, counters) {
  return !wasStopped && !!counters?.stopped;
}

/** checks.mjs's block/allow -> Claude Code's PreToolUse decision schema. */
export function toDecision(result) {
  if (result.blocked) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason || "blocked by worker guard",
      },
    };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

const counterStatePath = (sessionId) => {
  const evidence = process.env.CONTRACT_EVIDENCE;
  const dir = evidence ? dirname(evidence) : ".";
  return join(dir, `claude-counters-${sessionId || "default"}.json`);
};

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { return done(deny(`claude-guard-adapter: unparsable stdin envelope: ${e.message}`)); }

  try {
    const { evaluateDuring, newCounters } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done(deny("claude-guard-adapter: CONTRACT_GUARDS is not set - failing closed, not open."));
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;

    const statePath = counterStatePath(envelope.session_id);
    const counters = loadCounters(statePath, newCounters);
    const repoRoot = process.env.REPO_ROOT || process.cwd();
    const wasStopped = !!counters.stopped;

    const event = toCanonicalEvent(envelope.tool_name, envelope.tool_input);
    // REAL PRE-EXISTING GAP found 2026-10-12 while building hard_stop_engaged
    // parity: checks.mjs's own hard-stop logic (checks.mjs:814-826) reads
    // ctx.max_consecutive_blocks/max_total_blocks/max_total_blocks_window and
    // defaults EACH to Infinity when absent - this adapter never set them,
    // so counters.stopped could never become true here at all, on any
    // session, ever. The hard-stop engine has been structurally unreachable
    // on this backend since this adapter was written. Same three values as
    // contract-guard.ts's own ctx (pi) - one hard-stop policy, not a
    // per-backend one.
    const result = evaluateDuring(guards, event, {
      repoRoot, counters,
      max_consecutive_blocks: 5, max_total_blocks: 10, max_total_blocks_window: 100,
    });

    for (const v of result.violations ?? []) {
      log({ ev: "violation", guard: v.guard, check: v.check, hook: "tool_call",
        tool: event.toolName, detail: v.detail, on_violation: v.on_violation });
    }
    if (result.blocked) {
      log({ ev: "blocked", reason: result.reason, consecutive: result.consecutive,
        total: result.total, terminate: !!result.terminate, why: result.why });
    }
    // hard_stop_engaged - 2026-10-12: checks.mjs's evaluateDuring already sets
    // counters.stopped = true internally the moment `terminate` fires
    // (checks.mjs:846) - it was already being PERSISTED to this adapter's own
    // counter state file, just never logged as the dedicated marker pi's own
    // contract-guard.ts emits at agent_settled. Transition-detected (logged
    // once, the call where it FLIPS true) rather than every subsequent call,
    // since counters.stopped persists across this adapter's many
    // separate-process invocations within one session.
    if (shouldLogHardStop(wasStopped, counters)) {
      log({ ev: "hard_stop_engaged", blocks: counters.total_blocks, streak: counters.consecutive_blocks, tool_calls: counters.tool_calls });
    }

    writeFileSync(statePath, JSON.stringify(counters));
    return done(toDecision(result));
  } catch (e) {
    return done(deny(`claude-guard-adapter: internal error, failing closed: ${e.message}`));
  }
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function done(decision) { process.stdout.write(JSON.stringify(decision) + "\n"); process.exit(0); }

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // toCanonicalEvent - field names should pass through unrenamed (the
  // load-bearing claim this adapter makes over antigravity's equivalent)
  let e = toCanonicalEvent("Bash", { command: "git merge --no-ff feature/x" });
  ok(e.toolName === "bash" && e.input.command === "git merge --no-ff feature/x", "Bash -> bash, command passes through");

  e = toCanonicalEvent("Write", { file_path: "docs/x.md", content: "hello" });
  ok(e.toolName === "write" && e.input.path === "docs/x.md" && e.input.content === "hello", "Write -> write, file_path -> path");

  e = toCanonicalEvent("Edit", { file_path: "x.py", old_string: "old", new_string: "new" });
  ok(e.toolName === "edit" && e.input.old_string === "old" && e.input.new_string === "new", "Edit -> edit, old_string/new_string pass through");

  e = toCanonicalEvent("MultiEdit", { file_path: "x.py", edits: [{ old_string: "a", new_string: "b" }] });
  ok(e.toolName === "multiedit" && Array.isArray(e.input.edits) && e.input.edits[0].old_string === "a", "MultiEdit -> multiedit, edits array passes through");

  e = toCanonicalEvent("Read", { file_path: "x.py" });
  ok(e.toolName === "read" && e.input.path === "x.py", "Read -> read");

  e = toCanonicalEvent("SomeFutureTool", { a: 1 });
  ok(e.toolName === "SomeFutureTool" && e.input.a === 1, "unrecognised tool passes through unmapped, not dropped");

  // toDecision
  let d = toDecision({ blocked: true, reason: "nope" });
  ok(d.hookSpecificOutput.permissionDecision === "deny", "blocked -> deny");
  ok(d.hookSpecificOutput.permissionDecisionReason === "nope", "deny carries the reason");
  ok(d.hookSpecificOutput.hookEventName === "PreToolUse", "decision names the hook event (required field)");

  d = toDecision({ blocked: false });
  ok(d.hookSpecificOutput.permissionDecision === "allow", "not blocked -> allow");

  // log() - same shape/behaviour as antigravity-guard-adapter.mjs's own
  // selftest for the identical function, so guard-stats.mjs's correlate()
  // needs no claude-specific parsing for data written from now on.
  {
    const tmp = `/tmp/claude-guard-adapter-selftest-${process.pid}.jsonl`;
    const prevPath = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "violation", guard: "invariant.x", check: "x", detail: "d" });
      const lines = readFileSync(tmp, "utf8").trim().split("\n");
      ok(lines.length === 1, "log() appends exactly one line per call");
      const rec = JSON.parse(lines[0]);
      ok(typeof rec.t === "number", "log() stamps a numeric epoch-ms timestamp, same field name as contract-guard.ts");
      ok(rec.ev === "violation" && rec.guard === "invariant.x", "log() preserves the record's own fields unchanged");
    } finally {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      if (prevPath === undefined) delete process.env.CONTRACT_EVIDENCE; else process.env.CONTRACT_EVIDENCE = prevPath;
    }
  }
  {
    // CONTRACT_EVIDENCE unset -> log() must no-op, not throw (evidence is
    // best-effort; a missing path must never be what breaks the adapter).
    const prevPath = process.env.CONTRACT_EVIDENCE;
    delete process.env.CONTRACT_EVIDENCE;
    let threw = false;
    try { log({ ev: "violation" }); } catch { threw = true; }
    ok(!threw, "log() with CONTRACT_EVIDENCE unset does not throw");
    if (prevPath !== undefined) process.env.CONTRACT_EVIDENCE = prevPath;
  }

  // shouldLogHardStop - edge detection, the whole point of this function
  ok(shouldLogHardStop(false, { stopped: true }) === true, "flips false->true -> log it");
  ok(shouldLogHardStop(true, { stopped: true }) === false, "REGRESSION: already true before this call -> do NOT re-log on every subsequent call while a hard stop stays engaged");
  ok(shouldLogHardStop(false, { stopped: false }) === false, "never engaged -> never logs");
  ok(shouldLogHardStop(true, { stopped: false }) === false, "was true, now false - should not happen in practice (stopped never resets), but must not crash or mis-log if it somehow did");
  ok(shouldLogHardStop(false, {}) === false, "counters missing the field entirely -> falsy, not a crash");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("claude-guard-adapter self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("claude-guard-adapter.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
