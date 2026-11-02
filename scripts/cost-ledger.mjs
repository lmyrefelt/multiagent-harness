#!/usr/bin/env node
/**
 * cost-ledger.mjs - one normalised, per-message cost ledger across every backend the harness
 * runs (pi, Claude Code, Codex, Antigravity), tagged by ROLE and CHANGE, priced at list API
 * rates, and correlated with the subscription meters.
 *
 * WHY THIS EXISTS
 * session-cost.mjs, cache-stats.mjs and usage-meters.mjs each read the agents' own logs for one
 * purpose (pi cost, cache hit %, live pane meters). None of them answers the questions that
 * matter for routing: which ROLE burns the budget, what each CHANGE cost, how much of the spend
 * is cache writes (the subagent fan-out tax), and how many API-equivalent dollars one point of
 * each subscription meter buys - peak vs off-peak. Method borrowed from
 * github.com/phuryn/experiments (subscription-multipliers/05-claude-pro): log every message,
 * dedupe by message id (last record wins), price at list rates, divide by meter movement.
 *
 * WHERE THE DATA COMES FROM (no launcher changes needed - all paths already exist):
 *   <repo>/.pi-session/<name>/                       integrator-<x>, harness-planner-<x>, ...
 *   <repo>/.worktrees/<wt>/.pi-session/<name>/       harness-change-NNNN[-label][-NN] (workers)
 * inside each session dir:
 *   *.jsonl (top level, not evidence.jsonl)          pi
 *   claude-projects/**.jsonl                         Claude Code
 *   codex-sessions/**.jsonl                          Codex
 *   gemini-antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl   Antigravity
 *   antigravity-brain/<id>/.system_generated/logs/transcript.jsonl              (integrator)
 * meters: <repo>/.pi-session/routing/usage-history.jsonl  ({t, q: {key: usedPct}}, route-worker)
 * prices: scripts/list-prices.json (USD per million tokens; edit to add models)
 *
 * OUTPUT
 *   .pi-session/routing/ledger.jsonl          one line per model turn (rebuilt each run)
 *   .pi-session/routing/ledger-summary.json   the aggregates the report prints
 *   --sqlite <path>                           also writes a `ledger` table (needs node:sqlite)
 *
 * CAVEATS (printed with the report too)
 *   - $/meter-point counts only HARNESS sessions. Anything else on the same account (your own
 *     interactive Claude/Codex use) moves the meter too, so $/pt is a LOWER bound.
 *   - Antigravity transcripts carry no cache-write count; Codex reports none either. Their
 *     cache-write share reads 0, which is "not reported", not "none happened".
 *   - Models with no row in list-prices.json are counted in tokens and shown as unpriced -
 *     never guessed. pi turns fall back to pi's own logged cost when unpriced.
 *
 *   node scripts/cost-ledger.mjs [--days 7] [--print] [--json] [--sqlite out.db]
 *   node scripts/cost-ledger.mjs --selftest
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAntigravityModelChanges } from "./session-cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NL = "\n";

// ---------------------------------------------------------------------------
// role / change from the session-dir name (naming set by launch-*.sh)
// ---------------------------------------------------------------------------
/** "harness-change-0048-ui-02" -> {role:"worker", change:"CHANGE-0048"}. Pure. */
export function classifySession(name) {
	const n = String(name || "");
	if (/^integrator-/.test(n)) return { role: "integrator", change: null };
	if (/^harness-planner-/.test(n)) return { role: "planner", change: null };
	const m = /^harness-change-(\d+)/i.exec(n);
	if (m) return { role: "worker", change: `CHANGE-${m[1].padStart(4, "0")}` };
	if (/^harness-/.test(n)) return { role: "worker", change: null };
	return { role: "other", change: null };
}

