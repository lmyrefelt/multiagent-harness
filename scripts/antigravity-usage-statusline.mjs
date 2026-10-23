#!/usr/bin/env node
//
// antigravity-usage-statusline — logs Antigravity's own Gemini subscription
// quota windows (daily, weekly - keyed per model/bucket, NOT a fixed
// "five_hour"/"seven_day" shape like Claude's) into the same evidence.jsonl
// every other adapter in this project writes to, by piggybacking on
// Antigravity CLI's own scriptable statusLine feature.
//
// VERIFIED vs LOWER-CONFIDENCE - read before trusting this in production:
//   VERIFIED (antigravity.google/docs/cli/statusline/, fetched directly,
//   2026-10-12 - a real JSON example quoted on that page, not inferred):
//     - Antigravity CLI DOES support a scriptable statusline (confirmed
//       directly - unlike Codex CLI, which this project investigated the
//       same day and found explicitly does NOT: "Codex does not currently
//       support a command-backed status line that reads session JSON from
//       stdin" - Codex's quota tracking was NOT built for that reason, see
//       WORKER-GUARDRAILS.md).
//     - Configured via a `statusLine` block in
//       ~/.gemini/antigravity-cli/settings.json (the SAME file this
//       project already generates as PERMS_JSON in launch-worker.sh -
//       different from HOOKS_JSON/the PreToolUse+Stop hooks file).
//     - The real quoted example: `"quota": { "gemini-weekly":
//       { "remaining_fraction": 0.9378, "reset_time":
//       "2026-07-06T07:50:32Z", "reset_in_seconds": 560580 } }` - a MAP
//       keyed by bucket id (model/quota-class), not fixed field names like
//       Claude's `five_hour`/`seven_day`. This adapter is written to handle
//       WHATEVER keys are present, not a hardcoded pair.
//   LOWER CONFIDENCE: the exact bucket key naming convention for the DAILY
//   window (e.g. "gemini-daily") was not independently confirmed with a
//   second quoted example the way "gemini-weekly" was - this adapter does
//   not assume any specific key name exists; it logs every key `quota`
//   actually contains, so an unexpected bucket name still gets captured
//   correctly, just isn't specially labelled as "daily" vs "weekly" in the
//   printed status line (the LOGGED record always carries the real key).
//
// FAIL OPEN - a broken statusLine script must never hang or crash the
// terminal UI, same reasoning as claude-usage-statusline.mjs.
//
//   node scripts/antigravity-usage-statusline.mjs < statusline-input.json
//   node scripts/antigravity-usage-statusline.mjs --selftest
//
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { readStdin } from "./verify-change.mjs";

