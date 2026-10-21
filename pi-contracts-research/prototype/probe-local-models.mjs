#!/usr/bin/env node
/**
 * probe-local-models — measure what a local endpoint can ACTUALLY do.
 *
 * WHY THIS EXISTS
 * Hard rule 9 of the research: "Model names are not facts. Verify existence,
 * quantisation, chat template, and tool-calling support before attributing any
 * capability to them."
 *
 * oMLX auto-detects a different tool-call wire format per model family
 * (VERIFIED, oMLX README "Tool Calling & Structured Output"):
 *     Llama/Qwen/DeepSeek  -> JSON <tool_call>
 *     Qwen3.5 series       -> XML   <function=...>
 *     Gemma                -> <start_function_call>
 *     GLM (4.7, 5)         -> <arg_key>/<arg_value>
 *     MiniMax              -> <minimax:tool_call>
 *     Mistral              -> [TOOL_CALLS]
 *     Kimi K2              -> <|tool_calls_section_begin|>
 *     Longcat              -> <longcat_tool_call>
 *
 * So "it is a Qwen" does NOT tell you whether it will emit something pi can
 * parse. This script sends a real tool schema and inspects what comes back.
 *
 * THE DISTINCTION THAT MATTERS
 *   structured  the endpoint returned message.tool_calls  -> pi's agent loop
 *               will see them. Usable as a worker.
 *   MARKUP_ONLY the model emitted tool-call markup as PLAIN TEXT. The model
 *               understood the task, but the endpoint did not parse it into a
 *               structured call. pi will NOT see a tool call, so the agent loop
 *               stalls. This is a SILENT failure and the single most important
 *               thing to detect before trusting a model.
 *   none        no tool call and no markup. Broken.
 *   refused     the endpoint rejected the `tools` parameter outright.
 *
 * Usage:
 *   node probe-local-models.mjs --base-url http://host.docker.internal:8000/v1
 *                              [--emit models.probed.json]
 *
 * Runs inside the container. Nothing here is inferred from a model name.
 */

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = (arg("--base-url", process.env.LOCAL_LLM_BASE_URL ?? "http://host.docker.internal:8000/v1")).replace(/\/$/, "");
const KEY = arg("--api-key", process.env.LOCAL_LLM_API_KEY ?? "");
const EMIT = arg("--emit", null);

// Markup that oMLX documents per family. If we see it as text, the model tried
// and the endpoint did not parse it.
const MARKUP = [
	"<tool_call>", "<function=", "<start_function_call>",
	"<arg_key>", "<minimax:tool_call", "[TOOL_CALLS]",
	"<|tool_calls_section_begin|>", "<longcat_tool_call", "<ifm|tool_calls",
];

const PROBE_TOOL = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read a file from disk and return its contents.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "absolute file path" } },
			required: ["path"],
		},
	},
};

// Tier 2. The schema that actually breaks: an ARRAY of objects, each with a
// long replacement string. A 4-bit model that emits one string argument fine can
// still lose JSON structural fidelity here, and oMLX then rejects the whole
// response with 500 invalid_tool_call (omlx/server.py _tool_call_failure).
const HARD_TOOL = {
	type: "function",
	function: {
		name: "edit_file",
		description: "Apply one or more exact-match edits to a file.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: { oldText: { type: "string" }, newText: { type: "string" } },
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
	},
};

const headers = { "Content-Type": "application/json" };
if (KEY) headers.Authorization = `Bearer ${KEY}`;

async function getModels() {
	const r = await fetch(`${BASE}/models`, { headers });
	if (!r.ok) throw new Error(`GET /models -> HTTP ${r.status} ${await r.text()}`);
	const j = await r.json();
	return j.data ?? [];
}

async function probeToolCalling(modelId) {
	// TWO TIERS. The original single easy probe — one tool, one string argument —
	// passed 5/5 on this endpoint while ~40% of real agentic runs died with
	// oMLX HTTP 500 invalid_tool_call. The easy probe is necessary but NOT
	// predictive. Tier 2 mirrors the schema that actually fails: an array of
	// objects with long replacement strings, which is what an agent loop sends.
	const easy = await complete(modelId, PROBE_TOOL,
		"Read the file /etc/hostname using the read_file tool.");
	const hard = easy.verdict === "structured"
		? await complete(modelId, HARD_TOOL,
			"Replace the add() and mul() lines in /src/calc.js with a single sub() function using the edit_file tool. Use exactly two edits.")
		: { verdict: "skipped", ms: 0 };
	return { ...easy, tier2: hard };
}

/** One chat completion with a single tool. Classifies what came back. */
async function complete(modelId, tool, userText) {
	const t0 = Date.now();
	try {
		const r = await fetch(`${BASE}/chat/completions`, {
			method: "POST", headers,
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: userText }],
				tools: [tool], tool_choice: "auto",
				max_tokens: 512, temperature: 0,
			}),
		});
		const body = await r.text();
		const ms = Date.now() - t0;

		if (!r.ok) {
			const em = body.match(/"code"\s*:\s*"?([a-z_]+)"?/);
			const mm = body.match(/"message"\s*:\s*"([^"]+)"/);
			const code = em ? em[1] : null;
			return {
				verdict: "refused", http: r.status, code, ms,
				detail: (mm ? mm[1] : body).slice(0, 300),
				// oMLX returns 500 with code=invalid_tool_call / incomplete_tool_call
				// when the MODEL output fails to parse
				// (omlx/server.py _tool_call_failure). That is model damage, NOT a
				// transport fault and NOT "model not resident" — never conflate them.
				tool_call_parse_failure: code === "invalid_tool_call" || code === "incomplete_tool_call",
			};
		}
		const j = JSON.parse(body);
		const msg = j.choices?.[0]?.message ?? {};
		const structured = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
		const text = (msg.content ?? "") + JSON.stringify(msg.reasoning_content ?? "");
		const markup = MARKUP.filter((m) => text.includes(m));
		return {
			verdict: structured ? "structured" : markup.length ? "MARKUP_ONLY" : "none",
			ms, markup_found: markup, text_preview: text.slice(0, 160),
			structured_call: structured
				? { name: msg.tool_calls[0]?.function?.name, args: msg.tool_calls[0]?.function?.arguments }
				: null,
			usage: j.usage ?? {},
		};
	} catch (e) {
		return { verdict: "error", ms: Date.now() - t0, detail: String(e).slice(0, 200) };
	}
}

