#!/usr/bin/env node
//
// antigravity-guard-adapter — a PROTOCOL adapter, not new enforcement logic.
//
// WHY THIS EXISTS
// checks.mjs (pi-contracts-research) was deliberately built "free of any pi
// import, so the same code can be exercised by verify-guards.mjs (plain
// node) and contract-guard.ts (under jiti)". Antigravity CLI's hook system
// is a DIFFERENT integration shape - an external command, spawned fresh per
// tool call, reading a JSON envelope on stdin and writing a decision on
// stdout (antigravity.google/docs/hooks/) - but it is still just another
// consumer of the SAME pure evaluateDuring(guards, event, ctx). This file
// is the thin translation layer: antigravity's envelope in, checks.mjs's
// event shape through, antigravity's decision schema out. integrator_merge_gate
// itself is not reimplemented.
//
// VERIFIED vs ASSUMED - read before trusting this in production:
//   VERIFIED (antigravity.google/docs/hooks/, fetched directly):
//     - PreToolUse stdin shape: {toolCall:{name,args}, conversationId, ...}
//     - stdout decision shape: {decision: "allow"|"deny"|..., reason?}
//     - tool names/arg fields: run_command/CommandLine, write_to_file/
//       TargetFile+CodeContent, replace_file_content/TargetFile+
//       TargetContent+ReplacementContent, multi_replace_file_content.
//   ASSUMED, NOT YET VERIFIED - check on the first real run:
//     - That the hook subprocess inherits the parent container's env vars
//       (CONTRACT_GUARDS, etc.) - antigravity's docs do not address this.
//       If env vars do NOT arrive, this adapter has nothing to read and
//       FAILS CLOSED (see below), so the failure mode is "integrator
//       blocked entirely", not "silently unguarded" - safe, but check for
//       it: a guards-not-loaded error on every tool call means this.
//     - Tool names beyond the five above are UNENUMERATED by the docs
//       ("additional... collaboration... interaction tools"). This does not
//       weaken integrator_merge_gate or command_forbidden (both key only on
//       tool === "bash", which run_command maps to, verified) but means an
//       unmapped mutating tool would not be caught by a file_boundary guard
//       if one were ever added for this role. The integrator role does not
//       compile file_boundary at all, so this is not live today.
//
// FAIL CLOSED, not open: any unexpected error (bad JSON, missing
// CONTRACT_GUARDS, checks.mjs not found) returns {decision:"deny"} - a
// broken adapter must not become an open gate. This mirrors
// integrator_merge_gate's own "cannot confirm -> block" design.
//
// Counters (tool_call_limit) persist ACROSS invocations despite each one
// being a fresh process - antigravity spawns the hook command per call, with
// no shared memory - by reading/writing a small state file keyed by the
// envelope's conversationId, next to CONTRACT_EVIDENCE.
//
//   node scripts/antigravity-guard-adapter.mjs < envelope.json
//   node scripts/antigravity-guard-adapter.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

// 2026-10-11: this adapter used to persist ONLY a bare counter snapshot
// (tool_calls/steps/consecutive_blocks/total_blocks) - no guard id, no
// violated command, no timestamp per block. Found auditing CHANGE-0077
// (worked by three pi models AND antigravity): pi's violations are
// individually attributable via guard-stats.mjs; antigravity's were not -
// "4 total_blocks" with zero detail about which guard or what command.
// Same log() shape as contract-guard.ts's (t, ev, ...rec) so a FUTURE run's
// antigravity violations land in the SAME evidence.jsonl, in the SAME shape,
// and guard-stats.mjs correlates them with no special-casing needed. Fails
// silently on a write error - evidence logging must never be what turns an
// otherwise-correct deny into a crash (mirrors the fail-closed philosophy
// of the rest of this adapter, just for the non-critical logging path).
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

// Antigravity tool name/arg shape -> pi's canonical {toolName, input} shape,
// the one checks.mjs's evaluateDuring already understands. Only run_command
// is load-bearing for the INTEGRATOR role today (command_forbidden and
// integrator_merge_gate both key on tool === "bash"); the others are mapped
// for completeness and because getting write/edit right costs nothing extra.
export function toCanonicalEvent(toolCall) {
  const name = toolCall?.name;
  const a = toolCall?.args || {};
  switch (name) {
    case "run_command":
      return { toolName: "bash", input: { command: a.CommandLine, cwd: a.Cwd } }; // Cwd (VERIFIED): read_budget resolves relative paths against it
    case "write_to_file":
      return { toolName: "write", input: { path: a.TargetFile, content: a.CodeContent } };
    case "replace_file_content":
      return { toolName: "edit", input: { path: a.TargetFile, oldText: a.TargetContent, newText: a.ReplacementContent } };
    case "multi_replace_file_content":
      return { toolName: "multiedit", input: { path: a.TargetFile } };
    case "view_file":
      // VERIFIED 2026-10-17 against 1,876 real PLANNER_RESPONSE steps (6 antigravity
      // transcripts in Johannas_verden): view_file's args are AbsolutePath, StartLine,
      // EndLine (+ ContentOffset) - NOT TargetFile, which only write_to_file /
      // replace_file_content use. TargetFile kept as a fallback for older builds.
      return { toolName: "read", input: { path: a.AbsolutePath ?? a.TargetFile, offset: a.StartLine, end_line: a.EndLine } };
    default:
      // Unrecognised tool: pass the raw name through unmapped. No guard
      // compiled for the integrator keys on anything but "bash", so this is
      // inert today, not a silent bypass of something that would otherwise
      // have fired.
      return { toolName: name, input: a };
  }
}

