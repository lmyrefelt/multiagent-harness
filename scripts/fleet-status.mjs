#!/usr/bin/env node
//
// fleet-status — one fleet-wide report combining everything guard-stats.mjs
// and session-cost.mjs already track separately: per-model violations/
// hard-stops/completion-gate outcomes, per-model tokens/$ cost, and the
// CURRENT Claude/Gemini subscription usage (the latest rate_limit_snapshot/
// quota_snapshot across every session, by real timestamp).
//
// WHY THIS EXISTS
// guard-stats.mjs and session-cost.mjs each answer a different question
// well, per-directory - neither answers "across everything, right now,
// which models are expensive/unreliable, and how close are we to our
// subscription limits." This is a thin aggregation layer over both, reusing
// their own exported pure functions rather than re-deriving the parsing -
// the one new thing here is MERGING across session dirs and across both
// scripts' separate byModel shapes into one report.
//
//   node scripts/fleet-status.mjs            scan every .pi-session/*/ under the repo
//   node scripts/fleet-status.mjs --selftest
//
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  sessionFilesIn, antigravityTranscriptsIn, sumUsage, sumAntigravityUsage, readAntigravityModelChanges,
} from "./session-cost.mjs";
import {
  readModelChanges, correlate, latestRateLimitSnapshot, latestQuotaSnapshot, formatResetIn, readAntigravityCounterFiles,
} from "./guard-stats.mjs";

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** Same {messages,totalTokens,cost} merge session-cost.mjs's own mergeByModel does - duplicated, not imported (that helper isn't exported); same convention as log() being duplicated per-adapter elsewhere in this project. */
function mergeCostByModel(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    const d = dst[k] ??= { messages: 0, totalTokens: 0, cost: 0 };
    d.messages += v.messages; d.totalTokens += v.totalTokens; d.cost += v.cost;
  }
  return dst;
}

/** Same shape guard-stats.mjs's own mergeCorrelation does - duplicated for the same reason. */
function mergeGuardByModel(dst, src) {
  for (const [model, bucket] of Object.entries(src)) {
    const d = dst[model] ??= { events: {}, guards: {}, total: 0 };
    for (const [ev, n] of Object.entries(bucket.events)) d.events[ev] = (d.events[ev] ?? 0) + n;
    for (const [g, n] of Object.entries(bucket.guards)) d.guards[g] = (d.guards[g] ?? 0) + n;
    d.total += bucket.total;
  }
  return dst;
}

/**
 * Aggregate ONE session directory's cost + guard-correlation data, using the
 * real exported readers from both sibling scripts. Injectable fs functions
 * so this is testable without real files on disk.
 *
 * @returns { costByModel, guardByModel, rateLimit, quota, agyCounters }
 */
export function aggregateSessionDir(dir, fns = {}) {
  const { readFileSync: readFn = readFileSync, existsSync: existsFn = existsSync, readdirSync: listFn = readdirSync, statSync: statFn = statSync } = fns;

  const isFile = (() => { try { return statFn(dir).isFile(); } catch { return false; } })();
  const base = isFile ? dir.replace(/\/[^/]+$/, "") : dir;

  // --- cost/tokens ---
  const costByModel = {};
  const sessFiles = (isFile ? [dir] : sessionFilesIn(base, listFn)).map((f) => (isFile ? f : join(base, f)));
  for (const f of sessFiles) {
    let lines; try { lines = readFn(f, "utf8").split(/\r?\n/); } catch { continue; }
    mergeCostByModel(costByModel, sumUsage(lines).byModel);
  }
  if (!isFile) {
    for (const f of antigravityTranscriptsIn(base, listFn, existsFn)) {
      let lines; try { lines = readFn(f, "utf8").split(/\r?\n/); } catch { continue; }
      mergeCostByModel(costByModel, sumAntigravityUsage(lines).byModel);
    }
  }

  // --- guard correlation ---
  let modelChanges = [];
  for (const f of sessFiles) {
    let lines; try { lines = readFn(f, "utf8").split(/\r?\n/); } catch { continue; }
    modelChanges = modelChanges.concat(readModelChanges(lines));
  }
  if (!isFile) {
    for (const f of antigravityTranscriptsIn(base, listFn, existsFn)) {
      let lines; try { lines = readFn(f, "utf8").split(/\r?\n/); } catch { continue; }
      modelChanges = modelChanges.concat(readAntigravityModelChanges(lines));
    }
  }
  modelChanges.sort((a, b) => a.t - b.t);

  const evidencePath = join(base, "evidence.jsonl");
  const evidenceLines = existsFn(evidencePath) ? readFn(evidencePath, "utf8").split(/\r?\n/) : [];
  const { byModel: guardByModel } = correlate(evidenceLines, modelChanges);

  const agyCounters = isFile ? [] : readAntigravityCounterFiles(base, listFn, readFn);
  const rateLimit = latestRateLimitSnapshot(evidenceLines);
  const quota = latestQuotaSnapshot(evidenceLines);

  return { costByModel, guardByModel, rateLimit, quota, agyCounters };
}

