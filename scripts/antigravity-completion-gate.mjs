#!/usr/bin/env node
//
// antigravity-completion-gate — the completion-gate HALF of pi's
// contract-guard.ts that antigravity-guard-adapter.mjs (a PreToolUse-only
// adapter) structurally cannot provide, ported to Antigravity CLI's own
// `Stop` hook. Same role as claude-completion-gate.mjs/
// codex-completion-gate.mjs; shares the actual decision logic via
// completion-gate-core.mjs and differs only in envelope/transcript/decision
// shape - LESS CONFIRMED than either sibling, see below.
//
// VERIFIED vs ASSUMED - read before trusting this in production. This one
// is the WEAKEST-grounded of the three completion gates - say so plainly:
//   VERIFIED (antigravity.google/docs/hooks/, fetched directly, 2026-10-12):
//     - Stop stdin shape: {executionNum, terminationReason, error?,
//       fullyIdle, conversationId, workspacePaths, transcriptPath,
//       artifactDirectoryPath, modelName}.
//     - To force another turn: {"decision":"continue","reason"?} on stdout.
//       "Any other value permits normal termination" - this adapter always
//       emits an EXPLICIT {"decision":"allow"} for the non-blocking case
//       rather than silence, matching antigravity-guard-adapter.mjs's OWN
//       PreToolUse convention (it always emits a decision too, unlike
//       codex's "silence means allow") - consistency with this backend's
//       existing adapter mattered more here than matching claude/codex's
//       silence convention, since "any other value" already covers an
//       explicit allow just as validly as no output would.
//     - `fullyIdle: boolean` - true once the agent is completely finished,
//       false if background tasks remain active. USED here as a precondition:
//       this gate never even evaluates a completion claim while
//       fullyIdle===false - gating mid-background-task is the wrong moment
//       regardless of what the transcript says.
//   THE BIG DIFFERENCE FROM CLAUDE/CODEX: there is NO last_assistant_message
//   (or equivalent) field in this envelope at all. Both siblings get the
//   turn's final text handed to them directly and are told NOT to derive it
//   from the transcript (async-lag risk). Antigravity gives no such
//   shortcut - this adapter MUST read transcriptPath to get the model's own
//   words, which means the completion-CLAIM half of this gate carries the
//   same schema-guess risk the test-EVIDENCE half already had on the other
//   two backends. Compounded uncertainty, handled the same way: fail open
//   on anything unrecognised, never guess.
//   NOT OFFICIALLY DOCUMENTED AT ALL (every source checked agrees on this,
//   not just this adapter's own author): the transcript.jsonl step schema.
//   USER_INPUT/PLANNER_RESPONSE's `type`/`content` top-level string fields
//   ARE already proven in this project (scripts/session-cost.mjs's own
//   readAntigravityModelChanges/sumAntigravityUsage, which this file reuses
//   that same convention for, not a fresh guess). Tool calls/results are
//   NOT proven here - cross-referenced from a single GitHub issue
//   description (donovan-yohan/relay-ide#1528) naming
//   "PLANNER_RESPONSE.tool_calls[]" and "GENERIC tool results" WITHOUT a
//   verbatim JSON example - weaker evidence than codex-completion-gate.mjs's
//   rollout.jsonl cross-referencing (which had real quoted examples). No
//   call_id/tool_use_id equivalent is confirmed either, so pairing below is
//   positional (FIFO: the Nth tool_calls[] entry seen is paired with the Nth
//   GENERIC step's text that follows it) rather than id-based - strictly
//   weaker than either sibling's pairing and said so explicitly here rather
//   than implied to be equally reliable.
//
// FAIL OPEN, not closed - same reasoning as both siblings: a hung session
// from a Stop-hook bug is worse than missing one gate opportunity. Given
// this adapter's compounded schema uncertainty (see above), it fails open
// MORE readily than its siblings - any missing/ambiguous signal, not just a
// zero-tool-result transcript, skips the gate.
//
//   node scripts/antigravity-completion-gate.mjs < stop-envelope.json
//   node scripts/antigravity-completion-gate.mjs --selftest
//
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { evaluateCompletionGate, loadAttempts } from "./completion-gate-core.mjs";
import { counterStatePath } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";

// Same log() shape as every other adapter here (t, ev, ...rec).
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/**
 * Best-effort extraction from an Antigravity transcript.jsonl: the LAST
 * PLANNER_RESPONSE's text (the completion claim this adapter has no other
 * way to get - see header) and a positionally-paired {command, output,
 * isError}[] from PLANNER_RESPONSE.tool_calls[] + the GENERIC steps that
 * follow them. WEAKEST-confirmed schema of the three adapters - see header.
 * Positional pairing means a transcript with interleaved unrelated GENERIC
 * steps (anything not actually a tool result) will mis-pair - accepted risk,
 * bounded by the same fail-open design every unrecognised-schema path uses.
 *
 * @returns { lastAssistantMessage: string|null, toolResults: Array }
 */
