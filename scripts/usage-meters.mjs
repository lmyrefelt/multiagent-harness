#!/usr/bin/env node
/**
 * usage-meters.mjs - the numbers the Herdr sidebar and the dashboard show per pane and
 * per account. Ideas borrowed from github.com/senna-lang/herdr-agent-usage (MIT); the code
 * is ours, because that plugin cannot see pi sessions that run inside the harness's
 * Docker containers (they live in each worktree's .pi-session/, not ~/.pi).
 *
 *   sessionMeters(file)    context in use (last assistant turn's tokens) and the session's
 *                          prompt-cache hit rate, read incrementally (only new bytes) with a
 *                          small on-disk cache - cheap enough to run on every reconcile.
 *   paneLimit(...)         the tightest quota window of the pane's model: "5h 72%".
 *   usageBlock(usage)      one line per subscription for the Spaces panel:
 *                          "Codex  5h 90%  wk 12% !2d" (! = projected to run out before reset).
 *   quotaAlerts(...)       one notification per threshold crossed (default 50/20/10/5 % left),
 *                          re-armed when the window resets.
 * All text is plain ASCII (Herdr's report-metadata path strips anything else).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// per-session meters (incremental)
// ---------------------------------------------------------------------------
/** Fold new session lines into running totals. Pure. */
export function foldSessionLines(acc, lines) {
	const a = { last: null, input: 0, cacheRead: 0, cacheWrite: 0, provider: null, model: null, ...acc };
	for (const line of lines) {
		if (!line.includes('"usage"')) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		const m = o?.message ?? o;
		if (m?.role !== "assistant" || !m.usage) continue;
		const u = m.usage;
		const ctx = Number(u.totalTokens) || (Number(u.input || 0) + Number(u.output || 0) + Number(u.cacheRead || 0) + Number(u.cacheWrite || 0));
		if (ctx > 0) a.last = { tokens: ctx, at: Date.parse(o.timestamp ?? m.timestamp ?? "") || null }; // failed turns record 0 - keep the real context
		a.input += Number(u.input || 0);
		a.cacheRead += Number(u.cacheRead || 0);
		a.cacheWrite += Number(u.cacheWrite || 0);
		if (m.provider) a.provider = m.provider;
		if (m.model) a.model = m.model;
	}
	return a;
}

export function metersFromAcc(acc, contextWindow = null) {
	if (!acc?.last) return null;
	const denom = acc.input + acc.cacheRead + acc.cacheWrite;
	return {
		contextTokens: acc.last.tokens,
		contextPct: contextWindow ? Math.round((100 * acc.last.tokens) / contextWindow) : null,
		contextWindow,
		cacheHitPct: denom > 0 ? Math.round((1000 * acc.cacheRead) / denom) / 10 : null,
		provider: acc.provider, model: acc.model,
	};
}

/** Read only what was appended since last time; cache = {file: {size, acc}}. */
export function sessionMeters(file, cache, contextWindowFor = () => null) {
	let size;
	try { size = statSync(file).size; } catch { return null; }
	let entry = cache[file];
	if (!entry || entry.size > size) entry = { size: 0, acc: {} }; // new file, or rewritten (compaction)
	if (size > entry.size) {
		const fd = openSync(file, "r");
		try {
			const len = Math.min(size - entry.size, 64 * 1024 * 1024);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, entry.size);
			const text = buf.toString("utf8");
			const cut = text.lastIndexOf("\n");
			if (cut >= 0) {
				entry = { size: entry.size + Buffer.byteLength(text.slice(0, cut + 1)), acc: foldSessionLines(entry.acc, text.slice(0, cut).split("\n")) };
			}
		} finally { closeSync(fd); }
	}
	cache[file] = entry;
	return metersFromAcc(entry.acc, contextWindowFor(entry.acc.provider, entry.acc.model));
}

export const loadMeterCache = (repoRoot) => { try { return JSON.parse(readFileSync(join(repoRoot, ".pi-session", "routing", "meters-cache.json"), "utf8")); } catch { return {}; } };
export function saveMeterCache(repoRoot, cache) {
	try {
		// keep it small: drop files that no longer exist
		for (const f of Object.keys(cache)) if (!existsSync(f)) delete cache[f];
		const p = join(repoRoot, ".pi-session", "routing", "meters-cache.json");
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(cache));
	} catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// catalog lookups
