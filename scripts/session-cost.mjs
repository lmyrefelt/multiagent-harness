#!/usr/bin/env node
//
// session-cost — token/cost totals from pi's own session JSONL files.
//
// WHY THIS EXISTS
// The "too many tokens" discussion this session was reasoning from anecdote -
// my own read of one transcript - not data. Every launch-*.sh already points
// --session-dir at a path INSIDE the bind-mounted repo (originally so
// CONTRACT_EVIDENCE's evidence.jsonl survives `docker run --rm`), so pi's own
// session file lands there too and survives for free, regardless of whether
// PI_CONFIG_DIR is set.
//
// VERIFIED against three real session files already sitting in this repo
// from prior runs (.worktrees/harness-change-0048, -0057, harness-planner-pi) - not
// just pi's documentation. The real shape, confirmed by inspection:
//   { type: "message", message: { role: "assistant", provider, model,
//     usage: { input, output, cacheRead, cacheWrite, reasoning, totalTokens,
//              cost: { input, output, cacheRead, cacheWrite, total } } } }
// Only assistant turns carry usage - a model actually ran. `cost` is nested
// INSIDE `usage`, not a sibling of it (the doc-derived first draft of this
// script had that wrong; this version is checked against real data).
//
// 2026-10-11: added the model x thinking-level breakdown. A session logs
// `{type:"thinking_level_change", thinkingLevel}` as its OWN event, separate
// from every assistant message that follows it - a single session can and
// does switch both model and thinking level mid-session (VERIFIED against
// .worktrees/harness-change-0071's real session file: off -> medium within one
// run). The level is therefore STATE to carry forward while walking the file
// in order, not a field on each message - an assistant turn is attributed to
// whichever level was most recently set before it, "unknown" if none ever was.
//
// 2026-10-12: added antigravity support. Auditing CHANGE-0077 (worked by pi
// AND antigravity across several days) found antigravity's own real session
// data sitting unread in `gemini-antigravity-cli/brain/<conversation-id>/
// .system_generated/logs/transcript.jsonl` - a DIFFERENT shape from pi's:
// PLANNER_RESPONSE steps carry input_tokens/output_tokens/cache_read_tokens
// (no cost field - no rate card is embedded, so antigravity entries always
// report cost 0, not "unknown"); model+thinking-level identity is NOT a
// separate structured event the way pi's model_change/thinking_level_change
// are - it's announced as free text inside a USER_INPUT step ("the user
// changed setting `Model Selection` from X to Y(Level)."), extracted with a
// best-effort regex anchored on that exact, VERIFIED-by-inspection trailing
// phrase. Reported under its own `antigravity/<model (level)>` key so it's
// never confused with a pi-sourced model string.
//
// 2026-10-12: fixed a real "?/?" attribution gap. Most message lines carry
// their own `provider`/`model`, but an older log format in real
// integrator-pi session files omits BOTH on some lines even though a
// `model_change` event earlier in the SAME file already names the real
// model - MEASURED: ~$58 of real github-copilot/claude-opus-5.5 spend was
// landing in an unattributed "?/?" bucket as a result. sumUsage() now walks
// `model_change` as state (same pattern as thinking_level_change above) and
// falls back to it ONLY when a message's own fields are both absent.
//
//   node scripts/session-cost.mjs <path-to-.pi-session-dir-or-file>
//   node scripts/session-cost.mjs --all              scan every .pi-session/*/ under the repo
//   node scripts/session-cost.mjs --selftest
//
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const NL = String.fromCharCode(10);

/**
 * Sum usage/cost out of pi session JSONL lines, plus a per-model breakdown.
 * Malformed/non-JSON lines are skipped, not fatal - a session file being
 * appended to while read should not crash this.
 */