// ---------------------------------------------------------------------------
// peak hours: Anthropic's published peak is weekdays 05:00-11:00 America/Los_Angeles.
// Computed in LA time so the Europe/US daylight-saving gap is handled automatically.
// ---------------------------------------------------------------------------
const LA = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hourCycle: "h23" });
export function isPeak(ms, startHour = 5, endHour = 11) {
	if (!Number.isFinite(ms)) return null;
	const parts = Object.fromEntries(LA.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
	if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
	const h = Number(parts.hour);
	return h >= startHour && h < endHour;
}

// ---------------------------------------------------------------------------
// parsers: one log file's lines -> normalised turns. Pure.
// turn = { t, backend, model, id, input, cacheWrite5m, cacheWrite1h, cacheRead, output, subagent, loggedCost }
// `input` is always FRESH (uncached, unwritten) input, whatever the backend's own convention.
// ---------------------------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ts = (v) => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : null; };

export function parsePi(lines) {
	const out = [];
	let cur = null;
	lines.forEach((line, i) => {
		if (!line.includes('"usage"') && !line.includes("model_change")) return;
		let o; try { o = JSON.parse(line); } catch { return; }
		if (o?.type === "model_change") { cur = { provider: o.provider, model: o.modelId }; return; }
		const m = o?.message;
		if (o?.type !== "message" || m?.role !== "assistant" || !m.usage) return;
		const u = m.usage;
		const provider = m.provider ?? cur?.provider ?? "?";
		const model = m.model ?? cur?.model ?? "?";
		out.push({
			t: ts(o.timestamp ?? m.timestamp), backend: "pi", model: `${provider}/${model}`, id: o.id ?? `pi:${i}`,
			input: num(u.input), cacheWrite5m: num(u.cacheWrite), cacheWrite1h: 0, cacheRead: num(u.cacheRead), output: num(u.output),
			subagent: false, loggedCost: typeof u.cost?.total === "number" ? u.cost.total : null,
		});
	});
	return out;
}

/** Claude Code writes one line per content block; the LAST record per message id carries final usage. */
export function parseClaude(lines) {
	const byId = new Map();
	lines.forEach((line, i) => {
		if (!line.includes('"usage"')) return;
		let o; try { o = JSON.parse(line); } catch { return; }
		const m = o?.message;
		if (o?.type !== "assistant" || !m?.usage) return;
		const u = m.usage;
		const cc = u.cache_creation ?? {};
		const has1h = typeof cc.ephemeral_1h_input_tokens === "number";
		const w1h = num(cc.ephemeral_1h_input_tokens);
		const w5m = typeof cc.ephemeral_5m_input_tokens === "number" ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, num(u.cache_creation_input_tokens) - (has1h ? w1h : 0));
		const id = m.id ?? o.requestId ?? `claude:${i}`;
		byId.set(id, {
			t: ts(o.timestamp), backend: "claude", model: `anthropic/${m.model ?? "?"}`, id,
			input: num(u.input_tokens), cacheWrite5m: w5m, cacheWrite1h: w1h, cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens),
			subagent: o.isSidechain === true, loggedCost: null,
		});
	});
	return [...byId.values()];
}

/** Codex: token_count events; input_tokens INCLUDES cached. Repeats of the same running total are skipped. */
export function parseCodex(lines) {
	const out = [];
	let model = "?", lastTotal = null, n = 0;
	for (const line of lines) {
		if (!/token_count|turn_context/.test(line)) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (o?.type === "turn_context" && o.payload?.model) { model = o.payload.model; continue; }
		const info = o?.payload?.type === "token_count" ? o.payload.info : null;
		const u = info?.last_token_usage;
		if (!u) continue;
		const total = info.total_token_usage?.total_tokens;
		if (total != null && total === lastTotal) continue; // re-emitted, no new model turn
		lastTotal = total ?? lastTotal;
		const cached = num(u.cached_input_tokens);
		out.push({
			t: ts(o.timestamp), backend: "codex", model: `codex/${model}`, id: `codex:${n++}`,
			input: Math.max(0, num(u.input_tokens) - cached), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: cached,
			output: num(u.output_tokens), subagent: false, loggedCost: null,
		});
	}
	return out;
}

