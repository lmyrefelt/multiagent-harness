#!/usr/bin/env node
/**
 * plan-pricing.mjs - what each catalog model REALLY costs on the plan you use it through,
 * and its public leaderboard scores, from Real API Pricing (github.com/FeiZhuLulu/real-api-pricing,
 * MIT; site realapipricing.com). Cached in .pi-session/routing/pricing.json, refreshed at most daily.
 *
 * Per plan x model the dataset gives:
 *   monthly_tokens      tokens/month at saturated use (their convention: 97% cache reads,
 *                       2.5% fresh input, 0.5% output; 4-week month), with a confidence rating
 *   real_usd_per_mtok   monthly fee / monthly_tokens  (metered APIs: blended list price)
 *   scores              AA Intelligence, AA Coding Agent, Terminal-Bench 4, AA Terminal-Bench 4,
 *                       Arena Code, Arena Agent Mode, Open Design Arena, DeepSWE 1.1
 *
 * Mapping (catalog -> dataset): the model's provider picks the plan
 *   openai-codex/*, codex/* -> ChatGPT Plus      claude/*, anthropic/* -> Claude Pro
 *   opencode-go/*           -> OpenCode Go       antigravity/*         -> Google AI Pro
 * (catalog.pricing_plans overrides these; an entry can pin {"pricing": {"plan": "...", "model": "..."}}).
 * Pay-per-token providers (openai/, opencode/, openrouter/ non-free) use the model's cheapest
 * metered row. The model name is matched loosely (gpt-6.1-sol == GPT-6.1 Sol == gpt-6-1-sol).
 *
 *   node scripts/plan-pricing.mjs            table for the catalog
 *   node scripts/plan-pricing.mjs --refresh  fetch again now
 *   node scripts/plan-pricing.mjs --selftest
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PRICING_URL = "https://raw.githubusercontent.com/FeiZhuLulu/real-api-pricing/main/derived/points.csv";
export const PRICING_MAX_AGE_MS = 24 * 3600e3;
export const BOARDS = {
	aa_intelligence_index: "AA intel",
	aa_coding_agent_index: "AA coding agent",
	terminal_bench_4: "Terminal-Bench 4",
	aa_terminal_bench_4: "AA Terminal-Bench 4",
	arena_code: "Arena code",
	arena_agent_mode: "Arena agent",
	open_design_arena: "Open Design Arena",
	deepswe_1_1: "DeepSWE 1.1",
};
export const DEFAULT_PLANS = {
	"openai-codex": "ChatGPT Plus", codex: "ChatGPT Plus",
	claude: "Claude Pro", anthropic: "Claude Pro",
	"opencode-go": "OpenCode Go",
	antigravity: "Google AI Pro",
};
const METERED = new Set(["openai", "opencode", "openrouter", "deepseek", "xiaomi"]);

/** RFC-4180-ish CSV (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
	const rows = [];
	let row = [], field = "", q = false;
	const s = String(text).replace(/^﻿/, "");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (q) {
			if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
			else field += ch;
		} else if (ch === '"') q = true;
		else if (ch === ",") { row.push(field); field = ""; }
		else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
		else field += ch;
	}
	if (field || row.length) { row.push(field); rows.push(row); }
	const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const num = (v) => { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; };
export function compactRows(records) {
	return records.map((r) => {
		const scores = {};
		for (const b of Object.keys(BOARDS)) {
			const v = num(r[`${b}__score`]);
			if (v != null) scores[b] = { score: v, variant: r[`${b}__variant`] || null, estimated: r[`${b}__score_is_estimated`] === "True" || r[`${b}__score_is_estimated`] === "true" };
		}
		return {
			id: r.id, plan: r.plan, billing: r.billing, model: r.model, display: r.model_display, vendor: r.vendor,
			fee_usd: num(r.price_usd),
			monthly_tokens: num(r.monthly_yi) != null ? Math.round(num(r.monthly_yi) * 1e8) : null, // 1 yi = 100 M
			real_usd_per_mtok: num(r.real_usd_per_mtok),
			confidence: r.confidence || null, workload: r.workload || null, data_date: r.data_date || null,
			unmetered_until: r.unmetered === "True" || r.unmetered === "true" ? (r.promo_until || "promo") : null,
			scores,
		};
	}).filter((r) => r.model);
}

export const normModel = (s) => String(s ?? "").toLowerCase().split("/").pop().replace(/:free$/, "").replace(/\(.*?\)/g, "").replace(/(\d)\.(\d)/g, "$1-$2").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The dataset row for one catalog entry, or null. */
export function rowFor(entry, rows, plans = DEFAULT_PLANS) {
	if (!entry) return null;
	const pin = entry.pricing;
	const [prov, ...rest] = String(entry.id).split("/");
	const modelName = pin?.model ?? entry.score_name ?? (entry.model && !["opus", "sonnet", "haiku"].includes(entry.model) ? entry.model : rest.join("/"));
	const want = normModel(modelName);
	const plan = pin?.plan ?? plans[prov];
	if (plan) {
		return rows.find((r) => r.plan === plan && normModel(r.model) === want)
			?? rows.find((r) => r.plan === plan && normModel(r.display) === want) ?? null;
	}
	if (METERED.has(prov) && !/:free$/.test(entry.id)) {
		const cands = rows.filter((r) => r.billing !== "subscription" && normModel(r.model) === want && r.real_usd_per_mtok != null);
		return cands.sort((a, b) => a.real_usd_per_mtok - b.real_usd_per_mtok)[0] ?? null;
	}
	return null;
}

