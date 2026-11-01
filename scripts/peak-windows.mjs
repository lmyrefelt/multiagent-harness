#!/usr/bin/env node
/**
 * peak-windows.mjs - provider peak windows (herdr-plugin/peak-windows.json), shared by
 * cost-ledger.mjs (tag turns, test the meters) and route-worker.mjs (penalty while open).
 *
 * Every helper is pure except the two loaders. Times are evaluated in the window's own time
 * zone, so daylight-saving gaps between Europe and the US need no special handling.
 *
 *   node scripts/peak-windows.mjs            # which windows are open now, and when they next change
 *   node scripts/peak-windows.mjs --selftest
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TEST = { model_share: 0.8, min_spans: 5, min_points: 5, passes_through_ratio: 1.6, flat_ratio: 1.25 };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** peak-windows.json from the repo (falls back to the copy next to this script). Never throws. */
export function loadPeakConfig(repoRoot = resolve(HERE, "..")) {
	const raw = readJson(join(repoRoot, "herdr-plugin", "peak-windows.json")) ?? readJson(join(HERE, "..", "herdr-plugin", "peak-windows.json")) ?? {};
	return { penalty: raw.penalty ?? 3, windows: Array.isArray(raw.windows) ? raw.windows : [], test: { ...DEFAULT_TEST, ...(raw.test ?? {}) } };
}

/** Window-test verdicts written by cost-ledger.mjs: {id: {verdict, ratio, ...}}. Never throws. */
export function loadWindowVerdicts(repoRoot) {
	return readJson(join(repoRoot, ".pi-session", "routing", "ledger-summary.json"))?.windowTests ?? {};
}