/** Antigravity: PLANNER_RESPONSE steps; model from the Model-Selection announcements (shared parser). */
export function parseAntigravity(lines) {
	const changes = readAntigravityModelChanges(lines);
	const out = [];
	lines.forEach((line, i) => {
		if (!line.includes("PLANNER_RESPONSE")) return;
		let o; try { o = JSON.parse(line); } catch { return; }
		if (o?.type !== "PLANNER_RESPONSE" || o.input_tokens == null) return;
		const t = ts(o.created_at);
		let model = "antigravity/unknown";
		if (t != null) for (const c of changes) { if (c.t <= t) model = c.key; else break; }
		const cached = num(o.cache_read_tokens);
		out.push({
			t, backend: "antigravity", model, id: o.step_id ?? o.id ?? `agy:${i}`,
			input: Math.max(0, num(o.input_tokens) - cached), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: cached,
			output: num(o.output_tokens), subagent: false, loggedCost: null,
		});
	});
	return out;
}

// ---------------------------------------------------------------------------
// pricing
// ---------------------------------------------------------------------------
export function loadPrices(path = join(HERE, "list-prices.json")) {
	try { return JSON.parse(readFileSync(path, "utf8")).models ?? []; } catch { return []; }
}
/** First row whose `match` regex hits the model id. */
export function priceFor(prices, model) {
	for (const p of prices) { try { if (new RegExp(p.match, "i").test(model)) return p; } catch { /* bad regex */ } }
	return null;
}
/** USD at list price, or null if the model has no price row. Pure. */
export function priceTurn(turn, prices) {
	const p = priceFor(prices, turn.model);
	if (!p) return null;
	const w1h = p.cache_write_1h ?? p.cache_write_5m ?? p.input;
	const w5m = p.cache_write_5m ?? p.input;
	const usd = (turn.input * p.input + turn.cacheWrite5m * w5m + turn.cacheWrite1h * w1h + turn.cacheRead * (p.cache_read ?? p.input) + turn.output * p.output) / 1e6;
	const cwUsd = (turn.cacheWrite5m * w5m + turn.cacheWrite1h * w1h) / 1e6;
	return { usd, cacheWriteUsd: cwUsd };
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
function walk(dir, test, out = [], depth = 6) {
	let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of es) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (depth > 0) walk(p, test, out, depth - 1); }
		else if (test(p, e.name)) out.push(p);
	}
	return out;
}

/** Every session dir: [{dir, name}] from the repo's own .pi-session and every worktree's. */
export function sessionDirs(repo) {
	const roots = [join(repo, ".pi-session")];
	try { for (const w of readdirSync(join(repo, ".worktrees"))) roots.push(join(repo, ".worktrees", w, ".pi-session")); } catch { /* none */ }
	const out = [];
	for (const r of roots) {
		let es = []; try { es = readdirSync(r, { withFileTypes: true }); } catch { continue; }
		for (const e of es) if (e.isDirectory() && !["routing", "handoff", "briefs", "triage", "qualify", "bench", "herdr-lifecycle"].includes(e.name)) out.push({ dir: join(r, e.name), name: e.name });
	}
	return out;
}

/** The log files in one session dir, keyed by backend. */
export function logsIn(dir) {
	const jsonl = (p, n) => n.endsWith(".jsonl");
	const pi = (() => { try { return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !/^(evidence|events|decisions)/.test(f)).map((f) => join(dir, f)); } catch { return []; } })();
	const claude = walk(join(dir, "claude-projects"), jsonl);
	const codex = walk(join(dir, "codex-sessions"), jsonl);
	const agyT = (p, n) => n === "transcript.jsonl" && p.includes(`${sep}.system_generated${sep}`);
	const antigravity = [...walk(join(dir, "gemini-antigravity-cli", "brain"), agyT), ...walk(join(dir, "antigravity-brain"), agyT)];
	return { pi, claude, codex, antigravity };
}

const PARSERS = { pi: parsePi, claude: parseClaude, codex: parseCodex, antigravity: parseAntigravity };

