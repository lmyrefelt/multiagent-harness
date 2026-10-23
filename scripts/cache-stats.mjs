#!/usr/bin/env node
/**
 * cache-stats.mjs - how much of each model's input was served from the prompt cache, from the
 * agents' own session logs (pi, Claude Code, Codex, Antigravity) under .pi-session and every
 * worktree. Writes .pi-session/routing/cache-stats.json; the dashboard's Outcomes tab shows it.
 *
 *   node scripts/cache-stats.mjs [--days 7] [--print]
 *   node scripts/cache-stats.mjs --selftest
 *
 * hit% = cached input / all input (fresh + cache writes + cached). Fresh input is what you pay full price for; a low hit% on a
 * model that ran long sessions means its provider is not caching (or the cache keeps expiring).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One session-log line -> { model, fresh, cached, written } or null. Pure. */
export function usageOf(o) {
	const m = o.message;
	if (m?.role === "assistant" && m.usage && m.usage.input != null) // pi
		return { model: m.provider && m.model ? `${m.provider}/${m.model}` : m.model ?? "?", fresh: m.usage.input || 0, cached: m.usage.cacheRead || 0, written: m.usage.cacheWrite || 0, key: null };
	if (o.type === "assistant" && m?.usage && m.usage.input_tokens != null) // Claude Code (one line per content block -> dedupe by message id)
		return { model: m.model ? `anthropic/${m.model}` : "anthropic/?", fresh: m.usage.input_tokens || 0, cached: m.usage.cache_read_input_tokens || 0, written: m.usage.cache_creation_input_tokens || 0, key: m.id ?? o.requestId ?? null };
	const info = o.payload?.type === "token_count" ? o.payload.info : null; // Codex (input includes cached)
	if (info?.last_token_usage) { const u = info.last_token_usage; return { model: "codex", fresh: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), cached: u.cached_input_tokens || 0, written: 0, key: null }; }
	if (o.type === "turn_context" && o.payload?.model) return { model: `codex/${o.payload.model}`, setModel: true };
	if (o.type === "PLANNER_RESPONSE" && o.input_tokens != null) // Antigravity
		return { model: "antigravity", fresh: Math.max(0, Number(o.input_tokens) - Number(o.cache_read_tokens || 0)), cached: Number(o.cache_read_tokens || 0), written: 0, key: null };
	return null;
}

export function aggregate(lines, into = {}) {
	const seen = new Set();
	let codexModel = "codex";
	for (const l of lines) {
		if (!/usage|token_count|turn_context|PLANNER_RESPONSE/.test(l)) continue;
		let o; try { o = JSON.parse(l); } catch { continue; }
		const u = usageOf(o);
		if (!u) continue;
		if (u.setModel) { codexModel = u.model; continue; }
		if (u.key) { if (seen.has(u.key)) continue; seen.add(u.key); }
		const model = u.model === "codex" ? codexModel : u.model;
		const g = (into[model] ??= { fresh: 0, cached: 0, written: 0, turns: 0 });
		g.fresh += u.fresh; g.cached += u.cached; g.written += u.written; g.turns++;
	}
	return into;
}

function logs(dir, since, out = [], depth = 7) {
	let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of es) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (depth > 0 && !["handoff", "tool-results", "chunks", "triage", "qualify", "bench", "briefs", "routing", "herdr-lifecycle"].includes(e.name)) logs(p, since, out, depth - 1); }
		else if (/\.jsonl$/.test(e.name) && !/^(evidence|events|decisions|usage-history)/.test(e.name) && !p.includes("/chunks/")) { try { if (statSync(p).mtimeMs >= since) out.push(p); } catch { /* */ } }
	}
	return out;
}

