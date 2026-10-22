#!/usr/bin/env node
//
// codex-completion-gate — the completion-gate HALF of pi's contract-guard.ts
// that codex-guard-adapter.mjs (a PreToolUse-only adapter) structurally
// cannot provide, ported to Codex CLI's own `Stop` hook. Same role as
// claude-completion-gate.mjs for the claude backend; both share the actual
// decision logic via completion-gate-core.mjs and differ only in envelope/
// transcript/decision shape.
//
// WHY THIS EXISTS
// pi's gate lives in agent_before_settle/agent_settled, hooks that see the
// WHOLE turn/transcript. codex-guard-adapter.mjs answers PreToolUse only -
// one tool call at a time, no view of "did the model just claim done
// without tests passing." Codex's own `Stop` hook (fires once per turn) is
// the right integration point for that.
//
// VERIFIED vs ASSUMED - read before trusting this in production:
//   VERIFIED (learn.chatgpt.com/docs/hooks, fetched directly, 2026-10-12 -
//   confirmed this IS Codex's own docs, not a mislabelled fetch: the page's
//   own first 200 words name Codex throughout; an earlier same-session fetch
//   attempt returned a response whose SUMMARY was mistakenly titled for
//   Claude Code, re-fetched and re-checked before trusting it here):
//     - Stop stdin shape: {session_id, transcript_path, cwd,
//       hook_event_name:"Stop", model, permission_mode, turn_id,
//       stop_hook_active, last_assistant_message}.
//     - To force another turn: {"decision":"block","reason":"..."} on
//       stdout (exit 0), OR exit code 2 with the reason on stderr. NOTE:
//       simpler shape than Claude's - no hookSpecificOutput wrapper, `reason`
//       alone carries the text back to the model.
//     - To allow a normal stop: exit 0 with no output ("Exit 0 with no
//       output is treated as success and Codex continues" - continues the
//       SESSION, not the turn; the turn itself ends normally).
//     - `stop_hook_active: boolean` IS documented for Codex (unlike Claude,
//       where it only appeared in community examples, not official docs) -
//       "Whether this turn was already continued by Stop." NOT used as the
//       primary loop bound here anyway - this adapter's own persisted
//       attempt-counter file (same pattern as every other adapter's
//       tool_call_limit state) is the authoritative bound, for the same
//       reason claude-completion-gate.mjs gives: it does not depend on
//       trusting an exact field semantics guess under time pressure.
//   NOT DOCUMENTED AS STABLE (Codex's OWN docs say so explicitly, not
//   inferred): "The transcript format isn't a stable interface for hooks
//   and may change over time." The rollout.jsonl SHAPE used below
//   ({type:"response_item", payload:{type:"function_call"|
//   "function_call_output", name, arguments, call_id, output}}, arguments
//   as a JSON-encoded STRING, output as a plain string, paired by call_id)
//   is cross-referenced from real published examples (a reverse-engineering
//   writeup, an openai/codex GitHub PR introducing a RolloutLine schema, a
//   third-party project pairing function_call+function_call_output by
//   call_id) - NOT from Codex's own primary docs, which disclaim the shape
//   entirely. Same confidence tier as this adapter's own PreToolUse sibling
//   codex-guard-adapter.mjs already uses for extractPatchPaths() ("cross-
//   referenced but not independently confirmed"). If this guess is wrong,
//   extractCodexToolResults() returns zero entries - see FAIL OPEN below.
//
// FAIL OPEN, not closed - the OPPOSITE of codex-guard-adapter.mjs's own
// PreToolUse stance, and deliberately so, for the identical reason
// claude-completion-gate.mjs states: a PreToolUse adapter that fails open
// risks an unsafe WRITE; this hook only ever decides whether to let a turn
// end. Blocking a stop indefinitely because of a bug here produces a HUNG
// SESSION, worse than occasionally missing one real gate opportunity.
//
//   node scripts/codex-completion-gate.mjs < stop-envelope.json
//   node scripts/codex-completion-gate.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { evaluateCompletionGate, getCounterStatePath, loadAttempts } from "./completion-gate-core.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

