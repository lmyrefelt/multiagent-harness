#!/usr/bin/env node
//
// codex-guard-adapter — a PROTOCOL adapter, not new enforcement logic.
//
// WHY THIS EXISTS
// checks.mjs (pi-contracts-research) was deliberately built "free of any pi
// import, so the same code can be exercised by verify-guards.mjs (plain
// node) and contract-guard.ts (under jiti)". OpenAI Codex CLI's own hook
// system is a DIFFERENT integration shape - an external command, spawned
// fresh per tool call, reading a JSON envelope on stdin and writing a
// decision on stdout - but it is still just another consumer of the SAME
// pure evaluateDuring(guards, event, ctx). This file is the thin translation
// layer: Codex's envelope in, checks.mjs's event shape through, Codex's
// decision schema out.
//
// VERIFIED vs ASSUMED vs a REAL OPEN BUG - read before trusting this:
//   VERIFIED (developers.openai.com/codex/hooks via its learn.chatgpt.com
//   redirect, fetched directly, 2026-10-09, not from training memory):
//     - PreToolUse stdin shape: {tool_name, tool_input, session_id, cwd, ...}.
//       Bash AND apply_patch both report their payload under the SAME field,
//       tool_input.command - for Bash it's the shell command string; for
//       apply_patch it's the raw patch text (NOT structured file paths).
//     - stdout decision shape is IDENTICAL to Claude Code's:
//       {hookSpecificOutput:{hookEventName:"PreToolUse",
//       permissionDecision:"allow"|"deny", permissionDecisionReason?}}.
//       Exit code 2 + stderr also blocks.
//     - hooks.json locations: ~/.codex/hooks.json (user-level, loads
//       unconditionally) vs <repo>/.codex/hooks.json (project-level, loads
//       ONLY once that project's .codex/ layer is explicitly trusted via the
//       in-session /hooks command) - this is why launch-worker.sh mounts at
//       the USER-level path, not the repo path: a freshly-launched container
//       has no human available to grant that trust interactively, and a
//       guard that silently never loads because of an unmet trust gate is
//       exactly the no_guards_loaded failure mode this project has already
//       been burned by once.
//     - Hooks are architecturally independent of the approval/sandbox layer
//       ("Hooks and approval layers are separate systems... Hooks still run
//       during sandbox operations") - this is why launch-worker.sh uses
//       --dangerously-bypass-approvals-and-sandbox directly, same reasoning
//       as the claude backend. NOTE: no single sentence in the fetched docs
//       ties THIS SPECIFIC FLAG to "hooks still fire" the way Claude Code's
//       docs explicitly did - this is an INFERENCE from two separately
//       confirmed facts, not one direct statement. Weaker confidence than
//       the claude backend's equivalent claim.
//   A REAL, OPEN, CONFIRMED BUG (github.com/openai/codex#27833, fetched
//   directly, status OPEN as of this writing): a PreToolUse `deny` decision
//   for apply_patch is NOT always enforced - the hook fires and returns
//   deny, but the write proceeds anyway. Reported as platform-dependent: a
//   macOS 0.147.0 report says deny IS enforced there; Windows reports
//   (PowerShell hook wrapper) say it still fails on 0.154+. This container
//   runs Linux, architecturally closer to the working macOS path than the
//   broken Windows/pwsh one, but Linux itself is UNCONFIRMED in that thread
//   either way. THE MOST IMPORTANT GUARD FOR A WORKER (file_boundary, via
//   apply_patch) MAY NOT ACTUALLY BLOCK even when this adapter correctly
//   says deny. The first real test on this backend MUST verify the file
//   never lands on disk (.contract-evidence.jsonl + the actual filesystem),
//   not just that this adapter emitted the right JSON.
//   UNVERIFIED, NOT from official docs (inferred from the openai/codex
//   apply_patch format used elsewhere, e.g. platform.openai.com/docs/guides/
//   tools-apply-patch, cross-referenced but not independently confirmed
//   against a captured real envelope):
//     - The patch marker syntax parsed below (Add/Update/Delete File, Move
//       to). If Codex's real patch text differs even slightly,
//       extractPatchPaths() below returns zero paths, and this adapter
//       FAILS CLOSED (denies) rather than guessing - see the FAIL CLOSED
//       note below.
//     - "unified_exec" is mapped to bash alongside "Bash" (seen named as a
//       second shell-exec tool in a GitHub issue thread, not in any schema
//       dump) - inert if wrong, since nothing currently depends on it firing
//       beyond what Bash already covers.
//
// FAIL CLOSED, not open: any unexpected error (bad JSON, missing
// CONTRACT_GUARDS, checks.mjs not found, an apply_patch call whose paths
// can't be extracted) returns a deny decision. Mirrors antigravity-guard-
// adapter.mjs and claude-guard-adapter.mjs.
//
// ONE CODEX TOOL CALL, POSSIBLY MANY FILES: unlike Claude Code's MultiEdit
// (many edits, ONE file) or Write/Edit (one file each), a single apply_patch
// call can touch several DIFFERENT files in one patch blob. checks.mjs's
// file_boundary only ever checks ONE path per evaluateDuring() call. So this
// adapter evaluates the FIRST extracted path through the real, persisted
// counters (the one genuine tool-call-budget side effect this Codex call
// should count as), and every ADDITIONAL path through a throwaway counters
// clone (so tool_call_limit-style guards see this as the single call it
// actually is, not N calls) - but any one of them violating is enough to
// deny the whole patch. See evaluateAllPaths() below.
//
// Counters (tool_call_limit) persist ACROSS invocations despite each one
// being a fresh process - Codex spawns the hook command per call, with no
// shared memory - by reading/writing a small state file keyed by the
// envelope's session_id, next to CONTRACT_EVIDENCE. Same mechanism as the
// other two adapters.
//
//   node scripts/codex-guard-adapter.mjs < envelope.json
//   node scripts/codex-guard-adapter.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadCounters, counterStatePath, readStdin } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";
const UNPARSEABLE_PATCH_PATH = "__codex_adapter_unparseable_patch__";

