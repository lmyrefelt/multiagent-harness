#!/usr/bin/env node
/**
 * route-worker.mjs - pick the backend + model for a worker from
 *   (1) how hard the change is      (change.yaml + the integrator's routing hint + ledger)
 *   (2) what capacity is left        (subscription %, free-request budget, local server)
 *   (3) provider health              (overload storms in the last hour -> circuit breaker)
 * using the catalog in herdr-plugin/models.catalog.json.
 *
 * Principle: the CHEAPEST model that is strong enough. A change starts at the lowest
 * eligible tier >= its minimum and moves up a tier when it struggles (escalation from the
 * ledger: repeated impl-changes-requested, worker 'blocked').
 *
 * Hard rules (owner, 2026-10-15):
 *   - high risk            -> tier >= 3 from the start
 *   - critical risk        -> a human launches the worker
 *   - visual work (SVG, CSS, canvas, sprites, UI art, shaders ...) -> a model marked
 *     visual:true in the catalog (strong models: Opus / gpt-6-astra)
 *   - the integrator's size estimate (change.yaml routing.complexity) wins over the heuristic
 *
 * Track record (scripts/model-outcomes.mjs -> .pi-session/routing/outcomes.json): once a model
 * has catalog.outcome_min_rounds (default 5) worker rounds, its record moves it within a tier:
 * many worker reports per merged change, a low first-report acceptance, failed tool calls,
 * timeout/overload turns and "continue" messages add up to 8 cost points (a tier is 10, so a
 * record reorders models but never overrides the tier rules); a clean record earns -1.
 * catalog.outcome_weight scales it (0 = off).
 *
 * The decision is PURE (routeWorker) and reads a usage snapshot from disk. The snapshot
 * is refreshed asynchronously (--refresh-usage, started by the watcher at most every 5 min),
 * so a launch never waits on the network and never fails because telemetry is missing.
 *
 *   node scripts/route-worker.mjs CHANGE-0002            explain the decision
 *   node scripts/route-worker.mjs CHANGE-0002 --json
 *   node scripts/route-worker.mjs --refresh-usage        refresh .pi-session/routing/usage.json
 *   node scripts/route-worker.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSecret } from "./secrets.mjs";
import { julesUsage, julesReady } from "./jules-worker.mjs";
import { priceFor, scoresFor, loadPricing, DEFAULT_PLANS, pricingIsOld, refreshPricing } from "./plan-pricing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TIER_NAMES = { 1: "local", 2: "free/cheap cloud", 3: "strong", 4: "frontier" };
const SIZE_TIER = { S: 1, M: 2, L: 3, XL: 4 };
// Rough worker wall-clock per size, for "will this quota last the change?" (catalog.change_hours overrides).
// Owner (2026-10-17): low/medium-risk work without visuals starts on FREE models, L included;
// it moves up a tier only when it struggles (2 change requests / failed qualifications).
export const DEFAULT_MIN_TIER_BY_RISK = { low: { L: 2 }, medium: { L: 2 } };
export const DEFAULT_FREE_FIRST = { risks: ["low", "medium"], sizes: ["S", "M", "L"], bonus: 4 };
export const CHANGE_HOURS = { S: 1, M: 3, L: 8, XL: 16 };
// Rough tokens a worker burns per size (all tokens incl. cache reads, as pi records them);
// catalog.change_tokens overrides. Used with the plan's monthly allowance (Real API Pricing).
export const CHANGE_TOKENS = { S: 5e6, M: 20e6, L: 60e6, XL: 150e6 };
// $/Mtok -> cost points: 0.0005 -> 0, 0.005 -> 3, 0.05 -> 6, 0.5+ -> 9 (log scale, like the price spread).
export const pricePoints = (usd) => Math.min(9, Math.max(0, Math.log10(Math.max(usd, 0.0005) / 0.0005) * 3));
const COST_RANK = { local: 0, free: 1, sub: 2, metered: 3 };
export const USAGE_MAX_AGE_MS = 2 * 60 * 1000; // the watcher's heartbeat runs every 2 min
const USAGE_STALE_MS = 6 * 60 * 60 * 1000; // older than this: treated as unknown

// ---------------------------------------------------------------------------
// change.yaml - just the bits routing needs (no yaml dependency on the host)
// ---------------------------------------------------------------------------
export function readRoutingFacts(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const facts = {
		title: "", type: "", risk: { tier: null, reviewer_required: false, touches: [] },
		owned_paths: [], requirements: [], test_cases: 0, affected_modules: 0, depends_on: 0,
		routing: {},
	};
	let section = null;
	let sub = null;
	const scalar = (s) => { s = String(s ?? "").trim().replace(/\s+#.*$/, ""); return s.replace(/^(["'])(.*)\1$/, "$2"); };
	for (const raw of lines) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const top = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
		if (top) {
			section = top[1]; sub = null;
			const v = scalar(top[2]);
			if (section === "title") facts.title = v;
			if (section === "type") facts.type = v.toLowerCase();
			if (section === "depends_on" && /^\[.+\]$/.test(v)) facts.depends_on = v.slice(1, -1).split(",").filter((x) => x.trim()).length;
			if (section === "affected_modules" && /^\[.+\]$/.test(v)) facts.affected_modules = v.slice(1, -1).split(",").filter((x) => x.trim()).length;
			continue;
		}
		const item = raw.match(/^\s+-\s+(.*)$/);
		const kv = raw.match(/^(\s+)([a-zA-Z_]\w*):\s*(.*)$/);
		if (section === "owned_paths" && item) facts.owned_paths.push(scalar(item[1]));
		else if (section === "requirements") {
			if (item) facts.requirements.push(item[1]);
			else if (kv && facts.requirements.length) facts.requirements[facts.requirements.length - 1] += " " + kv[3];
		} else if (section === "depends_on" && item) facts.depends_on += 1;
		else if (section === "affected_modules" && item) facts.affected_modules += 1;
		else if (section === "tests") {
			if (kv && kv[1].length <= 2) sub = kv[2];
			if (sub === "cases" && (item || /^\s+-\s*\{/.test(raw))) facts.test_cases += 1;
		} else if (section === "risk" && kv) {
			const v = scalar(kv[3]);
			if (kv[2] === "tier") facts.risk.tier = v.toLowerCase() || null;
			else if (kv[2] === "reviewer_required") facts.risk.reviewer_required = v === "true";
			else if (/^touches_/.test(kv[2]) && v === "true") facts.risk.touches.push(kv[2].slice(8));
		} else if (section === "routing" && kv) {
			const v = scalar(kv[3]);
			if (kv[2] === "complexity") facts.routing.complexity = v.toUpperCase();
			else if (kv[2] === "visual") facts.routing.visual = v === "true";
			else if (kv[2] === "min_tier") facts.routing.min_tier = Number(v) || undefined;
			else if (kv[2] === "model") facts.routing.model = v || undefined;
			else if (kv[2] === "backend") facts.routing.backend = v || undefined;
			else if (kv[2] === "reason") facts.routing.reason = v;
		}
	}
	return facts;
}

// Visual work: the owner's rule is that graphics need a strong model.
const VISUAL_PATH_RE = /\.(svg|css|scss|sass|less|canvas|png|jpe?g|webp|gif|tscn|tres|gdshader|shader|glsl|frag|vert)$|(^|\/)(sprites?|icons?|art|graphics|illustrations?|ui|themes?|styles?|assets|shaders?|animations?)(\/|$)/i;
const VISUAL_TEXT_RE = /\b(svg|css|canvas|sprite|sprites|icon|icons|illustration|illustrations|animation|animations|graphic|graphics|visual|shader|shaders|layout|ui art|pixel art|tegning|grafikk|ikon|animasjon)\b/i;

export function detectVisual(facts) {
	if (typeof facts.routing?.visual === "boolean") return { visual: facts.routing.visual, why: "integrator set routing.visual" };
	const path = facts.owned_paths.find((p) => VISUAL_PATH_RE.test(p));
	if (path) return { visual: true, why: `owned path ${path}` };
	const text = [facts.title, ...facts.requirements].join(" ");
	const m = text.match(VISUAL_TEXT_RE);
	if (m) return { visual: true, why: `"${m[0]}" in title/requirements` };
	return { visual: false, why: "no visual paths or wording" };
}

/** Points table -> S/M/L/XL. Transparent on purpose: every point has a reason. */
export function scoreDifficulty(facts, { planRounds = 0 } = {}) {
	const reasons = [];
	let pts = 0;
	const add = (n, why) => { if (n) { pts += n; reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`); } };
	const tier = facts.risk.tier || "medium";
	add({ low: 0, medium: 2, high: 5, critical: 8 }[tier] ?? 2, `risk ${tier}`);
	add(facts.risk.touches.length * 2, facts.risk.touches.length ? `touches ${facts.risk.touches.join(", ")}` : "");
	add(facts.risk.reviewer_required ? 1 : 0, "reviewer required");
	const n = facts.owned_paths.length;
	add(n > 8 ? 2 : n > 3 ? 1 : 0, `${n} owned paths`);
	const r = facts.requirements.length;
	add(r > 10 ? 2 : r > 5 ? 1 : 0, `${r} requirements`);
	add(facts.test_cases > 8 ? 1 : 0, `${facts.test_cases} test cases`);
	add(facts.depends_on > 0 ? 1 : 0, `${facts.depends_on} dependencies`);
	add(planRounds > 5 ? 2 : planRounds > 2 ? 1 : 0, `${planRounds} plan rounds`);
	add(/^(docs?|documentation|chore)$/.test(facts.type) ? -1 : 0, `type ${facts.type}`);
	const size = pts <= 2 ? "S" : pts <= 5 ? "M" : pts <= 8 ? "L" : "XL";
	return { points: pts, size, reasons };
}

/**
 * Escalation from the change's own history: one tier up per TWO quality failures
 * (impl-changes-requested, qualification-failed). A worker that blocks or asks is waiting
 * for a decision, not writing bad code, so blocks never escalate (owner, 2026-10-16).
 */
export function escalationFrom(entries = []) {
	const changesRequested = entries.filter((e) => e.verdict === "impl-changes-requested").length;
	const qualFailed = entries.filter((e) => e.verdict === "qualification-failed").length;
	const levels = Math.floor((changesRequested + qualFailed) / 2);
	const why = [];
	if (changesRequested) why.push(`${changesRequested}x impl-changes-requested`);
	if (qualFailed) why.push(`${qualFailed}x qualification-failed`);
	return { levels, why: levels ? why : [] };
}

// ---------------------------------------------------------------------------
// capacity / health checks against a usage snapshot
// ---------------------------------------------------------------------------
function quotaState(q, now) {
	if (!q) return { known: false };
	if (q.resetsAt && q.resetsAt < now) return { known: true, usedPct: 0, reset: true }; // window already reset
	if (q.t && now - q.t > USAGE_STALE_MS) return { known: false, stale: true };
	return { known: true, usedPct: q.usedPct ?? null, remaining: q.remaining ?? null, resetsAt: q.resetsAt ?? null };
}

export function checkModel(m, usage, { now = Date.now(), floorPct = 15, visual = false, hours = null, designScore = null, visualMinDesign = 85, price = null, needTokens = null } = {}) {
	// Visual work: catalog visual:true, or an Open Design Arena score at/above the bar.
	if (visual && !m.visual && !(designScore != null && designScore >= visualMinDesign)) return { ok: false, why: designScore != null ? `Open Design Arena ${designScore} < ${visualMinDesign} (visual work)` : "not marked visual-capable" };
	if (m.cost === "local") {
		const up = usage?.local?.up;
		if (!up) return { ok: false, why: usage?.local ? `local server down (${usage.local.error ?? "no answer"})` : "local server not probed" };
		const want = (m.model || m.id).replace(/^local\//, "").toLowerCase().replace(/[^a-z0-9]/g, "");
		const served = (usage.local.models ?? []).map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
		if (served.length && !served.some((s) => s.includes(want) || want.includes(s))) return { ok: false, why: "local server does not serve it" };
	}
	const br = m.health_match ? usage?.breakers?.[m.health_match] : null;
	if (br && br.events >= (br.threshold ?? 6)) return { ok: false, why: `breaker open: ${br.events} overload errors in the last hour` };
	let scarcity = 0, unknown = 0, bonus = 0;
	const notes = [];
	for (const key of m.quotas ?? []) {
		const st = quotaState(usage?.quotas?.[key], now);
		if (!st.known) { unknown += 1; continue; }
		if (st.remaining != null && st.minRemaining != null && st.remaining < st.minRemaining) return { ok: false, why: `${key}: ${st.remaining} left` };
		if (key === "openrouter_free" && st.remaining != null && st.remaining < 100) return { ok: false, why: `only ${st.remaining} free OpenRouter requests left today` };
		if (st.usedPct != null) {
			if (100 - st.usedPct < floorPct) return { ok: false, quota: true, resetsAt: st.resetsAt ?? null, why: `${key} ${Math.round(st.usedPct)}% used (floor ${floorPct}% left)` };
			scarcity = Math.max(scarcity, st.usedPct / 100);
			notes.push(`${key} ${Math.round(st.usedPct)}%`);
			// Run-out projection (usage history): will this window last as long as the change?
			const proj = usage?.projections?.[key];
			if (hours && proj?.beforeReset && proj.runOutAt) {
				const until = now + hours * 3600e3;
				const end = st.resetsAt ? Math.min(until, st.resetsAt) : until;
				if (proj.runOutAt < end) {
					const inH = Math.max(0, (proj.runOutAt - now) / 3600e3);
					if (/_5h$/.test(key)) { scarcity += 0.5; notes.push(`${key} runs out in ${inH.toFixed(1)}h at current pace`); }
					else return { ok: false, quota: true, resetsAt: st.resetsAt ?? null, why: `${key} projected to run out in ${inH < 48 ? inH.toFixed(1) + "h" : Math.round(inH / 24) + "d"} - before this ${hours}h change would finish` };
				}
			}
			// use it or lose it: a weekly window with plenty left that resets within ~36h
			if (/weekly/.test(key) && st.resetsAt && st.resetsAt - now < 36 * 3600e3 && st.usedPct < 60) { bonus = 1; notes.push(`${key} resets soon - use it`); }
		}
	}
	// Token budget: the plan's allowance for THIS model (Real API Pricing) x what is left of the window.
	if (needTokens && price?.monthly_tokens) {
		for (const key of m.quotas ?? []) {
			const st = quotaState(usage?.quotas?.[key], now);
			if (!st.known || st.usedPct == null || /_5h$/.test(key)) continue;
			const windowTokens = /_monthly$/.test(key) ? price.monthly_tokens : price.monthly_tokens / 4;
			const left = windowTokens * (100 - st.usedPct) / 100;
			if (left < needTokens) return { ok: false, why: `~${Math.round(left / 1e6)}M tokens left on ${price.plan ?? "the plan"} (${key}) - a change this size needs ~${Math.round(needTokens / 1e6)}M` };
			notes.push(`~${Math.round(left / 1e6)}M tok left`);
		}
	}
	if (unknown && !notes.length) scarcity = 0.4; // nothing known: neither cheap nor scarce
	return { ok: true, scarcity, bonus, why: notes.join(", ") || (unknown ? "usage unknown" : "") };
}

// ---------------------------------------------------------------------------
// the decision (pure)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Backend per model (owner, 2026-10-16: "opencode before pi"). A catalog entry may list
// several agent tools that can run it ("backends": ["opencode", "pi"]); the router takes the
// first one that pipeline.auto_backends allows AND whose login covers the model's provider,
// in catalog.backend_priority order, and adds catalog.backend_weight[backend] to its cost.
// ---------------------------------------------------------------------------
export const DEFAULT_BACKEND_PRIORITY = ["opencode", "pi", "codex", "claude", "antigravity"];
export const DEFAULT_BACKEND_WEIGHT = { opencode: -1.5 };
export function chooseBackend(m, { catalog = {}, allowed = null, logins = {} } = {}) {
	const list = m.backends ?? [m.backend ?? "pi"];
	const prio = catalog.backend_priority ?? DEFAULT_BACKEND_PRIORITY;
	const order = [...list].sort((a, b) => (prio.indexOf(a) + 1 || 99) - (prio.indexOf(b) + 1 || 99));
	const why = [];
	for (const b of order) {
		if (allowed && !allowed.includes(b)) { why.push(`${b} not in pipeline auto_backends`); continue; }
		const model = b === "opencode" ? (m.opencode_model ?? m.id) : b === "pi" ? (m.pi_model ?? (m.backend === "pi" || !m.backend ? m.id : null)) : (m.model ?? null);
		if (b === "pi" && !model) { why.push("no pi model id"); continue; }
		const provider = String(model ?? m.id).split("/")[0];
		if (logins[b] === false) { why.push(`${b} is not logged in (run its login once in a harness container)`); continue; }
		const have = logins[b]; // Set of providers this backend's login covers, or null = unknown
		if (have && provider && !["local"].includes(provider) && !have.has(provider) && !(m.cost === "free" && b === "opencode" && provider === "opencode")) { why.push(`no ${provider} login for ${b}`); continue; }
		return { ok: true, backend: b, model, weight: (catalog.backend_weight ?? DEFAULT_BACKEND_WEIGHT)[b] ?? 0 };
	}
	return { ok: false, why: why.join("; ") || "no usable backend" };
}

/** The model's record in outcomes.json (by id, then by a loose match). */
export function outcomeFor(m, outcomes) {
	const list = outcomes?.models ?? [];
	const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9/]/g, "");
	return list.find((g) => g.model === m.id) ?? list.find((g) => norm(g.model) === norm(m.id)) ?? null;
}

/** Cost points from a model's track record. 0 until it has enough rounds. */
export function outcomePenalty(g, { minRounds = 5, weight = 1 } = {}) {
	if (!g || !weight || (g.rounds ?? 0) < minRounds) return { points: 0, why: g ? `record: ${g.rounds} round(s), too few to judge` : "" };
	const parts = [];
	let pts = 0;
	const add = (p, label) => { if (p > 0.05) { pts += p; parts.push(label); } };
	const rpm = g.reportsPerMerged ?? (g.merged ? null : g.rounds); // nothing merged yet: every round was rework
	if (rpm != null) add(Math.min(5, Math.max(0, (rpm - 1.5) * 1.5)), `${rpm} reports/merge`);
	if (g.firstPassPct != null) add(Math.min(2, Math.max(0, (60 - g.firstPassPct) / 20)), `${g.firstPassPct}% first-pass`);
	if (g.toolErrorsPer100 != null) add(Math.min(2, Math.max(0, (g.toolErrorsPer100 - 8) / 4)), `${g.toolErrorsPer100}% tool errors`);
	if (g.errorTurnsPer100 != null) add(Math.min(2, Math.max(0, (g.errorTurnsPer100 - 10) / 10)), `${g.errorTurnsPer100}% timeout turns`);
	if (g.continuesPerRound != null) add(Math.min(2, Math.max(0, g.continuesPerRound - 1)), `${g.continuesPerRound} continues/round`);
	pts = Math.min(8, pts);
	if (!pts && (g.reportsPerMerged ?? 9) <= 1.3 && (g.firstPassPct ?? 0) >= 80) return { points: -1 * weight, why: `good record over ${g.rounds} rounds` };
	return { points: Math.round(pts * weight * 100) / 100, why: pts ? `record +${(pts * weight).toFixed(1)} (${parts.join(", ")})` : `record clean over ${g.rounds} rounds` };
}

/** How hard the agent should think (owner 2026-10-20): medium for ordinary work, high for big, risky, visual or struggling work. */
export function effortFor({ size, risk, visual = false, escalated = 0 }) {
	return size === "L" || size === "XL" || risk === "high" || visual || escalated ? "high" : "medium";
}

/** A model's score on the harness's own fixed benchmark (scripts/model-bench.mjs), if it ran. */
export function benchFor(m, bench) {
	const r = bench?.results?.[m.id];
	return r && r.total ? r : null;
}

export function routeWorker({ facts, entries = [], planRounds = 0, catalog, usage = {}, pricing = null, allowedBackends = null, logins = {}, outcomes = null, limits = [], bench = null, now = Date.now() }) {
	const risk = facts.risk.tier || "medium";
	const difficulty = scoreDifficulty(facts, { planRounds });
	const hint = facts.routing ?? {};
	const size = SIZE_TIER[hint.complexity] ? hint.complexity : difficulty.size;
	const vis = detectVisual(facts);
	const esc = escalationFrom(entries);
	const reasons = [`size ${size}${SIZE_TIER[hint.complexity] ? " (integrator)" : ` (${difficulty.points} pts)`}`];

	// Pinned in change.yaml (routing.model [+ routing.backend]): the owner's explicit choice wins
	// over tiers, cost and quota. Backend: the pin, else the catalog entry's backends (opencode
	// first), else inferred from the provider (opencode, opencode-go -> opencode; otherwise pi).
	if (hint.model && risk !== "critical") {
		const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9/]/g, "");
		const entry = (catalog.models ?? []).find((m) => m.id === hint.model) ?? (catalog.models ?? []).find((m) => norm(m.id) === norm(hint.model));
		let backend = hint.backend ?? null, model = hint.model;
		if (!backend && entry) { const be = chooseBackend(entry, { catalog, allowed: allowedBackends, logins }); if (be.ok) { backend = be.backend; model = be.model ?? model; } }
		if (!backend) backend = ["opencode", "opencode-go"].includes(String(hint.model).split("/")[0]) ? "opencode" : (entry?.backend ?? "pi");
		if (entry && backend !== "pi" && backend !== "opencode" && entry.model) model = entry.model;
		const warn = allowedBackends && !allowedBackends.includes(backend) ? ` (note: ${backend} is not in pipeline auto_backends - launching anyway because it is pinned)` : "";
		return { escalateToHuman: false, pinned: true, size, risk, visual: vis, difficulty, escalation: esc, minTier: null,
			pick: { id: entry?.id ?? hint.model, backend, model, tier: entry?.tier ?? null, effort: effortFor({ size, risk, visual: vis.visual, escalated: esc.levels }) },
			reason: `${hint.model} via ${backend} - pinned in change.yaml (routing.model)${warn}`, candidates: [] };
	}
	// A backend-only owner request delegates model selection to that backend's configuration.
	if (hint.backend && !hint.model && risk !== "critical") {
		return { escalateToHuman: false, pinned: true, size, risk, visual: vis, difficulty, escalation: esc, minTier: null,
			pick: { id: `${hint.backend}/default`, backend: hint.backend, model: null, tier: null },
			reason: `${hint.backend} default model - owner-selected routing.backend`, candidates: [] };
	}
	if (risk === "critical") return { escalateToHuman: true, reason: "critical risk - a human launches the worker", size, risk, visual: vis, difficulty, escalation: esc, minTier: null, candidates: [] };

	let minTier = SIZE_TIER[size];
	// per-risk minimum by size (catalog.min_tier_by_risk; default: low/medium-risk L starts at tier 2).
	// It SETS the minimum, so it can lower it; high risk and visual work raise it again below.
	const byRisk = (catalog.min_tier_by_risk ?? DEFAULT_MIN_TIER_BY_RISK)[risk]?.[size];
	if (byRisk && byRisk !== minTier) { minTier = byRisk; reasons.push(`${risk} risk ${size} -> tier >= ${byRisk}`); }
	if (hint.min_tier) { minTier = Math.max(minTier, hint.min_tier); reasons.push(`integrator min_tier ${hint.min_tier}`); }
	if (risk === "high" && minTier < 3) { minTier = 3; reasons.push("high risk -> tier >= 3"); }
	if (vis.visual && minTier < 3) { minTier = 3; reasons.push("visual work -> strong visual model"); }
	if (esc.levels) { minTier = Math.min(4, minTier + esc.levels); reasons.push(`escalated +${esc.levels} (${esc.why.join(", ")})`); }

	const ff = catalog.free_first === false ? null : { ...DEFAULT_FREE_FIRST, ...(catalog.free_first ?? {}) };
	const freeFirst = ff && ff.risks.includes(risk) && ff.sizes.includes(size) && !vis.visual && !esc.levels ? ff : null;
	if (freeFirst) reasons.push("free models first");
	const floorPct = catalog.quota_floor_pct ?? 15;
	const plans = { ...DEFAULT_PLANS, ...(catalog.pricing_plans ?? {}) };
	const rank = (minTier) => (catalog.models ?? []).filter((m) => m.enabled !== false).map((m) => {
		// tier_for: a model can count as a higher tier for one kind of change only (owner: Gemini Flash for medium-risk M)
		const tier = m.tier_for?.[`${risk}:${size}`] ?? m.tier;
		if (tier < minTier) return { id: m.id, tier: m.tier, ok: false, why: `tier ${m.tier} < ${minTier}` };
		const be = chooseBackend(m, { catalog, allowed: allowedBackends, logins });
		if (!be.ok) return { id: m.id, tier: m.tier, ok: false, why: be.why };
		// an agent that stopped on its usage limit (limits.json, written when a pane shows it) is out until reset
		const hit = limits.find((l) => (!l.until || l.until > now) && l.backend === be.backend && (!l.model || l.model === m.id));
		if (hit) return { id: m.id, tier: m.tier, ok: false, quota: true, resetsAt: hit.until ?? null, why: `${be.backend} hit its ${hit.kind ?? "limit"}${hit.until ? ` until ${new Date(hit.until).toISOString().slice(11, 16)} UTC` : ""}` };
		const price = pricing ? priceFor(m, pricing, plans) : null;
		const design = pricing ? scoresFor(m, pricing.rows ?? [])?.open_design_arena?.score ?? null : null;
		const c = checkModel(m, usage, { now, floorPct, visual: vis.visual, hours: (catalog.change_hours ?? CHANGE_HOURS)[size] ?? null,
			designScore: design, visualMinDesign: catalog.visual_min_design ?? 85, price, needTokens: (catalog.change_tokens ?? CHANGE_TOKENS)[size] ?? null });
		if (!c.ok) return { id: m.id, tier: m.tier, ok: false, why: c.why, price: price?.usd_per_mtok ?? null, quota: !!c.quota, resetsAt: c.resetsAt ?? null };
		// lower is better: stay as close to the minimum tier as possible, then cheapest per token
		// (real $/Mtok on the plan you use it through, Real API Pricing; buckets when unknown),
		// then least scarce. Free endpoints get +1.5 over local/plan-covered: rate limits, flakiness.
		// free first (owner): low/medium risk, no visuals, not struggling -> free/local models lead
		const isFree = m.cost === "free" || m.cost === "local";
		const costPts = (price ? pricePoints(price.usd_per_mtok) + (m.cost === "free" && !freeFirst ? 1.5 : 0) : (COST_RANK[m.cost] ?? 3) * 3) - (freeFirst && isFree ? freeFirst.bonus ?? 4 : 0);
		let rec = outcomePenalty(outcomeFor(m, outcomes), { minRounds: catalog.outcome_min_rounds ?? 5, weight: catalog.outcome_weight ?? 1 });
		// no real track record yet: the fixed benchmark is the prior (pass rate below 60% +4, perfect -1)
		const bs = benchFor(m, bench);
		if (bs && !/^record [+c]|good record/.test(rec.why)) {
			const rate = bs.passed / bs.total;
			const pts = rate < 0.6 ? 4 : rate < 1 ? (1 - rate) * 5 : -1;
			rec = { points: rec.points + pts, why: [rec.why, `benchmark ${bs.passed}/${bs.total}${bs.seconds ? " in " + Math.round(bs.seconds) + "s" : ""}`].filter(Boolean).join(", ") };
		}
		// visual work: models trusted by the owner (visual:true - Opus, Astra) come first; a model that only
		// qualifies by its design score is the fallback when those are out of quota
		const visualPenalty = vis.visual && !m.visual ? (catalog.visual_fallback_penalty ?? 12) : 0;
		const cost = (Math.max(0, tier - minTier)) * 10 + visualPenalty + costPts + c.scarcity * 4 - c.bonus * 3 + (m.preference ?? 0) + be.weight + rec.points;
		const priceNote = price && price.usd_per_mtok > 0 ? `$${price.usd_per_mtok < 0.01 ? price.usd_per_mtok.toFixed(4) : price.usd_per_mtok.toFixed(3)}/Mtok${price.source === "plan" ? ` on ${price.plan}` : " list"}` : "";
		return { id: m.id, tier: m.tier, ok: true, cost: Math.round(cost * 100) / 100, why: [`via ${be.backend}`, priceNote, c.why, rec.why].filter(Boolean).join(", "), record: rec.points, price: price?.usd_per_mtok ?? null, model: m, backend: be.backend, launchModel: be.model };
	}).sort((a, b) => (b.ok - a.ok) || (a.cost ?? 99) - (b.cost ?? 99));

	let candidates = rank(minTier);
	let pick = candidates.find((c) => c.ok);
	if (!pick) {
		// Nothing at the wanted tier (owner 2026-10-18: give the work to ANOTHER agent rather than pause).
		// 1) the strongest model that IS available, never below the hard floor
		//    (high risk and visual work: tier 3, as the owner decided; otherwise tier 1).
		const floor = risk === "high" || vis.visual ? 3 : 1;
		const wanted = candidates;
		for (let t = minTier - 1; t >= floor && !pick; t--) {
			const c2 = rank(t);
			const p2 = c2.filter((c) => c.ok && c.tier === Math.max(...c2.filter((x) => x.ok).map((x) => x.tier)))[0];
			if (p2) { pick = p2; candidates = c2; reasons.push(`fallback: nothing usable at tier ${minTier}, using the strongest available (tier ${p2.tier})`); }
		}
		// 2) no other agent at all -> wait for the quota that comes back first
		if (!pick) {
			const waitH = catalog.wait_for_reset_hours ?? 12;
			const soon = wanted.filter((c) => c.quota && c.resetsAt && c.resetsAt > now && c.resetsAt - now <= waitH * 3600e3).sort((x, y) => x.resetsAt - y.resetsAt)[0];
			if (soon) {
				return { escalateToHuman: false, wait: true, waitUntil: soon.resetsAt, size, risk, visual: vis, difficulty, escalation: esc, minTier, candidates: wanted.map(({ model, ...c }) => c),
					reason: `waiting ${((soon.resetsAt - now) / 3600e3).toFixed(1)}h for ${soon.id} (quota resets ${new Date(soon.resetsAt).toISOString().slice(11, 16)} UTC; no other agent can take it) - ${reasons.join("; ")}` };
			}
		}
	}
	if (!pick) return { escalateToHuman: true, reason: `no model clears tier >= ${minTier}${vis.visual ? " + visual" : ""} with capacity left - ${reasons.join("; ")}`, size, risk, visual: vis, difficulty, escalation: esc, minTier, candidates: candidates.map(({ model, ...c }) => c) };
	const m = pick.model;
	return {
		escalateToHuman: false, size, risk, visual: vis, difficulty, escalation: esc, minTier,
		pick: { id: m.id, backend: pick.backend, model: pick.launchModel ?? m.model ?? (pick.backend === "pi" ? m.id : null), tier: m.tier, effort: effortFor({ size, risk, visual: vis.visual, escalated: esc.levels }) },
		reason: `${m.id} via ${pick.backend} (tier ${m.tier}) - ${reasons.join("; ")}${pick.why ? `; ${pick.why}` : ""}`,
		candidates: candidates.map(({ model, ...c }) => c),
	};
}

// ---------------------------------------------------------------------------
// usage snapshot (async, host side) - every source optional
// ---------------------------------------------------------------------------
async function fetchJson(url, { headers = {}, ms = 5000 } = {}) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), ms);
	try {
		const r = await fetch(url, { headers, signal: ctl.signal });
		if (!r.ok) return { error: `HTTP ${r.status}` };
		return { json: await r.json() };
	} catch (e) { return { error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message) }; }
	finally { clearTimeout(t); }
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function openRouterKey() {
	if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
	{ const k = getSecret("openrouter"); if (k) return k; }
	const root = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
	for (const p of [join(root, "pi", ".pi", "agent", "auth.json"), join(homedir(), ".pi", "agent", "auth.json")]) {
		const a = readJson(p)?.openrouter;
		const k = a?.key ?? a?.apiKey ?? a?.api_key ?? (typeof a === "string" ? a : null);
		if (k) return k;
	}
	return null;
}

/** OpenRouter GET /api/v1/key: free-model requests left today + credit left. */
export function openRouterQuotas(data, t) {
	const out = {};
	const f = data?.free_model_daily_requests;
	if (f && typeof f.remaining === "number") out.openrouter_free = { t, remaining: f.remaining, limit: f.limit, usedPct: f.limit ? (100 * (f.used ?? f.limit - f.remaining)) / f.limit : null };
	if (typeof data?.limit_remaining === "number") out.openrouter_usd = { t, remaining: data.limit_remaining, usedPct: data.limit ? 100 * (1 - data.limit_remaining / data.limit) : null };
	return out;
}

/** chatgpt.com/backend-api/wham/usage -> codex_5h / codex_weekly (primary = 5h, secondary = weekly). */
export function codexWham(j, t = Date.now()) {
	const out = {};
	const win = (w) => w && typeof w.used_percent === "number" ? { t, usedPct: w.used_percent, resetsAt: w.reset_at ? (w.reset_at > 1e12 ? w.reset_at : w.reset_at * 1000) : w.reset_after_seconds != null ? t + w.reset_after_seconds * 1000 : null } : null;
	const p = win(j?.rate_limit?.primary_window), s = win(j?.rate_limit?.secondary_window);
	if (p) out.codex_5h = p;
	if (s) out.codex_weekly = s;
	return out;
}

/** Host side: the Codex (ChatGPT) login pi saved, used READ-ONLY and only while its
 * access token is still valid (pi itself refreshes it; this never writes auth.json). */
async function codexFromPiLogin() {
	const root = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
	for (const p of [join(homedir(), ".pi", "agent", "auth.json"), join(root, "pi", ".pi", "agent", "auth.json")]) {
		const a = readJson(p)?.["openai-codex"];
		const token = a?.access;
		if (!token) continue;
		if (a.expires && Number(a.expires) < Date.now() + 60e3) return { error: "pi's Codex login token expired - it refreshes on the next pi use" };
		let accountId = a.accountId;
		try { accountId ??= JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))?.["https://api.openai.com/auth"]?.chatgpt_account_id; } catch { /* below */ }
		if (!accountId) continue;
		const r = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers: { authorization: `Bearer ${token}`, "ChatGPT-Account-ID": accountId, accept: "application/json", originator: "pi" } });
		return r.json ? { quotas: codexWham(r.json), plan: r.json.plan_type } : { error: r.error };
	}
	return { error: "no openai-codex login in pi's auth.json" };
}

/** Newest Codex token_count event with rate_limits (primary = 5h, secondary = weekly). */
export function codexQuotasFromLines(lines) {
	let best = null;
	for (const line of lines) {
		if (!line.includes("rate_limits")) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		const rl = o?.payload?.rate_limits ?? o?.payload?.info?.rate_limits ?? o?.rate_limits;
		if (!rl) continue;
		const t = Date.parse(o.timestamp ?? "") || 0;
		if (!best || t >= best.t) best = { t, rl };
	}
	if (!best) return {};
	const win = (w) => w && typeof w.used_percent === "number" ? {
		t: best.t || Date.now(), usedPct: w.used_percent,
		resetsAt: w.resets_at ? (w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000) : w.resets_in_seconds != null ? (best.t || Date.now()) + w.resets_in_seconds * 1000 : null,
	} : null;
	const out = {};
	const p = win(best.rl.primary), s = win(best.rl.secondary);
	if (p) out.codex_5h = p;
	if (s) out.codex_weekly = s;
	return out;
}

// --- live reads with the agents' OWN logins (read-only: tokens are never refreshed or written) ---
const configRoot = () => process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
const jwtExp = (tok) => { try { return JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString("utf8")).exp * 1000; } catch { return null; } };

/** api.anthropic.com/api/oauth/usage -> claude_5h / claude_weekly (utilization is a percentage). Pure. */
export function claudeOAuthQuotas(j, t = Date.now()) {
	const out = {};
	const w = (x) => x && typeof x.utilization === "number" ? { t, usedPct: x.utilization, resetsAt: x.resets_at ? Date.parse(x.resets_at) || null : null, via: "claude oauth" } : null;
	const five = w(j?.five_hour), week = w(j?.seven_day);
	if (five) out.claude_5h = five;
	if (week) out.claude_weekly = week;
	return out;
}
function claudeOAuthToken() {
	for (const p of [join(configRoot(), "claude", "credentials.json"), join(homedir(), ".claude", ".credentials.json")]) {
		const o = readJson(p)?.claudeAiOauth;
		if (o?.accessToken) return { token: o.accessToken, expires: o.expiresAt ?? null, from: p };
	}
	if (process.platform === "darwin") {
		try {
			const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
			const o = JSON.parse(raw)?.claudeAiOauth;
			if (o?.accessToken) return { token: o.accessToken, expires: o.expiresAt ?? null, from: "macOS keychain" };
		} catch { /* not there / denied */ }
	}
	return null;
}
async function claudeFromOAuth() {
	const c = claudeOAuthToken();
	if (!c) return { error: "no Claude Code login found (harness claude/credentials.json, ~/.claude/.credentials.json or keychain)" };
	if (c.expires && c.expires < Date.now() + 60e3) return { error: "Claude login token expired - it refreshes the next time Claude Code runs" };
	const r = await fetchJson("https://api.anthropic.com/api/oauth/usage", { headers: { authorization: `Bearer ${c.token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" } });
	return r.json ? { quotas: claudeOAuthQuotas(r.json) } : { error: `oauth usage: ${r.error}` };
}
/** The Codex CLI's own login (the harness codex workers use it) -> the same wham/usage endpoint. */
async function codexFromCliAuth() {
	for (const p of [join(configRoot(), "codex", "auth.json"), join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")]) {
		const tk = readJson(p)?.tokens;
		const token = tk?.access_token;
		if (!token) continue;
		const exp = jwtExp(token);
		if (exp && exp < Date.now() + 60e3) return { error: "Codex CLI token expired - it refreshes on the next codex run" };
		const accountId = tk.account_id ?? (() => { try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))?.["https://api.openai.com/auth"]?.chatgpt_account_id; } catch { return null; } })();
		if (!accountId) continue;
		const r = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers: { authorization: `Bearer ${token}`, "ChatGPT-Account-ID": accountId, accept: "application/json", originator: "codex_cli_rs" } });
		return r.json ? { quotas: codexWham(r.json), plan: r.json.plan_type } : { error: r.error };
	}
	return { error: "no Codex CLI login (~/.harness/config/codex/auth.json)" };
}
// --- Gemini / Antigravity: the same calls the Antigravity CLI makes (as quota-cli does) ---
// The access token is refreshed IN MEMORY when expired; nothing is written back.
// Resolved: Cleartext Authentication Credentials in Source Code
const AGY_CLIENT = { id: getSecret("antigravity_client_id") ?? null /* the Antigravity CLI's installed-app client ID; not shipped here */, secret: getSecret("antigravity") ?? null /* the Antigravity CLI's installed-app secret; not shipped here */, base: "https://daily-cloudcode-pa.googleapis.com" };
/** retrieveUserQuotaSummary -> gemini_5h / gemini_weekly / agy3p_5h / agy3p_weekly (remainingFraction -> used %). Pure. */
export function antigravityQuotas(j, t = Date.now()) {
	const buckets = (j?.groups ?? []).flatMap((g) => g.buckets ?? []);
	const out = {};
	const map = { "gemini-5h": "gemini_5h", "gemini-weekly": "gemini_weekly", "3p-5h": "agy3p_5h", "3p-weekly": "agy3p_weekly" };
	for (const b of buckets) {
		// unknown buckets (e.g. gemini-argon-wtu-weekly) keep their own key instead of being dropped
		const key = map[b.bucketId] ?? (b.bucketId ? (/^gemini-/.test(b.bucketId) ? "" : "agy_") + String(b.bucketId).replace(/[^a-z0-9]+/gi, "_").toLowerCase() : null);
		const f = Number(b.remainingFraction);
		if (!key || !Number.isFinite(f)) continue;
		let r = b.resetTime ?? null;
		if (r != null) { const n = Number(r); r = Number.isFinite(n) && String(r).trim() !== "" ? (n > 1e12 ? n : n * 1000) : Date.parse(r) || null; }
		out[key] = { t, usedPct: Math.round((1 - f) * 1000) / 10, resetsAt: r, via: "antigravity login" };
	}
	return out;
}
function antigravityCreds(repoRoot = null) {
	const claim = (tok, k) => { try { return JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString("utf8"))[k]; } catch { return null; } };
	if (process.platform === "darwin") {
		try {
			let raw = execFileSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (raw.startsWith("go-keyring-base64:")) raw = Buffer.from(raw.slice(18), "base64").toString("utf8");
			const o = JSON.parse(raw);
			if (o?.token?.access_token) return { access: o.token.access_token, refresh: o.token.refresh_token ?? null, expires: o.token.expiry ? Date.parse(o.token.expiry) : null, client: claim(o.id_token, "aud"), from: "keychain" };
		} catch { /* not signed in on this Mac */ }
	}
	// the harness's own Antigravity containers keep the CLI's token file in their persisted session folder
	if (repoRoot) {
		const found = [];
		const scan = (base) => { try { for (const s of readdirSync(base)) { const f = join(base, s, "gemini-antigravity-cli", "antigravity-oauth-token"); if (existsSync(f)) found.push(f); } } catch { /* none */ } };
		scan(join(repoRoot, ".pi-session"));
		try { for (const w of readdirSync(join(repoRoot, ".worktrees"))) scan(join(repoRoot, ".worktrees", w, ".pi-session")); } catch { /* none */ }
		found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		for (const f of found) {
			const o = readJson(f);
			if (o?.token?.access_token) return { access: o.token.access_token, refresh: o.token.refresh_token ?? null, expires: o.token.expiry ? Date.parse(o.token.expiry) : null, client: claim(o.id_token, "aud"), from: "harness antigravity session" };
		}
	}
	for (const dir of [join(configRoot(), "antigravity"), join(configRoot(), "gemini"), join(homedir(), ".gemini")]) {
		const o = readJson(join(dir, "oauth_creds.json"));
		if (o?.access_token) return { access: o.access_token, refresh: o.refresh_token ?? null, expires: o.expiry_date ?? null, client: claim(o.id_token, "aud"), from: dir };
	}
	return null;
}
async function postJson(url, token, body, ms = 8000) {
	const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
	try {
		const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "*/*", "user-agent": `antigravity/1.20.5 ${process.platform === "darwin" ? "darwin" : "linux"}/${process.arch === "arm64" ? "arm64" : "amd64"}` }, body: JSON.stringify(body) });
		if (!r.ok) return { error: `HTTP ${r.status}` };
		const txt = await r.text(); return { json: txt.trim() ? JSON.parse(txt) : {} };
	} catch (e) { return { error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message) }; }
	finally { clearTimeout(t); }
}
async function antigravityFromLogin(repoRoot = null) {
	const c = antigravityCreds(repoRoot);
	if (!c) return { error: "no Antigravity login on this Mac (keychain 'gemini'/'antigravity' or ~/.gemini/oauth_creds.json)" };
	if (!AGY_CLIENT.id) return { error: "Antigravity client ID not configured - set ANTIGRAVITY_OAUTH_CLIENT_ID" };
	if (c.client && c.client !== AGY_CLIENT.id) return { error: `login belongs to another Google client (${String(c.client).slice(0, 12)}...) - not Antigravity` };
	let token = c.access;
	if (c.expires && c.expires < Date.now() + 60e3) {
		if (!c.refresh) return { error: "Antigravity token expired and no refresh token" };
		if (!AGY_CLIENT.secret) return { error: "Antigravity token expired - set ANTIGRAVITY_OAUTH_CLIENT_SECRET to refresh it in memory" };
		const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
		try {
			const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: AGY_CLIENT.id, client_secret: AGY_CLIENT.secret, refresh_token: c.refresh, grant_type: "refresh_token" }) });
			if (!r.ok) return { error: `token refresh HTTP ${r.status}` };
			token = (await r.json()).access_token;
		} catch (e) { return { error: `token refresh: ${e.message}` }; } finally { clearTimeout(tm); }
	}
	const plat = `${process.platform === "darwin" ? "DARWIN" : "LINUX"}_${process.arch === "arm64" ? "ARM64" : "AMD64"}`;
	const load = await postJson(`${AGY_CLIENT.base}/v1internal:loadCodeAssist`, token, { mode: "FULL_ELIGIBILITY_CHECK", metadata: { ideName: "antigravity", ideType: "ANTIGRAVITY", ideVersion: "1.20.5", pluginVersion: "harness", platform: plat, updateChannel: "stable", pluginType: "GEMINI" } });
	if (!load.json) return { error: `loadCodeAssist ${load.error}` };
	const pr = load.json.cloudaicompanionProject;
	const project = typeof pr === "string" ? pr : pr?.id ?? pr?.projectId;
	if (!project) return { error: "no Code Assist project on this account" };
	const fm = await postJson(`${AGY_CLIENT.base}/v1internal:fetchAvailableModels`, token, { project });   // quota is empty without this call
	const q = await postJson(`${AGY_CLIENT.base}/v1internal:retrieveUserQuotaSummary`, token, { project });
	if (!q.json) return { error: `retrieveUserQuotaSummary ${q.error}` };
	const ids = (q.json?.groups ?? []).flatMap((g) => (g.buckets ?? []).map((b) => `${b.bucketId}=${b.remainingFraction ?? "?"}`));
	const mq = antigravityModelQuotas(fm.json);
	return { quotas: { ...mq.quotas, ...antigravityQuotas(q.json) }, from: c.from, ids, models: mq.names };
}