// Same log() shape as every other adapter here (t, ev, ...rec).
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/**
 * Best-effort function_call/function_call_output extraction from a Codex
 * rollout.jsonl, into pi's canonical {command, output, isError}[] shape -
 * testsRanAndPassed (checks.mjs) is schema-agnostic and only needs that.
 *
 * UNDOCUMENTED-AS-STABLE SCHEMA (see header) - tolerant on purpose: skips
 * anything that doesn't match rather than throwing, and returns [] (not a
 * partial guess) if nothing in the whole transcript matched this shape at
 * all, which is the signal the caller uses to distinguish "this schema
 * guess is simply wrong" from "the model genuinely made zero tool calls."
 * No error/status field is confirmed in any published example - isError
 * stays false; testsRanAndPassed's own failed_patterns text matching is
 * what actually catches a real failure, same as it does for every backend.
 */
export function extractCodexToolResults(lines) {
  const calls = new Map(); // call_id -> { command }
  const outputs = []; // { call_id, output } in file order, paired after
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type === "function_call" && payload.call_id) {
      let args = payload.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      const command = (args && typeof args === "object" && args.command != null)
        ? String(args.command)
        : JSON.stringify(args ?? {});
      calls.set(payload.call_id, { command });
    } else if (payload.type === "function_call_output" && payload.call_id) {
      const out = payload.output;
      const text = typeof out === "string" ? out
        : Array.isArray(out) ? out.map((c) => c?.text ?? c?.content ?? "").join("\n")
        : String(out ?? "");
      outputs.push({ call_id: payload.call_id, output: text });
    }
  }
  const paired = [];
  for (const o of outputs) {
    const call = calls.get(o.call_id);
    if (!call) continue; // an output with no matching call - schema mismatch on this line, skip it, not fatal
    paired.push({ command: call.command, output: o.output, isError: false });
  }
  return paired;
}



async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let envelope;
  try { envelope = JSON.parse(raw); } catch { return done(null); } // fail open - see header

  try {
    const { claimsCompletion, testsRanAndPassed, isTestInvocation } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done(null); // no guard config at all - nothing to gate, fail open
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;
    const gate = guards.find((g) => g.check === "evidence_captured" && g.params?.enforce_before_settle);
    if (!gate) return done(null); // this role's compiled contract doesn't want this gate

    let lines = [];
    try { lines = readFileSync(envelope.transcript_path, "utf8").split(/\r?\n/); } catch { /* transcript unreadable - toolResults stays [], handled below */ }
    const toolResults = extractCodexToolResults(lines);

    const statePath = getCounterStatePath("codex-completion-attempts", envelope.session_id);
    const priorAttempts = loadAttempts(statePath);

    const r = evaluateCompletionGate({
      lastAssistantMessage: envelope.last_assistant_message,
      toolResults,
      claimPatterns: gate.params.claim_patterns,
      gateParams: gate.params,
      priorAttempts,
      testsRanAndPassedFn: testsRanAndPassed,
      claimsCompletionFn: claimsCompletion,
      isTestInvocationFn: isTestInvocation,
    });

    if (r.outcome === "fired" || r.outcome === "exhausted") {
      try { writeFileSync(statePath, JSON.stringify({ attempts: r.attempts })); } catch { /* best-effort */ }
    }

    switch (r.outcome) {
      case "no_claim":
        return done(null);
      case "schema_unrecognised":
        log({ ev: "completion_gate_schema_unrecognised", why: r.reason });
        return done(null); // fail open - see header
      case "passed":
        log({ ev: "completion_gate_passed", why: r.reason });
        return done(null);
      case "exhausted":
        log({ ev: "completion_gate_exhausted", attempts: r.attempts, why: r.reason });
        // Let the turn actually end (fail open) - mirrors pi's own
        // continue:false, NOT a forced retry. The durable log record marks
        // this run unverified for anything reading evidence.jsonl afterward.
        return done(null);
      case "fired":
        log({ ev: "completion_gate_fired", attempt: r.attempts, why: r.reason });
        // Codex's decision shape is simpler than Claude's - just decision+reason,
        // no hookSpecificOutput wrapper (VERIFIED, see header).
        return done({ decision: "block", reason: r.message });
    }
  } catch (e) {
    log({ ev: "completion_gate_error", err: String(e.message || e) });
    return done(null); // fail open - see header
  }
}