export function computeCacheStats(repo, days = 7) {
	const since = Date.now() - days * 86400e3;
	const dirs = [join(repo, ".pi-session")];
	try { for (const w of readdirSync(join(repo, ".worktrees"))) dirs.push(join(repo, ".worktrees", w, ".pi-session")); } catch { /* none */ }
	const agg = {};
	for (const d of dirs) for (const f of logs(d, since)) { try { aggregate(readFileSync(f, "utf8").split("\n"), agg); } catch { /* */ } }
	const models = Object.entries(agg).map(([model, g]) => ({ model, ...g, hitPct: g.fresh + g.cached + g.written ? Math.round((1000 * g.cached) / (g.fresh + g.cached + g.written)) / 10 : null })).filter((m) => m.turns).sort((a, b) => (b.fresh + b.cached) - (a.fresh + a.cached));
	const out = { at: Date.now(), days, models };
	mkdirSync(join(repo, ".pi-session", "routing"), { recursive: true });
	writeFileSync(join(repo, ".pi-session", "routing", "cache-stats.json"), JSON.stringify(out, null, 1));
	return out;
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repo = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
	const i = argv.indexOf("--days");
	const o = computeCacheStats(repo, i >= 0 ? Number(argv[i + 1]) : 7);
	if (argv.includes("--print")) for (const m of o.models) console.log(`${m.model.padEnd(48)} hit ${String(m.hitPct ?? "-").padStart(5)}%  fresh ${(m.fresh / 1e6).toFixed(1)}M  cached ${(m.cached / 1e6).toFixed(1)}M  turns ${m.turns}`);
	else console.log(`wrote .pi-session/routing/cache-stats.json (${o.models.length} models, last ${o.days} days)`);
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };

	const usageTests = [
		// pi
		[{ message: { role: "assistant", provider: "openai", model: "gpt-4", usage: { input: 10, cacheRead: 5, cacheWrite: 2 } } }, { model: "openai/gpt-4", fresh: 10, cached: 5, written: 2, key: null }, "usageOf: pi with provider and model"],
		[{ message: { role: "assistant", model: "gpt-4", usage: { input: 10, cacheRead: 5, cacheWrite: 2 } } }, { model: "gpt-4", fresh: 10, cached: 5, written: 2, key: null }, "usageOf: pi without provider"],
		[{ message: { role: "assistant", usage: { input: 5 } } }, { model: "?", fresh: 5, cached: 0, written: 0, key: null }, "usageOf: pi without provider and model"],
		// Claude Code
		[{ type: "assistant", message: { id: "msg1", model: "claude-3", usage: { input_tokens: 20, cache_read_input_tokens: 15, cache_creation_input_tokens: 5 } } }, { model: "anthropic/claude-3", fresh: 20, cached: 15, written: 5, key: "msg1" }, "usageOf: Claude Code with model and id"],
		[{ type: "assistant", requestId: "req1", message: { usage: { input_tokens: 5 } } }, { model: "anthropic/?", fresh: 5, cached: 0, written: 0, key: "req1" }, "usageOf: Claude Code with requestId and no model"],
		// Codex
		[{ payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40 } } } }, { model: "codex", fresh: 60, cached: 40, written: 0, key: null }, "usageOf: Codex token_count"],
		[{ type: "turn_context", payload: { model: "gpt-4o" } }, { model: "codex/gpt-4o", setModel: true }, "usageOf: Codex turn_context"],
		// Antigravity
		[{ type: "PLANNER_RESPONSE", input_tokens: 150, cache_read_tokens: 50 }, { model: "antigravity", fresh: 100, cached: 50, written: 0, key: null }, "usageOf: Antigravity PLANNER_RESPONSE"],
		// Non-matching
		[{ type: "unknown" }, null, "usageOf: unknown type returns null"],
		[{}, null, "usageOf: empty object returns null"]
	];
	for (const [input, expected, msg] of usageTests) {
		const result = usageOf(input);
		ok(JSON.stringify(result) === JSON.stringify(expected), msg);
	}

	const L = [
		JSON.stringify({ type: "message", message: { role: "assistant", provider: "opencode", model: "x", usage: { input: 100, cacheRead: 900, cacheWrite: 0 } } }),
		JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 50 } } }),
		JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 50 } } }),
		JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
		JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600 } } } }),
		JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: "500", cache_read_tokens: "0" }),
	];
	const a = aggregate(L);
	ok(a["opencode/x"].cached === 900 && a["opencode/x"].fresh === 100, "pi usage");
	ok(a["anthropic/claude-opus-5-5"].turns === 1 && a["anthropic/claude-opus-5-5"].cached === 990, "Claude Code, deduped by message id");
	ok(a["codex/gpt-6.1-sol"].fresh === 400 && a["codex/gpt-6.1-sol"].cached === 600, "Codex: cached is part of input");
	ok(a.antigravity.fresh === 500, "Antigravity");

	// Test accumulation into an existing object
	const existingObj = {
		"antigravity": { fresh: 100, cached: 200, written: 50, turns: 2 }
	};
	const newLines = [
		JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: "300", cache_read_tokens: "150" }),
		'{"type": "PLANNER_RESPONSE", invalid json that still matches usage|token_count|turn_context|PLANNER_RESPONSE regex}',
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10 } } }) // no provider/model
	];
	const a2 = aggregate(newLines, existingObj);
	ok(a2 === existingObj, "aggregate returns the mutated input object");
	ok(a2.antigravity.fresh === 250, "accumulates fresh (100 + (300-150))");
	ok(a2.antigravity.cached === 350, "accumulates cached (200 + 150)");
	ok(a2.antigravity.turns === 3, "accumulates turns (2 + 1)");
	ok(a2["?"].fresh === 10, "adds new model to existing object");

	if (fails) { console.error(`${fails} cache-stats self-test(s) FAILED`); return 1; }
	console.log("cache-stats self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