/** Scores for a model regardless of plan (the same model on any plan has the same scores). */
export function scoresFor(entry, rows) {
	const r = rowFor(entry, rows);
	if (r && Object.keys(r.scores).length) return r.scores;
	const [, ...rest] = String(entry.id).split("/");
	const want = normModel(entry.score_name ?? rest.join("/"));
	return rows.find((x) => normModel(x.model) === want && Object.keys(x.scores).length)?.scores ?? {};
}

export async function refreshPricing(repoRoot) {
	const out = { at: Date.now(), source: PRICING_URL, rows: [], error: null };
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 20000);
		const r = await fetch(PRICING_URL, { signal: ctl.signal }).finally(() => clearTimeout(t));
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		out.rows = compactRows(parseCsv(await r.text()));
		out.snapshot = out.rows.reduce((m, r) => (r.data_date && r.data_date > m ? r.data_date : m), "");
	} catch (e) { out.error = e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message); }
	const p = join(repoRoot, ".pi-session", "routing", "pricing.json");
	if (!out.rows.length) { // keep the last good copy
		const prev = loadPricing(repoRoot);
		if (prev.rows?.length) { prev.lastError = out.error; prev.lastTry = out.at; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(prev)); return prev; }
	}
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(out));
	return out;
}
export function loadPricing(repoRoot) { try { return JSON.parse(readFileSync(join(repoRoot, ".pi-session", "routing", "pricing.json"), "utf8")); } catch { return {}; } }
export function pricingIsOld(repoRoot, now = Date.now()) { const p = loadPricing(repoRoot); return !(p.lastTry ?? p.at) || now - (p.lastTry ?? p.at) > PRICING_MAX_AGE_MS; }

/** Price per million tokens for routing: free/local = 0; plan or metered row; null = unknown. */
export function priceFor(entry, pricing, plans) {
	if (!entry) return null;
	if (entry.cost === "local" || entry.cost === "free") return { usd_per_mtok: 0, source: entry.cost };
	const r = rowFor(entry, pricing?.rows ?? [], plans);
	if (!r || r.real_usd_per_mtok == null) return null;
	return { usd_per_mtok: r.unmetered_until ? 0 : r.real_usd_per_mtok, monthly_tokens: r.monthly_tokens, confidence: r.confidence, plan: r.plan, source: r.billing === "subscription" ? "plan" : "list price" };
}

/** Best-value set: no other enabled model is at least as cheap AND at least as good (strictly better in one). */
export function paretoIds(points) {
	const ok = points.filter((p) => p.price != null && p.score != null);
	return new Set(ok.filter((p) => !ok.some((o) => o !== p && o.price <= p.price && o.score >= p.score && (o.price < p.price || o.score > p.score))).map((p) => p.id));
}

