#!/usr/bin/env node
/**
 * cost-ledger.mjs - one normalised, per-message cost ledger across every backend the harness
 * runs (pi, Claude Code, Codex, Antigravity, OpenCode), tagged by ROLE and CHANGE, priced at list API
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
 *   opencode-home/opencode.db                        OpenCode (plus the shared login dir's db)
 * meters: <repo>/.pi-session/routing/usage-history.jsonl  ({t, q: {key: usedPct}}, route-worker)
 * prices: scripts/list-prices.json (USD per million tokens; edit to add models)
 * peak windows: herdr-plugin/peak-windows.json (scripts/peak-windows.mjs) - every row is tagged
 *   with the windows it fell in, and each window's meters get an inside/outside test
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
import { tmpdir } from "node:os";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { readAntigravityModelChanges } from "./session-cost.mjs";
import { loadPeakConfig, inWindow, appliesTo, DEFAULT_TEST } from "./peak-windows.mjs";

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

/**
 * OpenCode message rows ({data, session_parent}) -> turns. `cost` is what OpenCode itself billed
 * (for opencode-go models: the dollars the Go meter counts), kept as loggedCost. Pure.
 */
export function opencodeTurns(msgs) {
	const out = [];
	for (const m of msgs) {
		let j; try { j = typeof m.data === "string" ? JSON.parse(m.data) : m.data; } catch { continue; }
		if (j?.role !== "assistant" || !j.tokens || j.summary === true || j.mode === "compaction") continue;
		const t = j.tokens;
		out.push({
			t: typeof j.time?.created === "number" ? j.time.created : ts(j.time?.created), backend: "opencode", model: `${j.providerID ?? "?"}/${j.modelID ?? "?"}`, id: String(m.id ?? j.id ?? `oc:${out.length}`),
			input: num(t.input), cacheWrite5m: num(t.cache?.write), cacheWrite1h: 0, cacheRead: num(t.cache?.read), output: num(t.output) + num(t.reasoning),
			subagent: !!m.session_parent, loggedCost: typeof j.cost === "number" ? j.cost : null,
		});
	}
	return out;
}

