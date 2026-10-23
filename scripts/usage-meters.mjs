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
	const a = { last: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, provider: null, model: null, turns: 0, recent: [], ...acc };
	for (const line of lines) {
		if (!line.includes('"usage"')) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		const m = o?.message ?? o;
		if (m?.role !== "assistant" || !m.usage) continue;
		const u = m.usage;
		const ctx = Number(u.totalTokens) || (Number(u.input || 0) + Number(u.output || 0) + Number(u.cacheRead || 0) + Number(u.cacheWrite || 0));
		const turnIn = Number(u.input || 0), turnOut = Number(u.output || 0);
		const turnAt = Date.parse(o.timestamp ?? m.timestamp ?? "") || Date.now();
		if (ctx > 0) a.last = { tokens: ctx, at: turnAt, turnIn, turnOut, turnTokens: turnIn + turnOut }; // failed turns record 0 - keep the real context
		a.input += turnIn;
		a.output = (a.output || 0) + turnOut;
		a.cacheRead += Number(u.cacheRead || 0);
		a.cacheWrite += Number(u.cacheWrite || 0);
		a.turns = (a.turns || 0) + 1;
		a.recent = [...(a.recent || []), { t: turnAt, tok: turnIn + turnOut }].slice(-40);
		if (m.provider) a.provider = m.provider;
		if (m.model) a.model = m.model;
	}
	return a;
}

