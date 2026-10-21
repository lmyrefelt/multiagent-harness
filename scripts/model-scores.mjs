#!/usr/bin/env node
/**
 * model-scores.mjs - public benchmark scores + this harness's own track record, per model.
 *
 * External (host side, cached in .pi-session/routing/scores.json, refreshed at most daily):
 *   - Artificial Analysis  GET https://artificialanalysis.ai/api/v2/language/models
 *       header x-api-key (free tier: 100 requests / 24h - we use ~1 per day).
 *       Key: ARTIFICIAL_ANALYSIS_API_KEY or ~/.harness/config/artificialanalysis.key
 *       Indexes: intelligence, coding, agentic. ATTRIBUTION REQUIRED: "Artificial Analysis".
 *   - Arena (arena.ai) leaderboards via the public daily mirror
 *       https://github.com/oolong-tea-2026/arena-ai-leaderboards (MIT): code, agent, text ELO.
 *       Arena has no public API. When a day's scrape came back empty, the newest day WITH data
 *       (up to 30 days back) is used, and its date is shown.
 *
 * Own (from the evidence the guards already write): turns, violations and blocked tool calls
 * per 100 turns, completion gate passed/exhausted - "how does this model behave HERE".
 *
 * Matching is fuzzy on purpose (providers name the same model differently: "gpt-6-astra-max",
 * "GPT-6 Astra", "openai-codex/gpt-6-astra"). Reasoning-effort variants (-max, -high, (xHigh)...)
 * count as the same model; the best-scoring variant is used and marked "≈". A catalog entry
 * can pin its public name with "score_name": "claude-opus-5.5".
 *
 *   node scripts/model-scores.mjs            show the table
 *   node scripts/model-scores.mjs --refresh  fetch again now
 *   node scripts/model-scores.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCORES_MAX_AGE_MS = 24 * 3600e3;
const ARENA_RAW = "https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data";
const ARENA_BOARDS = ["code", "agent", "text"];
const VARIANT = /^(max|xhigh|high|medium|low|minimal|thinking|reasoning|preview|free|latest|instruct|chat|exp|experimental|codex-harness|\d{4}|\d{6,8}|mlx|\d+bit|q\d+|oq\d+e?|mtp|a\d+b)$/;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** "openai-codex/gpt-6-astra" | "GPT-6 Astra (xHigh)" | "gpt-6-astra-max" -> "gpt-6-astra" */
export function baseName(name) {
	let s = String(name ?? "").toLowerCase();
	s = s.slice(s.lastIndexOf("/") + 1);
	s = s.replace(/\(.*?\)/g, " ").replace(/:free$/, "").replace(/(\d)\.(\d)/g, "$1-$2").replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
	const parts = s.split("-");
	while (parts.length > 1 && VARIANT.test(parts[parts.length - 1])) parts.pop();
	return parts.join("-");
}

/** Best entry in `rows` for a model; rows: [{name, ...}] . Returns {row, exact} or null. */
export function matchModel(ourNames, rows, scoreOf) {
	const wants = [...new Set(ourNames.filter(Boolean).map(baseName))];
	let best = null;
	for (const r of rows) {
		const b = baseName(r.name);
		if (!wants.includes(b)) continue;
		const exact = ourNames.some((n) => String(n).toLowerCase().split("/").pop() === String(r.name).toLowerCase());
		if (!best || exact > best.exact || (exact === best.exact && (scoreOf(r) ?? -1) > (scoreOf(best.row) ?? -1))) best = { row: r, exact };
	}
	return best;
}

// --- Artificial Analysis ------------------------------------------------------
function aaKey() {
	if (process.env.ARTIFICIAL_ANALYSIS_API_KEY) return process.env.ARTIFICIAL_ANALYSIS_API_KEY.trim();
	const root = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");
	try { return readFileSync(join(root, "artificialanalysis.key"), "utf8").trim() || null; } catch { return null; }
}
/** Find a numeric field anywhere in an object by key name (the API nests evaluations). */
function deepNum(o, key, depth = 0) {
	if (!o || typeof o !== "object" || depth > 4) return null;
	if (typeof o[key] === "number") return o[key];
	for (const v of Object.values(o)) { const r = deepNum(v, key, depth + 1); if (r != null) return r; }
	return null;
}
export function parseAA(json) {
	const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
	return list.map((m) => ({
		name: m.slug ?? m.name ?? m.model_name ?? "",
		display: m.name ?? m.slug ?? "",
		creator: m.model_creator?.name ?? m.creator ?? null,
		intelligence: deepNum(m, "artificial_analysis_intelligence_index"),
		coding: deepNum(m, "artificial_analysis_coding_index"),
		agentic: deepNum(m, "artificial_analysis_agentic_index"),
	})).filter((m) => m.name);
}