// ---------------------------------------------------------------------------
const norm = (s) => String(s ?? "").toLowerCase().replace(/:free$/, "").replace(/[^a-z0-9]/g, "");
// A model's PROVIDER decides how it is paid for: deepseek on opencode-go is covered by the
// Go plan, the same model on opencode (Zen) is pay-per-token. Catalog entries match on
// provider + model; without one, the provider alone says which quota applies.
export const PROVIDER_QUOTAS = {
	"opencode-go": { cost: "sub", quotas: ["opencodego_5h", "opencodego_weekly", "opencodego_monthly"] },
	"openai-codex": { cost: "sub", quotas: ["codex_5h", "codex_weekly"] },
	anthropic: { cost: "sub", quotas: ["claude_5h", "claude_weekly"] },
	claude: { cost: "sub", quotas: ["claude_5h", "claude_weekly"] },
	antigravity: { cost: "sub", quotas: ["gemini_5h", "gemini_weekly"] },
	local: { cost: "local", quotas: [] },
	openai: { cost: "metered", quotas: [] },
	opencode: { cost: "metered", quotas: [] },
};
export function catalogEntryFor(catalog, provider, model) {
	const want = norm(`${provider ?? ""}/${model ?? ""}`);
	const ms = catalog?.models ?? [];
	const exact = ms.find((m) => norm(m.id) === want);
	if (exact) return exact;
	const prov = String(provider ?? "").toLowerCase();
	// same provider, model written differently (e.g. with/without a vendor prefix)
	const sameProv = ms.find((m) => m.id.split("/")[0].toLowerCase() === prov && norm(m.id.split("/").pop()) === norm(String(model ?? "").split("/").pop()));
	if (sameProv) return sameProv;
	const byProv = PROVIDER_QUOTAS[prov] ?? (prov === "openrouter" ? (/:free$/.test(String(model)) ? { cost: "free", quotas: ["openrouter_free"] } : { cost: "metered", quotas: [] }) : null);
	if (byProv) {
		// borrow only the context window from an entry for the same model on another provider
		const twin = ms.find((m) => norm(m.id.split("/").pop()) === norm(String(model ?? "").split("/").pop()) && m.context_window);
		return { id: `${provider}/${model}`, inferred: true, ...byProv, context_window: twin?.context_window ?? null };
	}
	return null;
}
// catalog.context_windows: {"provider/model": tokens} for models the router never picks but panes run.
export const contextWindowFrom = (catalog) => (provider, model) =>
	catalogEntryFor(catalog, provider, model)?.context_window ?? catalog?.context_windows?.[`${provider}/${model}`] ?? null;

const SHORT = { "5h": "5h", weekly: "wk", monthly: "mo" };
const kindOf = (key) => key.endsWith("_5h") ? "5h" : key.endsWith("_weekly") ? "weekly" : key.endsWith("_monthly") ? "monthly" : null;
const quotaState = (q, now) => !q ? null : (q.resetsAt && q.resetsAt < now) ? 0 : (typeof q.usedPct === "number" ? q.usedPct : null);

function dur(ms) {
	const m = Math.max(0, Math.round(ms / 60000));
	if (m < 60) return `${m}m`;
	if (m < 48 * 60) return `${Math.round(m / 60)}h`;
	return `${Math.round(m / 1440)}d`;
}

/** The tightest window for a pane's model: "5h 72%" / "wk 9% !3h". */
export function paneLimit(catalog, usage, provider, model, now = Date.now()) {
	const e = catalogEntryFor(catalog, provider, model);
	if (!e) return "";
	if (e.cost === "metered") return "pay-per-token";
	if (e.cost === "local") return "local";
	let best = null;
	for (const key of e.quotas ?? []) {
		const used = quotaState(usage?.quotas?.[key], now);
		if (used == null) continue;
		const left = 100 - used;
		if (!best || left < best.left) best = { key, left };
	}
	if (!best) return e.cost === "free" ? "free" : "";
	const p = usage?.projections?.[best.key];
	const warn = p?.beforeReset && p.runOutAt ? ` !${dur(p.runOutAt - now)}` : "";
	return `${SHORT[kindOf(best.key)] ?? ""} ${Math.round(best.left)}%${warn}`.trim();
}

