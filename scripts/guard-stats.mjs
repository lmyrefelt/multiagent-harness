#!/usr/bin/env node
//
// guard-stats — which guard/violation/error each MODEL hits, and how often.
//
// WHY THIS EXISTS
// .contract-evidence.jsonl (the guard engine's own audit log - violation, blocked,
// disconnect_recovery_fired/exhausted, completion_gate_fired, etc.) is timestamped
// but has NO IDEA which model was active - the guard engine is model-agnostic by
// design (it evaluates tool_call events, not model identity). The session's OWN
// *.jsonl file DOES carry model identity, via model_change events, ALSO timestamped
// (session-cost.mjs already walks these for the cost breakdown). The two files
// already live side by side in every session dir and have never been correlated.
//
// Correlation rule: for each evidence event at time t, the active model is whichever
// model_change event has the LATEST timestamp <= t - same state-walk approach
// session-cost.mjs already uses for thinking-level tracking, just keyed on a
// different source file's events.
//
//   node scripts/guard-stats.mjs <path-to-.pi-session-dir-or-file>
//   node scripts/guard-stats.mjs --all              scan every .pi-session/*/ under the repo
//   node scripts/guard-stats.mjs --selftest
//
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { sessionFilesIn, readAntigravityModelChanges, antigravityTranscriptsIn } from "./session-cost.mjs";

const NL = String.fromCharCode(10);

/** Every model_change event from a session's OWN jsonl file(s), sorted ascending by time. */
export function readModelChanges(lines) {
  const changes = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "model_change") continue;
    const t = Date.parse(obj.timestamp);
    if (!Number.isFinite(t)) continue;
    changes.push({ t, key: `${obj.provider ?? "?"}/${obj.modelId ?? "?"}` });
  }
  changes.sort((a, b) => a.t - b.t);
  return changes;
}

/** The model active at time `t` - the last change at or before it, "unknown" if none yet. */
export function modelAt(changes, t) {
  let key = "unknown";
  for (const c of changes) {
    if (c.t <= t) key = c.key;
    else break; // changes is sorted ascending - nothing further can qualify
  }
  return key;
}

/**
 * Walk evidence.jsonl lines, attribute each event to the model active at its
 * timestamp. Malformed/non-JSON lines and events with no usable `t` are skipped,
 * not fatal - an evidence file being appended to while read should not crash this.
 */
export function correlate(evidenceLines, modelChanges) {
  const byModel = {};
  let total = 0;
  for (const line of evidenceLines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.ev || typeof obj.t !== "number") continue;
    const model = modelAt(modelChanges, obj.t);
    const bucket = byModel[model] ??= { events: {}, guards: {}, total: 0 };
    bucket.events[obj.ev] = (bucket.events[obj.ev] ?? 0) + 1;
    if (obj.guard) bucket.guards[obj.guard] = (bucket.guards[obj.guard] ?? 0) + 1;
    bucket.total += 1;
    total += 1;
  }
  return { byModel, total };
}

function mergeCorrelation(a, b) {
  for (const [model, bucket] of Object.entries(b)) {
    const dst = a[model] ??= { events: {}, guards: {}, total: 0 };
    for (const [ev, n] of Object.entries(bucket.events)) dst.events[ev] = (dst.events[ev] ?? 0) + n;
    for (const [g, n] of Object.entries(bucket.guards)) dst.guards[g] = (dst.guards[g] ?? 0) + n;
    dst.total += bucket.total;
  }
  return a;
}

/**
 * The most recent `rate_limit_snapshot` record in an evidence.jsonl (written
 * by scripts/claude-usage-statusline.mjs) - null if none exist, which is the
 * common case for pi/codex/antigravity sessions and for claude sessions on
 * API-key auth (that adapter never logs anything in either case). A raw
 * event-count tally ("rate_limit_snapshot: 47") would be useless for the
 * actual question - "how close to the limit are we RIGHT NOW" - only the
 * LATEST snapshot answers that; evidence.jsonl is append-only, so the last
 * matching line in the file is the most recent by construction.
 */