export function sumUsage(lines) {
  const totals = { messages: 0, totalTokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const byModel = {};
  const byModelThinking = {};
  let currentThinking = "unknown"; // state carried across lines - see header note
  let currentModel = null; // { provider, modelId } from the most recent model_change - see fallback below
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === "thinking_level_change") {
      if (typeof obj.thinkingLevel === "string" && obj.thinkingLevel) currentThinking = obj.thinkingLevel;
      continue;
    }
    if (obj?.type === "model_change") {
      if (obj.provider || obj.modelId) currentModel = { provider: obj.provider, modelId: obj.modelId };
      continue;
    }
    if (obj?.type !== "message") continue;
    const m = obj.message;
    const u = m?.usage;
    if (!u || typeof u !== "object") continue; // only a real model turn carries usage

    totals.messages += 1;
    for (const k of ["totalTokens", "input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
      if (typeof u[k] === "number") totals[k] += u[k];
    }
    const costTotal = typeof u.cost?.total === "number" ? u.cost.total : 0;
    totals.cost += costTotal;

    // Fallback to the most recent model_change's identity when THIS message
    // has no provider/model of its own - MEASURED (2026-10-12): an older log
    // format in real integrator-pi session files omits both fields on some
    // message lines, landing ~$58 of real github-copilot/claude-opus-5.5
    // spend in an unattributed "?/?" bucket even though a model_change event
    // earlier in the SAME file already names the real model. Prefers the
    // message's own fields when present - this only fills a genuine gap,
    // never overrides a message that already states its own model.
    const provider = m.provider ?? currentModel?.provider;
    const model = m.model ?? currentModel?.modelId;
    const key = `${provider ?? "?"}/${model ?? "?"}`;
    byModel[key] ??= { messages: 0, totalTokens: 0, cost: 0 };
    byModel[key].messages += 1;
    byModel[key].totalTokens += typeof u.totalTokens === "number" ? u.totalTokens : 0;
    byModel[key].cost += costTotal;

    const mtKey = `${key}@${currentThinking}`;
    byModelThinking[mtKey] ??= { messages: 0, totalTokens: 0, cost: 0 };
    byModelThinking[mtKey].messages += 1;
    byModelThinking[mtKey].totalTokens += typeof u.totalTokens === "number" ? u.totalTokens : 0;
    byModelThinking[mtKey].cost += costTotal;
  }
  return { ...totals, byModel, byModelThinking };
}

/** Which files in a session dir are pi's OWN session file(s) - everything except our evidence.jsonl. */
export function sessionFilesIn(dir, listFn = readdirSync) {
  return listFn(dir).filter((f) => f.endsWith(".jsonl") && f !== "evidence.jsonl");
}