// --- Arena mirror --------------------------------------------------------------
export function parseArena(json) {
	const rows = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
	return { fetched_at: json?.meta?.fetched_at ?? json?.fetched_at ?? null, updated: json?.meta?.last_updated ?? null, count: rows.length, rows: rows.map((r) => {
		// ELO boards have `score`; the agent board has several dimensions - use "Confirmed Success" (% of tasks).
		const dims = Array.isArray(r.scores) ? Object.fromEntries(r.scores.map((d) => [d.name, d.score])) : null;
		const score = typeof r.score === "number" ? r.score : dims ? (dims["Confirmed Success"] ?? Object.values(dims)[0] ?? null) : null;
		return { name: r.model ?? r.name, rank: r.rank, score, votes: r.votes, vendor: r.vendor, ...(dims ? { dims } : {}) };
	}).filter((r) => r.name) };
}

async function getJson(url, headers = {}, ms = 15000) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), ms);
	try {
		const r = await fetch(url, { headers, signal: ctl.signal });
		if (!r.ok) return { error: `HTTP ${r.status}` };
		return { json: await r.json() };
	} catch (e) { return { error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message) }; }
	finally { clearTimeout(t); }
}

export async function refreshScores(repoRoot) {
	const out = { at: Date.now(), sources: {}, aa: [], arena: {} };
	const key = aaKey();
	if (key) {
		const r = await getJson("https://artificialanalysis.ai/api/v2/language/models", { "x-api-key": key });
		if (r.json) { out.aa = parseAA(r.json); out.sources.aa = `ok (${out.aa.length} models)`; }
		else out.sources.aa = r.error;
	} else out.sources.aa = "no key - get a free one at artificialanalysis.ai, then put it in ~/.harness/config/artificialanalysis.key";
	const latest = await getJson(`${ARENA_RAW}/latest.json`);
	const top = latest.json?.date ?? latest.json?.path ?? null;
	if (top) {
		const t0 = Date.parse(top + "T12:00:00Z");
		for (let back = 0; back <= 30 && !Object.keys(out.arena).length; back++) {
			const day = new Date(t0 - back * 86400e3).toISOString().slice(0, 10);
			const idx = await getJson(`${ARENA_RAW}/${day}/_index.json`);
			const have = Object.keys(idx.json?.leaderboards ?? {});
			if (!have.length) continue;
			for (const b of ARENA_BOARDS.filter((x) => have.includes(x))) {
				const r = await getJson(`${ARENA_RAW}/${day}/${b}.json`);
				if (r.json) out.arena[b] = parseArena(r.json);
			}
			out.sources.arena = `snapshot ${day}${back ? ` (newest with data; ${top} was empty)` : ""}: ${Object.keys(out.arena).join(", ")}`;
		}
		if (!out.sources.arena) out.sources.arena = `no snapshot with data in the 30 days before ${top}`;
	} else out.sources.arena = latest.error ?? "mirror: no latest.json";
	const p = join(repoRoot, ".pi-session", "routing", "scores.json");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
	return out;
}
export const loadScores = (repoRoot) => readJson(join(repoRoot, ".pi-session", "routing", "scores.json")) ?? {};
export function scoresAreOld(repoRoot, now = Date.now()) { const s = loadScores(repoRoot); return !s.at || now - s.at > SCORES_MAX_AGE_MS; }

