#!/usr/bin/env node
//
// claude-completion-gate — the completion-gate HALF of pi's contract-guard.ts
// that claude-guard-adapter.mjs (a PreToolUse-only adapter) structurally
// cannot provide, ported to Claude Code's `Stop` hook.
//
// WHY THIS EXISTS
// pi's gate lives in agent_before_settle/agent_settled, hooks that see the
// WHOLE turn/transcript. claude-guard-adapter.mjs answers PreToolUse only -
// one tool call at a time, no view of "did the model just claim done without
// tests passing." Claude Code's own `Stop` hook (fires once per turn) is the
// right integration point for that - this file is pi's completion gate
// logic, re-expressed against Stop's envelope instead of pi's.
//
// VERIFIED vs ASSUMED - read before trusting this in production:
//   VERIFIED (code.claude.com/docs/en/hooks, fetched directly, 2026-10-12):
//     - Stop stdin shape: {session_id, prompt_id, transcript_path, cwd,
//       scratchpad_dir, permission_mode, effort, hook_event_name:"Stop",
//       last_assistant_message}.
//     - To force another turn: exit 0 with
//       {decision:"block", reason, hookSpecificOutput:{hookEventName:"Stop",
//       additionalContext}} on stdout. To allow a normal stop: exit 0 with
//       NO JSON output (decision omitted entirely) - NOT an explicit
//       {decision:"allow"} the way claude-guard-adapter.mjs's OWN PreToolUse
//       decision works; Stop has no such field for the non-blocking case.
//     - The docs EXPLICITLY recommend AGAINST parsing transcript_path for
//       Stop specifically ("written asynchronously and may lag... may not
//       yet include the current turn's most recent messages") and say to use
//       last_assistant_message for the turn's text instead - done here:
//       last_assistant_message is what claimsCompletion() is run against,
//       never the transcript.
//   NOT DOCUMENTED AT ALL (checked directly, not assumed silently):
//     - The exact JSONL schema of transcript_path's entries - the docs admit
//       this isn't specified anywhere public. This adapter still reads it,
//       ONLY to recover tool_use/tool_result pairs (which last_assistant_message
//       cannot give at all), using the shape Claude Code's transcripts are
//       known to share with the Messages API conversation format. If that
//       guess is wrong, extractToolResults() returns zero entries - see FAIL
//       OPEN below for what happens then.
//     - "stop_hook_active": appears in some community hook examples as a
//       loop-detection flag but is NOT in this project's own fetched docs.
//       NOT relied upon - the attempt budget below uses this adapter's own
//       persisted counter file instead (same proven pattern as the
//       PreToolUse adapters' tool_call_limit counters), which does not
//       depend on an undocumented field existing or meaning what community
//       examples guess it means.
//
// FAIL OPEN, not closed - the OPPOSITE of the PreToolUse adapters' stance,
// and deliberately so. A PreToolUse adapter that fails open risks an unsafe
// WRITE; this hook only ever decides whether to let a turn end. Blocking a
// stop indefinitely because of a bug here (bad JSON, missing guard config,
// an unrecognised transcript schema) produces a HUNG SESSION, which is a
// worse failure than occasionally missing one real gate opportunity. Every
// error path below exits 0 with no decision field - let the turn end, don't
// guess.
//
//   node scripts/claude-completion-gate.mjs < stop-envelope.json
//   node scripts/claude-completion-gate.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { evaluateCompletionGate, loadAttempts } from "./completion-gate-core.mjs";
import { counterStatePath, readStdin } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

// Same log() shape as every other adapter here (t, ev, ...rec) - so this
// hook's completion_gate_* records land in guard-stats.mjs's correlate()
// with no special-casing, same as the tool_call-level violation/blocked
// records claude-guard-adapter.mjs already writes.
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/**
 * Best-effort tool_use/tool_result extraction from a Claude Code transcript
 * JSONL, into pi's canonical {command, output, isError}[] shape -
 * testsRanAndPassed (checks.mjs) is schema-agnostic and only needs that.
 *
 * UNDOCUMENTED SCHEMA (see header) - tolerant on purpose: skips anything
 * that doesn't match rather than throwing, and returns [] (not a partial
 * guess) if NOTHING in the whole transcript matched this shape at all, which
 * is the signal the caller uses to distinguish "this schema guess is simply
 * wrong" from "the model genuinely made zero tool calls."
 */