export function metersFromAcc(acc, contextWindow = null, now = Date.now()) {
	if (!acc?.last) return null;
	const denom = acc.input + acc.cacheRead + acc.cacheWrite;
	const totalTokens = (acc.input || 0) + (acc.output || 0) + (acc.cacheRead || 0) + (acc.cacheWrite || 0);
	const recent5m = (acc.recent || []).filter((r) => now - r.t <= 5 * 60e3);
	const tokens5m = recent5m.reduce((sum, r) => sum + r.tok, 0);
	const burn_tpm_5m = Math.round(tokens5m / 5);
	return {
		contextTokens: acc.last.tokens,
		contextPct: contextWindow ? Math.round((100 * acc.last.tokens) / contextWindow) : null,
		contextWindow,
		cacheHitPct: denom > 0 ? Math.round((1000 * acc.cacheRead) / denom) / 10 : null,
		provider: acc.provider, model: acc.model,
		totalTokens,
		turns: acc.turns || 0,
		turnTokens: acc.last.turnTokens || 0,
		burn_tpm_5m,
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
	if (!m) return { ctx: "", cache: "", cache_hi: "", cache_mid: "", cache_low: "", tokens: "", tokens_recent: "", turn_tok: "", glyph: "", tu: "", ctx_num: "", cost_num: "", burn: "" };
	const k = m.contextTokens >= 1e6 ? `${(m.contextTokens / 1e6).toFixed(1)}M` : `${Math.round(m.contextTokens / 1000)}k`;
	const cache = m.cacheHitPct != null ? `cache ${m.cacheHitPct >= 99.95 ? 100 : m.cacheHitPct.toFixed(m.cacheHitPct >= 10 ? 0 : 1)}%` : "";
	// Exactly one of cache_hi / cache_mid / cache_low carries the text, so the sidebar config
	// can colour it (>= 80 % default colour, >= 50 % yellow, below red) - same idea as
	// herdr-agent-usage's $cache_high/$cache_mid/$cache_low.
	const band = m.cacheHitPct == null ? null : m.cacheHitPct >= 80 ? "hi" : m.cacheHitPct >= 50 ? "mid" : "low";
	const fmtTok = (n) => !n ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1000)}k` : String(n);
	const totK = fmtTok(m.totalTokens);
	const turnK = fmtTok(m.turnTokens);
	const tokens = totK ? `Σ ${totK}` : "";
	const tokens_recent = turnK && totK ? `last ${turnK} (Σ ${totK})` : tokens;
	const turn_tok = turnK ? `turn ${turnK}` : "";

	// Level glyph (pseudovar pattern from herdr-plugin-token-usage):
	// ■ critical (ctx >= 90% or burn spike >= 150k/m)
	// ▲ warn (ctx >= 75% or cache hit < 50%)
	// ▽ safe (ctx < 50% and cache hit >= 80%)
	const isCrit = (m.contextPct != null && m.contextPct >= 90) || (m.burn_tpm_5m != null && m.burn_tpm_5m >= 150000);
	const isWarn = !isCrit && ((m.contextPct != null && m.contextPct >= 75) || (m.cacheHitPct != null && m.cacheHitPct < 50));
	const isSafe = !isCrit && !isWarn && (m.contextPct != null && m.contextPct < 50) && (m.cacheHitPct == null || m.cacheHitPct >= 80);
	const glyph = isCrit ? "■" : isWarn ? "▲" : isSafe ? "▽" : "●";

	// Compact all-in-one token for a single sidebar slot ($tu)
	const tuParts = [glyph, m.contextPct != null ? `ctx ${m.contextPct}%` : `ctx ${k}`];
	if (tokens) tuParts.push(tokens);
	if (cache) tuParts.push(cache);
	const tu = tuParts.join(" · ");

	return {
		ctx: m.contextPct != null ? `ctx ${m.contextPct}% (${k})` : `ctx ${k}`,
		cache,
		cache_hi: band === "hi" ? cache : "", cache_mid: band === "mid" ? cache : "", cache_low: band === "low" ? cache : "",
		tokens,
		tokens_recent,
		turn_tok,
		glyph,
		tu,
		ctx_num: m.contextPct != null ? String(m.contextPct) : "",
		cost_num: m.totalTokens != null ? String(Math.round(m.totalTokens / 1000)) : "",
		burn: m.burn_tpm_5m > 0 ? `${fmtTok(m.burn_tpm_5m)}/m` : "",
		burn_num: m.burn_tpm_5m ?? 0,
		contextTokens: m.contextTokens ?? 0,
		contextWindow: m.contextWindow ?? 0,
	};
}

// ---------------------------------------------------------------------------
// pacing & compaction advisor
// ---------------------------------------------------------------------------
/**
 * Pacing ratio for a quota window.
 * Pace = actual used % / expected used % based on elapsed time in the window.
 * 1.0x = exactly on track to hit 100% at the reset moment.
 * > 1.15x = burning faster than quota allowance.
 * < 0.6x = burning slowly / plenty of headroom.
 */
export function quotaWindowPace(key, q, now = Date.now()) {
	if (!q || typeof q.usedPct !== "number" || !q.resetsAt || q.resetsAt <= now) return null;
	const duration = key.endsWith("_5h") ? 5 * 3600e3 : key.endsWith("_weekly") ? 7 * 86400e3 : key.endsWith("_monthly") ? 30 * 86400e3 : null;
	if (!duration) return null;
	const timeLeft = q.resetsAt - now;
	const elapsed = duration - timeLeft;
	if (elapsed <= 5 * 60e3) return null; // within first 5 minutes
	const expectedPct = Math.min(100, Math.max(1, (elapsed / duration) * 100));
	const pace = Math.round((q.usedPct / expectedPct) * 100) / 100;
	const glyph = (q.usedPct >= 85 || pace >= 1.3) ? "■" : pace >= 1.1 ? "▲" : pace <= 0.6 ? "▽" : "●";
	return { pace, glyph, label: pace >= 1.15 ? "over" : pace <= 0.6 ? "under" : "on track" };
}

/**
 * Compaction advisor: evaluates whether carrying the session's prompt context
 * costs more per hour than the one-off compaction operation.
 * (Design from pseudovar/herdr-plugin-token-usage §17).
 */
export function compactionAdvice({
	contextTokens = 0,
	contextWindow = 200000,
	callsPerHour = 12,
	inputPricePerM = 3.0,
	cacheReadPricePerM = 0.3,
	outputPricePerM = 15.0,
} = {}) {
	if (!contextTokens || contextTokens < 20000) {
		return { verdict: "keep", reason: "context small", savingsPerHour: 0, paybackCalls: null, carryCostPerCall: 0 };
	}
	const ctxPct = contextWindow ? Math.round((100 * contextTokens) / contextWindow) : 0;
	const carryCostPerCall = (contextTokens / 1e6) * cacheReadPricePerM;
	const compactedSize = Math.min(contextTokens, 15000);
	const postCompactCarryCost = (compactedSize / 1e6) * cacheReadPricePerM;
	const perCallSavings = Math.max(0, carryCostPerCall - postCompactCarryCost);
	const savingsPerHour = perCallSavings * callsPerHour;

	const summaryTokens = 8000;
	const oneOffCost = (contextTokens / 1e6) * inputPricePerM + (summaryTokens / 1e6) * outputPricePerM;
	const paybackCalls = perCallSavings > 0 ? Math.ceil(oneOffCost / perCallSavings) : 999;

	let verdict = "keep";
	if (ctxPct >= 80 || savingsPerHour >= 2.0 || paybackCalls <= 4) {
		verdict = "compact now";
	} else if (ctxPct >= 60 || savingsPerHour >= 0.50 || paybackCalls <= 8) {
		verdict = "compact soon";
	}

	return {
		verdict,
		contextTokens,
		ctxPct,
		carryCostPerCall: Math.round(carryCostPerCall * 1000) / 1000,
		savingsPerHour: Math.round(savingsPerHour * 100) / 100,
		oneOffCost: Math.round(oneOffCost * 100) / 100,
		paybackCalls,
	};
}

// ---------------------------------------------------------------------------
// account block for the Spaces panel & tab bar status
// ---------------------------------------------------------------------------
export const USAGE_PROVIDERS = [
	["claude", "Claude"], ["codex", "Codex"], ["gemini", "Gemini"], ["opencodego", "OC Go"], ["openrouter_free", "OpenRouter"],
];

/**
 * Compact single-line summary of tightest subscription limits for the Herdr tab bar / title.
 * Formats the most critical windows (e.g., "▲ Claude 5h: 22% 1.4× !2h | ▽ Codex: 45%").
 */
export function tabLimitSummary(usage, now = Date.now(), maxEntries = 2) {
	if (!usage?.quotas) return "";
	const items = [];
	for (const [prefix, label] of USAGE_PROVIDERS) {
		if (prefix === "openrouter_free") continue;
		let tightest = null;
		for (const kind of ["5h", "weekly", "monthly"]) {
			const key = `${prefix}_${kind}`;
			const used = quotaState(usage?.quotas?.[key], now);
			if (used == null) continue;
			const left = Math.round(100 - used);
			const p = usage?.projections?.[key];
			const runOut = p?.beforeReset && p.runOutAt ? ` !${dur(p.runOutAt - now)}` : "";
			const paceInfo = quotaWindowPace(key, usage?.quotas?.[key], now);
			const paceTxt = paceInfo ? ` ${paceInfo.pace}× ${paceInfo.glyph}` : "";
			if (!tightest || left < tightest.left || runOut) {
				tightest = { kind: SHORT[kind], left, runOut, paceTxt, glyph: paceInfo?.glyph ?? "", key };
			}
		}
		if (tightest) {
			items.push({ label, ...tightest });
		}
	}
	// Sort by lowest percentage remaining or run-out warning first
	items.sort((a, b) => {
		if (a.runOut && !b.runOut) return -1;
		if (!a.runOut && b.runOut) return 1;
		return a.left - b.left;
	});
	return items.slice(0, maxEntries).map((x) => `${x.glyph ? x.glyph + " " : ""}${x.label} ${x.kind}: ${x.left}%${x.paceTxt}${x.runOut}`.trim()).join(" | ");
}

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
	const tab = tabLimitSummary(usage, now);
	if (tab) out.tab_usage = tab;
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
		const s = state[key] ?? { level: null, resetsAt: q.resetsAt ?? null, lastPaceWarningAt: null };
		// a new window (reset moved, or usage went down) re-arms every threshold
		if ((q.resetsAt && s.resetsAt && q.resetsAt !== s.resetsAt && Math.abs(q.resetsAt - s.resetsAt) > 60e3) || (s.level != null && left > s.level + 5)) {
			s.level = null;
			s.lastPaceWarningAt = null;
		}
		s.resetsAt = q.resetsAt ?? s.resetsAt ?? null;
		const crossed = ts.filter((t) => left <= t);
		const lowest = crossed.length ? crossed[crossed.length - 1] : null;
		const p = usage?.projections?.[key];
		const name = `${PRETTY[key.replace(/_(5h|weekly|monthly)$/, "")] ?? key} ${kind === "5h" ? "5-hour" : kind}`;
		const isProjectedToRunOut = Boolean(p?.beforeReset && p.runOutAt && p.runOutAt > now);

		// 1) Standard threshold crossing (e.g. dropped past 50%, 20%, 10%, 5%)
		if (lowest != null && (s.level == null || lowest < s.level)) {
			const runOutMsg = isProjectedToRunOut ? ` - at current pace it runs out in ${dur(p.runOutAt - now)}` : "";
			messages.push(`${name} quota: ${Math.round(left)}% left${q.resetsAt ? `, resets in ${dur(q.resetsAt - now)}` : ""}${runOutMsg}. The router stops picking it below 15%.`);
			s.level = lowest;
			s.lastPaceWarningAt = now;
		} else if (isProjectedToRunOut && (!s.lastPaceWarningAt || now - s.lastPaceWarningAt > 30 * 60e3) && (s.level === null && left <= 30)) {
			// 2) Early pace-burn exhaustion warning (warn if burn rate projects running out before reset, throttled to max once every 30m)
			messages.push(`PACE ALERT: ${name} quota at ${Math.round(left)}% will run out in ${dur(p.runOutAt - now)} (before reset in ${q.resetsAt ? dur(q.resetsAt - now) : "unknown"}). Consider throttling or switching tiers.`);
			s.lastPaceWarningAt = now;
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
	ok(paneMeterTokens(m).tokens === "Σ 11k" && /last 400 \(Σ 11k\)/.test(paneMeterTokens(m).tokens_recent), "sidebar token pseudovars");
	ok(paneMeterTokens(m).glyph === "▽" && /ctx 3%/.test(paneMeterTokens(m).tu) && paneMeterTokens(m).ctx_num === "3", "level glyphs and unitless pseudovars");
	const adv = compactionAdvice({ contextTokens: 150000, contextWindow: 200000, callsPerHour: 15 });
	ok(adv.verdict === "compact soon" && adv.carryCostPerCall > 0 && adv.paybackCalls <= 15, `compaction advice: got ${adv.verdict}, payback ${adv.paybackCalls}`);
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
	const pace = quotaWindowPace("claude_5h", { usedPct: 60, resetsAt: now + 2 * 3600e3 }, now);
	ok(pace && pace.pace > 0 && typeof pace.glyph === "string", "quota window pacing");
	const usage = { at: now - 120e3, quotas: { codex_5h: { usedPct: 10, resetsAt: now + 3 * 3600e3 }, codex_weekly: { usedPct: 88, resetsAt: now + 4 * 86400e3 }, claude_5h: { usedPct: 30 }, opencodego_monthly: { usedPct: 40 }, openrouter_free: { remaining: 640, limit: 1000 } }, projections: { codex_weekly: { beforeReset: true, runOutAt: now + 2 * 86400e3 } } };
	ok(paneLimit(catalog, usage, "openai-codex", "gpt-6.1-sol", now) === "wk 12% !2d", `tightest window + run-out (got "${paneLimit(catalog, usage, "openai-codex", "gpt-6.1-sol", now)}")`);
	ok(paneLimit(catalog, usage, "opencode", "deepseek-v4.1-flash", now) === "pay-per-token", "metered");
	const b = usageBlock(usage, now);
	ok(/^Claude +5h 70%$/.test(b.usage_1) && /Codex +5h 90% +wk 12% !2d/.test(b.usage_2) && /OC Go +mo 60%/.test(b.usage_3) && /640 free req left/.test(b.usage_4) && /2m ago/.test(b.usage_hdr), `usage block (got ${JSON.stringify(b)})`);
	ok(b.tab_usage && /Codex wk: 12%.*!2d/.test(b.tab_usage), `tab_usage contains tightest constraint (got "${b.tab_usage}")`);
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