/** fetchAvailableModels -> per-model quota (quotaInfo.remainingFraction/resetTime) as agy_model_<name>;
 *  the Gemini buckets are missing from retrieveUserQuotaSummary on some accounts. Pure. */
export function antigravityModelQuotas(j, t = Date.now()) {
	const quotas = {}, names = [];
	const models = j?.models ?? {};
	const entries = Array.isArray(models) ? models.map((m) => [m.name ?? m.id ?? m.model, m]) : Object.entries(models);
	for (const [name, m] of entries) {
		const qi = m?.quotaInfo;
		const f = Number(qi?.remainingFraction);
		if (!name) continue;
		names.push(`${name}=${Number.isFinite(f) ? f : "?"}`);
		if (!Number.isFinite(f)) continue;
		let r = qi.resetTime ?? null;
		if (r != null) { const n = Number(r); r = Number.isFinite(n) && String(r).trim() !== "" ? (n > 1e12 ? n : n * 1000) : Date.parse(r) || null; }
		quotas[`agy_model_${String(name).replace(/^models\//, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`] = { t, usedPct: Math.round((1 - f) * 1000) / 10, resetsAt: r, via: "antigravity login" };
	}
	return { quotas, names };
}

// --- OpenAI API (admin key): today's tokens against the data-sharing free allowance, and this month's cost ---
export const OPENAI_FREE = {
	big: { limit: 250000, models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"] },
	mini: { limit: 2500000, models: ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-mini", "gpt-5-nano", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o-mini", "o3-mini", "o4-mini"] },
};
/** "gpt-5.4-mini-2026-03-01" -> "mini"; longest listed name that prefixes the model wins. Pure. */
export function openaiFreeGroup(model) {
	let best = null, len = 0;
	for (const [g, { models }] of Object.entries(OPENAI_FREE)) for (const m of models) if ((model === m || String(model).startsWith(m + "-")) && m.length > len) { best = g; len = m.length; }
	return best;
}
/** usage/completions buckets (group_by model) + costs buckets -> quotas. Pure. */
export function openaiQuotas(usageJson, costsJson, t = Date.now(), monthBudget = null) {
	const tok = { big: 0, mini: 0 };
	for (const b of usageJson?.data ?? []) for (const r of b.results ?? []) { const g = openaiFreeGroup(r.model ?? ""); if (g) tok[g] += (r.input_tokens ?? 0) + (r.output_tokens ?? 0); }
	const d = new Date(t), reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
	const out = {};
	for (const g of Object.keys(OPENAI_FREE)) out[`openai_free_${g}`] = { t, used: tok[g], limit: OPENAI_FREE[g].limit, usedPct: Math.round((1000 * tok[g]) / OPENAI_FREE[g].limit) / 10, resetsAt: reset, via: "openai admin" };
	if (costsJson) {
		let usd = 0;
		for (const b of costsJson.data ?? []) for (const r of b.results ?? []) usd += Number(r.amount?.value ?? 0);
		out.openai_usd_month = { t, spent: Math.round(usd * 100) / 100, limit: monthBudget, usedPct: monthBudget ? Math.round((1000 * usd) / monthBudget) / 10 : null, resetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), via: "openai admin" };
	}
	return out;
}
async function openaiFromAdmin(repoRoot) {
	const key = getSecret("openai_metrics");
	if (!key) return { error: "no admin key (Keychain harness.openai_metrics)" };
	const now = new Date(), day = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000), month = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
	const h = { headers: { authorization: `Bearer ${key}` } };
	const u = await fetchJson(`https://api.openai.com/v1/organization/usage/completions?start_time=${day}&bucket_width=1d&group_by=model&limit=1`, h);
	if (!u.json) return { error: `usage ${u.error}` };
	const c = await fetchJson(`https://api.openai.com/v1/organization/costs?start_time=${month}&bucket_width=1d&limit=31`, h);
	let budget = null; try { budget = JSON.parse(readFileSync(join(repoRoot, "herdr-plugin", "art.config.json"), "utf8")).monthly_budget_usd?.openai ?? null; } catch { /* none */ }
	return { quotas: openaiQuotas(u.json, c.json ?? null, Date.now(), budget), costError: c.json ? null : c.error };
}

