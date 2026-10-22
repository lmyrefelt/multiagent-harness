#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
//
// completion-gate-core — the backend-AGNOSTIC half of the Stop-hook
// completion gate, shared by claude-completion-gate.mjs and
// codex-completion-gate.mjs.
//
// WHY THIS IS ITS OWN FILE
// Extracted 2026-10-12 while building the codex equivalent of
// claude-completion-gate.mjs: the actual gating decision (did the model
// claim done, is there test evidence, has the retry budget run out) has
// NOTHING backend-specific in it - checks.mjs's own claimsCompletion/
// testsRanAndPassed already do the real work, schema-agnostically, on a
// plain {command, output, isError}[] array. Only the ENVELOPE (how to read
// "did it claim done" and the transcript file) and the DECISION (how to
// tell that backend's hook runtime to block/continue) differ per backend -
// those stay in claude-completion-gate.mjs/codex-completion-gate.mjs, which
// both import evaluateCompletionGate from here rather than duplicating it.
// Same "thin translation layer, not new enforcement logic" principle every
// other adapter in this project states in its own header.
//
export { };

/**
 * Pure decision core - given everything already extracted/read from
 * whichever backend's own envelope+transcript shape, decide what happens.
 *
 * @returns { outcome: "no_claim"|"passed"|"fired"|"exhausted"|"schema_unrecognised",
 *            attempts, reason, message? }
 */
export function evaluateCompletionGate({ lastAssistantMessage, toolResults, claimPatterns, gateParams, priorAttempts, testsRanAndPassedFn, claimsCompletionFn, isTestInvocationFn }) {
  if (!claimsCompletionFn(lastAssistantMessage ?? "", claimPatterns)) {
    return { outcome: "no_claim", attempts: priorAttempts, reason: "no completion claim" };
  }
  if (toolResults.length === 0) {
    // Could be a genuinely toolless turn, or (far more likely for a worker
    // mid-implementation) this adapter's transcript-schema guess is wrong -
    // BOTH backends' own docs explicitly disclaim the transcript format as
    // unstable/undocumented. Fail open rather than nag a worker that may
    // well have already passed its tests.
    return { outcome: "schema_unrecognised", attempts: priorAttempts, reason: "claimed completion, but no tool-call/result pairs were recognised in the transcript - not acting on an unreliable read" };
  }
  const tp = testsRanAndPassedFn(toolResults, gateParams);
  if (tp.passed) {
    return { outcome: "passed", attempts: priorAttempts, reason: tp.reason };
  }
  const attempts = priorAttempts + 1;
  const max = gateParams.max_completion_attempts ?? 4;
  if (attempts > max) {
    return { outcome: "exhausted", attempts, reason: tp.reason };
  }
  // Mirror pi's own testCommands[0] - the first command actually SEEN this
  // turn that looks like a test invocation, not a compiled config field
  // (evidence_captured's real params have no such field).
  const seenTestCmd = toolResults.find((r) => r.command && isTestInvocationFn(r.command))?.command;
  const cmd = seenTestCmd || "the project's test command";
  return {
    outcome: "fired", attempts, reason: tp.reason,
    message: `CONTRACT GATE attempt ${attempts}/${max}: you claimed completion, but the tests are not green (${tp.reason}). Run:  ${cmd}  and make it PASS. Do not claim completion until that command actually runs and passes.`,
  };
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  const alwaysClaims = () => true;
  const neverClaims = () => false;
  const fakeIsTestInvocation = (cmd) => /pytest|exec_command/.test(cmd);
  const paramsFixture = { claim_patterns: ["\\bdone\\b"], max_completion_attempts: 2 };

  let r = evaluateCompletionGate({
    lastAssistantMessage: "not done yet", toolResults: [], claimPatterns: [], gateParams: paramsFixture,
    priorAttempts: 0, testsRanAndPassedFn: () => ({ passed: true }), claimsCompletionFn: neverClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(r.outcome === "no_claim", "no completion claim -> no_claim, nothing else even evaluated");

  r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [], claimPatterns: [], gateParams: paramsFixture,
    priorAttempts: 0, testsRanAndPassedFn: () => ({ passed: true, reason: "x" }), claimsCompletionFn: alwaysClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(r.outcome === "schema_unrecognised",
    "REGRESSION: claims completion but zero tool results were recognised -> fail open (schema_unrecognised), never silently 'passed'");

  r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "pytest -q", output: "5 passed", isError: false }],
    claimPatterns: [], gateParams: paramsFixture, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: true, reason: "tests ran and passed" }), claimsCompletionFn: alwaysClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(r.outcome === "passed", "real tool results + testsRanAndPassed says passed -> passed, gate stays quiet");

  r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "pytest -q", output: "1 failed", isError: false }],
    claimPatterns: [], gateParams: paramsFixture, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed/errored" }), claimsCompletionFn: alwaysClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(r.outcome === "fired" && r.attempts === 1, "claimed done, tests failed, under budget -> fired, attempt 1");
  ok(/pytest -q/.test(r.message), "REGRESSION: the fired message names the ACTUAL command seen in toolResults (mirrors pi's own testCommands[0]), not an invented config field");

  r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "echo hi", output: "1 failed", isError: false }],
    claimPatterns: [], gateParams: paramsFixture, priorAttempts: 0,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed/errored" }), claimsCompletionFn: alwaysClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(/the project's test command/.test(r.message), "no recognised test command among toolResults -> generic fallback text, not a crash or a wrong command name");

  r = evaluateCompletionGate({
    lastAssistantMessage: "done", toolResults: [{ command: "pytest -q", output: "1 failed", isError: false }],
    claimPatterns: [], gateParams: paramsFixture, priorAttempts: 2,
    testsRanAndPassedFn: () => ({ passed: false, reason: "tests ran but failed/errored" }), claimsCompletionFn: alwaysClaims, isTestInvocationFn: fakeIsTestInvocation,
  });
  ok(r.outcome === "exhausted" && r.attempts === 3, "priorAttempts already at max (2) -> this attempt (3) exceeds it -> exhausted, not another fired");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("completion-gate-core self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("completion-gate-core.mjs");
if (direct && process.argv.includes("--selftest")) selftest();

export function getCounterStatePath(prefix, id) {
  const evidence = process.env.CONTRACT_EVIDENCE;
  const dir = evidence ? dirname(evidence) : ".";
  return join(dir, `${prefix}-${id || "default"}.json`);
}

export function loadAttempts(path) {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")).attempts ?? 0; } catch { /* fall through */ }
  }
  return 0;
}
