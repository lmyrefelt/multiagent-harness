#!/usr/bin/env node
// gen-compaction-overrides — pi compaction.modelOverrides from the model catalog.
//
// WHY. pi compacts when context > contextWindow - reserveTokens. The global
// reserveTokens (16384) is sized for ~128K local models; on a 272K-1M window it
// means compaction (almost) never fires. settings.defaults.json already said
// "reserveTokens = contextWindow - target" per big model - but only a handful
// of hand-typed keys existed, and NONE matched the models actually running.
// MEASURED (token-audit, 2026-10-20): 0 overrides applied to the pi models with
// >200K calls (opencode-go/mimo-v2.6-flash, openrouter/nvidia/nemotron-3-ultra,
// openrouter/anthropic/claude-opus-5.5, opencode/deepseek-v4.1-flash, GPT-6.x).
//
// So: generate one entry per catalog model whose window is comfortably above
// the target, keyed by the catalog id (= pi's provider/modelId - verified
// against real session files' provider/model fields). Hand-written entries
// (e.g. local/*) are kept untouched; generated keys are listed in
// _compaction_generated so a re-run can replace exactly those.
//
//   node scripts/gen-compaction-overrides.mjs            dry run: print the diff
//   node scripts/gen-compaction-overrides.mjs --write    update settings.defaults.json
//   node scripts/gen-compaction-overrides.mjs --selftest
// Target: HARNESS_COMPACT_AT (default 200000; <100000 = remove generated entries).
// pi bakes settings.defaults.json into the image: rebuild after --write.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MARGIN = 40000; // a window this close to the target gains nothing from an override

export function windowsFromCatalog(cat) {
	const out = {};
	// only models pi itself runs (other backends have their own knob in launch-*.sh)
	const onPi = (m) => !m.backend || m.backend === "pi" || (m.backends ?? []).includes("pi");
	for (const m of cat.models ?? []) if (m.id && onPi(m) && Number(m.context_window) > 0 && !String(m.id).endsWith("/default")) out[m.id] = Number(m.context_window);
	for (const [id, w] of Object.entries(cat.context_windows ?? {})) if (Number(w) > 0) out[id] ??= Number(w);
	return out;
}

export function plan(settings, windows, target) {
	const comp = settings.compaction ?? {};
	const old = comp.modelOverrides ?? {};
	const prevGen = new Set(settings._compaction_generated ?? comp._generated ?? []);
	const manual = Object.fromEntries(Object.entries(old).filter(([k]) => !prevGen.has(k)));
	const gen = {};
	if (target >= 100000)
		for (const [id, w] of Object.entries(windows).sort())
			if (!(id in manual) && w > target + MARGIN) gen[id] = { reserveTokens: w - target };
	const { _generated, ...compClean } = comp; // older runs kept the list inside compaction
	// The list lives at the TOP level (like _comment), not inside pi's own
	// compaction block, so pi never sees a key it doesn't know.
	return { ...settings, _compaction_generated: Object.keys(gen), compaction: { ...compClean, modelOverrides: { ...manual, ...gen } } };
}

function main() {
	const target = Number(process.env.HARNESS_COMPACT_AT ?? 200000);
	const catPath = [join(REPO, "herdr-plugin", "models.catalog.json")].find(existsSync);
	const setPath = ["contracts", "pi-contracts-research"].map((d) => join(REPO, d, "settings.defaults.json")).find(existsSync); // contracts/ = a bootstrapped project (the export ships pi-contracts-research/);
	if (!catPath || !setPath) { console.error("gen-compaction-overrides: catalog or settings.defaults.json not found"); process.exit(1); }
	const settings = JSON.parse(readFileSync(setPath, "utf8"));
	const next = plan(settings, windowsFromCatalog(JSON.parse(readFileSync(catPath, "utf8"))), target);
	const before = settings.compaction?.modelOverrides ?? {}, after = next.compaction.modelOverrides;
	for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const a = before[k]?.reserveTokens, b = after[k]?.reserveTokens;
		if (a !== b) console.log(`${a === undefined ? "+" : b === undefined ? "-" : "~"} ${k}: ${a ?? "-"} -> ${b ?? "-"}${b ? `  (compacts at ~${Math.round((windowsFromCatalog(JSON.parse(readFileSync(catPath, "utf8")))[k] - b) / 1000)}k)` : ""}`);
	}
	if (process.argv.includes("--write")) { writeFileSync(setPath, JSON.stringify(next, null, 2) + "\n"); console.log(`wrote ${setPath} - rebuild the pi images to apply`); }
	else console.log("(dry run - pass --write to apply)");
}

function selftest() {
	let f = 0; const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); f++; } };
	const w = windowsFromCatalog({ models: [{ id: "c/claude-only", backend: "claude", context_window: 1000000 }, { id: "a/big", context_window: 1000000 }, { id: "a/mid", context_window: 272000 }, { id: "a/small", context_window: 200000 }, { id: "x/default", context_window: 1000000 }], context_windows: { "b/extra": 1000000 } });
	ok(!("c/claude-only" in w), "non-pi backends skipped");
	ok(w["a/big"] === 1e6 && !("x/default" in w) && w["b/extra"] === 1e6, "catalog windows (skips */default)");
	const s0 = { _compaction_generated: ["a/big"], compaction: { reserveTokens: 16384, modelOverrides: { "local/q": { reserveTokens: 28000 }, "a/big": { reserveTokens: 1 } } } };
	const p = plan(s0, w, 200000).compaction;
	ok(p.modelOverrides["local/q"].reserveTokens === 28000, "manual entries kept");
	ok(p.modelOverrides["a/big"].reserveTokens === 800000 && p.modelOverrides["a/mid"].reserveTokens === 72000, "reserve = window - target");
	ok(!("a/small" in p.modelOverrides), "window within margin of target: no override");
	ok(Object.keys(plan(s0, w, 0).compaction.modelOverrides).join() === "local/q", "target 0 removes generated entries only");
	ok(p.reserveTokens === 16384 && !("_generated" in p), "global defaults untouched; pi's compaction block has no foreign keys");
	if (f) process.exit(1); console.log("gen-compaction-overrides self-test: all passed");
}

if (process.argv.includes("--selftest")) selftest(); else main();
