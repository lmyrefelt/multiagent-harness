#!/usr/bin/env node
//
// vibe-guard-adapter — a PROTOCOL adapter, not new enforcement logic.
//
// WHY THIS EXISTS
// Mistral Vibe CLI (`vibe`, Dockerfile.vibe) has an external-command hook
// system much like Claude Code's and Codex's: a `pre_tool` hook in
// ~/.vibe/hooks.toml (or $VIBE_HOME/hooks.toml) is spawned per tool call with
// a JSON envelope on stdin and answers on stdout. This file translates that
// envelope into checks.mjs's canonical {toolName, input} event, runs the SAME
// pure evaluateDuring(guards, event, ctx) pi's contract-guard.ts uses, and
// answers in Vibe's own decision schema.
//
// VERIFIED (2026-11-05, vibe 3.1.0) - not from training memory:
//   From the docs bundled in the package
//   (vibe/plugins/builtins/vibe/skills/vibe/SKILL.md, "Hooks"):
//     - stdin: {hook_event_name:"pre_tool", session_id, parent_session_id,
//       transcript_path, cwd, tool_name, tool_call_id, tool_input}.
//     - tool_name is ALWAYS the qualified name: file_system.bash,
//       file_system.write_file, file_system.edit, mcp_<server>.<tool>.
//     - stdout {"decision":"deny","reason":"..."} denies; the reason becomes
//       the tool error the model sees. Exit 0 + empty stdout = pass through.
//     - pre_tool runs BEFORE the permission prompt, so --auto-approve does
//       not skip it.
//     - Any hook failure (non-zero exit, timeout, bad stdout) FAILS OPEN
//       unless the hook has `strict = true` - launch-worker.sh sets it, so
//       a crash in this adapter denies the call instead of letting it run.
//   MEASURED against a real vibe 3.1.0 run (mock OpenAI-compatible model
//   scripting the tool calls, deny-on-path hook):
//     - write_file: the MODEL sends {path, content} (schema rejects
//       file_path), but the HOOK receives tool_input.file_path - Vibe
//       normalises it. Both are read here anyway.
//     - edit: tool_input {file_path, old_string, new_string}.
//     - bash: tool_input {command, timeout}.
//     - A deny for write_file AND edit kept the file off disk (checked on
//       the filesystem, not just the hook's output); allowed calls landed.
//     - Calls made from inside a `run_typescript` program
//       (tools.file_system.write_file / .bash) fire pre_tool with the SAME
//       tool_name/tool_input shape and honour a deny (the program sees a
//       tool_skipped error). The run_typescript call itself fired no
//       pre_tool in that run - so it is not mapped, and doesn't need to be:
//       its sandbox has no filesystem of its own, only tools.*.
//     - Tool calls in one model turn run CONCURRENTLY (parallel hook
//       processes). The counters state file is therefore updated under a
//       lock here - the other adapters never needed one.
//   UNVERIFIED: the qualified name of background commands. Docs name the
//   tool `process_start` (matcher), the app-server code `process.start`;
//   both, plus any *.bash / git_bash suffix, map to bash below.
//
// FAIL CLOSED, not open: bad JSON, missing CONTRACT_GUARDS, checks.mjs not
// found, a write/edit with no path, or a lock that can't be taken all deny.
//
//   node scripts/vibe-guard-adapter.mjs < envelope.json
//   node scripts/vibe-guard-adapter.mjs --selftest
//
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, rmdirSync, statSync, renameSync } from "node:fs";
import { loadCounters, counterStatePath, readStdin } from "./verify-change.mjs";

const CHECKS_MJS = process.env.CHECKS_MJS_PATH || "/opt/contracts/extensions/checks.mjs";
const MISSING_PATH = "__vibe_adapter_missing_path__";

// Same log() shape as the other adapters (t, ev, ...rec), so
// guard-stats.mjs's correlate() needs no vibe-specific parsing.
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/** "file_system.write_file" -> "write_file"; "mcp_x.y" stays whole (never a guarded mutator). */
export function shortName(toolName) {
  const n = String(toolName ?? "");
  if (n.startsWith("mcp_") || n.startsWith("connector_")) return n;
  const i = n.lastIndexOf(".");
  return i === -1 ? n : n.slice(i + 1);
}