const fmtCache = new Map();
function partsIn(tz, ms) {
	if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }));
	const p = Object.fromEntries(fmtCache.get(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return { day: p.weekday, hour: Number(p.hour) + Number(p.minute) / 60 };
}

/** Is ms inside window w? null for a bad timestamp. Pure. */
export function inWindow(w, ms) {
	if (!Number.isFinite(ms) || !w) return null;
	const { day, hour } = partsIn(w.tz ?? "UTC", ms);
	if (w.days && !w.days.includes(day)) return false;
	return (w.hours ?? []).some(([a, b]) => hour >= a && hour < b);
}

/** Does window w apply to this model? Free models never do. Pure. */
export function appliesTo(w, { id = "", cost = null } = {}) {
	if (cost === "free" || /-free$/.test(id)) return false;
	const re = w?.applies?.model;
	return !!re && new RegExp(re, "i").test(id);
}

/** Ids of the windows open at ms. Pure. */
export function openAt(cfg, ms) { return (cfg.windows ?? []).filter((w) => inWindow(w, ms)).map((w) => w.id); }

/** Next time the window opens (or closes, if open now), searched in 5-minute steps up to 8 days. Pure. */
export function nextChange(w, ms) {
	const now = inWindow(w, ms);
	const step = 5 * 60e3;
	let t = Math.ceil(ms / step) * step;
	for (let i = 0; i < (8 * 86400e3) / step; i++, t += step) if (inWindow(w, t) !== now) return { at: t, opens: !now };
	return null;
}

/**
 * Should the router see this window as real? 'published' always; 'measure' only once the
 * ledger's window test came back 'passes_through'. Pure.
 */
export function windowEnforced(w, verdicts = {}) {
	if (w.status === "published") return true;
	return verdicts?.[w.id]?.verdict === "passes_through";
}

/** Router cost points for a model right now: {points, notes[], measuring[]}. Pure. */
export function routerPenalty(cfg, model, now, verdicts = {}) {
	const out = { points: 0, notes: [], measuring: [] };
	if (!cfg?.windows?.length) return out;
	const id = model?.id ?? "";
	const ids = [id, model?.model, model?.opencode_model, model?.pi_model].filter(Boolean);
	for (const w of cfg.windows) {
		if (!ids.some((x) => appliesTo(w, { id: x, cost: model?.cost }))) continue;
		if (!inWindow(w, now)) continue;
		if (windowEnforced(w, verdicts)) { out.points += cfg.penalty ?? 3; out.notes.push(`${w.label ?? w.id} now (+${cfg.penalty ?? 3})`); }
		else out.measuring.push(w.id);
	}
	return out;
}

// ---------------------------------------------------------------------------
function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const cfg = loadPeakConfig();
	const A = cfg.windows.find((w) => w.id === "anthropic"), D = cfg.windows.find((w) => w.id === "deepseek");
	ok(A && D, "both windows load from herdr-plugin/peak-windows.json");
	// Anthropic: weekdays 05-11 LA. 2026-11-04 (Wed) after US DST ended: 13:30Z = 05:30 PST
	ok(inWindow(A, Date.parse("2026-11-04T13:30:00Z")) === true, "05:30 PST Wednesday is peak");
	ok(inWindow(A, Date.parse("2026-11-04T12:30:00Z")) === false, "04:30 PST is not");
	ok(inWindow(A, Date.parse("2026-10-28T12:30:00Z")) === true, "DST gap: 05:30 PDT (13:30 Oslo) is peak");
	ok(inWindow(A, Date.parse("2026-10-31T15:00:00Z")) === false, "Saturday never");
	// DeepSeek: weekdays 01-04 and 06-10 UTC
	ok(inWindow(D, Date.parse("2026-11-02T01:30:00Z")) && inWindow(D, Date.parse("2026-11-02T09:59:00Z")), "Monday 01:30Z and 09:59Z are DeepSeek peak");
	ok(!inWindow(D, Date.parse("2026-11-02T04:30:00Z")) && !inWindow(D, Date.parse("2026-11-02T10:00:00Z")), "04:30Z and 10:00Z are not");
	ok(!inWindow(D, Date.parse("2026-11-01T02:00:00Z")), "Sunday is not");
	ok(inWindow(A, Number.NaN) === null, "bad timestamp -> null");
	// applies
	ok(appliesTo(D, { id: "opencode-go/deepseek-v4.1-flash", cost: "sub" }), "paid Go DeepSeek is covered");
	ok(!appliesTo(D, { id: "opencode/deepseek-v4.1-flash-free", cost: "free" }), "free DeepSeek is exempt");
	ok(appliesTo(A, { id: "anthropic/claude-sonnet-5-5" }) && appliesTo(A, { id: "claude/opus" }) && !appliesTo(A, { id: "codex/gpt-6.1" }), "anthropic matching");
	// nextChange
	const nc = nextChange(D, Date.parse("2026-11-02T03:58:00Z"));
	ok(nc && nc.opens === false && nc.at === Date.parse("2026-11-02T04:00:00Z"), `DeepSeek closes 04:00Z (got ${JSON.stringify(nc)})`);
	const no = nextChange(D, Date.parse("2026-10-31T12:00:00Z"));
	ok(no && no.opens && no.at === Date.parse("2026-11-02T01:00:00Z"), "Saturday -> next opens Monday 01:00Z");
	// router penalty
	const peakBoth = Date.parse("2026-11-02T09:00:00Z"); // DeepSeek open, Anthropic closed (01:00 PST)
	const dsModel = { id: "opencode-go/deepseek-v4.1-flash", cost: "sub" };
	let p = routerPenalty(cfg, dsModel, peakBoth, {});
	ok(p.points === 0 && p.measuring.includes("deepseek"), "DeepSeek window only measured until the ledger confirms");
	p = routerPenalty(cfg, dsModel, peakBoth, { deepseek: { verdict: "passes_through" } });
	ok(p.points === cfg.penalty, "confirmed pass-through -> penalty");
	p = routerPenalty(cfg, { id: "anthropic/claude-sonnet-5-5", cost: "sub" }, Date.parse("2026-11-02T14:00:00Z"), {});
	ok(p.points === cfg.penalty && /Anthropic/.test(p.notes[0]), "Claude penalised at 06:00 PST Monday");
	p = routerPenalty(cfg, { id: "opencode/deepseek-v4.1-flash-free", cost: "free" }, peakBoth, { deepseek: { verdict: "passes_through" } });
	ok(p.points === 0 && !p.measuring.length, "free model untouched");
	console.log(fails ? `peak-windows self-test: ${fails} failed` : "peak-windows self-test: all passed");
	return fails ? 1 : 0;
}

function main() {
	if (process.argv.includes("--selftest")) return selftest();
	const repo = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
	const cfg = loadPeakConfig(repo), verdicts = loadWindowVerdicts(repo), now = Date.now();
	const local = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
	for (const w of cfg.windows) {
		const open = inWindow(w, now), nc = nextChange(w, now), v = verdicts[w.id];
		const router = windowEnforced(w, verdicts) ? "router penalty ON" : `router penalty off (${v?.verdict ?? "not measured yet"})`;
		console.log(`${(w.label ?? w.id).padEnd(16)} ${open ? "OPEN  " : "closed"}  ${nc ? `${nc.opens ? "opens" : "closes"} ${local(nc.at)}` : ""}  ${w.status}, ${router}`);
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