// ---------------------------------------------------------------------------
console.log("probe-local-models");
console.log("===================");
console.log(`endpoint  ${BASE}`);
console.log(`key       ${KEY ? "(supplied)" : "(none)"}`);
console.log("");

let models;
try {
	models = await getModels();
} catch (e) {
	console.error(`FATAL: cannot list models — ${e.message}`);
	console.error("Is oMLX running, and reachable from the container?");
	console.error("  on the Mac:   omlx start        # then: curl http://localhost:8000/v1/models");
	console.error("  in container: curl http://host.docker.internal:8000/v1/models");
	process.exit(2);
}

console.log(`found ${models.length} model(s)\n`);

const results = [];
for (const m of models) {
	process.stdout.write(`  probing ${m.id} ... `);
	const probe = await probeToolCalling(m.id);
	const rec = {
		id: m.id,
		owned_by: m.owned_by ?? null,
		// Only report what the endpoint actually told us.
		server_reported: Object.fromEntries(
			Object.entries(m).filter(([k]) => !["id", "object", "owned_by"].includes(k)),
		),
		tool_calling: probe,
		hard_tool_call: probe.tier2 ?? null,
	};
	results.push(rec);
	const v = probe.verdict;
	const badge = v === "structured" ? "STRUCTURED  " : v === "MARKUP_ONLY" ? "MARKUP-ONLY" : v.toUpperCase().padEnd(11);
	const hard = probe.tier2;
	console.log(`${badge} ${probe.ms}ms${probe.markup_found?.length ? "  markup=" + probe.markup_found.join(",") : ""}` +
		(hard ? `  | tier2(hard): ${hard.verdict}${hard.code ? " code=" + hard.code : ""}` : ""));
	if (v === "structured" && probe.structured_call) {
		console.log(`      -> called ${probe.structured_call.name}(${String(probe.structured_call.args).slice(0, 80)})`);
	}
	// A refusal is a diagnosis, not a verdict. Always print why.
	if (v === "refused" || v === "error") {
		const fast = probe.ms < 500;
		console.log(`      HTTP ${probe.http ?? "-"}  ${probe.detail?.replace(/\s+/g, " ").slice(0, 180) ?? ""}`);
		if (fast) {
			console.log(`      NOTE: instant rejection (<500ms) — the model is most likely NOT RESIDENT.`);
			console.log(`            That is a memory/load state, not a capability failure. Load it in oMLX`);
			console.log(`            (or restart oMLX so it auto-loads) and re-probe before ruling it out.`);
		}
	}
}

// --- verdict ---------------------------------------------------------------
const usable = results.filter((r) => r.tool_calling.verdict === "structured");
const markupOnly = results.filter((r) => r.tool_calling.verdict === "MARKUP_ONLY");
const refusedFast = results.filter((r) => r.tool_calling.verdict === "refused" && r.tool_calling.ms < 500);
const refusedOther = results.filter((r) => r.tool_calling.verdict === "refused" && r.tool_calling.ms >= 500);

console.log("\nverdict");
console.log("-------");
console.log(`  usable as a pi worker (structured tool calls): ${usable.length}/${results.length}`);
if (usable.length) console.log(`    ${usable.map((r) => r.id).join("\n    ")}`);
if (markupOnly.length) {
	console.log(`\n  MARKUP-ONLY — the model tries, but the endpoint does not emit structured calls:`);
	console.log(`    ${markupOnly.map((r) => `${r.id} (${r.tool_calling.markup_found.join(",")})`).join("\n    ")}`);
	console.log(`    pi will NOT see these as tool calls. Do not route a worker role to them`);
	console.log(`    until the chat template is fixed or an adapter is added.`);
}
if (refusedFast.length) {
	console.log(`\n  NOT RESIDENT (instant rejection, not a capability verdict): ${refusedFast.length}`);
	console.log(`    ${refusedFast.map((r) => r.id).join("\n    ")}`);
	console.log(`    Load them in oMLX, then re-run. They are NOT disqualified.`);
}
if (refusedOther.length) {
	console.log(`\n  refused AFTER generating time (${refusedOther.length}) — a real capability problem:`);
	console.log(`    ${refusedOther.map((r) => r.id).join("\n    ")}`);
}
if (!usable.length) {
	console.log("\n  NO MODEL produced structured tool calls. Stop here and fix the endpoint");
	console.log("  or the chat template before any agent routing — a worker that cannot emit");
	console.log("  a tool call cannot be a worker, however good its prose is.");
}

const out = EMIT
	? { endpoint: BASE, probed_at: new Date().toISOString(), models: results,
			usable_as_worker: usable.map((r) => r.id) }
	: null;
if (out) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(EMIT, JSON.stringify(out, null, 2) + "\n");
	console.log(`\nwrote ${EMIT}`);
}

process.exit(usable.length ? 0 : 3);