/** opencode.db -> turns. Copies db + WAL first (the agent may be writing). [] when node:sqlite is missing. */
export function readOpencodeTurns(dbPath) {
	const sqlite = process.getBuiltinModule?.("node:sqlite");
	if (!sqlite) return [];
	const tmp = mkdtempSync(join(tmpdir(), "cost-ledger-oc-"));
	try {
		for (const ext of ["", "-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(tmp, "opencode.db" + ext));
		const db = new sqlite.DatabaseSync(join(tmp, "opencode.db"));
		try {
			return opencodeTurns(db.prepare("select m.id as id, m.data as data, s.parent_id as session_parent from message m join session s on s.id = m.session_id").all());
		} finally { db.close(); }
	} catch { return []; } finally { rmSync(tmp, { recursive: true, force: true }); }
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
	const opencode = existsSync(join(dir, "opencode-home", "opencode.db")) ? [join(dir, "opencode-home", "opencode.db")] : [];
	return { pi, claude, codex, antigravity, opencode };
}

/** OpenCode's shared login dir doubles as a session store when OPENCODE_CONFIG_DIR is used (launch-worker.sh). */
function sharedOpencodeDb() {
	const p = join(process.env.HARNESS_CONFIG_ROOT ?? join(process.env.HOME ?? "", ".harness", "config"), "opencode", "opencode.db");
	return existsSync(p) ? p : null;
}

const PARSERS = { pi: parsePi, claude: parseClaude, codex: parseCodex, antigravity: parseAntigravity };

// ---------------------------------------------------------------------------
// build + aggregate
// ---------------------------------------------------------------------------
export function buildLedger(repo, { days = 7, prices = loadPrices(), now = Date.now(), peak = loadPeakConfig(repo) } = {}) {
	const since = now - days * 86400e3;
	const rows = [];
	const seen = new Set();
	const dirs = sessionDirs(repo).map((d) => ({ ...d, cls: classifySession(d.name) }));
	const shared = sharedOpencodeDb();
	// shared store: no session dir to read role/change from - counted as unattributed worker turns
	if (shared) dirs.push({ dir: null, name: "opencode-shared", cls: { role: "worker", change: null }, files: { opencode: [shared] } });
	for (const { dir, name, cls, files: given } of dirs) {
		const { role, change } = cls;
		const files = given ?? logsIn(dir);
		for (const [backend, paths] of Object.entries(files)) {
			for (const f of paths) {
				try { if (statSync(f).mtimeMs < since) continue; } catch { continue; }
				let turns;
				if (backend === "opencode") turns = readOpencodeTurns(f);
				else { let text; try { text = readFileSync(f, "utf8"); } catch { continue; } turns = PARSERS[backend](text.split(NL)); }
				for (const turn of turns) {
					if (turn.t != null && turn.t < since) continue;
					const key = `${backend}:${turn.id}`;
					if (!turn.id.includes(":") && seen.has(key)) continue; // real ids only: same message seen via two mounts
					seen.add(key);
					const priced = priceTurn(turn, prices);
					const usd = priced ? priced.usd : turn.loggedCost;
					rows.push({
						...turn, session: name, role, change, file: f.startsWith(repo) ? relative(repo, f) : f,
						peak: isPeak(turn.t),
						windows: (peak.windows ?? []).filter((w) => appliesTo(w, { id: turn.model }) && inWindow(w, turn.t)).map((w) => w.id),
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
	opencodego_: (r) => /^opencode-go\//.test(r.model),
};
const meterMatcher = (key) => Object.entries(METER_BACKENDS).find(([p]) => key.startsWith(p))?.[1] ?? null;

/**
 * $ per meter point, per quota key. Walks consecutive history points; a rise of d points between
 * t0 and t1 is paired with the priced spend of matching turns in (t0, t1]. Drops (resets) and
 * spans with unpriced turns are skipped. Split peak/off-peak by the span's end time, using the
 * window that lists the key in its `meters` (peak-windows.json), else Anthropic's hours. Pure.
 */
export function meterRates(rows, history, peak = { windows: [] }) {
	const out = {};
	const keys = new Set(); for (const h of history) for (const k of Object.keys(h.q ?? {})) keys.add(k);
	for (const key of keys) {
		const match = meterMatcher(key);
		if (!match) continue;
		const win = (peak.windows ?? []).find((w) => (w.meters ?? []).includes(key));
		const inPeak = (t) => (win ? inWindow(win, t) : isPeak(t));
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
			const bucket = inPeak(pts[i].t) ? acc.peak : acc.offpeak;
			for (const b of [acc.all, bucket]) { b.usd += usd; b.pts += d; b.spans++; }
		}
		const rate = (b) => (b.pts > 0 ? Math.round((b.usd / b.pts) * 100) / 100 : null);
		out[key] = { window: win?.id ?? "anthropic", usdPerPoint: rate(acc.all), peakUsdPerPoint: rate(acc.peak), offpeakUsdPerPoint: rate(acc.offpeak), points: acc.all.pts, spans: acc.all.spans, skippedUnpriced: acc.skippedUnpriced };
	}
	return out;
}

/** Weighted tokens: the harness's usual price shape (fresh 1, cache write 1.25, cache read 0.1, output 5). */
export const wtok = (r) => r.input + (r.cacheWrite5m + r.cacheWrite1h) * 1.25 + r.cacheRead * 0.1 + r.output * 5;

/**
 * Does a meter really move faster inside window w? For each meter key the window lists, walk
 * consecutive usage-history points; keep a span when >= model_share of its weighted tokens come
 * from the window's (non-free) models and >= 80% of them fell inside, or <= 20% (outside).
 * ratio = (points per weighted Mtok inside) / (outside). 2x billing passed on reads ~2.
 * clientRatio does the same with OpenCode's own logged cost per weighted token: ~2 means the
 * client already prices the peak. Pure.
 */
export function windowTest(rows, history, w, test = DEFAULT_TEST) {
	const T = { ...DEFAULT_TEST, ...test };
	const res = {};
	for (const key of w.meters ?? []) {
		const match = meterMatcher(key);
		if (!match) continue;
		const pts = history.filter((h) => typeof h.q?.[key] === "number").map((h) => ({ t: h.t, v: h.q[key] })).sort((a, b) => a.t - b.t);
		const mine = rows.filter((r) => r.t != null && match(r));
		const side = () => ({ spans: 0, pts: 0, wt: 0, usd: 0, usdWt: 0 });
		const acc = { inside: side(), outside: side(), mixed: 0, diluted: 0 };
		for (let i = 1; i < pts.length; i++) {
			const d = pts[i].v - pts[i - 1].v;
			if (d <= 0) continue;
			const span = mine.filter((r) => r.t > pts[i - 1].t && r.t <= pts[i].t);
			const total = span.reduce((s, r) => s + wtok(r), 0);
			if (!total) continue;
			const win = span.filter((r) => appliesTo(w, { id: r.model }));
			const winWt = win.reduce((s, r) => s + wtok(r), 0);
			if (winWt / total < T.model_share) { acc.diluted++; continue; }
			const insideWt = win.filter((r) => inWindow(w, r.t)).reduce((s, r) => s + wtok(r), 0) / winWt;
			const b = insideWt >= 0.8 ? acc.inside : insideWt <= 0.2 ? acc.outside : null;
			if (!b) { acc.mixed++; continue; }
			b.spans++; b.pts += d; b.wt += total;
			const logged = span.filter((r) => r.loggedCost != null);
			b.usd += logged.reduce((s, r) => s + r.loggedCost, 0); b.usdWt += logged.reduce((s, r) => s + wtok(r), 0);
		}
		const per = (b) => (b.wt > 0 ? (b.pts / b.wt) * 1e6 : null);
		const cpt = (b) => (b.usdWt > 0 && b.usd > 0 ? b.usd / b.usdWt : null);
		const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
		const ratio = per(acc.inside) && per(acc.outside) ? per(acc.inside) / per(acc.outside) : null;
		const clientRatio = cpt(acc.inside) && cpt(acc.outside) ? cpt(acc.inside) / cpt(acc.outside) : null;
		const enough = [acc.inside, acc.outside].every((b) => b.spans >= T.min_spans && b.pts >= T.min_points);
		const verdict = !enough || ratio == null ? "insufficient" : ratio >= T.passes_through_ratio ? "passes_through" : ratio <= T.flat_ratio ? "flat" : "unclear";
		res[key] = { verdict, ratio: r2(ratio), clientRatio: r2(clientRatio), inside: { spans: acc.inside.spans, points: r2(acc.inside.pts), ptsPerMwtok: r2(per(acc.inside)) },
			outside: { spans: acc.outside.spans, points: r2(acc.outside.pts), ptsPerMwtok: r2(per(acc.outside)) }, mixedSpans: acc.mixed, dilutedSpans: acc.diluted };
	}
	// the window's verdict: the first meter (fastest first, as listed) with a real answer
	const keys = Object.keys(res);
	const best = keys.find((k) => res[k].verdict !== "insufficient") ?? keys[0] ?? null;
	return { id: w.id, status: w.status, meter: best, verdict: best ? res[best].verdict : "no_meter_data", ratio: best ? res[best].ratio : null, clientRatio: best ? res[best].clientRatio : null, byMeter: res, at: Date.now() };
}

export function summarize(rows, history = [], peak = { windows: [], test: DEFAULT_TEST }) {
	const s = { at: Date.now(), turns: rows.length, total: blank(), byRole: {}, byChange: {}, byModel: {}, byPeak: { peak: blank(), offpeak: blank() }, meters: {} };
	for (const r of rows) {
		add(s.total, r);
		add((s.byRole[r.role] ??= blank()), r);
		if (r.change) add((s.byChange[r.change] ??= blank()), r);
		add((s.byModel[`${r.backend} ${r.model}`] ??= blank()), r);
		if (r.peak != null) add(s.byPeak[r.peak ? "peak" : "offpeak"], r);
	}
	s.meters = meterRates(rows, history, peak);
	s.byWindow = {};
	for (const w of peak.windows ?? []) {
		const g = (s.byWindow[w.id] = { inside: blank(), outside: blank() });
		for (const r of rows) if (appliesTo(w, { id: r.model }) && r.t != null) add(r.windows?.includes(w.id) ? g.inside : g.outside, r);
	}
	s.windowTests = Object.fromEntries((peak.windows ?? []).map((w) => [w.id, windowTest(rows, history, w, peak.test)]));
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
	for (const [k, m] of ms) L.push(`  ${k.padEnd(22)} all ${$(m.usdPerPoint)}  ${m.window ?? "anthropic"} peak ${$(m.peakUsdPerPoint)}  off-peak ${$(m.offpeakUsdPerPoint)}  (${m.points} pts over ${m.spans} spans${m.skippedUnpriced ? `, ${m.skippedUnpriced} unpriced spans skipped` : ""})`);
	L.push("", "peak-window tests (does the meter move faster per token inside the window?)");
	const wt = Object.values(s.windowTests ?? {});
	if (!wt.length) L.push("  (no windows in herdr-plugin/peak-windows.json)");
	for (const t of wt) {
		const m = t.byMeter?.[t.meter];
		L.push(`  ${t.id.padEnd(10)} ${t.verdict.padEnd(15)} ${t.meter ?? "-"}  ratio ${t.ratio ?? "-"}  client ${t.clientRatio ?? "-"}` + (m ? `  (inside ${m.inside.spans} spans/${m.inside.points} pts, outside ${m.outside.spans}/${m.outside.points}, ${m.mixedSpans} mixed, ${m.dilutedSpans} other-model spans skipped)` : ""));
	}
	L.push("  ratio ~2 = the provider's peak price reaches this meter; ~1 = it does not. 'measure' windows only steer routing once this says passes_through.");
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
	const peak = loadPeakConfig(repo);
	const rows = buildLedger(repo, { days, peak });
	const summary = summarize(rows, readHistory(repo), peak);
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

	// OpenCode: message rows -> turns (time.created is epoch ms; reasoning counts as output)
	const OC = opencodeTurns([
		{ id: "msg_a", session_parent: null, data: J({ role: "assistant", providerID: "opencode-go", modelID: "deepseek-v4.1-flash", time: { created: Date.parse("2026-11-02T02:00:00Z") }, tokens: { input: 1000, output: 100, reasoning: 50, cache: { read: 20000, write: 0 } }, cost: 0.0042 }) },
		{ id: "msg_b", session_parent: "ses_p", data: J({ role: "assistant", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", time: { created: Date.parse("2026-11-02T05:00:00Z") }, tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } }, cost: 0 }) },
		{ id: "msg_u", data: J({ role: "user" }) },
	]);
	ok(OC.length === 2 && OC[0].model === "opencode-go/deepseek-v4.1-flash" && OC[0].output === 150 && OC[0].t === Date.parse("2026-11-02T02:00:00Z") && OC[0].loggedCost === 0.0042, `opencode turn (${J(OC[0])})`);
	ok(OC[1].subagent === true, "opencode child session = subagent");
	ok(METER_BACKENDS.opencodego_(OC[0]) && !METER_BACKENDS.opencodego_(OC[1]), "Go meter counts opencode-go models only, not Zen free");
	// real opencode.db round trip (schema subset OpenCode uses)
	const sqlite = process.getBuiltinModule?.("node:sqlite");
	if (sqlite) {
		const dir = mkdtempSync(join(tmpdir(), "cl-oc-test-"));
		try {
			const db = new sqlite.DatabaseSync(join(dir, "opencode.db"));
			db.exec("create table session (id text primary key, parent_id text); create table message (id text primary key, session_id text, data text)");
			db.prepare("insert into session values (?, ?)").run("ses_1", null);
			db.prepare("insert into message values (?, ?, ?)").run("msg_a", "ses_1", J({ role: "assistant", providerID: "opencode-go", modelID: "deepseek-v4.1-flash", time: { created: 1 }, tokens: { input: 5, output: 1, cache: {} }, cost: 0.1 }));
			db.close();
			const R = readOpencodeTurns(join(dir, "opencode.db"));
			ok(R.length === 1 && R[0].id === "msg_a" && R[0].input === 5, `readOpencodeTurns (${J(R)})`);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}

	// window test: DeepSeek window, Go meter moving 2x per token inside vs outside
	const DS = { id: "deepseek", status: "measure", tz: "UTC", days: ["Mon", "Tue", "Wed", "Thu", "Fri"], hours: [[1, 4], [6, 10]], applies: { model: "deepseek" }, meters: ["opencodego_5h"] };
	const mkTurn = (t, model = "opencode-go/deepseek-v4.1-flash") => ({ t, model, backend: "opencode", input: 100000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, loggedCost: null });
	const synth = (insideRate, outsideRate) => {
		const rows2 = [], hist = [];
		let v = 0;
		// Mon-Fri 2026-11-02..06: one 30-min span at 02:00Z (inside) and one at 12:00Z (outside) each day
		for (let d = 0; d < 5; d++) for (const [hh, rate] of [[2, insideRate], [12, outsideRate]]) {
			const t0 = Date.parse(`2026-11-0${2 + d}T${String(hh).padStart(2, "0")}:00:00Z`);
			hist.push({ t: t0, q: { opencodego_5h: v } });
			rows2.push(mkTurn(t0 + 60e3), mkTurn(t0 + 120e3));
			v += rate; // 200k weighted tokens per span
			hist.push({ t: t0 + 30 * 60e3, q: { opencodego_5h: v } });
		}
		return { rows2, hist };
	};
	let syn = synth(2, 1);
	let wtres = windowTest(syn.rows2, syn.hist, DS);
	ok(wtres.verdict === "passes_through" && wtres.ratio === 2 && wtres.byMeter.opencodego_5h.inside.spans === 5, `2x inside -> passes_through (${J(wtres)})`);
	syn = synth(1, 1);
	ok(windowTest(syn.rows2, syn.hist, DS).verdict === "flat", "same rate -> flat");
	ok(windowTest(syn.rows2.slice(0, 4), syn.hist.slice(0, 4), DS).verdict === "insufficient", "too few spans -> insufficient");
	// spans dominated by other Go models are skipped, not counted against DeepSeek
	syn = synth(2, 1);
	const other = syn.rows2.map((r) => ({ ...r, model: "opencode-go/kimi-k3.1-pro" }));
	ok(windowTest(other, syn.hist, DS).byMeter.opencodego_5h.dilutedSpans === 10, "non-DeepSeek spans skipped");
	// summary carries the tests, keyed by window
	const sw = summarize(syn.rows2.map((r) => ({ ...r, role: "worker", windows: inWindow(DS, r.t) ? ["deepseek"] : [], usd: null, cacheWriteUsd: null })), syn.hist, { windows: [DS], test: DEFAULT_TEST });
	ok(sw.windowTests.deepseek.verdict === "passes_through" && sw.byWindow.deepseek.inside.turns === 10 && sw.meters.opencodego_5h.window === "deepseek", "summary windowTests + byWindow + meter window");
	ok(render(sw, 7).includes("peak-window tests"), "render window tests");

	if (fails) { console.error(`${fails} cost-ledger self-test(s) FAILED`); return 1; }
	console.log("cost-ledger self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c));