// --- CLI ----------------------------------------------------------------------
async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repoRoot = process.env.HARNESS_REPO_ROOT || (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return resolve(HERE, ".."); } })();
	if (argv.includes("--refresh") || pricingIsOld(repoRoot)) await refreshPricing(repoRoot);
	const pricing = loadPricing(repoRoot);
	let catalog = { models: [] };
	try { catalog = JSON.parse(readFileSync(join(repoRoot, "herdr-plugin", "models.catalog.json"), "utf8")); } catch { /* none */ }
	const plans = { ...DEFAULT_PLANS, ...(catalog.pricing_plans ?? {}) };
	for (const m of catalog.models ?? []) {
		const p = priceFor(m, pricing, plans), s = scoresFor(m, pricing.rows ?? []);
		console.log(`t${m.tier} ${m.id.padEnd(50)} ${p ? `$${p.usd_per_mtok.toFixed(4)}/Mtok`.padEnd(16) : "-".padEnd(16)} ${p?.monthly_tokens ? `${(p.monthly_tokens / 1e6).toFixed(0)}M/mo`.padEnd(9) : "".padEnd(9)} ${(p?.confidence ?? "").padEnd(7)} ${Object.entries(s).map(([k, v]) => `${BOARDS[k]} ${v.score}`).join(" · ")}`);
	}
	console.log(`source: ${pricing.source ?? PRICING_URL} snapshot ${pricing.snapshot ?? "?"} ${pricing.error || pricing.lastError ? `(last fetch: ${pricing.error ?? pricing.lastError})` : ""}`);
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const csv = '﻿id,plan,billing,model,model_display,price_usd,monthly_yi,real_usd_per_mtok,confidence,data_date,unmetered,promo_until,aa_coding_agent_index__score,aa_coding_agent_index__variant,open_design_arena__score,list_price\n'
		+ 'chatgpt_plus::gpt-6.1-sol,ChatGPT Plus,subscription,gpt-6.1-sol,GPT-6.1 Sol,20.0,8.7,0.023,high,2026-10-10,False,,62.9078,xhigh,90.1,\n'
		+ 'chatgpt_plus::gpt-6-astra,ChatGPT Plus,subscription,gpt-6-astra,GPT-6 Astra,20.0,1.59,0.126,high,2026-10-12,False,,61.645,,82.7,"{\'cached\': 1.0, ""x"": 2}"\n'
		+ 'opencode_go::deepseek-v4.1-flash,OpenCode Go,subscription,deepseek-v4.1-flash,DeepSeek V4.1 Flash,10.0,62.112,0.002,medium,2026-10-01,False,,,,81.2,\n'
		+ 'deepseek_api::deepseek-v4.1-flash,DeepSeek V4.1 Flash API,metered,deepseek-v4.1-flash,DeepSeek V4.1 Flash,,,0.019,high,,False,,,,81.2,\n'
		+ 'deepseek_api_offpeak::deepseek-v4.1-flash,DeepSeek V4.1 Flash API off-peak,metered,deepseek-v4.1-flash,DeepSeek V4.1 Flash,,,0.010,high,,False,,,,81.2,\n'
		+ 'claude_pro::claude-opus-5.5,Claude Pro,subscription,claude-opus-5.5,Claude Opus 5.5,20.0,30.54,0.007,high,,False,,65.9886,,,\n'
		+ 'openrouter::claude-opus-5.5,OpenRouter,metered,claude-opus-5.5,Claude Opus 5.5,,,0.419,high,,False,,65.9886,,,\n';
	const rows = compactRows(parseCsv(csv));
	ok(rows.length === 7 && rows[1].monthly_tokens === 159000000 && rows[0].scores.aa_coding_agent_index.score === 62.9078, "parses CSV (quotes, BOM, 1 yi = 100M tokens)");
	const plans = DEFAULT_PLANS;
	ok(rowFor({ id: "openai-codex/gpt-6.1-sol" }, rows, plans)?.id === "chatgpt_plus::gpt-6.1-sol", "openai-codex -> ChatGPT Plus row");
	ok(rowFor({ id: "codex/default", score_name: "gpt-6.1-sol" }, rows, plans)?.plan === "ChatGPT Plus", "codex CLI uses score_name");
	ok(rowFor({ id: "claude/opus", model: "opus", score_name: "claude-opus-5.5" }, rows, plans)?.real_usd_per_mtok === 0.007, "claude/opus -> Claude Pro, not OpenRouter");
	ok(rowFor({ id: "openrouter/anthropic/claude-opus-5.5" }, rows, plans)?.real_usd_per_mtok === 0.419, "openrouter -> metered row");
	ok(rowFor({ id: "opencode/deepseek-v4.1-flash" }, rows, plans)?.real_usd_per_mtok === 0.010, "pay-per-token -> cheapest metered row");
	ok(rowFor({ id: "opencode-go/deepseek-v4.1-flash" }, rows, plans)?.real_usd_per_mtok === 0.002, "opencode-go -> Go plan row");
	ok(priceFor({ id: "openrouter/x/y:free", cost: "free" }, { rows }).usd_per_mtok === 0, "free = 0");
	ok(scoresFor({ id: "opencode/deepseek-v4.1-flash" }, rows).open_design_arena?.score === 81.2, "scores follow the model");
	const par = paretoIds([{ id: "a", price: 0.002, score: 80 }, { id: "b", price: 0.02, score: 90 }, { id: "c", price: 0.1, score: 85 }, { id: "d", price: 0.002, score: 70 }]);
	ok(par.has("a") && par.has("b") && !par.has("c") && !par.has("d"), "pareto: c is dominated by b, d by a");
	if (fails) { console.error(`${fails} plan-pricing self-test(s) FAILED`); return 1; }
	console.log("plan-pricing self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((c) => process.exit(c ?? 0), (e) => { console.error(e); process.exit(1); });
}