export function latestRateLimitSnapshot(evidenceLines) {
  let latest = null;
  for (const line of evidenceLines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.ev === "rate_limit_snapshot") latest = obj;
  }
  return latest;
}

/** Same idea as latestRateLimitSnapshot, for Antigravity's `quota_snapshot` records
 * (scripts/antigravity-usage-statusline.mjs) - a bucket-keyed map, not a fixed pair. */
export function latestQuotaSnapshot(evidenceLines) {
  let latest = null;
  for (const line of evidenceLines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.ev === "quota_snapshot") latest = obj;
  }
  return latest;
}

/** "in 1h23m" / "in 3d2h" / "overdue" for a Unix-epoch-SECONDS resets_at against now (ms). */
export function formatResetIn(resetsAtSec, nowMs = Date.now()) {
  if (typeof resetsAtSec !== "number") return "unknown";
  const deltaSec = resetsAtSec - Math.floor(nowMs / 1000);
  if (deltaSec <= 0) return "overdue (stale snapshot, or window just reset)";
  const days = Math.floor(deltaSec / 86400);
  const hours = Math.floor((deltaSec % 86400) / 3600);
  const mins = Math.floor((deltaSec % 3600) / 60);
  if (days > 0) return `in ${days}d${hours}h`;
  if (hours > 0) return `in ${hours}h${mins}m`;
  return `in ${mins}m`;
}

