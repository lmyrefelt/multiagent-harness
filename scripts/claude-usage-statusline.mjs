#!/usr/bin/env node
//
// claude-usage-statusline — logs Claude's own subscription rate-limit
// windows (5-hour rolling, 7-day/weekly) into the SAME evidence.jsonl every
// other adapter in this project writes to, by piggybacking on Claude Code's
// `statusLine` feature.
//
// WHY A STATUSLINE SCRIPT, NOT A /usage-PARSING APPROACH
// An earlier idea was to have the SEED tell a worker to run `/usage` and
// parse its rendered output from the transcript - rejected after checking
// the real docs (code.claude.com/docs/en/statusline, fetched directly,
// 2026-10-12): `/usage`'s own output is a rendered TUI widget (progress
// bars), not a documented text format worth regexing, AND a real GitHub
// issue (anthropics/claude-code#78385) shows conflicting user reports about
// what `/usage` even displays across versions - an unstable thing to parse.
// The SAME data is available as clean, versioned JSON on `rate_limits` via
// the statusLine mechanism instead, with NO extra prompt/turn cost (it
// "runs locally and does not consume API tokens" - the docs' own words) and
// fires automatically: once at session start and again on every new
// assistant message, /compact, permission-mode change, and more - no SEED
// instruction needed at all.
//
// VERIFIED (code.claude.com/docs/en/statusline, fetched directly,
// 2026-10-12, full JSON schema quoted on that page, not inferred):
//   - Enable via a `statusLine` field in settings.json, a SIBLING of
//     `hooks`, not nested inside it: {"statusLine":{"type":"command",
//     "command":"..."}}.
//   - stdin JSON includes `rate_limits.five_hour.{used_percentage,
//     resets_at}` and `rate_limits.seven_day.{used_percentage,resets_at}`
//     (resets_at is Unix epoch seconds).
//   - `rate_limits` is ABSENT entirely until the session's first API
//     response, and absent altogether for API-key auth (it "appears only
//     for claude.ai Pro and Max subscribers... or behind a Claude apps
//     gateway with spend limits") - confirmed applicable here per the
//     owner's own account (subscription-based, not a metered API key).
//   - Claude Code "drops a window once its resets_at time passes" - so an
//     absent five_hour/seven_day object on a later call is expected
//     behaviour near a reset, not a bug.
//   - The script's stdout is what actually renders as the visible status
//     bar - this script still prints a short summary line so the feature
//     keeps working for a human watching the terminal; the evidence-logging
//     is an ADDITION to that, not a replacement.
//
//   node scripts/claude-usage-statusline.mjs < statusline-input.json
//   node scripts/claude-usage-statusline.mjs --selftest
//
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";

// Same log() shape as every other adapter here (t, ev, ...rec).
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/**
 * Pure extraction: the statusLine JSON -> a flat snapshot record, or null
 * if rate_limits is absent entirely (pre-first-response, API-key auth, or a
 * Claude apps gateway without this feature) - absence is the expected,
 * common case, not an error.
 * Supports both standard object format and alternative array/map shapes seen in
 * diverse Claude Code versions / usage tracker plugins.
 */
export function extractRateLimitSnapshot(input) {
  const rl = input?.rate_limits;
  if (!rl) return null;
  // Handle object or array forms if present
  let fiveHour = rl.five_hour ?? rl.fiveHour ?? rl["5h"];
  let sevenDay = rl.seven_day ?? rl.sevenDay ?? rl["7d"] ?? rl.weekly;
  if (!fiveHour && !sevenDay && Array.isArray(rl)) {
    fiveHour = rl.find((w) => w?.window === "5h" || w?.type === "five_hour" || w?.duration === 18000);
    sevenDay = rl.find((w) => w?.window === "7d" || w?.type === "seven_day" || w?.duration === 604800);
  }
  if (!fiveHour && !sevenDay) return null;
  const snap = {};
  const getPct = (w) => w.used_percentage ?? w.usedPercentage ?? w.usedPct ?? (typeof w.used === "number" && typeof w.limit === "number" && w.limit > 0 ? (100 * w.used) / w.limit : undefined);
  const getReset = (w) => {
    const r = w.resets_at ?? w.resetsAt ?? w.reset_time;
    if (r == null) return undefined;
    if (typeof r === "number") return r > 1e12 ? Math.floor(r / 1000) : r;
    const parsed = Date.parse(r);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  };
  const getTokens = (w) => w.tokens_used ?? w.tokensUsed ?? w.used_tokens ?? w.tokens;

  if (fiveHour) {
    snap.five_hour_pct = getPct(fiveHour);
    snap.five_hour_resets_at = getReset(fiveHour);
    const tok = getTokens(fiveHour);
    if (tok != null) snap.five_hour_tokens = tok;
  }
  if (sevenDay) {
    snap.seven_day_pct = getPct(sevenDay);
    snap.seven_day_resets_at = getReset(sevenDay);
    const tok = getTokens(sevenDay);
    if (tok != null) snap.seven_day_tokens = tok;
  }
  // Extract session context tokens / total tokens introspection if available
  const ctx = input?.session?.context_tokens ?? input?.context_tokens ?? input?.usage?.total_tokens;
  if (ctx != null) snap.context_tokens = ctx;

  if (snap.five_hour_pct == null && snap.seven_day_pct == null) return null;
  return snap;
}