/** Keep the fresher reading per key. */
function mergeFresher(into, from, via) {
	for (const [k, v] of Object.entries(from ?? {})) if (!into[k] || (v.t ?? 0) >= (into[k].t ?? 0)) into[k] = via ? { ...v, via: v.via ?? via } : v;
}

/** Newest Codex token_count event with rate_limits (primary = 5h, secondary = weekly):
 *  ~/.codex/sessions AND the harness codex workers'/integrators' persisted session folders. */
function codexQuotas(repoRoot = null) {
	const files = [];
	const walk = (d, depth) => {
		let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of es) {
			const p = join(d, e.name);
			if (e.isDirectory() && depth > 0) walk(p, depth - 1);
			else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) { try { if (Date.now() - statSync(p).mtimeMs < 8 * 86400e3) files.push(p); } catch { /* gone */ } }
		}
	};
	if (repoRoot) {
		const dirs = [join(repoRoot, ".pi-session")];
		try { for (const w of readdirSync(join(repoRoot, ".worktrees"))) dirs.push(join(repoRoot, ".worktrees", w, ".pi-session")); } catch { /* none */ }
		for (const d of dirs) { try { for (const s of readdirSync(d)) { const cs = join(d, s, "codex-sessions"); if (existsSync(cs)) walk(cs, 4); } } catch { /* none */ } }
	}
	const base = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
	if (!existsSync(base) && !files.length) return {};
	const now = new Date();
	for (let d = 0; d < 8; d++) {
		const day = new Date(now.getTime() - d * 86400e3);
		const dir = join(base, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
		try { for (const f of readdirSync(dir)) if (/^rollout-.*\.jsonl(\.zst)?$/.test(f)) files.push(join(dir, f)); } catch { /* no day */ }
		if (files.length >= 5) break;
	}
	files.sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
	for (const f of files.slice(0, 5)) {
		let text = "";
		try { text = f.endsWith(".zst") ? execFileSync("zstd", ["-dc", f], { encoding: "utf8", maxBuffer: 256e6, stdio: ["ignore", "pipe", "ignore"] }) : readFileSync(f, "utf8"); } catch { continue; }
		const q = codexQuotasFromLines(text.split("\n"));
		if (Object.keys(q).length) return q;
	}
	return {};
}