// 2026-10-12: brought up to the SAME evidence-logging floor as
// antigravity-guard-adapter.mjs (2026-10-11) and claude-guard-adapter.mjs
// (2026-10-12) - a codex-backed worker's violations/blocks had no
// individually-attributable record before this, only a bare counter
// snapshot. Same log() shape as contract-guard.ts's (t, ev, ...rec), so
// guard-stats.mjs's correlate() needs no codex-specific parsing. PARITY WITH
// ANTIGRAVITY/CLAUDE (tool_call-time violation/blocked events), NOT parity
// with pi's own contract-guard.ts - pi additionally logs
// completion_gate_fired/passed/exhausted and hard_stop_engaged from hooks
// that see the WHOLE turn/transcript (agent_before_settle/agent_settled).
// This adapter answers PreToolUse only, one tool call at a time - it cannot
// see that. A page fetched via Codex's own hooks-doc redirect describes a
// `Stop`-named hook with transcript access and a decision:"block" capability
// that could carry the completion-gate-equivalent logic, but the fetch
// landed on content titled for Claude Code, not confirmed Codex-specific -
// same "UNVERIFIED, check on first real run" tier as this file's other
// Codex-specific claims (see header). Deliberately NOT built here either
// way - call ONLY logs what evaluateAllPaths already evaluates per call.
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/** Extract every file path an apply_patch blob touches. Empty array on anything unrecognized. */
export function extractPatchPaths(patchText) {
  const text = String(patchText ?? "");
  const paths = [];
  const fileRe = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = fileRe.exec(text))) paths.push(m[1].trim());
  const moveRe = /^\*\*\* Move to: (.+)$/gm;
  while ((m = moveRe.exec(text))) paths.push(m[1].trim());
  return paths;
}

// Codex's tool_name/tool_input shape -> an ARRAY of pi's canonical
// {toolName, input} events (plural, because one apply_patch call can touch
// several files - see header). Bash/unified_exec/anything else always
// resolve to exactly one event.
export function toCanonicalEvents(toolName, toolInput) {
  const a = toolInput || {};
  switch (toolName) {
    case "Bash":
    case "unified_exec":
      return [{ toolName: "bash", input: { command: a.command } }];
    case "apply_patch": {
      const paths = extractPatchPaths(a.command);
      if (paths.length === 0) {
        // Can't identify what this patch touches - fail closed, not open.
        // A synthetic path that matches NOTHING plausible forces a deny
        // through the normal file_boundary path rather than a special case.
        return [{ toolName: "edit", input: { path: UNPARSEABLE_PATCH_PATH } }];
      }
      return paths.map((p) => ({ toolName: "edit", input: { path: p } }));
    }
    default:
      // Unrecognised tool: pass the raw name through unmapped. No guard
      // compiled for the worker role keys on anything but bash/write/edit/
      // multiedit/notebook_edit (MUTATORS, checks.mjs), so this is inert
      // today, not a silent bypass of something that would otherwise have
      // fired.
      return [{ toolName, input: a }];
  }
}

/**
 * True exactly on the call where counters.stopped FLIPS from false to true -
 * not on every subsequent call while it stays true. Same function as
 * claude-guard-adapter.mjs's own (duplicated, not shared, matching this
 * project's existing convention for small per-adapter utilities like log()
 * itself - each adapter file stays readable standalone).
 */
export function shouldLogHardStop(wasStopped, counters) {
  return !wasStopped && !!counters?.stopped;
}