/** The actual visible status-line text - kept simple on purpose; the real value of this script is the logging. */
export function formatStatusLine(input, snap) {
  const model = input?.model?.display_name ?? "claude";
  if (!snap) return `[${model}]`;
  const parts = [];
  if (snap.five_hour_pct != null) parts.push(`5h: ${Math.round(snap.five_hour_pct)}%`);
  if (snap.seven_day_pct != null) parts.push(`7d: ${Math.round(snap.seven_day_pct)}%`);
  return parts.length ? `[${model}] | ${parts.join(" ")}` : `[${model}]`;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try { input = JSON.parse(raw); } catch { console.log("[claude]"); return; } // fail open - a broken statusLine must never hang/crash the UI

  let snap = null;
  try { snap = extractRateLimitSnapshot(input); } catch { /* malformed rate_limits shape - treat as absent */ }

  if (snap) {
    log({ ev: "rate_limit_snapshot", ...snap, model: input?.model?.display_name, session_id: input?.session_id });
  }

  console.log(formatStatusLine(input, snap));
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(extractRateLimitSnapshot({}) === null, "no rate_limits field at all -> null, not an error (the common pre-first-response case)");
  ok(extractRateLimitSnapshot({ rate_limits: {} }) === null, "rate_limits present but both windows absent -> null");
  ok(extractRateLimitSnapshot(null) === null, "null input does not throw");

  const full = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } };
  const snap = extractRateLimitSnapshot(full);
  ok(snap.five_hour_pct === 23.5 && snap.five_hour_resets_at === 1738425600, "five_hour window extracted with real doc-example values");
  ok(snap.seven_day_pct === 41.2 && snap.seven_day_resets_at === 1738857600, "seven_day window extracted with real doc-example values");

  const onlyFiveHour = { rate_limits: { five_hour: { used_percentage: 10, resets_at: 100 } } };
  const snap2 = extractRateLimitSnapshot(onlyFiveHour);
  ok(snap2.five_hour_pct === 10 && snap2.seven_day_pct === undefined,
    "REGRESSION: Claude Code drops a window once its resets_at passes - seven_day being absent while five_hour is present must still extract what IS there, not null out the whole snapshot");

  const altShape = { rate_limits: [{ window: "5h", usedPercentage: 35, resetsAt: 1738425600, tokens: 45000 }, { window: "7d", used: 80, limit: 100, reset_time: "2026-07-06T07:50:32Z" }], context_tokens: 12000 };
  const snapAlt = extractRateLimitSnapshot(altShape);
  ok(snapAlt.five_hour_pct === 35 && snapAlt.five_hour_tokens === 45000 && snapAlt.seven_day_pct === 80 && snapAlt.context_tokens === 12000,
    "handles alternative statusline shapes from usage-tracker / token introspection plugins");

  // formatStatusLine - the actual visible feature must keep working
  ok(formatStatusLine({ model: { display_name: "Sonnet" } }, null) === "[Sonnet]",
    "no snapshot yet (pre-first-response) -> still prints a sensible status line, not blank/crash");
  ok(formatStatusLine({ model: { display_name: "Sonnet" } }, { five_hour_pct: 23.5, seven_day_pct: 41.2 }) === "[Sonnet] | 5h: 24% 7d: 41%",
    "both windows present -> both shown, rounded");
  ok(formatStatusLine({ model: { display_name: "Sonnet" } }, { five_hour_pct: 23.5 }) === "[Sonnet] | 5h: 24%",
    "only one window present -> only that one shown, no stray separator");
  ok(formatStatusLine({}, null) === "[claude]", "missing model.display_name falls back to a generic label, not a crash");

  // log()
  {
    const tmp = `/tmp/claude-usage-statusline-selftest-${process.pid}.jsonl`;
    const prevPath = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "rate_limit_snapshot", five_hour_pct: 50 });
      const lines = readFileSync(tmp, "utf8").trim().split("\n");
      ok(lines.length === 1, "log() appends exactly one line per call");
      const rec = JSON.parse(lines[0]);
      ok(typeof rec.t === "number" && rec.ev === "rate_limit_snapshot", "log() stamps t and preserves fields, same shape as every other adapter here");
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
  console.log("claude-usage-statusline self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("claude-usage-statusline.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
