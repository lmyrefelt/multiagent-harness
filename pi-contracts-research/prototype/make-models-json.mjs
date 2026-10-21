#!/usr/bin/env node
/**
 * make-models-json — turn a probe result into a working <agent-dir>/models.json.
 *
 * WHY THIS STEP EXISTS
 * models.json ships with an empty `models: []`, deliberately, because committing
 * model ids before probing them is exactly the "a model name is not a fact"
 * error. But an empty array means NO local model is registered at all, and pi
 * cannot resolve `local/<id>` — which is why the first harness run produced
 * 5/5 INVALID with zero tool calls.
 *
 * Two things this must get right, both learned the hard way:
 *
 *  1. `baseUrl` is NOT env-interpolated. docs/models.md: "`apiKey` and header
 *     values can use `$NAME` or `${NAME}` environment interpolation" — baseUrl
 *     is not in that list. So the port has to be BAKED IN at generation time
 *     from what the probe actually reached. Passing -e LOCAL_LLM_BASE_URL does
 *     nothing for the model endpoint.
 *
 *  2. Only models the probe verified as `structured` are emitted. A model that
 *     cannot emit a tool call is not a worker, whatever its name suggests, and
 *     silently registering it invites routing a role to something that will
 *     stall the agent loop with no error.
 *
 * Usage:
 *   node make-models-json.mjs --probe /results/models.probed.json \
 *                            --out models.json
 *
 * --context-window <n>  operator-asserted fallback for models whose endpoint
 *                        doesn't report its own context length (the common
 *                        case - oMLX servers often don't). Never overrides a
 *                        real endpoint-reported value; only replaces the
 *                        32768 default guess. Marked "operator" (not
 *                        "endpoint") in _verified.context_window_source so a
 *                        reader can tell this was asserted, not measured.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const probePath = arg("--probe", "/results/models.probed.json");
const outPath = arg("--out", "models.json");

// Operator-asserted, not invented: this only fills in for models the ENDPOINT
// never reported a context length for (the common case on servers that don't
// publish it). An endpoint-reported value always wins - this never overrides
// a real measurement, only the hardcoded 32768 guess. Marked distinctly in
// _verified so a reader can tell "the endpoint said so" from "the operator
// told the script so" from "nobody said anything, this is just the fallback".
const contextWindowOverrideArg = arg("--context-window", null);
const contextWindowOverride = contextWindowOverrideArg !== null ? Number(contextWindowOverrideArg) : null;
if (contextWindowOverrideArg !== null && !Number.isFinite(contextWindowOverride)) {
	console.error(`make-models-json: --context-window must be a number, got "${contextWindowOverrideArg}"`);
	process.exit(2);
}

// --base-url with no --probe means: probe inline, then generate. "Add a model"
// was a three-step, mount-sensitive, debuggable ritual; for a weekly workflow it
// has to be one command.
const INLINE = !argv.includes("--probe");
let probe;

if (INLINE) {
	const url = arg("--base-url", process.env.LOCAL_LLM_BASE_URL ?? "http://host.docker.internal:8001/v1");
	const { probeLocalModels } = await import("./probe-lib.mjs");
	console.log("no --probe given; probing inline against " + url);
	probe = await probeLocalModels(url, arg("--api-key", process.env.LOCAL_LLM_API_KEY ?? ""));
} else
try {
	probe = JSON.parse(readFileSync(probePath, "utf8"));
} catch (e) {
	if (e.code === "ENOENT") {
		console.error(`make-models-json: no probe file at ${probePath}`);
		console.error("");
		console.error("  That file is produced by step 1. Run the probe FIRST, and make sure");
		console.error("  /results is a real bind mount of a host directory:");
		console.error("");
		console.error("    docker run --rm -it --entrypoint node \\");
		console.error("      -v ~/pi-contracts-results:/results \\");
		console.error("      pi-contracts:latest /opt/contracts/probe-local-models.mjs \\");
		console.error("        --base-url http://host.docker.internal:8001/v1 \\");
		console.error("        --emit /results/models.probed.json");
		console.error("");
		console.error("  Verify on the host afterwards: ls -l ~/pi-contracts-results/models.probed.json");
		process.exit(2);
	}
	console.error(`make-models-json: could not read ${probePath}: ${e.message}`);
	process.exit(2);
}
const baseUrl = String(probe.endpoint).replace(/\/$/, "");

// Keep the endpoint's view of the model's own limits when it published any.
// oMLX may or may not; do not invent numbers we cannot source.
const CTX_SOURCE_LABEL = {
	endpoint: " (endpoint-reported)",
	operator: " (OPERATOR OVERRIDE via --context-window)",
	default: " (ASSUMED - not reported, not overridden)",
};

function limits(m) {
	const r = m.server_reported ?? {};
	const ctx = r.context_length ?? r.context_window ?? r.max_context_length ?? null;
	const out = r.max_output_tokens ?? r.max_completion_tokens ?? null;
	const ctxWasReported = Number.isFinite(ctx);
	const ctxSource = ctxWasReported ? "endpoint" : (contextWindowOverride !== null ? "operator" : "default");
	return {
		contextWindow: ctxWasReported ? Number(ctx) : (contextWindowOverride ?? 32768),
		maxTokens: Number.isFinite(out) ? Number(out) : 4096,
		ctxWasReported,
		ctxSource,
	};
}

// Must clear the HARD tier, not just tier 1. A model that emits one clean tool
// call but cannot structure a multi-edit array will stall the agent loop, and
// that is the entire question. The earlier "5/12 usable" figure came from tier 1
// alone and was too generous by exactly the models that break in a real run.
const usable = probe.models.filter(
	(m) => m.tool_calling.verdict === "structured"
		&& m.hard_tool_call?.verdict === "structured");
const skipped = probe.models.filter((m) => !usable.includes(m));

if (usable.length === 0) {
	console.error("make-models-json: no model produced structured tool calls — nothing to emit.");
	console.error("  Do NOT hand-write ids here. Fix the chat template or the endpoint first.");
	for (const m of skipped) {
		console.error(`    ${m.id}: ${m.tool_calling.verdict} (${m.tool_calling.ms}ms)` +
			(m.tool_calling.detail ? ` ${String(m.tool_calling.detail).slice(0, 120)}` : ""));
	}
	process.exit(3);
}

const models = usable.map((m) => {
	const l = limits(m);
	return {
		id: m.id,
		name: m.id,
		reasoning: false,
		input: ["text"],
		// oMLX serves locally, so cost is zero. Stated explicitly rather than
		// omitted so pi's usage accounting does not fall back to a default.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: l.contextWindow,
		maxTokens: l.maxTokens,
		// Provenance, kept so a reader can tell measured from assumed.
		_verified: {
			tool_calling: "structured",
			probed_at: probe.probed_at,
			probe_latency_ms: m.tool_calling.ms,
			context_window_reported_by_endpoint: l.ctxWasReported,
			context_window_source: l.ctxSource,  // "endpoint" | "operator" | "default"
		},
	};
});

// MERGE, DO NOT CLOBBER. The owner wants local models as the primary worker
// tier but also runs OpenRouter (and possibly others) for planning and review.
// Writing {providers:{local:...}} wholesale deleted every other provider on
// every regeneration — a silent, repeated, self-inflicted config loss.
//
// So: read whatever is already there, replace ONLY the local provider, and
// leave every other provider exactly as found.
const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "{}";
let prior = {};
try {
	prior = JSON.parse(existing);
} catch {
	console.warn(`  warn: ${outPath} is not valid JSON; treating it as empty and writing fresh`);
}
const preserved = Object.keys(prior.providers ?? {}).filter((k) => k !== "local");
if (preserved.length) {
	console.log(`preserved existing provider(s): ${preserved.join(", ")}`);
}

const out = {
	// _comment etc. from the existing file are intentionally kept.
	...prior,
	providers: {
		...prior.providers,
		local: {
			baseUrl,
			api: "openai-completions",
			// oMLX is typically unauthenticated. The dummy key is required to make
			// the provider usable at all (docs/models.md notes this for Ollama).
			apiKey: "omlx-local",
			models,
		},
	},
};

try {
	writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
} catch (e) {
	if (e.code === "EISDIR") {
		console.error(`make-models-json: ${outPath} is a DIRECTORY, not a file.`);
		console.error("");
		console.error("  Docker creates a directory when a bind-mount source does not exist on");
		console.error("  the host, so `-v .../models.generated.json:/out/models.json` silently");
		console.error("  becomes a directory mount. Write into the already-mounted results dir");
		console.error("  instead — no second mount, nothing for Docker to invent:");
		console.error("");
		console.error("    --out /results/models.generated.json");
		console.error("");
		console.error("  If a stray directory was already created on the host, remove it:");
		console.error("    rmdir ~/pi-contracts-results/models.generated.json");
		process.exit(2);
	}
	throw e;
}

console.log("make-models-json");
console.log("=================");
console.log(`probe  ${probePath}`);
console.log(`baseUrl ${baseUrl}   (baked in — baseUrl is NOT env-interpolated)`);
console.log(`emitted ${models.length} model(s):`);
for (const m of models) {
	const v = m._verified;
	console.log(`  ${m.id}`);
	console.log(`      ctx=${m.contextWindow}${CTX_SOURCE_LABEL[v.context_window_source]}` +
		`  maxTokens=${m.maxTokens}  probe=${(v.probe_latency_ms / 1000).toFixed(1)}s`);
}
if (skipped.length) {
	console.log(`\nskipped ${skipped.length} model(s) — with the reason each was rejected:`);
	for (const m of skipped) {
		const t1 = m.tool_calling.verdict;
		const t2 = m.hard_tool_call?.verdict;
		const fast = (m.tool_calling.ms ?? 0) < 500;
		let why;
		if (t1 === "refused" && fast) {
			why = "NOT RESIDENT — instant refusal. Load it in oMLX and re-probe. Not disqualified.";
		} else if (t1 === "refused") {
			why = `refused after ${m.tool_calling.ms}ms (HTTP ${m.tool_calling.http ?? "-"}): a real capability problem`;
		} else if (t1 === "MARKUP_ONLY") {
			why = "MARKUP-ONLY — emits tool-call markup as text; pi will not see a tool call";
		} else if (t1 === "structured" && t2 !== "structured") {
			// This is the one that matters. It passes the easy probe and fails the
			// hard one, which is precisely the quantisation-damage signature: the
			// model can emit one string argument but loses JSON structure over an
			// array of objects. It will stall a real agent loop.
			why = `FAILS THE HARD TIER (tier1 ok, tier2 ${t2}${m.hard_tool_call?.code ? " " + m.hard_tool_call.code : ""}) — cannot structure a multi-edit call. This is the quantisation-damage signature. NOT usable as a worker.`;
		} else {
			why = `${t1} / ${t2 ?? "n/a"}`;
		}
		console.log(`  ${m.id}\n      ${why}`);
	}
}

console.log(`\nwrote ${outPath}`);
console.log("\nIf any model shows 'ASSUMED' context window, verify it against oMLX's model");
console.log("card before relying on long-context behaviour — compaction thresholds depend on it.");