// ---------------------------------------------------------------------------
// build + aggregate
// ---------------------------------------------------------------------------
export function buildLedger(repo, { days = 7, prices = loadPrices(), now = Date.now() } = {}) {
	const since = now - days * 86400e3;
	const rows = [];
	const seen = new Set();
	for (const { dir, name } of sessionDirs(repo)) {
		const { role, change } = classifySession(name);
		const files = logsIn(dir);
		for (const [backend, paths] of Object.entries(files)) {
			for (const f of paths) {
				try { if (statSync(f).mtimeMs < since) continue; } catch { continue; }
				let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
				for (const turn of PARSERS[backend](text.split(NL))) {
					if (turn.t != null && turn.t < since) continue;
					const key = `${backend}:${turn.id}`;
					if (!turn.id.includes(":") && seen.has(key)) continue; // real ids only: same message seen via two mounts
					seen.add(key);
					const priced = priceTurn(turn, prices);
					const usd = priced ? priced.usd : turn.loggedCost;
					rows.push({
						...turn, session: name, role, change, file: relative(repo, f),
						peak: isPeak(turn.t),
						usd: usd == null ? null : Math.round(usd * 1e6) / 1e6,
						cacheWriteUsd: priced ? Math.round(priced.cacheWriteUsd * 1e6) / 1e6 : null,
						priceSource: priced ? "list" : turn.loggedCost != null ? "logged" : null,
					});
				}
			}
		}
	}
	rows.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
	return rows;
}

const blank = () => ({ turns: 0, usd: 0, cacheWriteUsd: 0, tokens: 0, unpricedTokens: 0, subagentUsd: 0 });
function add(g, r) {
	const tok = r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead + r.output;
	g.turns++; g.tokens += tok;
	if (r.usd == null) g.unpricedTokens += tok; else g.usd += r.usd;
	g.cacheWriteUsd += r.cacheWriteUsd ?? 0;
	if (r.subagent) g.subagentUsd += r.usd ?? 0;
}

/** Meter keys -> which turns move them. */
export const METER_BACKENDS = {
	claude_: (r) => r.backend === "claude" || /^(anthropic|claude)\//.test(r.model),
	codex_: (r) => r.backend === "codex" || /^(openai-codex|codex)\//.test(r.model),
	gemini_: (r) => r.backend === "antigravity",
};
const meterMatcher = (key) => Object.entries(METER_BACKENDS).find(([p]) => key.startsWith(p))?.[1] ?? null;

/**
 * $ per meter point, per quota key. Walks consecutive history points; a rise of d points between
 * t0 and t1 is paired with the priced spend of matching turns in (t0, t1]. Drops (resets) and
 * spans with unpriced turns are skipped. Split peak/off-peak by the span's end time. Pure.
 */
export function meterRates(rows, history) {
	const out = {};
	const keys = new Set(); for (const h of history) for (const k of Object.keys(h.q ?? {})) keys.add(k);
	for (const key of keys) {
		const match = meterMatcher(key);
		if (!match) continue;
		const pts = history.filter((h) => typeof h.q?.[key] === "number").map((h) => ({ t: h.t, v: h.q[key] })).sort((a, b) => a.t - b.t);
		const mine = rows.filter((r) => r.t != null && match(r));
		const acc = { all: { usd: 0, pts: 0, spans: 0 }, peak: { usd: 0, pts: 0, spans: 0 }, offpeak: { usd: 0, pts: 0, spans: 0 }, skippedUnpriced: 0 };
		for (let i = 1; i < pts.length; i++) {
			const d = pts[i].v - pts[i - 1].v;
			if (d <= 0) continue;
			const span = mine.filter((r) => r.t > pts[i - 1].t && r.t <= pts[i].t);
			if (!span.length) continue;
			if (span.some((r) => r.usd == null)) { acc.skippedUnpriced++; continue; }
			const usd = span.reduce((s, r) => s + r.usd, 0);
			const bucket = isPeak(pts[i].t) ? acc.peak : acc.offpeak;
			for (const b of [acc.all, bucket]) { b.usd += usd; b.pts += d; b.spans++; }
		}
		const rate = (b) => (b.pts > 0 ? Math.round((b.usd / b.pts) * 100) / 100 : null);
		out[key] = { usdPerPoint: rate(acc.all), peakUsdPerPoint: rate(acc.peak), offpeakUsdPerPoint: rate(acc.offpeak), points: acc.all.pts, spans: acc.all.spans, skippedUnpriced: acc.skippedUnpriced };
	}
	return out;
}