/**
 * checks.mjs's block/allow -> Codex's PreToolUse decision schema.
 *
 * NOT blocked -> null, meaning "print nothing, exit 0" (see done() below) -
 * NOT the explicit {permissionDecision:"allow"} shape claude-guard-adapter.mjs
 * uses. MEASURED on a real launch (2026-10-10): Codex rejected that exact
 * shape outright - "Hook failed: PreToolUse hook returned unsupported
 * permissionDecision:allow". This matches what the FIRST research pass on
 * Codex's hooks found (agenticcontrolplane.com: "Only permissionDecision:
 * 'deny' is operational... parses but rejects allow and ask") - a LATER,
 * more detailed fetch (developers.openai.com/codex/hooks) listed "allow" as
 * documented too, so this adapter went with Claude Code's shape for both.
 * The real error settles which source was right, for Codex specifically -
 * Claude Code's OWN first-party docs do explicitly support "allow", so
 * claude-guard-adapter.mjs is untouched; this is a Codex-only quirk.
 */
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
  return null;
}

/**
 * Evaluate every event from one Codex tool call. The FIRST event uses the
 * real, persisted counters (the one genuine tool-call-budget side effect);
 * every additional one (extra files in the same apply_patch) uses a
 * disposable clone, so a multi-file patch is still counted as ONE call for
 * tool_call_limit purposes while every file still gets a real file_boundary
 * check. Any single violation denies the whole call.
 */
export function evaluateAllPaths(guards, events, ctx) {
  let result = { violations: [], blocked: false, reason: null };
  for (let i = 0; i < events.length; i++) {
    const useCtx = i === 0 ? ctx : { ...ctx, counters: { ...ctx.counters } };
    const r = evaluateDuringRef(guards, events[i], useCtx);
    if (i === 0) result = r;
    else if (r.blocked && !result.blocked) result = r;
  }
  return result;
}

// Indirection so selftest can run without importing checks.mjs's real path.
let evaluateDuringRef = () => ({ violations: [], blocked: false, reason: null });

