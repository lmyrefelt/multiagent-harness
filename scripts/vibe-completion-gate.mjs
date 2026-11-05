#!/usr/bin/env node
//
// vibe-completion-gate — Mistral Vibe `post_agent` hook: completion-gate
// parity with pi's contract-guard.ts (agent_before_settle), the same job
// codex-completion-gate.mjs / claude-completion-gate.mjs do for their CLIs.
// All decision logic is completion-gate-core.mjs + checks.mjs; this file only
// reads Vibe's transcript into that core's canonical shapes.
//
// VERIFIED (2026-11-05, vibe 3.1.0):
//   Docs bundled in the package (vibe/plugins/builtins/vibe/skills/vibe/SKILL.md):
//     - post_agent fires once per turn after the agent finishes with no
//       pending tool calls; stdin {hook_event_name:"post_agent", session_id,
//       parent_session_id, transcript_path, cwd, agent_name}. NO last
//       assistant message in the payload (unlike Codex/Claude Stop hooks).
//     - stdout {"decision":"deny","reason":R} injects R as a retry user
//       message; Vibe itself caps that at 3 retries per turn.
//     - launch-worker.sh registers it with match = "main" so it never fires
//       on a subagent's turn.
//   MEASURED on a real run (hook copying transcript_path at post_agent time):
//     - transcript_path is a session-store DIRECTORY, not a file. At
//       post_agent time the final reply is only in journal/*.jsonl (the
//       chunks/ store lags behind), so the journal is what's read here.
//     - Final reply: the LAST record {type:"action_result",
//       payload.result.type:"completion_succeeded"} -> result.result.parts[]
//       items with type "text".
//     - Tool results: {type:"action_result", payload.result.type:
//       "tool_succeeded", payload.result.call_id, payload.result.result.
//       structured_content:{command, stdout, stderr, returncode}} for bash.
//       A bash call exiting non-zero is still tool_succeeded (returncode
//       carries it) - same as Vibe's docs say for post_tool.
//   UNDOCUMENTED-AS-STABLE: the journal is Vibe's internal recovery store
//   (store_format "mistral.vibe.unified-session-store/v1"). Parsing is
//   tolerant; if nothing recognisable is found, completion-gate-core reports
//   schema_unrecognised and this gate FAILS OPEN - same policy as the codex/
//   claude/antigravity gates (a gate that blocks on a misread transcript is
//   worse than one that stays quiet).
//
//   node scripts/vibe-completion-gate.mjs < envelope.json
//   node scripts/vibe-completion-gate.mjs --selftest
//
import { readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { evaluateCompletionGate, loadAttempts } from "./completion-gate-core.mjs";
import { counterStatePath, readStdin } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/** All journal lines of a Vibe session store, oldest segment first. */
export function readJournal(transcriptPath) {
  const dir = join(String(transcriptPath ?? ""), "journal");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; }
  const lines = [];
  for (const f of files) {
    try { lines.push(...readFileSync(join(dir, f), "utf8").split(/\r?\n/)); } catch { /* skip unreadable segment */ }
  }
  return lines;
}

/**
 * Journal lines -> { lastAssistantMessage, toolResults[{command, output, isError}] }.
 * Tolerant: anything that doesn't match is skipped, never thrown.
 */
export function extractVibeTranscript(lines) {
  const callArgs = new Map(); // call_id -> parsed arguments, from completion tool_call parts
  const results = [];
  let lastAssistantMessage = "";
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.type !== "action_result") continue;
    const res = r.payload?.result;
    if (!res || typeof res !== "object") continue;

    if (res.type === "completion_succeeded") {
      const parts = Array.isArray(res.result?.parts) ? res.result.parts : [];
      for (const p of parts) {
        if (p?.type === "tool_call" && p.id) {
          let a = p.arguments_json ?? p.arguments;
          if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
          callArgs.set(p.id, a ?? {});
        }
      }
      const text = parts.filter((p) => p?.type === "text").map((p) => String(p.text ?? "")).join("\n");
      if (text.trim()) lastAssistantMessage = text;
    } else if (typeof res.type === "string" && res.type.startsWith("tool_") && res.call_id) {
      const sc = res.result?.structured_content ?? {};
      const args = callArgs.get(res.call_id) ?? {};
      const command = sc.command != null ? String(sc.command)
        : args.command != null ? String(args.command)
        : JSON.stringify(args);
      const output = [sc.stdout, sc.stderr].filter((x) => x != null && x !== "").join("\n")
        || (Array.isArray(res.result?.content) ? res.result.content.map((c) => c?.text ?? "").join("\n") : "")
        || String(res.result?.error?.message ?? res.error ?? "");
      const isError = res.type !== "tool_succeeded" || (typeof sc.returncode === "number" && sc.returncode !== 0);
      results.push({ command, output, isError });
    }
  }
  return { lastAssistantMessage, toolResults: results };
}