export function summarize(rows, history = []) {
	const s = { at: Date.now(), turns: rows.length, total: blank(), byRole: {}, byChange: {}, byModel: {}, byPeak: { peak: blank(), offpeak: blank() }, meters: {} };
	for (const r of rows) {
		add(s.total, r);
		add((s.byRole[r.role] ??= blank()), r);
		if (r.change) add((s.byChange[r.change] ??= blank()), r);
		add((s.byModel[`${r.backend} ${r.model}`] ??= blank()), r);
		if (r.peak != null) add(s.byPeak[r.peak ? "peak" : "offpeak"], r);
	}
	s.meters = meterRates(rows, history);
	return s;
}

export function readHistory(repo) {
	try {
		return readFileSync(join(repo, ".pi-session", "routing", "usage-history.jsonl"), "utf8").split(NL)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((h) => h && Number.isFinite(h.t));
	} catch { return []; }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const $ = (v) => (v == null ? "     -" : `$${v.toFixed(2)}`.padStart(9));
const pct = (a, b) => (b > 0 ? `${Math.round((100 * a) / b)}%`.padStart(5) : "    -");
const mtok = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`).padStart(7);

function table(title, groups, limit = 15) {
	const L = [title];
	const entries = Object.entries(groups).sort((a, b) => b[1].usd - a[1].usd).slice(0, limit);
	if (!entries.length) return [...L, "  (none)"];
	L.push(`  ${"".padEnd(44)} ${"API $".padStart(9)} ${"cw%".padStart(5)} ${"sub%".padStart(5)} ${"tokens".padStart(7)} ${"unpriced".padStart(8)}  turns`);
	for (const [k, g] of entries) L.push(`  ${k.slice(0, 44).padEnd(44)} ${$(g.usd)} ${pct(g.cacheWriteUsd, g.usd)} ${pct(g.subagentUsd, g.usd)} ${mtok(g.tokens)} ${g.unpricedTokens ? mtok(g.unpricedTokens).padStart(8) : "       -"}  ${g.turns}`);
	return L;
}

export function render(s, days) {
	const L = [`cost ledger - last ${days} days, ${s.turns} model turns, ${$(s.total.usd).trim()} at list price` + (s.total.unpricedTokens ? ` (+${mtok(s.total.unpricedTokens).trim()} tokens unpriced)` : ""), ""];
	L.push(...table("by role", s.byRole), "");
	L.push(...table("by change (top 15)", s.byChange), "");
	L.push(...table("by backend + model", s.byModel), "");
	L.push("peak vs off-peak (weekdays 05-11 America/Los_Angeles)");
	L.push(`  peak     ${$(s.byPeak.peak.usd)}  ${s.byPeak.peak.turns} turns`, `  off-peak ${$(s.byPeak.offpeak.usd)}  ${s.byPeak.offpeak.turns} turns`, "");
	L.push("API-equivalent $ per subscription meter point (harness sessions only - a lower bound)");
	const ms = Object.entries(s.meters);
	if (!ms.length) L.push("  (no usage-history yet - run `node scripts/route-worker.mjs --refresh-usage` periodically)");
	for (const [k, m] of ms) L.push(`  ${k.padEnd(22)} all ${$(m.usdPerPoint)}  peak ${$(m.peakUsdPerPoint)}  off-peak ${$(m.offpeakUsdPerPoint)}  (${m.points} pts over ${m.spans} spans${m.skippedUnpriced ? `, ${m.skippedUnpriced} unpriced spans skipped` : ""})`);
	L.push("", "cw% = share of $ spent on cache writes; sub% = share spent in Claude subagents.");
	L.push("Codex and Antigravity do not report cache writes, so their cw% reads 0.");
	return L.join(NL);
}

async function writeSqlite(path, rows) {
	let DatabaseSync;
	try { ({ DatabaseSync } = await import("node:sqlite")); } catch { console.error("node:sqlite not available in this Node - skipping --sqlite (needs Node 22.13+)"); return false; }
	const db = new DatabaseSync(path);
	db.exec(`DROP TABLE IF EXISTS ledger; CREATE TABLE ledger (t INTEGER, session TEXT, role TEXT, change TEXT, backend TEXT, model TEXT, id TEXT,
		input INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER, cache_read INTEGER, output INTEGER, subagent INTEGER, peak INTEGER,
		usd REAL, cache_write_usd REAL, price_source TEXT, file TEXT)`);
	const ins = db.prepare("INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
	db.exec("BEGIN");
	for (const r of rows) ins.run(r.t, r.session, r.role, r.change, r.backend, r.model, r.id, r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output, r.subagent ? 1 : 0, r.peak == null ? null : r.peak ? 1 : 0, r.usd, r.cacheWriteUsd, r.priceSource, r.file);
	db.exec("COMMIT");
	db.close();
	return true;
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repo = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
	const di = argv.indexOf("--days");
	const days = di >= 0 ? Number(argv[di + 1]) : 7;
	const rows = buildLedger(repo, { days });
	const summary = summarize(rows, readHistory(repo));
	const outDir = join(repo, ".pi-session", "routing");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join(NL) + (rows.length ? NL : ""));
	writeFileSync(join(outDir, "ledger-summary.json"), JSON.stringify({ days, ...summary }, null, 1));
	const si = argv.indexOf("--sqlite");
	if (si >= 0 && argv[si + 1]) await writeSqlite(resolve(argv[si + 1]), rows);
	if (argv.includes("--json")) console.log(JSON.stringify({ days, ...summary }, null, 1));
	else if (argv.includes("--print")) console.log(render(summary, days));
	else console.log(`wrote .pi-session/routing/ledger.jsonl (${rows.length} turns) and ledger-summary.json - add --print for the report`);
	return 0;
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------
function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const J = JSON.stringify;

	// role/change
	ok(classifySession("harness-change-0048").role === "worker" && classifySession("harness-change-48-ui-02").change === "CHANGE-0048", "worker + change id");
	ok(classifySession("harness-planner-pi").role === "planner", "planner");
	ok(classifySession("integrator-main").role === "integrator", "integrator");
	ok(classifySession("misc").role === "other", "other");

	// peak: Wed 2026-10-28 13:30 Oslo = 05:30 LA (US still on PDT) -> peak; 12:30 Oslo -> not
	ok(isPeak(Date.parse("2026-10-28T12:30:00Z")) === true, "13:30 Oslo during the DST gap is peak");
	ok(isPeak(Date.parse("2026-10-28T11:30:00Z")) === false, "12:30 Oslo is before peak");
	ok(isPeak(Date.parse("2026-11-04T12:30:00Z")) === false && isPeak(Date.parse("2026-11-04T13:30:00Z")) === true, "after US DST ends, peak starts 14:00 Oslo");
	ok(isPeak(Date.parse("2026-10-31T15:00:00Z")) === false, "Saturday is never peak");

	// Claude: last record per id wins, 5m/1h split, sidechain = subagent
	const C = parseClaude([
		J({ type: "assistant", timestamp: "2026-10-28T20:00:00Z", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 1 } } }),
		J({ type: "assistant", timestamp: "2026-10-28T20:00:01Z", isSidechain: true, message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 }, cache_read_input_tokens: 2000, output_tokens: 500 } } }),
		J({ type: "assistant", message: { id: "m2", model: "claude-opus-5-5", usage: { input_tokens: 1, cache_creation_input_tokens: 300, output_tokens: 0 } } }),
	]);
	ok(C.length === 2 && C[0].output === 500 && C[0].subagent, "claude dedupe keeps last record");
	ok(C[0].cacheWrite5m === 600 && C[0].cacheWrite1h === 400, "claude 5m/1h split");
	ok(C[1].cacheWrite5m === 300 && C[1].cacheWrite1h === 0, "claude without split -> all 5m");

	// pricing: Opus 5.5 list ($4 in, $5 cw5m, $8 cw1h, $0.20 read, $20 out per Mtok)
	const prices = [{ match: "claude-opus-5-5", input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 }];
	const p = priceTurn(C[0], prices);
	const want = (10 * 4 + 600 * 5 + 400 * 8 + 2000 * 0.2 + 500 * 20) / 1e6;
	ok(Math.abs(p.usd - want) < 1e-12, `opus pricing (${p.usd} vs ${want})`);
	ok(Math.abs(p.cacheWriteUsd - (600 * 5 + 400 * 8) / 1e6) < 1e-12, "cache-write $ share");
	ok(priceTurn({ ...C[0], model: "anthropic/unknown" }, prices) === null, "unpriced model -> null, never guessed");

	// Codex: input includes cached; repeated running total skipped; model from turn_context
	const X = parseCodex([
		J({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
		J({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }, total_token_usage: { total_tokens: 1050 } } } }),
		J({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }, total_token_usage: { total_tokens: 1050 } } } }),
	]);
	ok(X.length === 1 && X[0].input === 400 && X[0].cacheRead === 600 && X[0].model === "codex/gpt-6.1-sol", "codex fresh = input - cached, repeat skipped");

	// Antigravity: model from the announcement, fresh = input - cache_read
	const A = parseAntigravity([
		J({ type: "USER_INPUT", created_at: "2026-10-28T10:00:00Z", content: "the user changed setting `Model Selection` from Gemini 3.8 Flash (Low) to Gemini 3.8 Pro (High). No need to comment on this change." }),
		J({ type: "PLANNER_RESPONSE", created_at: "2026-10-28T10:01:00Z", input_tokens: 900, cache_read_tokens: 300, output_tokens: 40 }),
	]);
	ok(A.length === 1 && A[0].input === 600 && A[0].model === "antigravity/Gemini 3.8 Pro (High)", "antigravity parse");

	// pi: logged cost carried, model_change fallback
	const P = parsePi([
		J({ type: "model_change", provider: "opencode", modelId: "deepseek-v4.1-flash" }),
		J({ type: "message", id: "a1", timestamp: "2026-10-28T10:00:00Z", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0.0123 } } } }),
	]);
	ok(P.length === 1 && P[0].model === "opencode/deepseek-v4.1-flash" && P[0].loggedCost === 0.0123, "pi parse + model_change fallback");

	// meter rates: two spans, one peak one off-peak
	const t0 = Date.parse("2026-10-28T12:00:00Z"); // 13:00 Oslo, 05:00 LA -> peak window
	const rows = [
		{ t: t0 + 60e3, backend: "claude", model: "anthropic/claude-opus-5-5", usd: 2.0 },
		{ t: t0 + 120e3, backend: "claude", model: "anthropic/claude-opus-5-5", usd: 2.0 },
		{ t: t0 + 120e3, backend: "codex", model: "codex/gpt-6.1-sol", usd: 9.0 },
		{ t: t0 + 8 * 3600e3 + 60e3, backend: "claude", model: "anthropic/claude-opus-5-5", usd: 3.0 },
	];
	const hist = [
		{ t: t0, q: { claude_weekly: 10 } },
		{ t: t0 + 180e3, q: { claude_weekly: 12 } },             // +2 pts at peak for $4
		{ t: t0 + 8 * 3600e3, q: { claude_weekly: 12 } },
		{ t: t0 + 8 * 3600e3 + 180e3, q: { claude_weekly: 13 } }, // +1 pt off-peak for $3
		{ t: t0 + 9 * 3600e3, q: { claude_weekly: 0 } },          // reset: skipped
	];
	const mr = meterRates(rows, hist).claude_weekly;
	ok(mr.usdPerPoint === 2.33 && mr.peakUsdPerPoint === 2 && mr.offpeakUsdPerPoint === 3, `meter $/pt split (${J(mr)})`);
	ok(mr.points === 3, "codex spend not charged to the claude meter");

	// summarize
	const s = summarize([{ ...C[0], role: "worker", change: "CHANGE-0001", peak: false, usd: p.usd, cacheWriteUsd: p.cacheWriteUsd }, { ...X[0], role: "planner", change: null, peak: true, usd: null, cacheWriteUsd: null }]);
	ok(s.byRole.worker.usd > 0 && s.byRole.planner.unpricedTokens === 1050, "unpriced tokens tracked separately");
	ok(s.byChange["CHANGE-0001"].subagentUsd === s.byChange["CHANGE-0001"].usd, "subagent $ attributed");
	ok(render(s, 7).includes("by role"), "render");

	if (fails) { console.error(`${fails} cost-ledger self-test(s) FAILED`); return 1; }
	console.log("cost-ledger self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c));