// Anchored on the EXACT trailing phrase confirmed by inspection (CHANGE-0077's
// real transcript) - "Model Selection` from X to Y(Level). No need to comment
// on this change...". Non-greedy capture up to the first ")" that phrase
// follows, so it naturally stops at "Gemini 3.8 Flash (High)" rather than
// over- or under-matching on the model name's own internal punctuation
// ("3.8" contains a period, which rules out a naive "match up to the next
// period" approach).
const ANTIGRAVITY_MODEL_RE = /Model Selection`\s*from\s+.*?\s+to\s+(.+?\))\.\s*No need to comment/;

/** Every antigravity Model-Selection announcement in a transcript, sorted ascending by time. */
export function readAntigravityModelChanges(lines) {
  const changes = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "USER_INPUT" || typeof obj.content !== "string") continue;
    const m = ANTIGRAVITY_MODEL_RE.exec(obj.content);
    if (!m) continue;
    const t = Date.parse(obj.created_at);
    if (!Number.isFinite(t)) continue;
    changes.push({ t, key: `antigravity/${m[1]}` });
  }
  changes.sort((a, b) => a.t - b.t);
  return changes;
}

/**
 * Sum token usage out of an antigravity transcript - same byModel SHAPE as
 * sumUsage() above (messages, totalTokens, cost - always 0 here, no rate card
 * is embedded in the transcript) so callers merge both sources identically.
 */
export function sumAntigravityUsage(lines) {
  const changes = readAntigravityModelChanges(lines);
  const byModel = {};
  let messages = 0, totalTokens = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "PLANNER_RESPONSE") continue;
    const input = typeof obj.input_tokens === "number" ? obj.input_tokens : 0;
    const output = typeof obj.output_tokens === "number" ? obj.output_tokens : 0;
    const cacheRead = typeof obj.cache_read_tokens === "number" ? obj.cache_read_tokens : 0;
    const tTotal = input + output + cacheRead;
    const t = Date.parse(obj.created_at);
    let key = "antigravity/unknown";
    if (Number.isFinite(t)) { for (const c of changes) { if (c.t <= t) key = c.key; else break; } }
    byModel[key] ??= { messages: 0, totalTokens: 0, cost: 0 };
    byModel[key].messages += 1;
    byModel[key].totalTokens += tTotal;
    messages += 1; totalTokens += tTotal;
  }
  return { messages, totalTokens, cost: 0, byModel };
}

/** Every antigravity transcript.jsonl under a session dir's gemini-antigravity-cli/brain/. */
export function antigravityTranscriptsIn(dir, listFn = readdirSync, existsFn = existsSync) {
  const brainDir = join(dir, "gemini-antigravity-cli", "brain");
  if (!existsFn(brainDir)) return [];
  let convoDirs;
  try { convoDirs = listFn(brainDir, { withFileTypes: true }); } catch { return []; }
  const paths = [];
  for (const e of convoDirs) {
    if (!e.isDirectory?.()) continue;
    const p = join(brainDir, e.name, ".system_generated", "logs", "transcript.jsonl");
    if (existsFn(p)) paths.push(p);
  }
  return paths;
}

function sh(c) { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

// Generic over any string-keyed {messages,totalTokens,cost} map - used for
// both the per-model and the per-(model,thinkingLevel) breakdowns.
function mergeByModel(a, b) {
  for (const [k, v] of Object.entries(b)) {
    a[k] ??= { messages: 0, totalTokens: 0, cost: 0 };
    a[k].messages += v.messages; a[k].totalTokens += v.totalTokens; a[k].cost += v.cost;
  }
  return a;
}

function reportOne(dir) {
  if (!existsSync(dir)) { console.error(`no such path: ${dir}`); return null; }
  const isFile = statSync(dir).isFile();
  const files = isFile ? [dir] : sessionFilesIn(dir).map((f) => join(dir, f));
  const agyFiles = isFile ? [] : antigravityTranscriptsIn(dir);
  if (!files.length && !agyFiles.length) { console.log(`  ${dir}: no session *.jsonl found (only evidence.jsonl, or empty)`); return null; }
  let agg = { messages: 0, totalTokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, byModel: {}, byModelThinking: {} };
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    const t = sumUsage(lines);
    for (const k of Object.keys(agg)) if (k !== "byModel" && k !== "byModelThinking") agg[k] += t[k];
    mergeByModel(agg.byModel, t.byModel);
    mergeByModel(agg.byModelThinking, t.byModelThinking);
  }
  // Antigravity: merged into the SAME byModel map (under its own antigravity/
  // prefix, see header) but NOT into byModelThinking - the level is baked into
  // the model string itself here, not a separate trackable dimension the way
  // pi's thinking_level_change is, so a separate breakdown would just duplicate
  // byModel's own keys.
  for (const f of agyFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    const t = sumAntigravityUsage(lines);
    agg.messages += t.messages; agg.totalTokens += t.totalTokens; agg.cost += t.cost;
    mergeByModel(agg.byModel, t.byModel);
  }
  console.log(`  ${dir}`);
  console.log(`    messages=${agg.messages}  totalTokens=${agg.totalTokens}  cost=${agg.cost.toFixed(4)}` +
    `  (input=${agg.input} output=${agg.output} cacheRead=${agg.cacheRead} cacheWrite=${agg.cacheWrite} reasoning=${agg.reasoning})`);
  for (const [model, v] of Object.entries(agg.byModel)) {
    console.log(`      ${model}: ${v.messages} turns, ${v.totalTokens} tokens, cost ${v.cost.toFixed(4)}`);
  }
  for (const [modelThinking, v] of Object.entries(agg.byModelThinking)) {
    console.log(`        ${modelThinking}: ${v.messages} turns, ${v.totalTokens} tokens, cost ${v.cost.toFixed(4)}`);
  }
  if (agg.messages === 0) console.log(`    (no assistant turns with usage found - empty/fresh session)`);
  return agg;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--all")) {
    const root = sh("git rev-parse --show-toplevel").trim();
    const wtBase = join(root, ".worktrees");
    const dirs = [];
    // REAL BUG fixed 2026-10-12: see guard-stats.mjs's identical fix for the
    // full explanation - a bare `.pi-session` AT base (the repo root's own,
    // holding integrator-pi/, integrator-pi-02/, harness-change-0003*/, etc.)
    // was pushed into dirs AS ITSELF instead of having its OWN subdirectories
    // enumerated, so every root-level session (including the two largest
    // github-copilot sessions in the whole repo) was silently never counted.
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
    let grand = { messages: 0, totalTokens: 0, cost: 0, byModel: {}, byModelThinking: {} };
    for (const d of dirs) {
      const r = reportOne(d);
      if (r) {
        grand.messages += r.messages; grand.totalTokens += r.totalTokens; grand.cost += r.cost;
        mergeByModel(grand.byModel, r.byModel);
        mergeByModel(grand.byModelThinking, r.byModelThinking);
      }
    }
    console.log("");
    console.log(`TOTAL: ${grand.messages} assistant turns, ${grand.totalTokens} tokens, cost ${grand.cost.toFixed(4)}`);
    for (const [model, v] of Object.entries(grand.byModel)) {
      console.log(`  ${model}: ${v.messages} turns, ${v.totalTokens} tokens, cost ${v.cost.toFixed(4)}`);
    }
    console.log("");
    console.log(`TOTAL by model x thinking level:`);
    for (const [modelThinking, v] of Object.entries(grand.byModelThinking)) {
      console.log(`  ${modelThinking}: ${v.messages} turns, ${v.totalTokens} tokens, cost ${v.cost.toFixed(4)}`);
    }
    process.exit(0);
  }

  const target = args.find((a) => !a.startsWith("--"));
  if (!target) { console.error("usage: session-cost.mjs <path> | --all"); process.exit(1); }
  reportOne(target);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // Shape VERIFIED against real session files (see header) - not guessed.
  const assistantTurn = (totalTokens, cost, model = "stealth/space-bunny-alpha") => JSON.stringify({
    type: "message",
    message: { role: "assistant", provider: "openrouter", model,
      usage: { input: totalTokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } },
  });
  const lines = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }), // no usage - must not count
    assistantTurn(150, 0.002),
    assistantTurn(280, 0.004),
    JSON.stringify({ type: "message", message: { role: "assistant" } }), // assistant turn with no usage at all (e.g. a refusal?) - must not crash
    "not even json",
    "",
  ];
  const t = sumUsage(lines);
  ok(t.messages === 2, "only assistant turns carrying usage are counted (REGRESSION: cost lives inside usage, not beside it)");
  ok(t.totalTokens === 430, "sums totalTokens across turns");
  ok(Math.abs(t.cost - 0.006) < 1e-9, "sums the nested usage.cost.total across turns");
  ok(t.byModel["openrouter/stealth/space-bunny-alpha"]?.messages === 2, "groups by provider/model");

  ok(sumUsage([]).messages === 0, "empty input -> zero totals, not a crash");
  ok(sumUsage(["garbage", "{broken"]).messages === 0, "malformed lines are skipped, not fatal");

  const lines2 = [assistantTurn(100, 0.001, "openai/gpt-5"), assistantTurn(200, 0.002, "anthropic/claude")];
  const t2 = sumUsage(lines2);
  ok(Object.keys(t2.byModel).length === 2, "two different models produce two byModel entries");

  // model_change fallback - REAL bug fixed 2026-10-12, real event shape
  // (confirmed by inspection, see header): {type:"model_change", provider,
  // modelId} - note the field is "modelId", not "model".
  const modelChange = (provider, modelId) => JSON.stringify({ type: "model_change", id: "x", parentId: null, timestamp: "2026-10-08T20:20:12.702Z", provider, modelId });
  const bareMessage = (totalTokens, cost) => JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { totalTokens, cost: { total: cost } } }, // NO provider/model fields at all
  });
  const linesFallback = [modelChange("github-copilot", "claude-opus-5.5"), bareMessage(1000, 1.5)];
  const tFallback = sumUsage(linesFallback);
  ok(tFallback.byModel["github-copilot/claude-opus-5.5"]?.cost === 1.5,
    "REGRESSION: a message with no provider/model of its own falls back to the most recent model_change's identity, not an unattributed '?/?' bucket");
  ok(!("?/?" in tFallback.byModel), "the fallback actually fires - no stray ?/? entry when a model_change precedes the message");

  const linesNoChange = [bareMessage(500, 0.5)]; // no model_change at all before it
  const tNoChange = sumUsage(linesNoChange);
  ok(tNoChange.byModel["?/?"]?.cost === 0.5, "no model_change EVER seen -> still falls back to the honest '?/?' label, not a guess");

  const linesOwnModel = [modelChange("github-copilot", "claude-opus-5.5"), assistantTurn(50, 0.01, "its-own-model")];
  const tOwnModel = sumUsage(linesOwnModel);
  ok(tOwnModel.byModel["openrouter/its-own-model"]?.cost === 0.01 && !("github-copilot/claude-opus-5.5" in tOwnModel.byModel),
    "a message that DOES carry its own provider/model is never overridden by a preceding model_change");

  // thinking-level tracking: a turn before ANY thinking_level_change is logged
  // against "unknown"; later turns pick up whatever level was most recently set,
  // matching the real session shape confirmed against CHANGE-0071 (off -> medium
  // mid-session, same model throughout).
  const thinkChange = (level) => JSON.stringify({ type: "thinking_level_change", thinkingLevel: level });
  const lines3 = [
    assistantTurn(100, 0.001, "local/qwen"),           // before any level is set
    thinkChange("off"),
    assistantTurn(200, 0.002, "local/qwen"),
    assistantTurn(300, 0.003, "local/qwen"),            // still "off" - no new change event
    thinkChange("medium"),
    assistantTurn(400, 0.004, "local/qwen"),
  ];
  const t3 = sumUsage(lines3);
  ok(t3.byModelThinking["openrouter/local/qwen@unknown"]?.messages === 1, "turn before any thinking_level_change is attributed to 'unknown'");
  ok(t3.byModelThinking["openrouter/local/qwen@off"]?.messages === 2, "two turns after 'off' and before the next change both attribute to 'off'");
  ok(t3.byModelThinking["openrouter/local/qwen@medium"]?.messages === 1, "the turn after switching to 'medium' attributes to 'medium', not 'off'");
  ok(t3.byModel["openrouter/local/qwen"]?.messages === 4, "byModel is unaffected by thinking-level tracking - still sums all 4 turns for the one model");
  const malformedLevel = JSON.stringify({ type: "thinking_level_change", thinkingLevel: 123 });
  const t4 = sumUsage([malformedLevel, assistantTurn(100, 0.001)]);
  ok(t4.byModelThinking["openrouter/stealth/space-bunny-alpha@unknown"]?.messages === 1, "a non-string thinkingLevel is ignored, not adopted (stays 'unknown')");

  const files = sessionFilesIn("fake-dir", () => ["evidence.jsonl", "2026-10-05_abc123.jsonl", "notes.txt"]);
  ok(files.length === 1 && files[0] === "2026-10-05_abc123.jsonl", "sessionFilesIn excludes evidence.jsonl and non-jsonl files");

  // --- antigravity support (2026-10-12) --------------------------------------
  // Fixture text is the EXACT phrasing confirmed by inspection against a real
  // transcript (CHANGE-0077) - not invented, see the function's own comment.
  const userInput = (iso, from, to) => JSON.stringify({
    type: "USER_INPUT", created_at: iso,
    content: `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>`,
  });
  const plannerResponse = (iso, inputT, outputT, cacheT = 0) => JSON.stringify({
    type: "PLANNER_RESPONSE", created_at: iso, input_tokens: inputT, output_tokens: outputT, cache_read_tokens: cacheT,
  });

  const agyChanges = readAntigravityModelChanges([
    userInput("2026-10-10T16:00:00Z", "None", "Gemini 3.8 Flash (High)"),
    userInput("2026-10-10T17:00:00Z", "Gemini 3.8 Flash (High)", "Gemini 3.8 Flash (Medium)"),
  ]);
  ok(agyChanges.length === 2, "reads both Model Selection announcements");
  ok(agyChanges[0].key === "antigravity/Gemini 3.8 Flash (High)", "extracts the TO value, prefixed antigravity/, periods inside the model name do not truncate the match");
  ok(agyChanges[1].key === "antigravity/Gemini 3.8 Flash (Medium)", "the second announcement correctly captures the switched-to level");

  const agyLines = [
    userInput("2026-10-10T16:00:00Z", "None", "Gemini 3.8 Flash (High)"),
    plannerResponse("2026-10-10T16:05:00Z", 1000, 200, 50),
    userInput("2026-10-10T17:00:00Z", "Gemini 3.8 Flash (High)", "Gemini 3.8 Flash (Medium)"),
    plannerResponse("2026-10-10T17:05:00Z", 2000, 300, 0),
    "not even json",
  ];
  const agyUsage = sumAntigravityUsage(agyLines);
  ok(agyUsage.messages === 2, "two PLANNER_RESPONSE steps counted, malformed line skipped");
  ok(agyUsage.cost === 0, "antigravity usage always reports cost 0 - no rate card in the transcript");
  ok(agyUsage.byModel["antigravity/Gemini 3.8 Flash (High)"]?.totalTokens === 1250, "first response (before the switch) attributed to the first model: 1000+200+50");
  ok(agyUsage.byModel["antigravity/Gemini 3.8 Flash (Medium)"]?.totalTokens === 2300, "second response (after the switch) attributed to the second model: 2000+300+0");

  const plannerBeforeAnySwitch = sumAntigravityUsage([plannerResponse("2026-10-10T15:00:00Z", 10, 10)]);
  ok(plannerBeforeAnySwitch.byModel["antigravity/unknown"]?.messages === 1, "a response before any Model Selection announcement attributes to 'antigravity/unknown', not dropped");

  const agyDirs = antigravityTranscriptsIn("fake-dir",
    (p, opts) => (opts?.withFileTypes ? [{ name: "convo-1", isDirectory: () => true }, { name: "stray.txt", isDirectory: () => false }] : []),
    (p) => p.endsWith("transcript.jsonl") || p === "fake-dir/gemini-antigravity-cli/brain");
  ok(agyDirs.length === 1 && agyDirs[0].endsWith("convo-1/.system_generated/logs/transcript.jsonl"), "finds exactly one transcript.jsonl per conversation directory, skips non-directory entries");

  const noAgyDirs = antigravityTranscriptsIn("fake-dir-without-antigravity", () => [], () => false);
  ok(noAgyDirs.length === 0, "no gemini-antigravity-cli/brain directory at all -> empty list, not an error");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("session-cost self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("session-cost.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