function done(decision) {
  if (decision !== null) process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // extractCodexToolResults - real published rollout.jsonl shape
  const fakeRollout = [
    JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ command: "pytest -q" }), call_id: "call_1" } }),
    JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "5 passed in 0.4s" } }),
    "not json at all, must be skipped not thrown",
    JSON.stringify({ type: "response_item", payload: { type: "something_else" } }),
  ].join("\n");
  const paired = extractCodexToolResults(fakeRollout.split("\n"));
  ok(paired.length === 1, "one function_call + its matching function_call_output pairs into one entry");
  ok(paired[0].command === "pytest -q" && paired[0].output === "5 passed in 0.4s" && paired[0].isError === false,
    "paired entry carries command/output/isError in testsRanAndPassed's expected shape, args JSON-string decoded correctly");

  ok(extractCodexToolResults(["garbage", "{}", ""]).length === 0, "no recognisable function_call/function_call_output anywhere -> empty, not a crash");

  const orphanOutput = [
    JSON.stringify({ payload: { type: "function_call_output", call_id: "unknown", output: "x" } }),
  ];
  ok(extractCodexToolResults(orphanOutput).length === 0, "a function_call_output with no matching function_call is dropped, not force-paired with garbage");

  // arguments as an already-parsed object (not a string) must also work -
  // the real docs only confirm the string form, but a tolerant parser
  // should not break if a future/variant rollout emits an object directly.
  const objectArgs = [
    JSON.stringify({ payload: { type: "function_call", name: "exec_command", arguments: { command: "echo hi" }, call_id: "c2" } }),
    JSON.stringify({ payload: { type: "function_call_output", call_id: "c2", output: "hi" } }),
  ];
  ok(extractCodexToolResults(objectArgs)[0].command === "echo hi", "arguments already an object (not a JSON string) is also tolerated");

  // a call with no 'command' key in its arguments falls back to stringifying
  // the whole thing, same defensive pattern as every other adapter here
  const noCommandKey = [
    JSON.stringify({ payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch: "*** Begin Patch ***" }), call_id: "c3" } }),
    JSON.stringify({ payload: { type: "function_call_output", call_id: "c3", output: "ok" } }),
  ];
  ok(/patch/.test(extractCodexToolResults(noCommandKey)[0].command), "no 'command' key in arguments -> falls back to stringifying the whole arguments object, not dropped");

  // main()'s decision shape - thin smoke test that this file's OWN output
  // shape differs from claude's (no hookSpecificOutput wrapper) - the actual
  // gating decision logic is tested exhaustively in completion-gate-core.mjs.
  const r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "pytest -q", output: "1 failed", isError: false }],
    claimPatterns: [], gateParams: { claim_patterns: ["\\bdone\\b"], max_completion_attempts: 2 }, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed/errored" }),
    claimsCompletionFn: () => true,
    isTestInvocationFn: (cmd) => /pytest/.test(cmd),
  });
  ok(r.outcome === "fired" && /pytest -q/.test(r.message), "imported evaluateCompletionGate is wired correctly end-to-end from this file");

  // log()
  {
    const tmp = `/tmp/codex-completion-gate-selftest-${process.pid}.jsonl`;
    const prevPath = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "completion_gate_fired", attempt: 1 });
      const lines2 = readFileSync(tmp, "utf8").trim().split("\n");
      ok(lines2.length === 1, "log() appends exactly one line per call");
      const rec = JSON.parse(lines2[0]);
      ok(typeof rec.t === "number" && rec.ev === "completion_gate_fired", "log() stamps t and preserves fields, same shape as every other adapter here");
    } finally {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      if (prevPath === undefined) delete process.env.CONTRACT_EVIDENCE; else process.env.CONTRACT_EVIDENCE = prevPath;
    }
  }
  {
    const prevPath = process.env.CONTRACT_EVIDENCE;
    delete process.env.CONTRACT_EVIDENCE;
    let threw = false;
    try { log({ ev: "x" }); } catch { threw = true; }
    ok(!threw, "log() with CONTRACT_EVIDENCE unset does not throw");
    if (prevPath !== undefined) process.env.CONTRACT_EVIDENCE = prevPath;
  }

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("codex-completion-gate self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("codex-completion-gate.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