// Vibe's tool_name/tool_input -> pi's canonical {toolName, input}.
export function toCanonicalEvent(toolName, toolInput) {
  const a = toolInput || {};
  const short = shortName(toolName);
  const path = a.file_path ?? a.path;
  switch (short) {
    case "bash":
    case "git_bash":
    case "process_start":
    case "start": // "process.start" (app-server naming) after shortName()
      return { toolName: "bash", input: { command: a.command } };
    case "write_file":
      // No path = can't check the boundary: fail closed through the normal
      // file_boundary path with a synthetic path that matches nothing.
      return { toolName: "write", input: { path: path ?? MISSING_PATH, content: a.content } };
    case "edit":
      return { toolName: "edit", input: { path: path ?? MISSING_PATH, old_string: a.old_string, new_string: a.new_string } };
    case "read_file":
      return { toolName: "read", input: { path, offset: a.offset, limit: a.limit } };
    default:
      // Unrecognised tool: pass the raw name through. No worker guard keys on
      // anything but bash/write/edit/multiedit/notebook_edit (checks.mjs
      // MUTATORS), so this is inert, not a silent bypass.
      return { toolName: short || String(toolName ?? ""), input: a };
  }
}

export function shouldLogHardStop(wasStopped, counters) {
  return !wasStopped && !!counters?.stopped;
}

/** checks.mjs result -> Vibe's decision; null = print nothing (pass through). */
export function toDecision(result) {
  if (result.blocked) return { decision: "deny", reason: result.reason || "blocked by worker guard" };
  return null;
}

/**
 * Run fn() while holding an exclusive lock on statePath (mkdir is atomic).
 * Vibe runs one turn's tool calls in parallel, so two hook processes can
 * read-modify-write the same counters file at once. A lock older than
 * staleMs is treated as left behind by a killed hook and taken over.
 */
export async function withLock(statePath, fn, { waitMs = 8000, staleMs = 15000 } = {}) {
  const lock = statePath + ".lock";
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmdirSync(lock); continue; } } catch { /* raced, retry */ }
      if (Date.now() > deadline) throw new Error("could not take the counters lock");
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try { return await fn(); } finally { try { rmdirSync(lock); } catch { /* best-effort */ } }
}

async function main() {
  const raw = await readStdin();

  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { return done(deny(`unparsable stdin envelope: ${e.message}`)); }

  try {
    const { evaluateDuring, newCounters } = await import(CHECKS_MJS);

    const guardsPath = process.env.CONTRACT_GUARDS;
    if (!guardsPath) return done(deny("CONTRACT_GUARDS is not set - failing closed, not open."));
    const guards = JSON.parse(readFileSync(guardsPath, "utf8")).guards;
    const repoRoot = process.env.REPO_ROOT || envelope.cwd || process.cwd();
    const event = toCanonicalEvent(envelope.tool_name, envelope.tool_input);

    // Subagents share the parent's counters: one worker, one budget.
    const sessionKey = envelope.parent_session_id || envelope.session_id;
    const statePath = counterStatePath("vibe-counters", sessionKey);

    const result = await withLock(statePath, () => {
      const counters = loadCounters(statePath, newCounters);
      const wasStopped = !!counters.stopped;
      // Same hard-stop policy as every other adapter (contract-guard.ts's ctx).
      const r = evaluateDuring(guards, event, {
        repoRoot, counters,
        max_consecutive_blocks: 5, max_total_blocks: 10, max_total_blocks_window: 100,
      });
      for (const v of r.violations ?? []) {
        log({ ev: "violation", guard: v.guard, check: v.check, hook: "tool_call",
          tool: event.toolName, detail: v.detail, on_violation: v.on_violation });
      }
      if (r.blocked) {
        log({ ev: "blocked", reason: r.reason, consecutive: r.consecutive,
          total: r.total, terminate: !!r.terminate, why: r.why });
      }
      if (shouldLogHardStop(wasStopped, counters)) {
        log({ ev: "hard_stop_engaged", blocks: counters.total_blocks, streak: counters.consecutive_blocks, tool_calls: counters.tool_calls });
      }
      writeFileSync(statePath + ".tmp", JSON.stringify(counters));
      renameSync(statePath + ".tmp", statePath);
      return r;
    });

    return done(toDecision(result));
  } catch (e) {
    return done(deny(`internal error, failing closed: ${e.message}`));
  }
}

// Vibe wraps this as "Tool 'X' was denied by hook 'Y': {reason}" - so no
// self-naming in the reason (its docs ask for that).
function deny(reason) {
  return { decision: "deny", reason };
}

function done(decision) {
  if (decision !== null) process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}