// --- own track record (from fleet-status's merged guard/cost data) -------------
export function ownRecord(fleet, names) {
	const wants = names.map(baseName);
	const agg = { turns: 0, violations: 0, blocked: 0, hardStops: 0, gatePassed: 0, gateExhausted: 0, gateFired: 0, models: [] };
	for (const m of new Set([...Object.keys(fleet?.costByModel ?? {}), ...Object.keys(fleet?.guardByModel ?? {})])) {
		if (!wants.includes(baseName(m))) continue;
		const k = fleet.costByModel?.[m] ?? {};
		const g = fleet.guardByModel?.[m]?.events ?? {};
		agg.models.push(m);
		agg.turns += k.messages ?? 0;
		agg.violations += g.violation ?? 0;
		agg.blocked += g.blocked ?? 0;
		agg.hardStops += g.hard_stop_engaged ?? 0;
		agg.gatePassed += g.completion_gate_passed ?? 0;
		agg.gateExhausted += g.completion_gate_exhausted ?? 0;
		agg.gateFired += g.completion_gate_fired ?? 0;
	}
	if (!agg.models.length) return null;
	agg.violPer100 = agg.turns ? (100 * agg.violations) / agg.turns : null;
	agg.blockPer100 = agg.turns ? (100 * agg.blocked) / agg.turns : null;
	// 0-100 "behaves well here": starts at 80, loses for rule-breaking and gave-up runs, gains for passed gates.
	// Few turns -> pulled toward the 80 prior (shown with its n so nobody over-reads it).
	if (agg.turns) {
		const raw = 80 - 6 * (agg.violPer100 ?? 0) - 3 * (agg.blockPer100 ?? 0) - 15 * agg.hardStops - 10 * agg.gateExhausted + 3 * Math.min(5, agg.gatePassed);
		const w = Math.min(1, agg.turns / 100);
		agg.reliability = Math.round(Math.max(0, Math.min(100, 80 + (raw - 80) * w)));
	}
	return agg;
}

// --- one row per catalog model ------------------------------------------------
export function scoreTable(catalog, scores, fleet) {
	const rows = [];
	for (const m of catalog.models ?? []) {
		const names = [m.score_name, m.model && m.model !== "opus" && m.model !== "sonnet" ? m.model : null, m.id].filter(Boolean);
		const aa = matchModel(names, scores.aa ?? [], (r) => r.coding ?? r.intelligence);
		const arena = {};
		for (const b of ARENA_BOARDS) {
			const hit = matchModel(names, scores.arena?.[b]?.rows ?? [], (r) => r.score);
			if (hit) arena[b] = { ...hit.row, exact: hit.exact, of: scores.arena[b].count };
		}
		rows.push({
			id: m.id, tier: m.tier, cost: m.cost, visual: !!m.visual, enabled: m.enabled !== false,
			aa: aa ? { ...aa.row, exact: aa.exact } : null, arena,
			own: ownRecord(fleet, [m.id, ...(m.score_name ? [m.score_name] : [])]),
		});
	}
	return rows;
}

/** Plain-language hints where public scores disagree with the catalog tiers. */
export function tierHints(rows) {
	const hints = [];
	const metric = (r) => r.aa?.coding ?? (r.arena.code ? r.arena.code.score : null);
	const kind = (r) => r.aa?.coding != null ? "coding index" : "Arena code";
	const scored = rows.filter((r) => r.enabled && metric(r) != null);
	for (const lo of scored) for (const hi of scored) {
		if (lo.tier >= hi.tier || kind(lo) !== kind(hi)) continue;
		const margin = kind(lo) === "Arena code" ? 25 : 3;
		if (metric(lo) > metric(hi) + margin) hints.push(`${lo.id} (t${lo.tier}) out-scores ${hi.id} (t${hi.tier}) on ${kind(lo)} - consider raising it a tier or lowering the other`);
	}
	for (const r of rows.filter((x) => x.enabled && x.own?.reliability != null && x.own.turns >= 50 && x.own.reliability < 55)) hints.push(`${r.id} behaves poorly here (reliability ${r.own.reliability}/100 over ${r.own.turns} turns) - consider disabling or lowering it`);
	return hints;
}