function sh(c) { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

/**
 * The bare counter snapshot antigravity-guard-adapter.mjs persists per
 * conversation (tool_calls, steps, consecutive_blocks, total_blocks, stopped) -
 * NO per-event detail (no guard id, no violated command, no timestamp per
 * block), unlike everything correlate() above handles. This is the only
 * antigravity signal available for runs that predate the 2026-10-12 fix to
 * that adapter (it now ALSO writes to evidence.jsonl in the same shape pi
 * uses, so future runs correlate like everything else and show up in
 * byModel/correlate() directly, not here).
 */
export function readAntigravityCounterFiles(dir, listFn = readdirSync, readFn = readFileSync) {
  let entries;
  try { entries = listFn(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const m = /^antigravity-counters-(.+)\.json$/.exec(name);
    if (!m) continue;
    try { out.push({ conversationId: m[1], counters: JSON.parse(readFn(join(dir, name), "utf8")) }); }
    catch { /* unreadable/corrupt counter file - skip, don't crash the whole report */ }
  }
  return out;
}

function reportOne(dir) {
  if (!existsSync(dir)) { console.error(`no such path: ${dir}`); return null; }
  const isFile = statSync(dir).isFile();
  const base = isFile ? dir.replace(/\/[^/]+$/, "") : dir;
  const sessFiles = (isFile ? [dir] : sessionFilesIn(base)).map((f) => (isFile ? f : join(base, f)));
  let modelChanges = [];
  for (const f of sessFiles) {
    try { modelChanges = modelChanges.concat(readModelChanges(readFileSync(f, "utf8").split(/\r?\n/))); }
    catch { /* unreadable session file - correlate against whatever we have */ }
  }
  // Antigravity model identity, merged into the SAME timeline - evidence.jsonl
  // is shared across every backend (one CONTRACT_EVIDENCE path per launch, see
  // launch-worker.sh), so a FUTURE antigravity violation (post 2026-10-12 fix)
  // needs antigravity's own model-change timeline to attribute correctly, not
  // just pi's.
  if (!isFile) {
    for (const f of antigravityTranscriptsIn(base)) {
      try { modelChanges = modelChanges.concat(readAntigravityModelChanges(readFileSync(f, "utf8").split(/\r?\n/))); }
      catch { /* unreadable transcript - correlate against whatever we have */ }
    }
  }
  modelChanges.sort((a, b) => a.t - b.t);

  const evidencePath = join(base, "evidence.jsonl");
  const agyCounters = isFile ? [] : readAntigravityCounterFiles(base);
  if (!existsSync(evidencePath) && agyCounters.length === 0) { console.log(`  ${dir}: no evidence.jsonl found`); return null; }
  const evidenceLines = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").split(/\r?\n/) : [];
  const { byModel, total } = correlate(evidenceLines, modelChanges);
  if (total === 0 && agyCounters.length === 0) { console.log(`  ${dir}: no evidence events found`); return null; }
  console.log(`  ${dir}`);
  for (const [model, bucket] of Object.entries(byModel)) {
    console.log(`    ${model}: ${bucket.total} events`);
    for (const [ev, n] of Object.entries(bucket.events)) console.log(`      ${ev}: ${n}`);
    for (const [g, n] of Object.entries(bucket.guards)) console.log(`      guard ${g}: ${n}`);
  }
  if (agyCounters.length) {
    console.log(`    antigravity (AGGREGATE ONLY - no per-event detail, see antigravity-guard-adapter.mjs's 2026-10-12 fix):`);
    for (const { conversationId, counters } of agyCounters) {
      console.log(`      conversation ${conversationId}: tool_calls=${counters.tool_calls} total_blocks=${counters.total_blocks} consecutive_blocks_at_end=${counters.consecutive_blocks} stopped=${counters.stopped}`);
    }
  }
  const rateLimit = latestRateLimitSnapshot(evidenceLines);
  if (rateLimit) {
    const parts = [];
    if (rateLimit.five_hour_pct != null) parts.push(`5h=${Math.round(rateLimit.five_hour_pct)}% (${formatResetIn(rateLimit.five_hour_resets_at)})`);
    if (rateLimit.seven_day_pct != null) parts.push(`7d=${Math.round(rateLimit.seven_day_pct)}% (${formatResetIn(rateLimit.seven_day_resets_at)})`);
    console.log(`    latest Claude subscription usage (${rateLimit.model ?? "claude"}): ${parts.join(" ")}`);
  }
  const quota = latestQuotaSnapshot(evidenceLines);
  if (quota?.quota) {
    // reset_in_seconds is already a countdown (not an epoch timestamp like
    // Claude's resets_at) - formatResetIn(x, 0) reuses the same formatter by
    // treating "now" as epoch 0, so deltaSec reduces to exactly reset_in_seconds.
    const parts = Object.entries(quota.quota).map(([bucket, v]) => `${bucket}=${v.used_pct}% (${formatResetIn(v.reset_in_seconds, 0)})`);
    console.log(`    latest Gemini subscription usage (${quota.model ?? "antigravity"}): ${parts.join(" ")}`);
  }
  return { byModel, total, agyCounters, rateLimit, quota };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--all")) {
    const root = sh("git rev-parse --show-toplevel").trim();
    const wtBase = join(root, ".worktrees");
    const dirs = [];
    // REAL BUG fixed 2026-10-12: a bare `.pi-session` AT base (e.g. the repo
    // root's own .pi-session/, holding integrator-pi/, integrator-pi-02/,
    // harness-change-0003*/, etc.) was pushed into dirs AS ITSELF - treated as
    // one flat session dir with *.jsonl directly inside it. It is actually a
    // CONTAINER of named session dirs, exactly like .worktrees/<name>/.pi-session
    // already was handled - this is the SAME shape, just one level shallower,
    // and the original code never recognised that. Found because the owner
    // asked why github-copilot's real spend looked too low: the two largest
    // integrator-pi/-02 session files in the ENTIRE repo (740 and 732
    // github-copilot usage lines) live at the repo root, not under
    // .worktrees, and were never scanned by this or either sibling script
    // (session-cost.mjs, fleet-status.mjs - all three had the identical bug,
    // fixed together).
    const scanFor = (base) => {
      if (!existsSync(base)) return;
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const piSessionDir = e.name === ".pi-session" ? join(base, e.name) : join(base, e.name, ".pi-session");
        if (existsSync(piSessionDir)) {
          for (const s of readdirSync(piSessionDir, { withFileTypes: true })) {
            if (s.isDirectory()) dirs.push(join(piSessionDir, s.name));
          }
        }
      }
    };
    scanFor(root);
    scanFor(wtBase);
    if (!dirs.length) { console.log("no .pi-session/* directories found under the repo."); process.exit(0); }
    console.log(`found ${dirs.length} session dir(s):`);
    let grand = {};
    for (const d of dirs) {
      const r = reportOne(d);
      if (r) mergeCorrelation(grand, r.byModel);
    }
    console.log("");
    console.log("TOTAL by model:");
    for (const [model, bucket] of Object.entries(grand)) {
      console.log(`  ${model}: ${bucket.total} events`);
      for (const [ev, n] of Object.entries(bucket.events)) console.log(`    ${ev}: ${n}`);
      for (const [g, n] of Object.entries(bucket.guards)) console.log(`    guard ${g}: ${n}`);
    }
    process.exit(0);
  }

  const target = args.find((a) => !a.startsWith("--"));
  if (!target) { console.error("usage: guard-stats.mjs <path> | --all"); process.exit(1); }
  reportOne(target);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  const modelChange = (iso, provider, modelId) => JSON.stringify({ type: "model_change", timestamp: iso, provider, modelId });
  const sessionLines = [
    modelChange("2026-10-11T10:00:00.000Z", "local", "qwen-6bit"),
    modelChange("2026-10-11T10:05:00.000Z", "openrouter", "nemotron-ultra"),
  ];
  const changes = readModelChanges(sessionLines);
  ok(changes.length === 2, "reads both model_change events");
  ok(changes[0].t < changes[1].t, "sorted ascending by time");

  ok(modelAt(changes, Date.parse("2026-10-11T09:59:00.000Z")) === "unknown", "before any model_change -> unknown");
  ok(modelAt(changes, Date.parse("2026-10-11T10:02:00.000Z")) === "local/qwen-6bit", "between the two changes -> the first model");
  ok(modelAt(changes, Date.parse("2026-10-11T10:10:00.000Z")) === "openrouter/nemotron-ultra", "after the second change -> the second model");
  ok(modelAt(changes, Date.parse("2026-10-11T10:05:00.000Z")) === "openrouter/nemotron-ultra", "exactly AT a change's timestamp counts as that model (<=, not <)");

  const violation = (t, guard) => JSON.stringify({ t, ev: "violation", guard, check: guard.split(".").pop() });
  const blocked = (t) => JSON.stringify({ t, ev: "blocked" });
  const evidenceLines = [
    violation(Date.parse("2026-10-11T09:58:00.000Z"), "invariant.no_write_outside_boundary"), // before any model_change
    violation(Date.parse("2026-10-11T10:01:00.000Z"), "invariant.no_progress_loop"),            // local/qwen-6bit
    blocked(Date.parse("2026-10-11T10:06:00.000Z")),                                            // openrouter/nemotron-ultra
    violation(Date.parse("2026-10-11T10:07:00.000Z"), "invariant.no_progress_loop"),            // openrouter/nemotron-ultra (same guard again)
    "not even json",
    "",
  ];
  const { byModel, total } = correlate(evidenceLines, changes);
  ok(total === 4, "4 well-formed evidence events counted, malformed/blank lines skipped");
  ok(byModel["unknown"]?.total === 1, "the pre-model_change violation attributes to 'unknown', not silently dropped");
  ok(byModel["local/qwen-6bit"]?.guards["invariant.no_progress_loop"] === 1, "local/qwen-6bit hit no_progress_loop once");
  ok(byModel["openrouter/nemotron-ultra"]?.total === 2, "openrouter/nemotron-ultra has 2 events (1 blocked + 1 violation)");
  ok(byModel["openrouter/nemotron-ultra"]?.guards["invariant.no_progress_loop"] === 1, "the SAME guard id hit by two different models is counted separately per model, not merged");
  ok(byModel["openrouter/nemotron-ultra"]?.events["blocked"] === 1 && byModel["openrouter/nemotron-ultra"]?.events["violation"] === 1, "event TYPES are tracked, not just guard ids - a 'blocked' with no guard field still counts");

  const merged = mergeCorrelation({}, byModel);
  mergeCorrelation(merged, byModel); // merge the SAME data again, simulating a second session dir
  ok(merged["local/qwen-6bit"].total === 2, "mergeCorrelation sums across multiple session dirs, not just the last one");
  ok(merged["openrouter/nemotron-ultra"].guards["invariant.no_progress_loop"] === 2, "guard counts also sum correctly across merges");

  // --- antigravity's coarse counter files (2026-10-12) -----------------------
  const fakeFiles = ["antigravity-counters-convo-abc.json", "antigravity-counters-convo-def.json", "evidence.jsonl", "notes.txt", "antigravity-counters-broken.json"];
  const fakeRead = (p) => {
    if (p.endsWith("convo-abc.json")) return JSON.stringify({ tool_calls: 251, steps: 251, consecutive_blocks: 1, total_blocks: 4, stopped: false });
    if (p.endsWith("convo-def.json")) return JSON.stringify({ tool_calls: 10, steps: 10, consecutive_blocks: 0, total_blocks: 0, stopped: false });
    if (p.endsWith("broken.json")) throw new Error("corrupt file");
    throw new Error("not a counter file - should never be read");
  };
  const agyCounters = readAntigravityCounterFiles("fake-dir", () => fakeFiles, fakeRead);
  ok(agyCounters.length === 2, "finds exactly two VALID antigravity-counters-*.json files - evidence.jsonl/notes.txt/the broken one are excluded, not crashed on");
  ok(agyCounters.some((c) => c.conversationId === "convo-abc" && c.counters.total_blocks === 4), "extracts the conversation id from the filename and the real counters from its content");
  ok(readAntigravityCounterFiles("missing-dir", () => { throw new Error("ENOENT"); }).length === 0, "an unreadable directory returns an empty list, not a crash");

  // latestRateLimitSnapshot
  ok(latestRateLimitSnapshot([]) === null, "no evidence lines at all -> null");
  ok(latestRateLimitSnapshot([JSON.stringify({ ev: "violation" })]) === null, "evidence exists but no rate_limit_snapshot record -> null (the common case for pi/codex/antigravity, and claude on API-key auth)");
  {
    const lines = [
      JSON.stringify({ ev: "rate_limit_snapshot", five_hour_pct: 10, t: 1 }),
      JSON.stringify({ ev: "violation" }),
      JSON.stringify({ ev: "rate_limit_snapshot", five_hour_pct: 55, seven_day_pct: 70, t: 2 }),
      "not json, must be skipped not thrown",
    ];
    const latest = latestRateLimitSnapshot(lines);
    ok(latest.five_hour_pct === 55 && latest.seven_day_pct === 70,
      "REGRESSION: the LATEST (last-in-file, evidence.jsonl is append-only) snapshot wins, not the first");
  }

  // latestQuotaSnapshot
  ok(latestQuotaSnapshot([]) === null, "no evidence lines at all -> null");
  ok(latestQuotaSnapshot([JSON.stringify({ ev: "violation" })]) === null, "evidence exists but no quota_snapshot record -> null");
  {
    const lines = [
      JSON.stringify({ ev: "quota_snapshot", quota: { "gemini-weekly": { used_pct: 6.2 } } }),
      JSON.stringify({ ev: "quota_snapshot", quota: { "gemini-weekly": { used_pct: 12.5 } } }),
    ];
    ok(latestQuotaSnapshot(lines).quota["gemini-weekly"].used_pct === 12.5,
      "REGRESSION: the LATEST quota_snapshot wins, same append-only reasoning as latestRateLimitSnapshot");
  }

  // formatResetIn
  const nowMs = 1_700_000_000_000;
  ok(formatResetIn(Math.floor(nowMs / 1000) + 90 * 60, nowMs) === "in 1h30m", "90 minutes out formats as hours+minutes");
  ok(formatResetIn(Math.floor(nowMs / 1000) + 2 * 86400 + 3 * 3600, nowMs) === "in 2d3h", "multi-day window formats as days+hours");
  ok(formatResetIn(Math.floor(nowMs / 1000) + 300, nowMs) === "in 5m", "under an hour formats as minutes only");
  ok(/overdue/.test(formatResetIn(Math.floor(nowMs / 1000) - 60, nowMs)), "a resets_at in the past -> overdue, not a negative duration");
  ok(formatResetIn(undefined, nowMs) === "unknown", "missing resets_at does not crash, reports unknown");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("guard-stats self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("guard-stats.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