async function main() {
  const raw = await readStdin();

  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { return done(deny(`codex-guard-adapter: unparsable stdin envelope: ${e.message}`)); }

  try {
    const { evaluateDuring, newCounters } = await import(CHECKS_MJS);
    evaluateDuringRef = evaluateDuring;

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done(deny("codex-guard-adapter: CONTRACT_GUARDS is not set - failing closed, not open."));
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;

    const statePath = counterStatePath("codex-counters", envelope.session_id);
    const counters = loadCounters(statePath, newCounters);
    const repoRoot = process.env.REPO_ROOT || process.cwd();
    const wasStopped = !!counters.stopped;

    const events = toCanonicalEvents(envelope.tool_name, envelope.tool_input);
    // REAL PRE-EXISTING GAP found 2026-10-12 while building hard_stop_engaged
    // parity: checks.mjs's own hard-stop logic (checks.mjs:814-826) reads
    // ctx.max_consecutive_blocks/max_total_blocks/max_total_blocks_window and
    // defaults EACH to Infinity when absent - this adapter never set them,
    // so counters.stopped could never become true here at all. Same three
    // values as contract-guard.ts's own ctx (pi) and claude-guard-adapter.mjs's
    // identical fix - one hard-stop policy, not a per-backend one.
    const result = evaluateAllPaths(guards, events, {
      repoRoot, counters,
      max_consecutive_blocks: 5, max_total_blocks: 10, max_total_blocks_window: 100,
    });

    // One multi-file apply_patch call still logs as ONE call here, same as
    // it counts as one for tool_call_limit (evaluateAllPaths' own header) -
    // the tool name logged is the call's, not any one individual file's.
    for (const v of result.violations ?? []) {
      log({ ev: "violation", guard: v.guard, check: v.check, hook: "tool_call",
        tool: events[0]?.toolName, detail: v.detail, on_violation: v.on_violation });
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
    return done(deny(`codex-guard-adapter: internal error, failing closed: ${e.message}`));
  }
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

// decision === null means "not blocked, no opinion" - print NOTHING and exit
// 0, matching the convention both Claude Code's and Codex's own example hook
// scripts use for that case (the "else: exit 0" branch, no stdout write at
// all) rather than an explicit allow decision.
function done(decision) {
  if (decision !== null) process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // extractPatchPaths - the load-bearing parsing this adapter adds that
  // neither sibling adapter needed
  let p = extractPatchPaths("*** Begin Patch\n*** Update File: src/x.py\n@@\n-old\n+new\n*** End Patch");
  ok(p.length === 1 && p[0] === "src/x.py", "single Update File extracted");

  p = extractPatchPaths(
    "*** Begin Patch\n*** Add File: src/new.py\n+hello\n*** Update File: README.md\n@@\n-a\n+b\n*** End Patch"
  );
  ok(p.length === 2 && p.includes("src/new.py") && p.includes("README.md"), "multi-file patch extracts every path");

  p = extractPatchPaths("*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n-x\n+y\n*** End Patch");
  ok(p.includes("a.py") && p.includes("b.py"), "Move to: is extracted alongside the original path");

  p = extractPatchPaths("not a patch at all");
  ok(p.length === 0, "unrecognised text extracts nothing (triggers fail-closed upstream)");

  // toCanonicalEvents
  let e = toCanonicalEvents("Bash", { command: "ls -la" });
  ok(e.length === 1 && e[0].toolName === "bash" && e[0].input.command === "ls -la", "Bash -> bash, one event");

  e = toCanonicalEvents("unified_exec", { command: "pwd" });
  ok(e.length === 1 && e[0].toolName === "bash", "unified_exec -> bash too");

  e = toCanonicalEvents("apply_patch", { command: "*** Begin Patch\n*** Update File: src/x.py\n@@\n-a\n+b\n*** End Patch" });
  ok(e.length === 1 && e[0].toolName === "edit" && e[0].input.path === "src/x.py", "apply_patch -> edit, path extracted from the patch text");

  e = toCanonicalEvents("apply_patch", { command: "*** Begin Patch\n*** Add File: a.py\n+x\n*** Delete File: b.py\n*** End Patch" });
  ok(e.length === 2 && e.some((x) => x.input.path === "a.py") && e.some((x) => x.input.path === "b.py"), "multi-file apply_patch -> one edit event per path");

  e = toCanonicalEvents("apply_patch", { command: "garbage, not a real patch" });
  ok(e.length === 1 && e[0].input.path === UNPARSEABLE_PATCH_PATH, "unparseable apply_patch fails closed with a synthetic non-matching path, not silently zero events");

  e = toCanonicalEvents("SomeFutureTool", { a: 1 });
  ok(e.length === 1 && e[0].toolName === "SomeFutureTool" && e[0].input.a === 1, "unrecognised tool passes through unmapped, not dropped");

  // evaluateAllPaths - counters semantics: first event real, rest disposable
  evaluateDuringRef = (guards, event, ctx) => {
    ctx.counters.tool_calls = (ctx.counters.tool_calls || 0) + 1;
    const blocked = event.input.path === "blocked.py";
    return { violations: [], blocked, reason: blocked ? "nope: " + event.input.path : null };
  };
  const sharedCtx = { repoRoot: "/x", counters: { tool_calls: 0 } };
  let r = evaluateAllPaths([], [{ toolName: "edit", input: { path: "a.py" } }, { toolName: "edit", input: { path: "blocked.py" } }], sharedCtx);
  ok(r.blocked === true && r.reason === "nope: blocked.py", "any path blocking denies the whole multi-file call");
  ok(sharedCtx.counters.tool_calls === 1, "only the FIRST path's evaluation mutates the real shared counters - a 2-file patch still counts as ONE tool call");

  r = evaluateAllPaths([], [{ toolName: "edit", input: { path: "a.py" } }, { toolName: "edit", input: { path: "c.py" } }], sharedCtx);
  ok(r.blocked === false, "no path blocking -> allow");

  // toDecision - deny shape matches claude-guard-adapter.mjs's; NOT blocked
  // is null here (Codex rejects an explicit allow - see this function's own
  // header), unlike claude-guard-adapter.mjs's explicit {permissionDecision:"allow"}.
  let d = toDecision({ blocked: true, reason: "nope" });
  ok(d.hookSpecificOutput.permissionDecision === "deny", "blocked -> deny");
  ok(d.hookSpecificOutput.permissionDecisionReason === "nope", "deny carries the reason");
  d = toDecision({ blocked: false });
  ok(d === null, "not blocked -> null (print nothing), NOT an explicit allow - Codex rejects that");

  // log() - same shape/behaviour as antigravity-guard-adapter.mjs's and
  // claude-guard-adapter.mjs's own selftest for the identical function, so
  // guard-stats.mjs's correlate() needs no codex-specific parsing.
  {
    const tmp = `/tmp/codex-guard-adapter-selftest-${process.pid}.jsonl`;
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

  // shouldLogHardStop - edge detection, same semantics as claude-guard-adapter.mjs's
  ok(shouldLogHardStop(false, { stopped: true }) === true, "flips false->true -> log it");
  ok(shouldLogHardStop(true, { stopped: true }) === false, "REGRESSION: already true before this call -> do NOT re-log on every subsequent call while a hard stop stays engaged");
  ok(shouldLogHardStop(false, { stopped: false }) === false, "never engaged -> never logs");
  ok(shouldLogHardStop(false, {}) === false, "counters missing the field entirely -> falsy, not a crash");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("codex-guard-adapter self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("codex-guard-adapter.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