/** Claude (statusline) + Gemini/Antigravity (quota_snapshot) from the evidence logs. */
export function evidenceQuotas(lines) {
	let claude = null, gem = null, codex = null;
	for (const line of lines) {
		if (!line.includes("_snapshot")) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (o.ev === "rate_limit_snapshot" && (!claude || o.t >= claude.t)) claude = o;
		if (o.ev === "quota_snapshot" && (!gem || o.t >= gem.t)) gem = o;
		if (o.ev === "codex_quota_snapshot" && (!codex || o.t >= codex.t)) codex = o;
	}
	const out = {};
	if (codex) Object.assign(out, codexWham({ rate_limit: { primary_window: codex.primary, secondary_window: codex.secondary } }, codex.t));
	if (claude?.five_hour_pct != null) out.claude_5h = { t: claude.t, usedPct: claude.five_hour_pct, resetsAt: claude.five_hour_resets_at ? claude.five_hour_resets_at * 1000 : null };
	if (claude?.seven_day_pct != null) out.claude_weekly = { t: claude.t, usedPct: claude.seven_day_pct, resetsAt: claude.seven_day_resets_at ? claude.seven_day_resets_at * 1000 : null };
	for (const [k, v] of Object.entries(gem?.quota ?? {})) {
		const key = k.replace(/^3p-/, "agy3p_").replace(/^gemini-/, "gemini_").replace(/-/g, "_").replace(/_5h$/, "_5h").replace(/_weekly$/, "_weekly");
		out[key] = { t: gem.t, usedPct: v.used_pct, resetsAt: Date.parse(v.reset_time ?? "") || null };
	}
	return out;
}

/** Overload storms per provider in the last hour (disconnect-recovery events in every evidence log). */
export function breakersFromLines(lines, catalog, now = Date.now()) {
	const matchers = [...new Set((catalog.models ?? []).map((m) => m.health_match).filter(Boolean))];
	const out = {};
	for (const key of matchers) out[key] = { events: 0, threshold: catalog.breaker_threshold ?? 6 };
	for (const line of lines) {
		if (!line.includes("disconnect_recovery")) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (!o.t || now - o.t > 3600e3 || !o.errorMessage) continue;
		if (!/deferred|fired|stall/.test(o.ev)) continue;
		for (const key of matchers) if (new RegExp(key, "i").test(o.errorMessage)) out[key].events += 1;
	}
	return out;
}

function evidenceFiles(repoRoot) {
	const out = [];
	const scan = (base) => { try { for (const d of readdirSync(base)) { const f = join(base, d, "evidence.jsonl"); if (existsSync(f)) out.push(f); } } catch { /* none */ } };
	scan(join(repoRoot, ".pi-session"));
	try { for (const wt of readdirSync(join(repoRoot, ".worktrees"))) scan(join(repoRoot, ".worktrees", wt, ".pi-session")); } catch { /* none */ }
	return out;
}
const tailLines = (f, bytes = 2e6) => { try { const s = readFileSync(f, "utf8"); return s.slice(Math.max(0, s.length - bytes)).split("\n"); } catch { return []; } };