// Same log() shape as every other adapter here (t, ev, ...rec).
function log(rec) {
  const path = process.env.CONTRACT_EVIDENCE;
  if (!path) return;
  try { appendFileSync(path, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best-effort */ }
}

/**
 * Pure extraction: the statusline JSON's `quota` map -> a flat
 * {bucket: {used_pct, reset_time, reset_in_seconds}} object, or null if
 * `quota` is absent/empty - absence is the expected common case (API-key
 * auth, or before the first quota check), not an error. `remaining_fraction`
 * is converted to `used_pct` (0-100) to match the vocabulary
 * claude-usage-statusline.mjs already uses, even though the underlying
 * shape (a fraction REMAINING, not a percentage USED) is the opposite of
 * Claude's own fields - do not copy this conversion assumption to a future
 * backend without checking its own real shape first.
 */
export function extractQuotaSnapshot(input) {
  const quota = input?.quota;
  if (!quota || typeof quota !== "object") return null;
  const buckets = Object.entries(quota);
  if (buckets.length === 0) return null;
  const out = {};
  for (const [bucket, v] of buckets) {
    if (!v || typeof v.remaining_fraction !== "number") continue;
    out[bucket] = {
      used_pct: Math.round((1 - v.remaining_fraction) * 1000) / 10,
      reset_time: v.reset_time ?? null,
      reset_in_seconds: typeof v.reset_in_seconds === "number" ? v.reset_in_seconds : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** The actual visible status-line text - kept simple; the real value here is the logging. */
export function formatStatusLine(input, snapshot) {
  const model = input?.model?.display_name ?? "antigravity";
  if (!snapshot) return `[${model}]`;
  const parts = Object.entries(snapshot).map(([bucket, v]) => `${bucket}: ${v.used_pct}%`);
  return `[${model}] | ${parts.join(" ")}`;
}

async function main() {
  const raw = await readStdin();

  let input;
  try { input = JSON.parse(raw); } catch { console.log("[antigravity]"); return; } // fail open

  let snapshot = null;
  try { snapshot = extractQuotaSnapshot(input); } catch { /* malformed quota shape - treat as absent */ }

  if (snapshot) {
    log({ ev: "quota_snapshot", quota: snapshot, model: input?.model?.display_name, conversation_id: input?.conversation_id ?? input?.session_id });
  }

  console.log(formatStatusLine(input, snapshot));
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(extractQuotaSnapshot({}) === null, "no quota field at all -> null, not an error");
  ok(extractQuotaSnapshot({ quota: {} }) === null, "quota present but empty -> null");
  ok(extractQuotaSnapshot(null) === null, "null input does not throw");

  // the REAL doc-quoted example, verbatim
  const real = { quota: { "gemini-weekly": { remaining_fraction: 0.9378, reset_time: "2026-07-06T07:50:32Z", reset_in_seconds: 560580 } } };
  const snap = extractQuotaSnapshot(real);
  ok(snap["gemini-weekly"].used_pct === 6.2, "REGRESSION: remaining_fraction 0.9378 -> used_pct 6.2 (1-0.9378)*100, rounded to one decimal, using the REAL doc-quoted example");
  ok(snap["gemini-weekly"].reset_time === "2026-07-06T07:50:32Z", "reset_time passes through unchanged");
  ok(snap["gemini-weekly"].reset_in_seconds === 560580, "reset_in_seconds passes through unchanged");

  // an unexpected/unconfirmed bucket key must still be captured, not dropped -
  // the whole point of NOT hardcoding "gemini-weekly"/"gemini-daily"
  const unknownBucket = { quota: { "some-future-bucket-id": { remaining_fraction: 0.5, reset_time: "x", reset_in_seconds: 1 } } };
  ok(Object.keys(extractQuotaSnapshot(unknownBucket))[0] === "some-future-bucket-id",
    "an unrecognised bucket key is still captured under its real name, not silently dropped");

  // malformed entries are skipped individually, not fatal to the whole snapshot
  const mixedValidity = { quota: { "good": { remaining_fraction: 0.8 }, "bad": { nope: true }, "alsobad": "not an object" } };
  const snap2 = extractQuotaSnapshot(mixedValidity);
  ok(Object.keys(snap2).length === 1 && snap2.good, "a malformed bucket entry is skipped individually; a valid sibling bucket is still extracted");

  // formatStatusLine
  ok(formatStatusLine({ model: { display_name: "Gemini" } }, null) === "[Gemini]", "no snapshot yet -> still prints a sensible status line");
  ok(formatStatusLine({ model: { display_name: "Gemini" } }, { "gemini-weekly": { used_pct: 6.2 } }) === "[Gemini] | gemini-weekly: 6.2%",
    "a real snapshot renders the bucket name and percentage");
  ok(formatStatusLine({}, null) === "[antigravity]", "missing model.display_name falls back to a generic label, not a crash");

  // log()
  {
    const tmp = `/tmp/antigravity-usage-statusline-selftest-${process.pid}.jsonl`;
    const prevPath = process.env.CONTRACT_EVIDENCE;
    process.env.CONTRACT_EVIDENCE = tmp;
    try {
      log({ ev: "quota_snapshot", quota: { x: { used_pct: 1 } } });
      const lines = readFileSync(tmp, "utf8").trim().split("\n");
      ok(lines.length === 1, "log() appends exactly one line per call");
      const rec = JSON.parse(lines[0]);
      ok(typeof rec.t === "number" && rec.ev === "quota_snapshot", "log() stamps t and preserves fields, same shape as every other adapter here");
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
  console.log("antigravity-usage-statusline self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("antigravity-usage-statusline.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