async function main() {
  const raw = await readStdin();

  let envelope;
  try { envelope = JSON.parse(raw); } catch { return done(null); } // fail open

  try {
    if (envelope.parent_session_id) return done(null); // subagent turn: the main agent's claim is what counts
    const { claimsCompletion, testsRanAndPassed, isTestInvocation } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done(null);
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;
    const gate = guards.find((g) => g.check === "evidence_captured" && g.params?.enforce_before_settle);
    if (!gate) return done(null);

    const { lastAssistantMessage, toolResults } = extractVibeTranscript(readJournal(envelope.transcript_path));

    const statePath = counterStatePath("vibe-completion-attempts", envelope.session_id);
    const priorAttempts = loadAttempts(statePath);

    const r = evaluateCompletionGate({
      lastAssistantMessage,
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
        return done(null);
      case "passed":
        log({ ev: "completion_gate_passed", why: r.reason });
        return done(null);
      case "exhausted":
        log({ ev: "completion_gate_exhausted", attempts: r.attempts, why: r.reason });
        return done(null);
      case "fired":
        log({ ev: "completion_gate_fired", attempt: r.attempts, why: r.reason });
        return done({ decision: "deny", reason: r.message });
    }
    return done(null);
  } catch (e) {
    log({ ev: "completion_gate_error", err: String(e.message || e) });
    return done(null); // fail open
  }
}

function done(decision) {
  if (decision !== null) process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // Records in the shapes MEASURED from a real vibe 3.1.0 journal (see header).
  const ar = (result) => JSON.stringify({ type: "action_result", payload: { result } });
  const journal = [
    JSON.stringify({ type: "core_input", payload: {} }),
    ar({ type: "completion_succeeded", result: { finish_reason: "tool_call", parts: [
      { type: "tool_call", id: "c1", name: "bash", arguments_json: JSON.stringify({ command: "pytest -q" }) },
      { type: "tool_call", id: "c2", name: "write_file", arguments_json: JSON.stringify({ path: "a.txt", content: "x" }) },
    ] } }),
    ar({ type: "tool_succeeded", call_id: "c1", result: { type: "success", structured_content: { command: "pytest -q", returncode: 1, stdout: "1 failed", stderr: "" } } }),
    ar({ type: "tool_succeeded", call_id: "c2", result: { type: "success", structured_content: { bytes_written: 1, path: "/w/a.txt" } } }),
    "not json, skipped",
    ar({ type: "hook_completed", result: {} }),
    ar({ type: "completion_succeeded", result: { finish_reason: "stop", parts: [{ type: "text", text: "All done." }] } }),
  ];
  const t = extractVibeTranscript(journal);
  ok(t.lastAssistantMessage === "All done.", "last text reply is the final completion's text parts");
  ok(t.toolResults.length === 2, "every tool_* result is paired");
  ok(t.toolResults[0].command === "pytest -q" && t.toolResults[0].output === "1 failed", "bash command/output from structured_content");
  ok(t.toolResults[0].isError === true, "non-zero returncode -> isError even though the type is tool_succeeded");
  ok(/a\.txt/.test(t.toolResults[1].command) && t.toolResults[1].isError === false, "non-bash tool falls back to its call arguments");

  const t2 = extractVibeTranscript([
    ar({ type: "completion_succeeded", result: { parts: [{ type: "tool_call", id: "x", arguments_json: "{\"command\":\"make\"}" }] } }),
    ar({ type: "tool_failed", call_id: "x", error: "boom" }),
  ]);
  ok(t2.toolResults.length === 1 && t2.toolResults[0].isError && t2.toolResults[0].command === "make", "tool_failed -> isError, command from the call");

  const t3 = extractVibeTranscript(["garbage", "{}", ""]);
  ok(t3.toolResults.length === 0 && t3.lastAssistantMessage === "", "nothing recognisable -> empty (-> schema_unrecognised, fail open)");

  const t4 = extractVibeTranscript([
    ar({ type: "completion_succeeded", result: { parts: [{ type: "text", text: "first" }] } }),
    ar({ type: "completion_succeeded", result: { parts: [{ type: "tool_call", id: "y", arguments_json: "{}" }] } }),
  ]);
  ok(t4.lastAssistantMessage === "first", "a later tool-call-only completion doesn't blank the last text reply");

  const r = evaluateCompletionGate({
    lastAssistantMessage: t.lastAssistantMessage, toolResults: t.toolResults,
    claimPatterns: [], gateParams: { claim_patterns: ["done"], max_completion_attempts: 2 }, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed" }),
    claimsCompletionFn: () => true, isTestInvocationFn: (c) => /pytest/.test(c),
  });
  ok(r.outcome === "fired" && /pytest -q/.test(r.message), "wired end-to-end into completion-gate-core");

  ok(readJournal("/nonexistent/dir").length === 0, "missing transcript dir -> no lines, no throw");

  {
    const tmp = `/tmp/vibe-completion-gate-selftest-${process.pid}.jsonl`;
    const prev = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "completion_gate_fired", attempt: 1 });
      const rec = JSON.parse(readFileSync(tmp, "utf8").trim());
      ok(typeof rec.t === "number" && rec.ev === "completion_gate_fired", "log() shape matches the other adapters");
    } finally {
      try { unlinkSync(tmp); } catch { /* cleanup */ }
      if (prev === undefined) delete process.env.CONTRACT_EVIDENCE; else process.env.CONTRACT_EVIDENCE = prev;
    }
  }

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("vibe-completion-gate self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("vibe-completion-gate.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