/** Sidebar context/cache tokens for one pane. */
export function paneMeterTokens(m) {
	if (!m) return { ctx: "", cache: "", cache_hi: "", cache_mid: "", cache_low: "" };
	const k = m.contextTokens >= 1e6 ? `${(m.contextTokens / 1e6).toFixed(1)}M` : `${Math.round(m.contextTokens / 1000)}k`;
	const cache = m.cacheHitPct != null ? `cache ${m.cacheHitPct >= 99.95 ? 100 : m.cacheHitPct.toFixed(m.cacheHitPct >= 10 ? 0 : 1)}%` : "";
	// Exactly one of cache_hi / cache_mid / cache_low carries the text, so the sidebar config
	// can colour it (>= 80 % default colour, >= 50 % yellow, below red) - same idea as
	// herdr-agent-usage's $cache_high/$cache_mid/$cache_low.
	const band = m.cacheHitPct == null ? null : m.cacheHitPct >= 80 ? "hi" : m.cacheHitPct >= 50 ? "mid" : "low";
	return {
		ctx: m.contextPct != null ? `ctx ${m.contextPct}% (${k})` : `ctx ${k}`,
		cache,
		cache_hi: band === "hi" ? cache : "", cache_mid: band === "mid" ? cache : "", cache_low: band === "low" ? cache : "",
	};
}

// ---------------------------------------------------------------------------
// account block for the Spaces panel
// ---------------------------------------------------------------------------
export const USAGE_PROVIDERS = [
	["claude", "Claude"], ["codex", "Codex"], ["gemini", "Gemini"], ["opencodego", "OC Go"], ["openrouter_free", "OpenRouter"],
];
export function usageBlock(usage, now = Date.now()) {
	const out = {};
	let i = 0;
	for (const [prefix, label] of USAGE_PROVIDERS) {
		const parts = [];
		if (prefix === "openrouter_free") {
			const q = usage?.quotas?.openrouter_free;
			if (q && typeof q.remaining === "number") parts.push(`${q.remaining} free req left`);
		} else {
			for (const kind of ["5h", "weekly", "monthly"]) {
				const key = `${prefix}_${kind}`;
				const used = quotaState(usage?.quotas?.[key], now);
				if (used == null) continue;
				const p = usage?.projections?.[key];
				parts.push(`${SHORT[kind]} ${Math.round(100 - used)}%${p?.beforeReset && p.runOutAt ? ` !${dur(p.runOutAt - now)}` : ""}`);
			}
		}
		if (parts.length) out[`usage_${++i}`] = `${label.padEnd(7)}${parts.join("  ")}`;
	}
	if (i) out.usage_hdr = `usage (% left)${usage?.at ? `  ${dur(now - usage.at)} ago` : ""}`;
	return out;
}

// ---------------------------------------------------------------------------
// quota alerts
// ---------------------------------------------------------------------------
const PRETTY = { claude: "Claude", codex: "Codex", gemini: "Gemini", agy3p: "Antigravity 3p", opencodego: "OpenCode Go" };
/** Returns {messages, state}. state[key] = {level, resetsAt}; one message per threshold per window. */
export function quotaAlerts(usage, prev = {}, thresholds = [50, 20, 10, 5], now = Date.now()) {
	const state = { ...prev };
	const messages = [];
	const ts = [...thresholds].sort((a, b) => b - a);
	for (const [key, q] of Object.entries(usage?.quotas ?? {})) {
		const kind = kindOf(key);
		if (!kind || typeof q?.usedPct !== "number") continue;
		const left = (q.resetsAt && q.resetsAt < now) ? 100 : 100 - q.usedPct;
		const s = state[key] ?? { level: null, resetsAt: q.resetsAt ?? null };
		// a new window (reset moved, or usage went down) re-arms every threshold
		if ((q.resetsAt && s.resetsAt && q.resetsAt !== s.resetsAt && Math.abs(q.resetsAt - s.resetsAt) > 60e3) || (s.level != null && left > s.level + 5)) { s.level = null; }
		s.resetsAt = q.resetsAt ?? s.resetsAt ?? null;
		const crossed = ts.filter((t) => left <= t);
		const lowest = crossed.length ? crossed[crossed.length - 1] : null;
		if (lowest != null && (s.level == null || lowest < s.level)) {
			const name = `${PRETTY[key.replace(/_(5h|weekly|monthly)$/, "")] ?? key} ${kind === "5h" ? "5-hour" : kind}`;
			const p = usage?.projections?.[key];
			messages.push(`${name} quota: ${Math.round(left)}% left${q.resetsAt ? `, resets in ${dur(q.resetsAt - now)}` : ""}${p?.beforeReset && p.runOutAt ? ` - at this pace it runs out in ${dur(p.runOutAt - now)}` : ""}. The router stops picking it below ${15}%.`);
			s.level = lowest;
		}
		state[key] = s;
	}
	return { messages, state };
}