export function extractToolResults(lines) {
  const uses = new Map(); // tool_use_id -> { command }
  const results = []; // { id, output, isError } in file order, paired after
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.id) {
        const command = b.name === "Bash" ? String(b.input?.command ?? "") : JSON.stringify(b.input ?? {});
        uses.set(b.id, { command });
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const content = Array.isArray(b.content)
          ? b.content.map((c) => c?.text ?? "").join("\n")
          : String(b.content ?? "");
        results.push({ id: b.tool_use_id, output: content, isError: !!b.is_error });
      }
    }
  }
  const paired = [];
  for (const r of results) {
    const use = uses.get(r.id);
    if (!use) continue; // a result with no matching tool_use - schema mismatch on this line, skip it, not fatal
    paired.push({ command: use.command, output: r.output, isError: r.isError });
  }
  return paired;
}

async function main() {
  const raw = await readStdin();

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
    const toolResults = extractToolResults(lines);

    const statePath = counterStatePath("claude-completion-attempts", envelope.session_id);
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
        // Let the turn actually end (fail open) - this mirrors pi's own
        // continue:false, NOT a forced retry. The durable log record is
        // what marks this run as unverified for anything reading evidence.jsonl
        // afterward; forcing MORE turns once the budget is spent would be
        // the SAME unbounded-retry failure mode guards elsewhere exist to stop.
        return done(null);
      case "fired":
        log({ ev: "completion_gate_fired", attempt: r.attempts, why: r.reason });
        return done({
          decision: "block",
          reason: `tests not green (${r.reason})`,
          hookSpecificOutput: { hookEventName: "Stop", additionalContext: r.message },
        });
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

  // extractToolResults
  const fakeTranscript = [
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "uv run pytest -q" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "5 passed in 0.4s" }], is_error: false }] } }),
    "not json at all, must be skipped not thrown",
    JSON.stringify({ message: { content: "not an array, must be skipped" } }),
  ].join("\n");
  const paired = extractToolResults(fakeTranscript.split("\n"));
  ok(paired.length === 1, "one tool_use + its matching tool_result pairs into one entry");
  ok(paired[0].command === "uv run pytest -q" && paired[0].output === "5 passed in 0.4s" && paired[0].isError === false,
    "paired entry carries command/output/isError in testsRanAndPassed's expected shape");

  ok(extractToolResults(["garbage", "{}", ""]).length === 0, "no recognisable tool_use/tool_result anywhere -> empty, not a crash");

  const orphanResult = [
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "x", is_error: false }] } }),
  ];
  ok(extractToolResults(orphanResult).length === 0, "a tool_result with no matching tool_use is dropped, not force-paired with garbage");

  const edgeCasesTranscript = [
    "   ",
    JSON.stringify({ message: { content: [null, "string-block"] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "OtherTool", input: { key: "val" } }] } }), // missing id
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "t2", name: "OtherTool", input: { key: "val" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "raw string result", is_error: true }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "t3", name: "Bash" }] } }), // missing input
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "text" }, { type: "text", text: "part2" }] }] } }) // missing text
  ].join("\n");
  const advPaired = extractToolResults(edgeCasesTranscript.split("\n"));
  ok(advPaired.length === 2, "handles non-Bash tools, errors, missing inputs, and string contents correctly");
  ok(advPaired[0].command === '{"key":"val"}' && advPaired[0].output === "raw string result" && advPaired[0].isError === true, "non-bash JSON serializes input, reads string result, parses is_error");
  ok(advPaired[1].command === "" && advPaired[1].output === "\npart2" && advPaired[1].isError === false, "handles missing Bash input and concatenates array contents skipping missing texts");

  // evaluateCompletionGate itself is tested exhaustively in
  // completion-gate-core.mjs's own selftest (shared by codex-completion-gate.mjs
  // too) - this is just confirming the import wires through correctly, using
  // Claude-shaped tool results, not re-testing the decision logic again here.
  const r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "uv run pytest -q", output: "1 failed", isError: false }],
    claimPatterns: [], gateParams: { claim_patterns: ["\\bdone\\b"], max_completion_attempts: 2 }, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed/errored" }),
    claimsCompletionFn: () => true,
    isTestInvocationFn: (cmd) => /pytest/.test(cmd),
  });
  ok(r.outcome === "fired" && /uv run pytest -q/.test(r.message), "imported evaluateCompletionGate is wired correctly end-to-end from this file");

  // log()
  {
    const tmp = `/tmp/claude-completion-gate-selftest-${process.pid}.jsonl`;
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
  console.log("claude-completion-gate self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("claude-completion-gate.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