export function extractAntigravityTranscript(lines) {
  let lastAssistantMessage = null;
  const pendingCalls = [];
  const toolResults = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "PLANNER_RESPONSE") {
      if (typeof entry.content === "string") lastAssistantMessage = entry.content;
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          const name = tc?.name;
          const args = tc?.args || {};
          const command = name === "run_command" ? String(args.CommandLine ?? "") : JSON.stringify(args);
          pendingCalls.push({ command });
        }
      }
    } else if (entry?.type === "GENERIC") {
      const text = typeof entry.content === "string" ? entry.content
        : typeof entry.text === "string" ? entry.text
        : typeof entry.output === "string" ? entry.output
        : null;
      if (text != null && pendingCalls.length > 0) {
        const call = pendingCalls.shift();
        toolResults.push({ command: call.command, output: text, isError: false });
      }
    }
  }
  return { lastAssistantMessage, toolResults };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let envelope;
  try { envelope = JSON.parse(raw); } catch { return done({ decision: "allow" }); } // fail open - see header

  try {
    // fullyIdle===false means background work is still active - gating
    // "did you claim done and are tests green" at this moment is simply the
    // wrong question; let it continue on its own, don't evaluate anything.
    if (envelope.fullyIdle === false) return done({ decision: "allow" });

    const { claimsCompletion, testsRanAndPassed, isTestInvocation } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done({ decision: "allow" }); // no guard config at all - nothing to gate, fail open
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;
    const gate = guards.find((g) => g.check === "evidence_captured" && g.params?.enforce_before_settle);
    if (!gate) return done({ decision: "allow" }); // this role's compiled contract doesn't want this gate

    let lines = [];
    try { lines = readFileSync(envelope.transcriptPath, "utf8").split(/\r?\n/); } catch { /* transcript unreadable - handled below */ }
    const { lastAssistantMessage, toolResults } = extractAntigravityTranscript(lines);

    // No signal at all (couldn't even find a last assistant message) -
    // compounded uncertainty beyond what either sibling faces (they get
    // last_assistant_message handed to them directly) - fail open here
    // specifically, before even asking whether it claims completion.
    if (lastAssistantMessage == null) {
      log({ ev: "completion_gate_schema_unrecognised", why: "no PLANNER_RESPONSE text found in transcript - cannot even read the completion claim" });
      return done({ decision: "allow" });
    }

    const statePath = counterStatePath("antigravity-completion-attempts", envelope.conversationId);
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
        return done({ decision: "allow" });
      case "schema_unrecognised":
        log({ ev: "completion_gate_schema_unrecognised", why: r.reason });
        return done({ decision: "allow" }); // fail open - see header
      case "passed":
        log({ ev: "completion_gate_passed", why: r.reason });
        return done({ decision: "allow" });
      case "exhausted":
        log({ ev: "completion_gate_exhausted", attempts: r.attempts, why: r.reason });
        // Let the turn actually end (fail open) - mirrors pi's own
        // continue:false, NOT a forced retry.
        return done({ decision: "allow" });
      case "fired":
        log({ ev: "completion_gate_fired", attempt: r.attempts, why: r.reason });
        return done({ decision: "continue", reason: r.message });
    }
  } catch (e) {
    log({ ev: "completion_gate_error", err: String(e.message || e) });
    return done({ decision: "allow" }); // fail open - see header
  }
}

function done(decision) {
  process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // extractAntigravityTranscript - the already-proven USER_INPUT/PLANNER_RESPONSE
  // type/content convention (session-cost.mjs), plus the cross-referenced
  // (not verbatim-confirmed) tool_calls[]/GENERIC pairing.
  const fakeTranscript = [
    JSON.stringify({ type: "USER_INPUT", content: "please implement X" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", content: "running the tests now", tool_calls: [{ name: "run_command", args: { CommandLine: "pytest -q" } }] }),
    JSON.stringify({ type: "GENERIC", content: "5 passed in 0.4s" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", content: "The feature is done and ready for review." }),
    "not json at all, must be skipped not thrown",
  ].join("\n");
  const parsed = extractAntigravityTranscript(fakeTranscript.split("\n"));
  ok(parsed.lastAssistantMessage === "The feature is done and ready for review.",
    "lastAssistantMessage is the LAST PLANNER_RESPONSE's content, not the first");
  ok(parsed.toolResults.length === 1 && parsed.toolResults[0].command === "pytest -q" && parsed.toolResults[0].output === "5 passed in 0.4s",
    "a tool_calls[] entry is positionally paired with the GENERIC step that follows it");

  ok(extractAntigravityTranscript(["garbage", "{}", ""]).lastAssistantMessage === null,
    "no recognisable PLANNER_RESPONSE anywhere -> lastAssistantMessage null, not a crash or a wrong guess");
  ok(extractAntigravityTranscript(["garbage", "{}", ""]).toolResults.length === 0, "same case -> no tool results either");

  const orphanGeneric = [
    JSON.stringify({ type: "PLANNER_RESPONSE", content: "x" }),
    JSON.stringify({ type: "GENERIC", content: "orphaned, no tool_calls preceded it" }),
  ];
  ok(extractAntigravityTranscript(orphanGeneric).toolResults.length === 0,
    "a GENERIC step with no pending tool call is dropped, not force-paired with garbage");

  // main()'s decision shape - thin smoke test; the actual gating logic is
  // tested exhaustively in completion-gate-core.mjs.
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
    const tmp = `/tmp/antigravity-completion-gate-selftest-${process.pid}.jsonl`;
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
  console.log("antigravity-completion-gate self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("antigravity-completion-gate.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