function localBaseUrl(repoRoot) {
	let url = process.env.LOCAL_LLM_BASE_URL;
	if (!url) { try { url = (readFileSync(join(repoRoot, ".pi", "worker.env"), "utf8").match(/^LOCAL_LLM_BASE_URL=(.+)$/m) ?? [])[1]; } catch { /* none */ } }
	return String(url || "http://host.docker.internal:8001/v1").trim().replace(/^["']|["']$/g, "").replace("host.docker.internal", "127.0.0.1").replace(/\/+$/, "");
}

export async function refreshUsage(repoRoot, catalog) {
	const now = Date.now();
	const usage = { at: now, quotas: {}, sources: {} };
	const lines = evidenceFiles(repoRoot).flatMap((f) => tailLines(f));
	Object.assign(usage.quotas, evidenceQuotas(lines));
	usage.breakers = breakersFromLines(lines, catalog, now);
	try { const q = codexQuotas(repoRoot); mergeFresher(usage.quotas, q, "codex rollouts"); usage.sources.codex = Object.keys(q).length ? "codex cli rollouts" : "no rollout with rate_limits"; } catch (e) { usage.sources.codex = String(e.message); }
	if (usage.quotas.codex_5h || usage.quotas.codex_weekly) usage.sources.codex = usage.sources.codex === "codex cli rollouts" ? usage.sources.codex : "pi sessions (codex_quota_snapshot)";
	// live, with the agents' own logins (fresh every refresh, unlike the session evidence)
	try {
		const c = await claudeFromOAuth();
		if (c.quotas && Object.keys(c.quotas).length) { mergeFresher(usage.quotas, c.quotas); usage.sources.claude = "live (Claude Code login)"; }
		else usage.sources.claude = c.error;
	} catch (e) { usage.sources.claude = String(e.message); }
	try {
		const c = await antigravityFromLogin(repoRoot);
		if (c.quotas && Object.keys(c.quotas).length) { mergeFresher(usage.quotas, c.quotas); usage.sources.antigravity = `live (Antigravity login, ${c.from})`; usage.sources.antigravity_buckets = (c.ids ?? []).join(" "); usage.sources.antigravity_models = (c.models ?? []).join(" "); }
		else usage.sources.antigravity = c.error ?? "no quota buckets in the answer";
	} catch (e) { usage.sources.antigravity = String(e.message); }
	try {
		const c = await codexFromCliAuth();
		if (c.quotas && Object.keys(c.quotas).length) { mergeFresher(usage.quotas, Object.fromEntries(Object.entries(c.quotas).map(([k, v]) => [k, { ...v, via: "codex login" }]))); usage.sources.codex = `live (Codex CLI login, ${c.plan ?? "plan ?"})`; }
		else if (!usage.quotas.codex_5h) usage.sources.codex = c.error;
	} catch (e) { if (!usage.quotas.codex_5h) usage.sources.codex = String(e.message); }
	try {
		const c = await codexFromPiLogin();
		if (c.quotas && Object.keys(c.quotas).length) { mergeFresher(usage.quotas, c.quotas, "pi codex login"); if (!/^live/.test(usage.sources.codex ?? "")) usage.sources.codex = `pi Codex login (${c.plan ?? "plan ?"})`; }
		else if (!usage.quotas.codex_5h) usage.sources.codex = c.error ?? usage.sources.codex;
	} catch (e) { if (!usage.quotas.codex_5h) usage.sources.codex = String(e.message); }
	try {
		const qc = await quotaCliUsage();
		if (qc.quotas && Object.keys(qc.quotas).length) {
			// Live reads: newer than the evidence snapshots, but never overwrite a fresher pi Codex login read.
			for (const [k, v] of Object.entries(qc.quotas)) if (!(k.startsWith("codex_") && /pi Codex login/.test(usage.sources.codex ?? "")) && !/claude oauth|codex login|antigravity login/.test(usage.quotas[k]?.via ?? "")) usage.quotas[k] = v;
			usage.sources.quota_cli = `ok (${qc.providers.join(", ")})`;
			if (qc.quotas.claude_5h && !/^live/.test(usage.sources.claude ?? "")) usage.sources.claude = "quota-cli";
		} else usage.sources.quota_cli = qc.error ?? `no usable windows${qc.notes?.length ? ": " + qc.notes.join("; ") : ""}`;
	} catch (e) { usage.sources.quota_cli = String(e.message); }
	const goKey = opencodeGoKey();
	if (goKey) {
		const r = await fetchJson("https://opencode.ai/zen/go/v1/usage", { headers: { authorization: `Bearer ${goKey}`, accept: "application/json" } });
		if (r.json) { const q = opencodeGoQuotas(r.json, now); Object.assign(usage.quotas, q); usage.sources.opencode_go = Object.keys(q).length ? "ok" : "response had no usage windows (endpoint changed?)"; }
		else usage.sources.opencode_go = r.error === "HTTP 401" ? "key rejected" : r.error === "HTTP 403" ? "key has no OpenCode Go subscription" : r.error;
	} else usage.sources.opencode_go = "no key (OPENCODE_GO_API_KEY, ~/.harness/config/opencode-go.key, or pi's opencode-go login)";
	const key = openRouterKey();
	if (key) {
		const r = await fetchJson("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
		if (r.json?.data) { Object.assign(usage.quotas, openRouterQuotas(r.json.data, now)); usage.sources.openrouter = "ok"; } else usage.sources.openrouter = r.error ?? "unexpected response";
	} else usage.sources.openrouter = "no key (OPENROUTER_API_KEY or auth.json)";
	try {
		const o = await openaiFromAdmin(repoRoot);
		if (o.quotas) { Object.assign(usage.quotas, o.quotas); usage.sources.openai = o.costError ? `usage ok, costs ${o.costError}` : "ok (admin key)"; } else usage.sources.openai = o.error;
	} catch (e) { usage.sources.openai = String(e.message); }
	try { Object.assign(usage.quotas, julesUsage(repoRoot)); usage.sources.jules = julesReady(repoRoot) ? "ok (local session count)" : "not set up (key harness.jules + source in herdr-plugin/jules.json)"; } catch (e) { usage.sources.jules = String(e.message); }
	// readings no live source refreshed for a day (e.g. Gemini buckets that only came from worker logs) are marked stale
	for (const v of Object.values(usage.quotas)) if (v && v.t && now - v.t > 24 * 3600e3) v.stale = true;
	const lr = await fetchJson(`${localBaseUrl(repoRoot)}/models`, { ms: 2500 });
	usage.local = lr.json ? { up: true, models: (lr.json.data ?? lr.json.models ?? []).map((m) => m.id ?? m.key).filter(Boolean) } : { up: false, error: lr.error };
	try { usage.projections = appendHistoryAndProject(repoRoot, usage); } catch { usage.projections = {}; }
	try { if (pricingIsOld(repoRoot)) await refreshPricing(repoRoot); } catch { /* keeps the last good copy */ }
	// track record per worker model (the dashboard also refreshes it)
	try {
		const o = readJson(join(repoRoot, ".pi-session", "routing", "outcomes.json"));
		if (!o?.at || Date.now() - o.at > 10 * 60e3) await (await import("./model-outcomes.mjs")).computeOutcomes(repoRoot);
	} catch { /* keeps the last copy */ }
	const p = join(repoRoot, ".pi-session", "routing", "usage.json");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(usage, null, 2) + "\n");
	return usage;
}

// ---------------------------------------------------------------------------
// Usage history + run-out projection (idea from github.com/senna-lang/herdr-agent-usage, MIT).
// Each refresh appends {t, q: {key: usedPct}} to .pi-session/routing/usage-history.jsonl.
// Rate = growth inside the CURRENT window (points after the last drop = reset), over the
// last 90 min for 5h windows and the last 24h for longer ones. Long windows floor the
// elapsed time at 12h, so "5% in the first 10 minutes" does not project an absurd pace.
// ---------------------------------------------------------------------------
export function projectRunOut(points, current, now = Date.now(), kind = "weekly") {
	if (!current || typeof current.usedPct !== "number") return null;
	const lookback = kind === "5h" ? 90 * 60e3 : 24 * 3600e3;
	let pts = (points ?? []).filter((p) => typeof p.v === "number" && p.t <= now && now - p.t <= lookback).sort((a, b) => a.t - b.t);
	pts.push({ t: now, v: current.usedPct });
	for (let i = pts.length - 1; i > 0; i--) if (pts[i].v < pts[i - 1].v - 0.5) { pts = pts.slice(i); break; } // reset inside the lookback
	if (pts.length < 2) return null;
	const first = pts[0];
	const elapsedMin = (now - first.t) / 60e3;
	if (elapsedMin < 10) return null;
	const delta = current.usedPct - first.v;
	if (delta <= 0) return { ratePerHour: 0, runOutAt: null, beforeReset: false };
	const denomMin = kind === "5h" ? elapsedMin : Math.max(elapsedMin, 12 * 60);
	const ratePerMin = delta / denomMin;
	const runOutAt = now + ((100 - current.usedPct) / ratePerMin) * 60e3;
	return { ratePerHour: Math.round(ratePerMin * 60 * 100) / 100, runOutAt: Math.round(runOutAt), beforeReset: !current.resetsAt || runOutAt < current.resetsAt };
}

const HISTORY_MAX_LINES = 4000;
export function appendHistoryAndProject(repoRoot, usage) {
	const p = join(repoRoot, ".pi-session", "routing", "usage-history.jsonl");
	let lines = [];
	try { lines = readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { /* first run */ }
	const q = {};
	for (const [k, v] of Object.entries(usage.quotas ?? {})) if (/_(5h|weekly|monthly)$/.test(k) && typeof v.usedPct === "number") q[k] = Math.round(v.usedPct * 10) / 10;
	if (Object.keys(q).length) lines.push(JSON.stringify({ t: usage.at, q }));
	if (lines.length > HISTORY_MAX_LINES) lines = lines.slice(-Math.round(HISTORY_MAX_LINES * 0.75));
	try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.join("\n") + "\n"); } catch { /* best effort */ }
	const series = {};
	for (const l of lines.slice(0, -1)) { let o; try { o = JSON.parse(l); } catch { continue; } for (const [k, v] of Object.entries(o.q ?? {})) (series[k] ??= []).push({ t: o.t, v }); }
	const projections = {};
	for (const [k, v] of Object.entries(usage.quotas ?? {})) {
		const kind = k.endsWith("_5h") ? "5h" : /_(weekly|monthly)$/.test(k) ? "weekly" : null;
		if (!kind) continue;
		const pr = projectRunOut(series[k], v, usage.at, kind);
		if (pr) projections[k] = pr;
	}
	return projections;
}

// ---------------------------------------------------------------------------
// quota-cli (github.com/pinkpixel-dev/quota, Apache-2.0) - optional extra source.
// `quota-cli usage --json` reads Claude / Codex / Antigravity usage from the logins
// those CLIs already stored, strictly read-only. Used only when it is installed.
// Output: [{provider, accountLabel, windows: [{label, remainingPercent, resetAt}], note}]
// ---------------------------------------------------------------------------
const QUOTA_CLI_PROVIDER = { claude: "claude", "claude-code": "claude", anthropic: "claude", codex: "codex", antigravity: "gemini", agy: "gemini" };
function windowKind(label) {
	const l = String(label ?? "").toLowerCase();
	if (/^(wk|week|weekly|7d)$/.test(l) || /week|7.?day/.test(l)) return "weekly";
	const h = l.match(/^(\d+)\s*h/);
	if (h && Number(h[1]) <= 24) return "5h";
	if (/month|mo$/.test(l)) return "monthly";
	return null;
}
export function quotaCliQuotas(records, t = Date.now()) {
	const out = {};
	for (const r of Array.isArray(records) ? records : []) {
		const prefix = QUOTA_CLI_PROVIDER[String(r?.provider ?? "").toLowerCase()];
		if (!prefix) continue;
		for (const w of r.windows ?? []) {
			const kind = windowKind(w.label);
			if (!kind || typeof w.remainingPercent !== "number") continue;
			out[`${prefix}_${kind}`] = { t, usedPct: 100 - w.remainingPercent, resetsAt: w.resetAt ? (w.resetAt > 1e12 ? w.resetAt : w.resetAt * 1000) : null, via: "quota-cli" };
		}
	}
	return out;
}
function findQuotaCli() {
	if (process.env.QUOTA_CLI && existsSync(process.env.QUOTA_CLI)) return process.env.QUOTA_CLI;
	const dirs = [...String(process.env.PATH ?? "").split(":"), join(homedir(), ".cargo", "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	for (const d of dirs) { const f = join(d, "quota-cli"); if (d && existsSync(f)) return f; }
	return null;
}
async function quotaCliUsage() {
	const bin = findQuotaCli();
	if (!bin) return { error: "quota-cli not installed (optional: prebuilt binaries at github.com/pinkpixel-dev/quota/releases)" };
	return new Promise((res) => {
		execFile(bin, ["usage", "--json"], { timeout: 25000, maxBuffer: 4e6 }, (err, stdout, stderr) => {
			let json = null;
			try { json = JSON.parse(stdout || "null"); } catch { /* below */ }
			if (!Array.isArray(json)) return res({ error: (String(stderr || err?.message || "no output").split("\n")[0]).slice(0, 160) });
			res({ quotas: quotaCliQuotas(json), providers: json.map((r) => r.provider), notes: String(stderr || "").split("\n").filter(Boolean).slice(0, 4) });
		});
	});
}

// ---------------------------------------------------------------------------
// OpenCode Go (the $10/month plan): GET https://opencode.ai/zen/go/v1/usage with the
// Go API key -> usage.rolling / weekly / monthly {percent (used), resetsAt (ISO)}.
// Undocumented endpoint (same one the Quota app uses) - may need a fix if OpenCode changes it.
// An unused rolling window comes back as 0% with a placeholder reset ~5h out: no real reset.
// ---------------------------------------------------------------------------
export function opencodeGoQuotas(body, now = Date.now()) {
	const u = body?.usage;
	if (!u || typeof u !== "object") return {};
	const out = {};
	const win = (raw) => {
		if (!raw || typeof raw.percent !== "number") return null;
		return { t: now, usedPct: Math.max(0, Math.min(100, raw.percent)), resetsAt: Date.parse(raw.resetsAt ?? "") || null };
	};
	const r = win(u.rolling), w = win(u.weekly), m = win(u.monthly);
	if (r) { if (r.usedPct === 0 && r.resetsAt && r.resetsAt - now >= 5 * 3600e3 - 120e3) r.resetsAt = null; out.opencodego_5h = r; }
	if (w) out.opencodego_weekly = w;
	if (m) out.opencodego_monthly = m;
	return out;
}
function opencodeGoKey() {
	if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY.trim();
	{ const k = getSecret("opencode"); if (k) return k.trim(); }
	const root = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
	try { const k = readFileSync(join(root, "opencode-go.key"), "utf8").trim(); if (k) return k; } catch { /* next */ }
	for (const p of [join(root, "pi", ".pi", "agent", "auth.json"), join(homedir(), ".pi", "agent", "auth.json")]) {
		const a = readJson(p)?.["opencode-go"];
		const k = a?.key ?? a?.apiKey ?? a?.api_key ?? (typeof a === "string" ? a : null);
		if (k) return k;
	}
	return null;
}

// ---------------------------------------------------------------------------
// glue used by the watcher and the CLI
// ---------------------------------------------------------------------------
export function loadCatalog(repoRoot) {
	for (const p of [join(repoRoot, "herdr-plugin", "models.catalog.json"), join(HERE, "..", "herdr-plugin", "models.catalog.json")]) {
		const c = readJson(p);
		if (c) return c;
	}
	return { models: [] };
}
export function loadUsage(repoRoot) { return readJson(join(repoRoot, ".pi-session", "routing", "usage.json")) ?? {}; }
export function usageIsOld(repoRoot, now = Date.now()) { const u = loadUsage(repoRoot); return !u.at || now - u.at > USAGE_MAX_AGE_MS; }

export function logDecision(repoRoot, rec) {
	try {
		const p = join(repoRoot, ".pi-session", "routing", "decisions.jsonl");
		mkdirSync(dirname(p), { recursive: true });
		appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
	} catch { /* best effort */ }
}

function findChangeYaml(repoRoot, change) {
	const roots = [repoRoot];
	try { for (const wt of readdirSync(join(repoRoot, ".worktrees"))) roots.push(join(repoRoot, ".worktrees", wt)); } catch { /* none */ }
	let best = null;
	for (const r of roots) {
		try {
			for (const d of readdirSync(join(r, "docs", "changes"))) {
				if (!d.toUpperCase().startsWith(change + "-") && d.toUpperCase() !== change) continue;
				const f = join(r, "docs", "changes", d, "change.yaml");
				if (existsSync(f) && (!best || statSync(f).mtimeMs > statSync(best).mtimeMs)) best = f;
			}
		} catch { /* none */ }
	}
	return best;
}

function ledgerEntries(repoRoot, change) {
	const files = [join(repoRoot, ".pi-session", "handoff", `${change}.jsonl`)];
	try { for (const wt of readdirSync(join(repoRoot, ".worktrees"))) files.push(join(repoRoot, ".worktrees", wt, ".pi-session", "handoff", `${change}.jsonl`)); } catch { /* none */ }
	return files.flatMap((f) => tailLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Which providers each backend's login covers (host side, read-only). null = could not tell. */
export function detectLogins(repoRoot) {
	const root = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
	const keys = (p) => { const j = readJson(p); return j && typeof j === "object" ? Object.keys(j).filter((k) => !k.startsWith("_")) : null; };
	const out = {};
	// pi: harness auth.json + providers declared in mounted models files (local, custom keys)
	const piAuth = keys(join(root, "pi", ".pi", "agent", "auth.json"));
	if (piAuth) {
		const set = new Set(piAuth);
		for (const f of [join(root, "pi", ".pi", "agent", "models.json"), join(repoRoot, "models.local.json"), join(repoRoot, "contracts", "models.json")]) {
			const j = readJson(f);
			for (const [k, v] of Object.entries(j?.providers ?? {})) if (k === "local" || (v?.apiKey && !/YOUR_API_KEY/.test(v.apiKey))) set.add(k);
		}
		out.pi = set;
	} else out.pi = null;
	// opencode: OPENCODE_CONFIG_DIR (env or .pi/worker.env) / auth.json
	let ocDir = process.env.OPENCODE_CONFIG_DIR;
	if (!ocDir) { try { ocDir = (readFileSync(join(repoRoot, ".pi", "worker.env"), "utf8").match(/^OPENCODE_CONFIG_DIR=(.+)$/m) ?? [])[1]?.trim().replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, homedir()); } catch { /* none */ } }
	const oc = ocDir ? keys(join(ocDir, "auth.json")) : null;
	out.opencode = oc ? new Set(oc) : null;
	// claude / codex containers mount the harness's own login files: false = not logged in (skip that agent)
	const cl = readJson(join(root, "claude", "credentials.json"))?.claudeAiOauth;
	out.claude = cl?.refreshToken || cl?.accessToken ? null : existsSync(join(root, "claude", "credentials.json")) ? false : null;
	const cx = readJson(join(root, "codex", "auth.json"));
	// openai-free/* models run in pi with the Keychain OpenAI key
	if (out.pi instanceof Set && getSecret("openai")) out.pi.add("openai");
	// jules: needs its key and a configured GitHub source (herdr-plugin/jules.json)
	out.jules = julesReady(repoRoot) ? null : false;
	out.codex = cx?.tokens?.refresh_token || cx?.tokens?.access_token || cx?.OPENAI_API_KEY ? null : existsSync(join(root, "codex", "auth.json")) ? false : null;
	return out;
}
function readPipeline(repoRoot) { return readJson(join(repoRoot, "herdr-plugin", "pipeline.json")) ?? {}; }

/** Everything from disk -> decision. Never throws. */
export function decideForChange(repoRoot, change, { entries = null } = {}) {
	try {
		const f = findChangeYaml(repoRoot, change);
		const facts = readRoutingFacts(f ? readFileSync(f, "utf8") : "");
		const all = entries ?? ledgerEntries(repoRoot, change);
		const planRounds = all.filter((e) => e.verdict === "plan-changes-requested").length;
		const pipeline = readPipeline(repoRoot);
		return { change, change_yaml: f, ...routeWorker({ facts, entries: all, planRounds, catalog: loadCatalog(repoRoot), usage: loadUsage(repoRoot), pricing: loadPricing(repoRoot),
			allowedBackends: pipeline.auto_backends ?? null, logins: detectLogins(repoRoot), limits: readJson(join(repoRoot, ".pi-session", "routing", "limits.json")) ?? [], bench: readJson(join(repoRoot, ".pi-session", "routing", "bench.json")), outcomes: readJson(join(repoRoot, ".pi-session", "routing", "outcomes.json")) }) };
	} catch (e) {
		return { change, escalateToHuman: false, error: String(e), reason: `router failed (${e.message}) - using the pinned backend`, pick: null };
	}
}

/**
 * What the router would launch for typical changes right now (same catalog, quotas,
 * prices and track records as a real launch). For the dashboard's routing map.
 */
export const MAP_SCENARIOS = [
	{ key: "S", label: "small", size: "S", risk: "low" },
	{ key: "M", label: "medium", size: "M", risk: "medium" },
	{ key: "L", label: "large", size: "L", risk: "medium" },
	{ key: "XL", label: "extra large", size: "XL", risk: "medium" },
	{ key: "high", label: "high risk (M)", size: "M", risk: "high" },
	{ key: "visual", label: "visual / SVG (M)", size: "M", risk: "medium", visual: true },
	{ key: "critical", label: "critical risk", size: "M", risk: "critical" },
];
export function routingMap(repoRoot, { now = Date.now() } = {}) {
	const pipeline = readPipeline(repoRoot);
	const ctx = { catalog: loadCatalog(repoRoot), usage: loadUsage(repoRoot), pricing: loadPricing(repoRoot), allowedBackends: pipeline.auto_backends ?? null,
		logins: detectLogins(repoRoot), outcomes: readJson(join(repoRoot, ".pi-session", "routing", "outcomes.json")), now };
	return MAP_SCENARIOS.map((sc) => {
		const facts = readRoutingFacts(["title: scenario", "risk:", `  tier: ${sc.risk}`, "routing:", `  complexity: ${sc.size}`, `  visual: ${sc.visual ? "true" : "false"}`].join("\n"));
		try { return { ...sc, ...routeWorker({ facts, ...ctx }) }; } catch (e) { return { ...sc, error: String(e.message ?? e) }; }
	});
}

/**
 * What WOULD launch right now for every kind of change: risk x size (+ visual, + struggling),
 * with the same data a real launch uses. Feeds the dashboard's routing tree.
 */
export const SCENARIO_SIZES = ["S", "M", "L", "XL"];
export function routingScenarios({ catalog, usage = {}, pricing = null, allowedBackends = null, logins = {}, outcomes = null, now = Date.now() }) {
	const run = (risk, size, { visual = false, struggling = 0 } = {}) => {
		const facts = readRoutingFacts(`risk:\n  tier: ${risk}\nrouting:\n  complexity: ${size}\n  visual: ${visual}`);
		const entries = Array.from({ length: struggling * 2 }, () => ({ role: "integrator", verdict: "impl-changes-requested" }));
		const d = routeWorker({ facts, entries, catalog, usage, pricing, allowedBackends, logins, outcomes, now });
		const ok = (d.candidates ?? []).filter((x) => x.ok);
		return { risk, size, visual, struggling, minTier: d.minTier, human: !!d.escalateToHuman, wait: !!d.wait, waitUntil: d.waitUntil ?? null, fallback: /fallback:/.test(d.reason ?? ""), reason: d.reason,
			pick: d.pick ? { id: d.pick.id, backend: d.pick.backend, cost: ok[0]?.cost ?? null } : null,
			next: ok[1] ? { id: ok[1].id, backend: ok[1].backend, cost: ok[1].cost } : null, eligible: ok.length, candidates: d.candidates ?? [] };
	};
	const branches = [
		{ key: "low", label: "low risk", rule: "free models first for S-L; XL needs a frontier model", leaves: SCENARIO_SIZES.map((z) => run("low", z)) },
		{ key: "medium", label: "medium risk", rule: "same as low risk", leaves: SCENARIO_SIZES.map((z) => run("medium", z)) },
		{ key: "struggling", label: "struggling (2 change requests / failed qualifications)", rule: "+1 tier per 2 failures; blocks do not count", leaves: SCENARIO_SIZES.map((z) => run("medium", z, { struggling: 1 })) },
		{ key: "visual", label: "visual work (SVG, CSS, canvas, UI art ...)", rule: "tier >= 3 and a visual model", leaves: SCENARIO_SIZES.map((z) => run("medium", z, { visual: true })) },
		{ key: "high", label: "high risk", rule: "tier >= 3 from the start", leaves: SCENARIO_SIZES.map((z) => run("high", z)) },
		{ key: "critical", label: "critical risk", rule: "a human launches the worker", leaves: [run("critical", "M")] },
	];
	// per backend: which models it would carry, and why the others are out
	const backends = {};
	const prio = catalog.backend_priority ?? DEFAULT_BACKEND_PRIORITY;
	const weight = catalog.backend_weight ?? DEFAULT_BACKEND_WEIGHT;
	const wins = {};
	for (const b of branches) for (const l of b.leaves) if (l.pick && !l.wait) (wins[l.pick.id] ??= []).push(`${b.key}:${l.size}`);
	for (const m of (catalog.models ?? [])) {
		for (const b of m.backends ?? [m.backend ?? "pi"]) backends[b] ??= { name: b, priority: prio.indexOf(b) + 1 || null, weight: weight[b] ?? 0, allowed: !allowedBackends || allowedBackends.includes(b), models: [] };
		if (m.enabled === false) { backends[m.backends?.[0] ?? m.backend ?? "pi"].models.push({ id: m.id, tier: m.tier, state: "off", why: "disabled in catalog" }); continue; }
		const be = chooseBackend(m, { catalog, allowed: allowedBackends, logins });
		if (!be.ok) { backends[m.backends?.[0] ?? m.backend ?? "pi"].models.push({ id: m.id, tier: m.tier, state: "out", why: be.why }); continue; }
		const anyOk = branches.flatMap((b) => b.leaves).map((l) => l.candidates.find((x) => x.id === m.id)).filter(Boolean);
		const okOnce = anyOk.find((x) => x.ok);
		const notOk = anyOk.find((x) => !x.ok && !/^tier \d+ < \d+/.test(x.why ?? ""));
		backends[be.backend].models.push({ id: m.id, tier: m.tier, state: wins[m.id] ? "picked" : okOnce ? "ready" : "out", wins: wins[m.id] ?? [],
			cost: okOnce?.cost ?? null, why: okOnce ? (okOnce.why ?? "") : notOk?.why ?? "never eligible", visual: !!m.visual });
	}
	const order = Object.values(backends).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
	return { branches, backends: order };
}
export function scenariosForRepo(repoRoot) {
	const pipeline = readPipeline(repoRoot);
	return routingScenarios({ catalog: loadCatalog(repoRoot), usage: loadUsage(repoRoot), pricing: loadPricing(repoRoot), allowedBackends: pipeline.auto_backends ?? null,
		logins: detectLogins(repoRoot), outcomes: readJson(join(repoRoot, ".pi-session", "routing", "outcomes.json")) });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function explain(d) {
	const L = [];
	L.push(`${d.change}: ${d.escalateToHuman ? "HUMAN - " + d.reason : d.wait ? `WAIT until ${new Date(d.waitUntil).toISOString()}` : d.pick ? `${d.pick.id} via ${d.pick.backend}` : "no decision"}`);
	if (!d.escalateToHuman) L.push(`  why: ${d.reason}`);
	if (d.difficulty) L.push(`  difficulty: ${d.difficulty.points} pts -> ${d.difficulty.size}  [${d.difficulty.reasons.join(", ")}]`);
	if (d.visual) L.push(`  visual: ${d.visual.visual} (${d.visual.why})`);
	if (d.minTier) L.push(`  minimum tier: ${d.minTier} (${TIER_NAMES[d.minTier]})`);
	for (const c of d.candidates ?? []) L.push(`  ${c.ok ? "ok " : " - "} t${c.tier} ${c.id.padEnd(52)} ${c.ok ? `cost ${c.cost}` : ""} ${c.why ?? ""}`);
	return L.join("\n");
}

async function main() {
	const argv = process.argv.slice(2);
	const repoRoot = process.env.HARNESS_REPO_ROOT || (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return resolve(HERE, ".."); } })();
	if (argv.includes("--selftest")) return selftest();
	if (argv.includes("--refresh-usage")) {
		const u = await refreshUsage(repoRoot, loadCatalog(repoRoot));
		if (!argv.includes("--quiet")) console.log(JSON.stringify({ quotas: u.quotas, local: u.local, breakers: u.breakers, sources: u.sources }, null, 2));
		return 0;
	}
	const change = argv.find((a) => /^CHANGE-\d+$/i.test(a));
	if (!change) { console.error("usage: route-worker.mjs CHANGE-NNNN [--json] [--refresh] | --refresh-usage | --selftest"); return 2; }
	if (argv.includes("--refresh") || usageIsOld(repoRoot)) await refreshUsage(repoRoot, loadCatalog(repoRoot)).catch(() => {});
	const d = decideForChange(repoRoot, change.toUpperCase().replace(/(\d+)$/, (n) => n.padStart(4, "0")));
	console.log(argv.includes("--json") ? JSON.stringify(d, null, 2) : explain(d));
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const now = Date.UTC(2026, 9, 15, 12);
	const catalog = {
		quota_floor_pct: 15,
		models: [
			{ id: "local/qwen", backend: "pi", tier: 1, cost: "local" },
			{ id: "openrouter/nemotron:free", backend: "pi", tier: 2, cost: "free", quotas: ["openrouter_free"], health_match: "nvidia" },
			{ id: "antigravity/gemini", backend: "antigravity", tier: 2, cost: "sub", quotas: ["gemini_5h", "gemini_weekly"] },
			{ id: "openai/gpt-6.1-sol", backend: "pi", tier: 3, cost: "sub", quotas: ["codex_5h", "codex_weekly"] },
			{ id: "openai/gpt-6-astra", backend: "pi", tier: 4, cost: "sub", visual: true, quotas: ["codex_5h", "codex_weekly"] },
			{ id: "claude/opus", backend: "claude", model: "opus", tier: 4, cost: "sub", visual: true, quotas: ["claude_5h", "claude_weekly"] },
		],
	};
	const yaml = (extra = "") => ["id: CHANGE-0009", "title: tidy docs", "type: docs", "owned_paths:", "  - docs/a.md", "requirements:", "  - R1 one", "risk:", "  tier: low", "  reviewer_required: false", extra].join("\n");
	const base = { local: { up: true, models: ["qwen"] }, quotas: {}, breakers: {} };

	let f = readRoutingFacts(yaml());
	ok(f.risk.tier === "low" && f.owned_paths.length === 1 && f.requirements.length === 1 && f.type === "docs", "parses change.yaml basics");
	let d = routeWorker({ facts: f, catalog, usage: base, now });
	ok(d.pick?.id === "local/qwen", `small low-risk docs change -> local (got ${d.pick?.id})`);
	d = routeWorker({ facts: f, catalog, usage: { ...base, local: { up: false } }, now });
	ok(d.pick?.id === "openrouter/nemotron:free", `local down -> free cloud (got ${d.pick?.id})`);
	d = routeWorker({ facts: f, catalog, usage: { ...base, local: { up: false }, breakers: { nvidia: { events: 9, threshold: 6 } } }, now });
	ok(d.pick?.id === "antigravity/gemini", `nvidia breaker open -> next in tier (got ${d.pick?.id})`);
	d = routeWorker({ facts: f, catalog, usage: { ...base, local: { up: false }, quotas: { openrouter_free: { t: now, remaining: 20, limit: 1000 } } }, now });
	ok(d.pick?.id === "antigravity/gemini", "free requests nearly used up -> skip");

	f = readRoutingFacts(yaml().replace("tier: low", "tier: high"));
	d = routeWorker({ facts: f, catalog, usage: base, now });
	ok(d.pick?.tier >= 3, `high risk -> tier >= 3 (got ${d.pick?.id})`);

	f = readRoutingFacts(yaml().replace("docs/a.md", "assets/sprites/hero.svg"));
	d = routeWorker({ facts: f, catalog, usage: base, now });
	ok(d.visual.visual && ["openai/gpt-6-astra", "claude/opus"].includes(d.pick?.id), `SVG work -> visual model (got ${d.pick?.id})`);
	f = readRoutingFacts(yaml("routing:\n  complexity: S\n  visual: false"));
	ok(f.routing.complexity === "S" && f.routing.visual === false, "reads the integrator's routing hint");
	f = readRoutingFacts(yaml("routing:\n  complexity: L"));
	d = routeWorker({ facts: f, catalog, usage: base, now });
	ok(d.minTier === 2 && d.pick?.tier >= 2, "integrator complexity L on low risk -> tier 2 (free first)");
	d = routeWorker({ facts: readRoutingFacts(yaml("routing:\n  complexity: L").replace("tier: low", "tier: high")), catalog, usage: base, now });
	ok(d.minTier === 3 && d.pick?.tier >= 3, "integrator complexity L on high risk -> tier 3");

	f = readRoutingFacts(yaml());
	d = routeWorker({ facts: f, catalog, usage: base, now, entries: [{ verdict: "impl-changes-requested" }, { verdict: "impl-changes-requested" }] });
	ok(d.minTier === 2 && d.pick?.tier === 2, `two rejected rounds -> one tier up (got min ${d.minTier}, ${d.pick?.id})`);

	f = readRoutingFacts(yaml().replace("tier: low", "tier: high"));
	const quotas = { codex_5h: { t: now, usedPct: 10 }, codex_weekly: { t: now, usedPct: 90 } };
	d = routeWorker({ facts: f, catalog, usage: { ...base, quotas }, now });
	ok(d.pick?.id === "claude/opus", `codex weekly at 90% -> not codex models (got ${d.pick?.id})`);
	const q2 = { claude_weekly: { t: now, usedPct: 30, resetsAt: now + 10 * 3600e3 }, codex_weekly: { t: now, usedPct: 30, resetsAt: now + 5 * 86400e3 } };
	const cat2 = { ...catalog, models: catalog.models.filter((m) => m.tier === 4) };
	d = routeWorker({ facts: f, catalog: cat2, usage: { ...base, quotas: q2 }, now });
	ok(d.pick?.id === "claude/opus", `use-it-or-lose-it: weekly quota resetting soon wins (got ${d.pick?.id})`);

	f = readRoutingFacts(yaml().replace("tier: low", "tier: critical"));
	ok(routeWorker({ facts: f, catalog, usage: base, now }).escalateToHuman, "critical -> human");

	ok(Object.keys(codexQuotasFromLines([JSON.stringify({ timestamp: "2026-10-15T10:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 299, resets_in_seconds: 600 }, secondary: { used_percent: 40, window_minutes: 10079, resets_in_seconds: 86400 } } } })])).join() === "codex_5h,codex_weekly", "reads Codex rate_limits");
	const wq = evidenceQuotas([JSON.stringify({ t: now, ev: "codex_quota_snapshot", primary: { used_percent: 42, window_seconds: 18000, reset_at: 1792080000 }, secondary: { used_percent: 7, reset_at: 1792500000 } })]);
	ok(wq.codex_5h?.usedPct === 42 && wq.codex_weekly?.usedPct === 7 && wq.codex_5h.resetsAt === 1792080000000, "reads codex_quota_snapshot (pi + Codex login)");
	const H = 3600e3;
	let pr = projectRunOut([{ t: now - 20 * H, v: 40 }, { t: now - 10 * H, v: 50 }], { usedPct: 60, resetsAt: now + 4 * 86400e3 }, now, "weekly");
	ok(pr && pr.beforeReset && Math.abs((pr.runOutAt - now) / H - 40) < 1, `weekly: +20% in 20h -> runs out in ~40h (got ${pr && (pr.runOutAt - now) / H})`);
	pr = projectRunOut([{ t: now - 0.5 * H, v: 58 }], { usedPct: 60, resetsAt: now + 4 * 86400e3 }, now, "weekly");
	ok(pr && (pr.runOutAt - now) / H > 200, "long window floors elapsed at 12h (no panic after 30 min)");
	pr = projectRunOut([{ t: now - 3 * H, v: 80 }, { t: now - 1 * H, v: 5 }], { usedPct: 10, resetsAt: now + 4 * 86400e3 }, now, "weekly");
	ok(pr && !pr.beforeReset, "points before a reset are ignored");
	pr = projectRunOut([{ t: now - H, v: 20 }], { usedPct: 70, resetsAt: now + 2 * H }, now, "5h");
	ok(pr && pr.beforeReset && Math.abs((pr.runOutAt - now) / H - 0.6) < 0.05, "5h: +50% in 1h -> out in ~36 min");
	f = readRoutingFacts(yaml().replace("tier: low", "tier: high"));
	d = routeWorker({ facts: f, catalog: { ...catalog, models: catalog.models.filter((m) => m.tier >= 3) }, usage: { ...base, quotas: { codex_weekly: { t: now, usedPct: 60, resetsAt: now + 4 * 86400e3 }, claude_weekly: { t: now, usedPct: 70 } }, projections: { codex_weekly: { beforeReset: true, runOutAt: now + 2 * H } } }, now });
	ok(d.pick?.id === "claude/opus" && d.candidates.find((c) => c.id === "openai/gpt-6.1-sol")?.why?.includes("projected to run out"), `run-out projection excludes codex for an L change (got ${d.pick?.id})`);
	{
		const pricing = { rows: [
			{ plan: "ChatGPT Plus", billing: "subscription", model: "gpt-6.1-sol", real_usd_per_mtok: 0.023, monthly_tokens: 870e6, scores: { open_design_arena: { score: 90.1 } } },
			{ plan: "ChatGPT Plus", billing: "subscription", model: "gpt-6-astra", real_usd_per_mtok: 0.126, monthly_tokens: 159e6, scores: { open_design_arena: { score: 82.7 } } },
			{ plan: "Claude Pro", billing: "subscription", model: "claude-opus-5.5", real_usd_per_mtok: 0.0065, monthly_tokens: 3054e6, scores: {} },
		] };
		const cat3 = { models: [
			{ id: "openai-codex/gpt-6.1-sol", backend: "pi", tier: 4, cost: "sub", quotas: ["codex_5h", "codex_weekly"] },
			{ id: "openai-codex/gpt-6-astra", backend: "pi", tier: 4, cost: "sub", visual: true, quotas: ["codex_5h", "codex_weekly"] },
			{ id: "claude/opus", backend: "claude", model: "opus", score_name: "claude-opus-5.5", tier: 4, cost: "sub", visual: true, quotas: ["claude_5h", "claude_weekly"] },
		] };
		f = readRoutingFacts(yaml().replace("docs/a.md", "assets/ui/hero.svg"));
		d = routeWorker({ facts: f, catalog: cat3, usage: base, pricing, now });
		ok(d.pick?.id === "claude/opus" && d.candidates.find((c) => c.id === "openai-codex/gpt-6.1-sol")?.ok, `visual: Open Design Arena 90 makes 6.1-sol eligible; cheapest per token (opus on Claude Pro) wins (got ${d.pick?.id})`);
		d = routeWorker({ facts: f, catalog: { models: cat3.models.slice(0, 2) }, usage: base, pricing, now });
		ok(d.pick?.id === "openai-codex/gpt-6-astra", `visual: the owner's visual model (astra) beats 6.1-sol, which only qualifies by design score (got ${d.pick?.id})`);
		ok(routeWorker({ facts: f, catalog: { models: cat3.models.slice(0, 2) }, usage: { ...base, quotas: { codex_5h: { t: now, usedPct: 10 } } }, pricing, now, }).candidates.find((c) => c.id === "openai-codex/gpt-6.1-sol")?.ok, "6.1-sol stays eligible as the visual fallback");
		d = routeWorker({ facts: readRoutingFacts(yaml("routing:\n  complexity: L")), catalog: { models: cat3.models.slice(0, 2) }, usage: { ...base, quotas: { codex_weekly: { t: now, usedPct: 50 } } }, pricing, now });
		ok(d.pick?.id === "openai-codex/gpt-6.1-sol" && /tokens left/.test(d.candidates.find((c) => c.id.endsWith("astra"))?.why ?? ""), `token budget: astra has ~20M left this week, an L change needs ~60M (got ${JSON.stringify(d.candidates.map((c) => c.why))})`);
	}
	{
		const cat4 = { models: [
			{ id: "openrouter/nvidia/nemotron:free", backend: "pi", tier: 2, cost: "free", quotas: [] },
			{ id: "opencode/deepseek-v4.1-flash-free", backends: ["opencode", "pi"], tier: 2, cost: "free" },
			{ id: "claude/opus", backend: "claude", model: "opus", tier: 4, cost: "sub" },
		] };
		f = readRoutingFacts(yaml());
		d = routeWorker({ facts: f, catalog: cat4, usage: { ...base, local: { up: false } }, allowedBackends: ["opencode", "pi"], logins: { pi: new Set(["openrouter"]), opencode: new Set(["opencode"]) }, now });
		ok(d.pick?.id === "opencode/deepseek-v4.1-flash-free" && d.pick.backend === "opencode" && d.pick.model === "opencode/deepseek-v4.1-flash-free", `free models: opencode before pi (got ${JSON.stringify(d.pick)})`);
		d = routeWorker({ facts: readRoutingFacts(yaml().replace("tier: low", "tier: high")), catalog: cat4, usage: base, allowedBackends: ["opencode", "pi"], logins: {}, now });
		ok(d.escalateToHuman && /not in pipeline auto_backends/.test(d.candidates.find((c) => c.id === "claude/opus")?.why ?? ""), "a backend outside auto_backends is never launched");
		d = routeWorker({ facts: f, catalog: { models: [cat4.models[0]] }, usage: { ...base, local: { up: false } }, allowedBackends: ["pi"], logins: { pi: new Set(["opencode-go"]) }, now });
		ok(d.escalateToHuman && /no openrouter login for pi/.test(d.candidates[0].why), "a provider without a login is skipped");
	}
	{
		const cat5 = { models: [{ id: "opencode-go/deepseek-v4.1-flash", backends: ["opencode", "pi"], tier: 2, cost: "sub" }, { id: "claude/opus", backend: "claude", model: "opus", tier: 4, cost: "sub" }] };
		let pf = readRoutingFacts(yaml("routing:\n  model: opencode-go/deepseek-v4.1-flash").replace("tier: low", "tier: high"));
		d = routeWorker({ facts: pf, catalog: cat5, usage: base, allowedBackends: ["opencode", "pi"], now });
		ok(d.pinned && d.pick.id === "opencode-go/deepseek-v4.1-flash" && d.pick.backend === "opencode", `pin wins over the high-risk tier rule (got ${JSON.stringify(d.pick)})`);
		pf = readRoutingFacts(yaml("routing:\n  model: claude/opus\n  backend: claude"));
		d = routeWorker({ facts: pf, catalog: cat5, usage: base, allowedBackends: ["opencode", "pi"], now });
		ok(d.pick.backend === "claude" && d.pick.model === "opus" && /not in pipeline auto_backends/.test(d.reason), "pinned backend outside auto_backends: launched, with a note");
		pf = readRoutingFacts(yaml("routing:\n  model: openrouter/x/y:free"));
		d = routeWorker({ facts: pf, catalog: cat5, usage: base, now });
		ok(d.pick.backend === "pi" && d.pick.model === "openrouter/x/y:free", "a model not in the catalog: provider decides the backend");
	}
	{
		// track record: reorders within a tier, never across tiers; ignored below min rounds
		const cat6 = { models: [
			{ id: "opencode-go/mimo", backend: "pi", tier: 2, cost: "sub" },
			{ id: "opencode-go/deepseek", backend: "pi", tier: 2, cost: "sub", preference: 1 },
			{ id: "openai/strong", backend: "pi", tier: 3, cost: "sub" },
		] };
		const outcomes = { models: [
			{ model: "opencode-go/mimo", rounds: 17, merged: 3, reportsPerMerged: 5.7, firstPassPct: 75, toolErrorsPer100: 14.1, errorTurnsPer100: 2.2, continuesPerRound: 0 },
			{ model: "opencode-go/deepseek", rounds: 1, merged: 1, reportsPerMerged: 1, firstPassPct: 100 },
		] };
		const f6 = readRoutingFacts(yaml());
		let d = routeWorker({ facts: f6, catalog: cat6, usage: base, now });
		ok(d.pick.id === "opencode-go/mimo", "without a record the cheaper preference wins");
		d = routeWorker({ facts: f6, catalog: cat6, usage: base, now, outcomes });
		const mimo = d.candidates.find((c) => c.id === "opencode-go/mimo");
		ok(d.pick.id === "opencode-go/deepseek" && mimo.record > 6.4 && mimo.record < 6.6 && /5.7 reports\/merge/.test(mimo.why), `a bad record moves MiMo behind DeepSeek (got ${d.pick.id}, record ${mimo.record})`);
		ok(d.candidates.find((c) => c.id === "opencode-go/deepseek").record === 0, "one round is too few to judge");
		const worst = outcomePenalty({ rounds: 9, merged: 0, firstPassPct: 0, toolErrorsPer100: 40, errorTurnsPer100: 60, continuesPerRound: 5 });
		ok(worst.points === 8, "penalty is capped below one tier step");
		ok(outcomePenalty({ rounds: 6, merged: 5, reportsPerMerged: 1.2, firstPassPct: 90, toolErrorsPer100: 3, errorTurnsPer100: 2, continuesPerRound: 0 }).points === -1, "clean record earns a small bonus");
		ok(routeWorker({ facts: f6, catalog: { ...cat6, outcome_weight: 0 }, usage: base, now, outcomes }).pick.id === "opencode-go/mimo", "outcome_weight 0 switches it off");
	}
	{
		const yamlish = ["title: scenario", "risk:", "  tier: high", "routing:", "  complexity: S", "  visual: false"].join("\n");
		const f = readRoutingFacts(yamlish);
		ok(f.risk.tier === "high" && f.routing.complexity === "S" && f.routing.visual === false, "routing-map scenario yaml parses");
	}
	{
		const sc = routingScenarios({ catalog, usage: base, now });
		const low = sc.branches.find((b) => b.key === "low");
		ok(low.leaves.length === 4 && low.leaves[0].pick?.id === "local/qwen", `scenario tree: S low-risk goes local (got ${low.leaves[0].pick?.id})`);
		ok(sc.branches.find((b) => b.key === "critical").leaves[0].human, "scenario tree: critical -> human");
		ok(sc.branches.find((b) => b.key === "high").leaves.every((l) => l.human || l.pick.id !== "local/qwen"), "scenario tree: high risk never local");
		ok(sc.backends.some((b) => b.name === "claude" && b.models.some((m) => m.id === "claude/opus")), "scenario tree: models grouped by backend");
	}
	{
		// owner rules 2026-10-16: medium M -> tier 3; blocks never escalate; wait for a quota that resets soon; else fall back
		const cat7 = { models: [
			{ id: "opencode-go/deepseek", backend: "pi", tier: 2, cost: "sub" },
			{ id: "codex/gpt-6.1-sol", backend: "codex", model: "gpt-6.1-sol", tier: 3, cost: "sub", quotas: ["codex_5h"] },
			{ id: "claude/opus", backend: "claude", model: "opus", tier: 4, cost: "sub", visual: true, quotas: ["claude_5h"] },
		] };
		const fx = (risk, size, extra = "") => readRoutingFacts(`risk:\n  tier: ${risk}\nrouting:\n  complexity: ${size}${extra}`);
		let d = routeWorker({ facts: fx("medium", "M"), catalog: cat7, usage: base, now });
		const free = { id: "opencode/free-coder", backend: "pi", tier: 2, cost: "free" };
		const cat8 = { models: [...cat7.models, free] };
		for (const [risk, size] of [["medium", "M"], ["low", "M"], ["medium", "L"], ["low", "S"]]) {
			d = routeWorker({ facts: fx(risk, size), catalog: cat8, usage: base, now });
			ok(d.pick?.id === free.id, `${risk}-risk ${size} without visuals starts on a free model (got ${d.pick?.id}, min ${d.minTier})`);
		}
		d = routeWorker({ facts: fx("medium", "L"), catalog: cat8, usage: base, now, entries: [{ verdict: "impl-changes-requested" }, { verdict: "qualification-failed" }] });
		ok(d.minTier === 3 && d.pick?.id === "codex/gpt-6.1-sol", `struggling L moves up to tier 3 (got ${d.pick?.id})`);
		d = routeWorker({ facts: fx("medium", "S"), catalog: cat8, usage: base, now, entries: [{ verdict: "impl-changes-requested" }, { verdict: "impl-changes-requested" }] });
		ok(d.minTier === 2 && /escalated/.test(d.reason) && !/free models first/.test(d.reason), `struggling S: one tier up, no free-first bonus (got ${d.reason})`);
		ok(routeWorker({ facts: fx("high", "M"), catalog: cat8, usage: base, now }).pick?.id === "codex/gpt-6.1-sol", "high risk still tier 3");
		ok(routeWorker({ facts: fx("medium", "M", "\n  visual: true"), catalog: cat8, usage: base, now }).pick?.id === "claude/opus", "visual still Opus");
		const blocks = [1, 2, 3].map(() => ({ role: "worker", verdict: "blocked" }));
		ok(escalationFrom(blocks).levels === 0, "blocks never escalate");
		ok(escalationFrom([{ verdict: "impl-changes-requested" }, { verdict: "qualification-failed" }]).levels === 1, "a change request + a failed qualification = +1");
		const busy = { ...base, quotas: { claude_5h: { t: now, usedPct: 100, resetsAt: now + 2 * 3600e3 } } };
		d = routeWorker({ facts: fx("medium", "M", "\n  visual: true"), catalog: { models: cat7.models.filter((m) => m.id !== "codex/gpt-6.1-sol") }, usage: busy, now });
		ok(d.wait && !d.escalateToHuman && d.waitUntil === now + 2 * 3600e3, `visual work waits 2h for Opus (got ${d.reason})`);
		const later = { ...base, quotas: { claude_5h: { t: now, usedPct: 100, resetsAt: now + 5 * 3600e3 } } };
		d = routeWorker({ facts: fx("medium", "L", "\n  visual: true"), catalog: { ...cat7, models: [...cat7.models.slice(0, 2), { ...cat7.models[2] }, { id: "codex/visual3", backend: "codex", tier: 3, cost: "sub", visual: true }] }, usage: later, now, entries: [{ verdict: "impl-changes-requested" }, { verdict: "impl-changes-requested" }] });
		ok(!d.wait && d.pick?.id === "codex/visual3" && /fallback/.test(d.reason), `reset too far away -> strongest available (got ${d.pick?.id}: ${d.reason})`);
		d = routeWorker({ facts: fx("high", "M"), catalog: { models: [cat7.models[0]] }, usage: base, now });
		ok(d.escalateToHuman, "high risk never falls back below tier 3");
		ok(routeWorker({ facts: fx("medium", "M"), catalog: cat7, usage: base, now }).pick.effort === "medium" && routeWorker({ facts: fx("medium", "XL"), catalog: cat7, usage: base, now }).pick?.effort === "high", "effort: medium for M, high for XL");
		const bq = { results: { "opencode-go/deepseek": { passed: 5, total: 11 } } };
		const bc = routeWorker({ facts: fx("low", "M"), catalog: cat7, usage: base, now, bench: bq }).candidates.find((c) => c.id === "opencode-go/deepseek");
		ok(bc.record === 4 && /benchmark 5\/11/.test(bc.why), "a weak benchmark score is the prior when there is no track record");
		ok(/claude is not logged in/.test(routeWorker({ facts: fx("medium", "M", "\n  visual: true"), catalog: cat7, usage: base, now, logins: { claude: false } }).candidates.find((c) => c.id === "claude/opus").why), "an agent without a login is skipped, with the reason");
		const lim = [{ backend: "claude", kind: "usage limit", until: now + 4 * 3600e3 }];
		d = routeWorker({ facts: fx("medium", "M", "\n  visual: true"), catalog: { models: [...cat7.models, { id: "codex/astra", backend: "codex", tier: 4, cost: "sub", visual: true }] }, usage: base, now, limits: lim });
		ok(d.pick?.id === "codex/astra" && /hit its usage limit/.test(d.candidates.find((c) => c.id === "claude/opus").why), `claude at its limit -> another agent takes it (got ${d.pick?.id})`);
		d = routeWorker({ facts: fx("medium", "XL"), catalog: cat7, usage: base, now, limits: lim });
		ok(d.pick?.id === "codex/gpt-6.1-sol" && /fallback/.test(d.reason), `tier 4 out -> strongest other agent instead of waiting (got ${d.pick?.id}: ${d.reason})`);
		const gem = { id: "antigravity/gemini-flash", backend: "antigravity", tier: 2, cost: "sub", tier_for: { "medium:M": 3 } };
		ok(routeWorker({ facts: fx("medium", "M"), catalog: { models: [gem, cat7.models[1]] }, usage: base, now }).candidates.find((c) => c.id === gem.id).ok, "tier_for lets Gemini Flash take medium-risk M");
		ok(!routeWorker({ facts: fx("high", "M"), catalog: { models: [gem, cat7.models[1]] }, usage: base, now }).candidates.find((c) => c.id === gem.id).ok, "but not high-risk M");
		const sol = { ...cat7.models[1], id: "codex/sol-design" };
		const viz = { models: [sol, cat7.models[2]] };
		const ds = { rows: [] };
		d = routeWorker({ facts: fx("medium", "M", "\n  visual: true"), catalog: { ...viz, models: [{ ...sol, visual: false }, cat7.models[2]] }, usage: base, now });
		ok(d.pick?.id === "claude/opus" || d.escalateToHuman === false, `visual: Opus first when it has quota (got ${d.pick?.id})`);
	}
	{
		const cq = claudeOAuthQuotas({ five_hour: { utilization: 42, resets_at: "2026-10-18T15:00:00Z" }, seven_day: { utilization: 61, resets_at: null } }, 5);
		const aq = antigravityQuotas({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: "2026-10-18T15:00:00Z" }, { bucketId: "gemini-weekly", remainingFraction: "0.4", resetTime: 1792400000 }] }, { buckets: [{ bucketId: "3p-5h", remainingFraction: 1 }] }] }, 7);
		ok(aq.gemini_5h.usedPct === 25 && aq.gemini_5h.resetsAt === Date.parse("2026-10-18T15:00:00Z") && aq.gemini_weekly.usedPct === 60 && aq.gemini_weekly.resetsAt === 1792400000000 && aq.agy3p_5h.usedPct === 0, "maps Antigravity's quota summary");
		ok(cq.claude_5h.usedPct === 42 && cq.claude_5h.resetsAt === Date.parse("2026-10-18T15:00:00Z") && cq.claude_weekly.usedPct === 61 && cq.claude_5h.t === 5, "maps Claude's oauth usage response");
	}
	const qc = quotaCliQuotas([{ provider: "claude", windows: [{ label: "5h", remainingPercent: 98, resetAt: 1792080000 }, { label: "Wk", remainingPercent: 35, resetAt: 1792500000 }] }, { provider: "antigravity", windows: [{ label: "5h", remainingPercent: 100 }, { label: "Wk", remainingPercent: 97 }] }, { provider: "cursor", windows: [{ label: "Plan", remainingPercent: 100 }] }]);
	ok(qc.claude_5h?.usedPct === 2 && qc.claude_weekly?.usedPct === 65 && qc.claude_5h.resetsAt === 1792080000000 && qc.gemini_weekly?.usedPct === 3 && !Object.keys(qc).some((k) => k.startsWith("cursor")), "maps quota-cli JSON (remaining -> used, labels -> windows)");
	const og = opencodeGoQuotas({ usage: { rolling: { percent: 0, resetsAt: new Date(now + 5 * 3600e3).toISOString() }, weekly: { percent: 41.5, resetsAt: "2026-10-19T00:00:00Z" }, monthly: { percent: 12 } } }, now);
	ok(og.opencodego_5h.usedPct === 0 && og.opencodego_5h.resetsAt === null && og.opencodego_weekly.usedPct === 41.5 && og.opencodego_monthly.usedPct === 12, "OpenCode Go windows; unused rolling window has no fake reset");
	const orq = openRouterQuotas({ limit: null, limit_remaining: null, free_model_daily_requests: { used: 950, limit: 1000, remaining: 50 } }, now);
	ok(orq.openrouter_free.remaining === 50 && Math.round(orq.openrouter_free.usedPct) === 95, "reads OpenRouter free-request budget");
	const eq = evidenceQuotas([JSON.stringify({ t: now, ev: "quota_snapshot", quota: { "gemini-weekly": { used_pct: 22.4, reset_time: "2026-10-19T10:03:30Z" }, "3p-5h": { used_pct: 0 } } })]);
	ok(eq.gemini_weekly?.usedPct === 22.4 && eq.agy3p_5h, "reads Gemini/Antigravity quota buckets");
	const br = breakersFromLines([JSON.stringify({ t: now - 60e3, ev: "disconnect_recovery_deferred", errorMessage: "Upstream error from Nvidia: Service temporarily overloaded" })], catalog, now);
	ok(br.nvidia.events === 1, "counts overload events per provider");

	if (fails) { console.error(`${fails} route-worker self-test(s) FAILED`); return 1; }
	console.log("route-worker self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((c) => process.exit(c ?? 0), (e) => { console.error(e); process.exit(1); });
}
