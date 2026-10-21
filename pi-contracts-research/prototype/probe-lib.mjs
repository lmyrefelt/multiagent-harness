/**
 * probe-lib — the model capability prober, as an importable function.
 *
 * Extracted so `make-models-json.mjs` can probe inline and generate from the
 * result in ONE command. The reason for the extraction is not tidiness: this
 * project has been bitten repeatedly by two copies of the same logic drifting
 * apart — the compiled vs hand-written guards, and the gate vs the audit using
 * different notions of "a test ran". One definition, imported by both callers.
 *
 * Two tiers, because the easy one is not predictive:
 *   tier 1  one tool, one string argument  — passes almost everything
 *   tier 2  an array of objects with long strings — what an agent loop really
 *           sends, and where a 4-bit model starts emitting unparseable JSON
 *           that oMLX rejects with HTTP 500 invalid_tool_call.
 */

export const MARKUP = [
	"<tool_call>", "<function=", "<start_function_call>",
	"<arg_key>", "<minimax:tool_call", "[TOOL_CALLS]",
	"<|tool_calls_section_begin|>", "<longcat_tool_call", "<ifm|tool_calls",
];

const EASY_TOOL = {
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

async function complete(base, headers, modelId, tool, userText) {
	const t0 = Date.now();
	try {
		const r = await fetch(`${base}/chat/completions`, {
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
				// oMLX HTTP 500 + invalid_tool_call / incomplete_tool_call means the
				// MODEL's output failed to parse. Not a transport fault, and not
				// "model not resident". Never conflate the two.
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

/**
 * Probe every model an endpoint reports.
 * @returns {{endpoint, probed_at, models: Array, usable_as_worker: string[]}}
 */
export async function probeLocalModels(baseUrl, apiKey = "") {
	const base = String(baseUrl).replace(/\/$/, "");
	const headers = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const r = await fetch(`${base}/models`, { headers });
	if (!r.ok) {
		throw new Error(`GET ${base}/models -> HTTP ${r.status}. Is oMLX running and reachable?`);
	}
	const listed = (await r.json()).data ?? [];

	const models = [];
	for (const m of listed) {
		const easy = await complete(base, headers, m.id, EASY_TOOL,
			"Read the file /etc/hostname using the read_file tool.");
		const hard = easy.verdict === "structured"
			? await complete(base, headers, m.id, HARD_TOOL,
				"Replace the add() and mul() lines in /src/calc.js with a single sub() function using the edit_file tool. Use exactly two edits.")
			: { verdict: "skipped", ms: 0 };
		models.push({
			id: m.id,
			owned_by: m.owned_by ?? null,
			server_reported: Object.fromEntries(
				Object.entries(m).filter(([k]) => !["id", "object", "owned_by"].includes(k)),
			),
			tool_calling: easy,
			hard_tool_call: hard,
		});
	}

	// "usable" is a stricter bar than "passed tier 1": a model that cannot emit
	// a structured call over a multi-edit array will stall the agent loop.
	const usable = models.filter((m) =>
		m.tool_calling.verdict === "structured" && m.hard_tool_call.verdict === "structured");

	return {
		endpoint: base,
		probed_at: new Date().toISOString(),
		models,
		usable_as_worker: usable.map((m) => m.id),
	};
}