// --- CLI ----------------------------------------------------------------------
async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repoRoot = process.env.HARNESS_REPO_ROOT || (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return resolve(HERE, ".."); } })();
	if (argv.includes("--refresh") || scoresAreOld(repoRoot)) await refreshScores(repoRoot);
	const scores = loadScores(repoRoot);
	const catalog = readJson(join(repoRoot, "herdr-plugin", "models.catalog.json")) ?? { models: [] };
	let fleet = {};
	try { const f = await import("./fleet-status.mjs"); fleet = f.mergeFleet(f.discoverSessionDirs(repoRoot).map((d) => f.aggregateSessionDir(d))); } catch { /* no fleet */ }
	const rows = scoreTable(catalog, scores, fleet);
	if (argv.includes("--json")) { console.log(JSON.stringify({ sources: scores.sources, rows, hints: tierHints(rows) }, null, 2)); return 0; }
	for (const r of rows) console.log(`t${r.tier} ${r.id.padEnd(50)} AA coding ${r.aa?.coding ?? "-"}  Arena code ${r.arena.code ? `#${r.arena.code.rank} ${r.arena.code.score}` : "-"}  own ${r.own?.reliability ?? "-"}`);
	for (const h of tierHints(rows)) console.log("hint: " + h);
	console.log(`sources: ${JSON.stringify(scores.sources)}`);
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	ok(baseName("openai-codex/gpt-6-astra") === "gpt-6-astra", "strip provider");
	ok(baseName("gpt-6-astra-max") === "gpt-6-astra", "strip effort variant");
	ok(baseName("GPT-6 Astra (xHigh)") === "gpt-6-astra", "display name + (xHigh)");
	ok(baseName("gpt-5.6-sol-xhigh (codex-harness)") === "gpt-5-6-sol", "dots, effort and harness tag");
	ok(baseName("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free") === "nemotron-3-ultra-550b", "strips :free and active-param tag");
	ok(baseName("claude-opus-5.5") !== baseName("claude-opus-5-max"), "different versions do NOT match");
	ok(baseName("deepseek-v4.1-flash-max") === baseName("opencode/deepseek-v4.1-flash"), "deepseek variant matches");
	const ag = parseArena({ meta: { leaderboard: "agent" }, models: [{ rank: 2, model: "GPT 6 Astra (Max)", scores: [{ name: "Net Improvement", score: 9.1 }, { name: "Confirmed Success", score: 15.2 }] }] });
	ok(ag.rows[0].score === 15.2 && baseName(ag.rows[0].name) === "gpt-6-astra", "agent board: Confirmed Success + display-name matching");
	const arena = parseArena({ fetched_at: "2026-09-21", models: [{ rank: 1, model: "gpt-6-astra-max", score: 1800 }, { rank: 16, model: "deepseek-v4.1-flash-max", score: 1614 }, { rank: 20, model: "gemini-3.7-flash-high", score: 1587 }] });
	const aa = parseAA({ data: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", evaluations: { artificial_analysis_coding_index: 71, artificial_analysis_intelligence_index: 74 } }, { slug: "gpt-6-luna", evaluations: { artificial_analysis_coding_index: 52 } }, { slug: "deepseek-v4-1-flash", evaluations: { artificial_analysis_coding_index: 58 } }] });
	ok(aa[0].coding === 71 && aa[0].intelligence === 74, "parses AA nested evaluations");
	const catalog = { models: [
		{ id: "openai-codex/gpt-6-astra", tier: 4, cost: "sub", visual: true },
		{ id: "openai-codex/gpt-6-luna", tier: 2, cost: "sub" },
		{ id: "opencode/deepseek-v4.1-flash", tier: 2, cost: "metered" },
		{ id: "antigravity/gemini-3.8-flash", tier: 2, cost: "sub" },
		{ id: "openai-codex/gpt-6.1-sol", tier: 3, cost: "sub" },
	] };
	const aa2 = [...aa, { name: "gpt-6-1-sol", coding: 50 }];
	const fleet = { costByModel: { "openai/gpt-6-luna": { messages: 122 } }, guardByModel: { "openai/gpt-6-luna": { events: { violation: 2, blocked: 2 } } } };
	const rows = scoreTable(catalog, { aa: aa2, arena: { code: arena } }, fleet);
	const astra = rows.find((r) => r.id.endsWith("astra"));
	ok(astra.aa.coding === 71 && astra.arena.code.rank === 1 && !astra.arena.code.exact, "astra: AA exact + Arena variant (≈)");
	ok(!rows.find((r) => r.id.includes("gemini")).arena.code, "gemini 3.8 does not match 3.7");
	const luna = rows.find((r) => r.id.endsWith("luna"));
	ok(luna.own?.turns === 122 && luna.own.reliability > 0 && luna.own.reliability <= 80, "own record across providers (openai/ + openai-codex/)");
	const hints = tierHints(rows);
	ok(hints.some((h) => /deepseek.*out-scores.*gpt-6.1-sol/.test(h)), "hint when a t2 model out-codes a t3 model");
	if (fails) { console.error(`${fails} model-scores self-test(s) FAILED`); return 1; }
	console.log("model-scores self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((c) => process.exit(c ?? 0), (e) => { console.error(e); process.exit(1); });
}