async function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(shortName("file_system.write_file") === "write_file", "qualified name -> short");
  ok(shortName("bash") === "bash", "bare name unchanged");
  ok(shortName("mcp_linear.create_issue") === "mcp_linear.create_issue", "mcp names kept whole");

  // Shapes below are the ones MEASURED on a real vibe 3.1.0 run (see header).
  let e = toCanonicalEvent("file_system.bash", { timeout: 120, command: "echo hi" });
  ok(e.toolName === "bash" && e.input.command === "echo hi", "file_system.bash -> bash");

  e = toCanonicalEvent("file_system.write_file", { file_path: "src/x.gd", content: "x" });
  ok(e.toolName === "write" && e.input.path === "src/x.gd" && e.input.content === "x", "write_file (hook form, file_path) -> write");

  e = toCanonicalEvent("file_system.write_file", { path: "src/y.gd", content: "y" });
  ok(e.input.path === "src/y.gd", "write_file (model form, path) also read");

  e = toCanonicalEvent("file_system.write_file", { content: "y" });
  ok(e.input.path === MISSING_PATH, "write_file without any path fails closed via a synthetic path");

  e = toCanonicalEvent("file_system.edit", { file_path: "a.txt", old_string: "o", new_string: "n" });
  ok(e.toolName === "edit" && e.input.path === "a.txt" && e.input.old_string === "o" && e.input.new_string === "n", "edit -> edit");

  e = toCanonicalEvent("file_system.edit", {});
  ok(e.input.path === MISSING_PATH, "edit without a path fails closed");

  for (const n of ["process_start", "process.start", "file_system.process_start", "git_bash"]) {
    ok(toCanonicalEvent(n, { command: "sleep 1" }).toolName === "bash", `${n} -> bash`);
  }

  e = toCanonicalEvent("file_system.read_file", { path: "a.txt", offset: 1, limit: 5 });
  ok(e.toolName === "read" && e.input.path === "a.txt" && e.input.limit === 5, "read_file -> read");

  e = toCanonicalEvent("mcp_x.do", { a: 1 });
  ok(e.toolName === "mcp_x.do" && e.input.a === 1, "unknown tool passes through unmapped");

  ok(toDecision({ blocked: true, reason: "nope" }).decision === "deny", "blocked -> deny");
  ok(toDecision({ blocked: true, reason: "nope" }).reason === "nope", "deny carries the reason");
  ok(toDecision({ blocked: false }) === null, "not blocked -> print nothing");

  ok(shouldLogHardStop(false, { stopped: true }) === true, "hard stop flips -> log");
  ok(shouldLogHardStop(true, { stopped: true }) === false, "hard stop already on -> don't re-log");
  ok(shouldLogHardStop(false, {}) === false, "missing field -> no crash");

  // withLock: parallel read-modify-write must not lose updates.
  {
    const p = `/tmp/vibe-guard-adapter-selftest-${process.pid}.json`;
    writeFileSync(p, JSON.stringify({ n: 0 }));
    await Promise.all(Array.from({ length: 20 }, () => withLock(p, async () => {
      const s = JSON.parse(readFileSync(p, "utf8"));
      await new Promise((r) => setTimeout(r, 2));
      writeFileSync(p, JSON.stringify({ n: s.n + 1 }));
    })));
    ok(JSON.parse(readFileSync(p, "utf8")).n === 20, "withLock serialises 20 concurrent updates (no lost counts)");
    // Stale lock from a killed hook is taken over, not waited on forever.
    mkdirSync(p + ".lock");
    const old = new Date(Date.now() - 60000);
    (await import("node:fs")).utimesSync(p + ".lock", old, old);
    let ran = false;
    await withLock(p, () => { ran = true; }, { waitMs: 500 });
    ok(ran, "a stale lock is taken over");
    // A live lock past the wait budget throws (main() turns that into a deny).
    mkdirSync(p + ".lock");
    let threw = false;
    try { await withLock(p, () => {}, { waitMs: 100 }); } catch { threw = true; }
    ok(threw, "a held lock past the wait budget throws -> fail closed");
    try { rmdirSync(p + ".lock"); unlinkSync(p); } catch { /* cleanup */ }
  }

  {
    const tmp = `/tmp/vibe-guard-adapter-selftest-${process.pid}.jsonl`;
    const prev = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "violation", guard: "invariant.x" });
      const rec = JSON.parse(readFileSync(tmp, "utf8").trim());
      ok(typeof rec.t === "number" && rec.ev === "violation", "log() stamps t and keeps fields");
    } finally {
      try { unlinkSync(tmp); } catch { /* cleanup */ }
      if (prev === undefined) delete process.env.CONTRACT_EVIDENCE; else process.env.CONTRACT_EVIDENCE = prev;
    }
  }

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("vibe-guard-adapter self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("vibe-guard-adapter.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