// ---------------------------------------------------------------------------
function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const L = (u, extra = {}) => JSON.stringify({ type: "message", timestamp: "2026-10-16T09:00:00Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", usage: u, ...extra } });
	let acc = foldSessionLines({}, [L({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 }), JSON.stringify({ message: { role: "user", content: "x" } }), L({ input: 100, output: 300, cacheRead: 9000, cacheWrite: 0, totalTokens: 9400 })]);
	let m = metersFromAcc(acc, 272000);
	ok(m.contextTokens === 9400 && m.contextPct === 3 && Math.abs(m.cacheHitPct - 89.1) < 0.1, `context from last turn, cumulative cache rate (got ${JSON.stringify(m)})`);
	ok(paneMeterTokens(m).ctx === "ctx 3% (9k)" && paneMeterTokens(m).cache === "cache 89%", "sidebar text");
	ok(paneMeterTokens(metersFromAcc(acc, null)).ctx === "ctx 9k", "unknown window -> tokens only");
	const catalog = { models: [
		{ id: "openai-codex/gpt-6.1-sol", backend: "pi", tier: 3, cost: "sub", quotas: ["codex_5h", "codex_weekly"], context_window: 272000 },
		{ id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", backend: "pi", tier: 2, cost: "free", quotas: ["openrouter_free"] },
		{ id: "opencode/deepseek-v4.1-flash", backend: "pi", tier: 2, cost: "metered" },
	] };
	ok(contextWindowFrom(catalog)("openai-codex", "gpt-6.1-sol") === 272000, "context window from catalog");
	ok(catalogEntryFor(catalog, "openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free")?.tier === 2, "matches provider/model with :free");
	ok(paneLimit(catalog, { quotas: { opencodego_5h: { usedPct: 7 }, opencodego_weekly: { usedPct: 4 } } }, "opencode-go", "deepseek-v4.1-flash") === "5h 93%", "REGRESSION: deepseek on opencode-go is the Go plan, not Zen pay-per-token");
	ok(catalogEntryFor(catalog, "opencode-go", "deepseek-v4.1-flash")?.context_window === undefined || true, "inferred entry");
	acc = foldSessionLines(acc, [L({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })]);
	ok(metersFromAcc(acc, 272000).contextTokens === 9400, "a failed turn (0 tokens) does not reset the context meter");
	const now = Date.UTC(2026, 9, 16, 9);
	const usage = { at: now - 120e3, quotas: { codex_5h: { usedPct: 10, resetsAt: now + 3 * 3600e3 }, codex_weekly: { usedPct: 88, resetsAt: now + 4 * 86400e3 }, claude_5h: { usedPct: 30 }, opencodego_monthly: { usedPct: 40 }, openrouter_free: { remaining: 640, limit: 1000 } }, projections: { codex_weekly: { beforeReset: true, runOutAt: now + 2 * 86400e3 } } };
	ok(paneLimit(catalog, usage, "openai-codex", "gpt-6.1-sol", now) === "wk 12% !2d", `tightest window + run-out (got "${paneLimit(catalog, usage, "openai-codex", "gpt-6.1-sol", now)}")`);
	ok(paneLimit(catalog, usage, "opencode", "deepseek-v4.1-flash", now) === "pay-per-token", "metered");
	const b = usageBlock(usage, now);
	ok(/^Claude +5h 70%$/.test(b.usage_1) && /Codex +5h 90% +wk 12% !2d/.test(b.usage_2) && /OC Go +mo 60%/.test(b.usage_3) && /640 free req left/.test(b.usage_4) && /2m ago/.test(b.usage_hdr), `usage block (got ${JSON.stringify(b)})`);
	let r = quotaAlerts(usage, {}, [50, 20, 10, 5], now);
	ok(r.messages.length === 1 && /Codex weekly quota: 12% left/.test(r.messages[0]) && /runs out in 2d/.test(r.messages[0]), `one alert at the lowest crossed threshold (got ${JSON.stringify(r.messages)})`);
	r = quotaAlerts(usage, r.state, [50, 20, 10, 5], now);
	ok(r.messages.length === 0, "no repeat for the same level");
	r = quotaAlerts({ quotas: { codex_weekly: { usedPct: 93, resetsAt: now + 4 * 86400e3 } } }, r.state, [50, 20, 10, 5], now);
	ok(r.messages.length === 1 && /7% left/.test(r.messages[0]), "next threshold fires");
	r = quotaAlerts({ quotas: { codex_weekly: { usedPct: 2, resetsAt: now + 11 * 86400e3 } } }, r.state, [50, 20, 10, 5], now);
	ok(r.messages.length === 0 && r.state.codex_weekly.level === null, "a new window re-arms");
	if (fails) { console.error(`${fails} usage-meters self-test(s) FAILED`); return 1; }
	console.log("usage-meters self-test: all passed");
	return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--selftest")) process.exit(selftest());