/** checks.mjs's block/allow -> antigravity's decision schema. */
export function toDecision(result) {
  if (result.blocked) return { decision: "deny", reason: result.reason || "blocked by integrator guard" };
  return { decision: "allow" };
}

/**
 * True exactly on the call where counters.stopped FLIPS from false to true -
 * not on every subsequent call while it stays true. Same function as
 * claude-guard-adapter.mjs's/codex-guard-adapter.mjs's own (duplicated, not
 * shared, matching this project's existing convention for small per-adapter
 * utilities like log() itself).
 */
export function shouldLogHardStop(wasStopped, counters) {
  return !wasStopped && !!counters?.stopped;
}

const counterStatePath = (conversationId) => {
  const evidence = process.env.CONTRACT_EVIDENCE;
  const dir = evidence ? dirname(evidence) : ".";
  return join(dir, `antigravity-counters-${conversationId || "default"}.json`);
};

function loadCounters(path, newCounters) {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* fall through to fresh */ }
  }
  return newCounters();
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { return done({ decision: "deny", reason: `antigravity-guard-adapter: unparsable stdin envelope: ${e.message}` }); }

  try {
    const { evaluateDuring, newCounters } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done({ decision: "deny", reason: "antigravity-guard-adapter: CONTRACT_GUARDS is not set - failing closed, not open." });
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;

    const statePath = counterStatePath(envelope.conversationId);
    const counters = loadCounters(statePath, newCounters);
    const repoRoot = process.env.REPO_ROOT || process.cwd();
    const wasStopped = !!counters.stopped;

    const event = toCanonicalEvent(envelope.toolCall);
    // REAL PRE-EXISTING GAP found 2026-10-12 while building hard_stop_engaged
    // parity: checks.mjs's own hard-stop logic (checks.mjs:814-826) reads
    // ctx.max_consecutive_blocks/max_total_blocks/max_total_blocks_window and
    // defaults EACH to Infinity when absent - this adapter never set them,
    // so counters.stopped could never become true here at all. Same three
    // values as contract-guard.ts's own ctx (pi) and the other two adapters'
    // identical fix - one hard-stop policy, not a per-backend one.
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
    if (shouldLogHardStop(wasStopped, counters)) {
      log({ ev: "hard_stop_engaged", blocks: counters.total_blocks, streak: counters.consecutive_blocks, tool_calls: counters.tool_calls });
    }

    writeFileSync(statePath, JSON.stringify(counters));
    return done(toDecision(result));
  } catch (e) {
    return done({ decision: "deny", reason: `antigravity-guard-adapter: internal error, failing closed: ${e.message}` });
  }
}

function done(decision) { process.stdout.write(JSON.stringify(decision) + "\n"); process.exit(0); }

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // toCanonicalEvent - the one verified-critical mapping
  let e = toCanonicalEvent({ name: "run_command", args: { CommandLine: "git merge --no-ff feature/x" } });
  ok(e.toolName === "bash" && e.input.command === "git merge --no-ff feature/x", "run_command -> bash, CommandLine -> command (the load-bearing mapping)");

  e = toCanonicalEvent({ name: "write_to_file", args: { TargetFile: "docs/x.md", CodeContent: "hello" } });
  ok(e.toolName === "write" && e.input.path === "docs/x.md" && e.input.content === "hello", "write_to_file -> write");

  e = toCanonicalEvent({ name: "replace_file_content", args: { TargetFile: "x.py", TargetContent: "old", ReplacementContent: "new" } });
  ok(e.toolName === "edit" && e.input.oldText === "old" && e.input.newText === "new", "replace_file_content -> edit");

  e = toCanonicalEvent({ name: "some_future_tool", args: { a: 1 } });
  ok(e.toolName === "some_future_tool" && e.input.a === 1, "unrecognised tool passes through unmapped, not dropped");

  // toDecision
  ok(toDecision({ blocked: true, reason: "nope" }).decision === "deny", "blocked -> deny");
  ok(toDecision({ blocked: true, reason: "nope" }).reason === "nope", "deny carries the reason");
  ok(toDecision({ blocked: false }).decision === "allow", "not blocked -> allow");

  // log() - 2026-10-11 addition. Must write the SAME {t, ev, ...} shape
  // contract-guard.ts's own log() does, so guard-stats.mjs's correlate()
  // needs no antigravity-specific parsing for data written from now on.
  {
    const tmp = `/tmp/antigravity-guard-adapter-selftest-${process.pid}.jsonl`;
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

  // shouldLogHardStop - edge detection, same semantics as the other two adapters'
  ok(shouldLogHardStop(false, { stopped: true }) === true, "flips false->true -> log it");
  ok(shouldLogHardStop(true, { stopped: true }) === false, "REGRESSION: already true before this call -> do NOT re-log on every subsequent call while a hard stop stays engaged");
  ok(shouldLogHardStop(false, { stopped: false }) === false, "never engaged -> never logs");
  ok(shouldLogHardStop(false, {}) === false, "counters missing the field entirely -> falsy, not a crash");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("antigravity-guard-adapter self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("antigravity-guard-adapter.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