/**
 * Merge several aggregateSessionDir() results into one fleet-wide view.
 * rate_limit/quota are kept as whichever is GLOBALLY most recent by `t`
 * (not "last directory scanned wins" - directories aren't scanned in
 * chronological order).
 */
export function mergeFleet(results) {
  const fleet = { costByModel: {}, guardByModel: {}, rateLimit: null, quota: null, agyCounters: [] };
  for (const r of results) {
    mergeCostByModel(fleet.costByModel, r.costByModel);
    mergeGuardByModel(fleet.guardByModel, r.guardByModel);
    if (r.rateLimit && (!fleet.rateLimit || r.rateLimit.t > fleet.rateLimit.t)) fleet.rateLimit = r.rateLimit;
    if (r.quota && (!fleet.quota || r.quota.t > fleet.quota.t)) fleet.quota = r.quota;
    fleet.agyCounters = fleet.agyCounters.concat(r.agyCounters);
  }
  return fleet;
}

/** Pure text formatting - deterministic, so this is what selftest checks directly. */
export function formatFleetReport(fleet) {
  const lines = [];
  lines.push("FLEET STATUS");
  lines.push("");

  lines.push("Current subscription usage:");
  if (fleet.rateLimit) {
    const rl = fleet.rateLimit;
    const parts = [];
    if (rl.five_hour_pct != null) parts.push(`5h=${Math.round(rl.five_hour_pct)}% (${formatResetIn(rl.five_hour_resets_at)})`);
    if (rl.seven_day_pct != null) parts.push(`7d=${Math.round(rl.seven_day_pct)}% (${formatResetIn(rl.seven_day_resets_at)})`);
    lines.push(`  Claude (${rl.model ?? "claude"}): ${parts.join(" ")}`);
  } else {
    lines.push("  Claude: no snapshot yet (subscription auth required, or no claude session has run)");
  }
  if (fleet.quota) {
    const parts = Object.entries(fleet.quota.quota).map(([bucket, v]) => `${bucket}=${v.used_pct}% (${formatResetIn(v.reset_in_seconds, 0)})`);
    lines.push(`  Gemini (${fleet.quota.model ?? "antigravity"}): ${parts.join(" ")}`);
  } else {
    lines.push("  Gemini: no snapshot yet (no antigravity session has run)");
  }
  lines.push("  Codex: not tracked - see WORKER-GUARDRAILS.md (no scriptable statusline, no confirmed session-file schema)");
  lines.push("");

  lines.push("Per-model totals (all sessions):");
  const models = new Set([...Object.keys(fleet.costByModel), ...Object.keys(fleet.guardByModel)]);
  let grandTurns = 0, grandTokens = 0, grandCost = 0, grandViolations = 0, grandHardStops = 0;
  for (const model of [...models].sort()) {
    const cost = fleet.costByModel[model] ?? { messages: 0, totalTokens: 0, cost: 0 };
    const guard = fleet.guardByModel[model] ?? { events: {}, total: 0 };
    const violations = guard.events.violation ?? 0;
    const blocked = guard.events.blocked ?? 0;
    const hardStops = guard.events.hard_stop_engaged ?? 0;
    const fired = guard.events.completion_gate_fired ?? 0;
    const passed = guard.events.completion_gate_passed ?? 0;
    const exhausted = guard.events.completion_gate_exhausted ?? 0;
    lines.push(`  ${model}: ${cost.messages} turns, ${cost.totalTokens} tokens, $${cost.cost.toFixed(4)}`);
    if (guard.total > 0) {
      lines.push(`      violations=${violations} blocked=${blocked} hard_stops=${hardStops}` +
        ` completion_gate: fired=${fired} passed=${passed} exhausted=${exhausted}`);
    }
    grandTurns += cost.messages; grandTokens += cost.totalTokens; grandCost += cost.cost;
    grandViolations += violations; grandHardStops += hardStops;
  }
  lines.push("");
  lines.push(`TOTAL: ${grandTurns} turns, ${grandTokens} tokens, $${grandCost.toFixed(4)}, ${grandViolations} violations, ${grandHardStops} hard stops across ${models.size} model(s)`);

  if (fleet.agyCounters.length) {
    lines.push("");
    lines.push(`Antigravity sessions predating the 2026-10-12 evidence-logging fix (aggregate only, no per-event detail): ${fleet.agyCounters.length} conversation(s)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
function sh(c) { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

/** Same .pi-session/* discovery both sibling scripts already do independently - duplicated here for the same reason their own helpers are (see mergeCostByModel's header note). */
export function discoverSessionDirs(root) {
  const wtBase = join(root, ".worktrees");
  const dirs = [];
  // REAL BUG fixed 2026-10-12 (inherited from guard-stats.mjs/session-cost.mjs,
  // fixed in all three together): a bare `.pi-session` AT base (the repo
  // root's own, holding integrator-pi/, integrator-pi-02/, harness-change-0003*/,
  // etc.) was pushed as ITSELF instead of having its own subdirectories
  // enumerated - the owner caught this by noticing real github-copilot spend
  // looked too low; the two largest github-copilot session files in the
  // whole repo live at the repo root, not under .worktrees.
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
  return dirs;
}

function main() {
  const root = sh("git rev-parse --show-toplevel").trim();
  const dirs = discoverSessionDirs(root);
  if (!dirs.length) { console.log("no .pi-session/* directories found under the repo."); process.exit(0); }
  const results = dirs.map((d) => aggregateSessionDir(d));
  console.log(formatFleetReport(mergeFleet(results)));
  process.exit(0);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // mergeFleet - latest-by-timestamp, not last-in-array
  const r1 = { costByModel: { "a/b": { messages: 1, totalTokens: 10, cost: 0.1 } }, guardByModel: {}, rateLimit: { t: 100, five_hour_pct: 10 }, quota: null, agyCounters: [] };
  const r2 = { costByModel: { "a/b": { messages: 1, totalTokens: 20, cost: 0.2 } }, guardByModel: {}, rateLimit: { t: 50, five_hour_pct: 99 }, quota: null, agyCounters: [] };
  const fleet = mergeFleet([r1, r2]);
  ok(fleet.costByModel["a/b"].totalTokens === 30 && Math.abs(fleet.costByModel["a/b"].cost - 0.3) < 1e-9, "cost merges additively across dirs");
  ok(fleet.rateLimit.five_hour_pct === 10, "REGRESSION: the snapshot with the LATER timestamp wins (t=100), not whichever dir was scanned/merged last (r2, t=50, came second in the array)");

  const r3 = { costByModel: {}, guardByModel: { "x/y": { events: { violation: 2 }, guards: {}, total: 2 } }, rateLimit: null, quota: { t: 5, model: "Gemini", quota: { "gemini-weekly": { used_pct: 1 } } }, agyCounters: [{ conversationId: "c1" }] };
  const fleet2 = mergeFleet([r1, r3]);
  ok(fleet2.guardByModel["x/y"].events.violation === 2, "guard events merge in from a dir with no cost data");
  ok(fleet2.quota.model === "Gemini", "a quota snapshot present in only one dir still surfaces in the merged fleet");
  ok(fleet2.agyCounters.length === 1, "agyCounters concatenate across dirs");

  // formatFleetReport - deterministic text, exercised directly
  const report = formatFleetReport({
    costByModel: { "openrouter/free": { messages: 5, totalTokens: 1000, cost: 0 } },
    guardByModel: { "openrouter/free": { events: { violation: 3, blocked: 2, hard_stop_engaged: 1, completion_gate_fired: 1, completion_gate_passed: 2 }, guards: {}, total: 9 } },
    rateLimit: { model: "Opus", five_hour_pct: 24, five_hour_resets_at: Math.floor(Date.now() / 1000) + 3600 },
    quota: { model: "Gemini", quota: { "gemini-weekly": { used_pct: 6.2, reset_in_seconds: 100 } } },
    agyCounters: [],
  });
  ok(report.includes("Claude (Opus): 5h=24%"), "report names the real model and the real 5h percentage");
  ok(report.includes("Gemini (Gemini): gemini-weekly=6.2%"), "report names the real quota bucket and percentage");
  ok(report.includes("violations=3 blocked=2 hard_stops=1"), "per-model guard line shows the real counts");
  ok(report.includes("TOTAL: 5 turns, 1000 tokens"), "grand total line sums correctly");
  ok(report.includes("Codex: not tracked"), "Codex's known gap is stated plainly in every report, not silently omitted");

  const emptyReport = formatFleetReport({ costByModel: {}, guardByModel: {}, rateLimit: null, quota: null, agyCounters: [] });
  ok(emptyReport.includes("no snapshot yet"), "no data at all for a backend -> an explicit 'no snapshot yet' line, not a blank/crash");

  // aggregateSessionDir - fully injected fake fs, no real disk I/O
  {
    const fakeFiles = { "2026-10-12_abc.jsonl": true, "evidence.jsonl": true };
    const fakeList = () => Object.keys(fakeFiles);
    const fakeExists = (p) => p.endsWith("evidence.jsonl") || p.endsWith(".pi-session/sess1");
    const fakeStat = () => ({ isFile: () => false });
    const assistantTurn = JSON.stringify({ type: "message", message: { role: "assistant", provider: "openrouter", model: "free", usage: { totalTokens: 100, cost: { total: 0 } } } });
    const violationLine = JSON.stringify({ ev: "violation", guard: "g1", t: 1 });
    const fakeRead = (p) => {
      if (p.endsWith("2026-10-12_abc.jsonl")) return assistantTurn + "\n";
      if (p.endsWith("evidence.jsonl")) return violationLine + "\n";
      throw new Error("unexpected read: " + p);
    };
    const agg = aggregateSessionDir("/fake/.pi-session/sess1", { readFileSync: fakeRead, existsSync: fakeExists, readdirSync: fakeList, statSync: fakeStat });
    ok(agg.costByModel["openrouter/free"]?.totalTokens === 100, "aggregateSessionDir reads real-shaped session lines via injected fs and extracts cost");
    ok((agg.guardByModel["unknown"]?.events.violation ?? 0) === 1, "aggregateSessionDir reads evidence.jsonl via injected fs and extracts guard events");
  }

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("fleet-status self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("fleet-status.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
