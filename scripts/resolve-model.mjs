#!/usr/bin/env node
/**
 * resolve-model.mjs - make sure a pi container is launched with a model it can
 * actually resolve, so a launch never dies with
 *     Error: Model "local/<id>" not found. Use --list-models to see available models.
 *
 * WHY: the image bakes /home/node/.pi/agent/models.json with `"local": { models: [] }`
 * on purpose (model ids are only written after probing the real server). So a
 * `local/<id>` model only resolves when a probed models file is mounted over it
 * (MODELS_JSON, or models.local.json at the repo root). If that file was never
 * generated, or the server now serves a different id, pi refuses to start.
 *
 * What this does (host side, before `docker run`), never exiting non-zero:
 *   1. Model is not local/<id>                    -> unchanged.
 *   2. MODELS_JSON already declares local/<id>    -> unchanged.
 *   3. Otherwise ask the local server what it serves right now (LOCAL_LLM_BASE_URL,
 *      then the other usual oMLX port), pick the requested id - exact, alias, or the
 *      closest name - and write .pi-session/models.auto.json (the base registry +
 *      the served model(s), baseUrl pointing at the port that answered). Mount that.
 *   4. Server unreachable / nothing usable -> next entry of the fallback list
 *      (<ROLE>_MODEL_FALLBACKS or HARNESS_MODEL_FALLBACKS, comma separated,
 *      e.g. "opencode/big-pickle,openrouter/qwen/qwen3-coder:free").
 *   5. Still nothing -> start WITHOUT --model (pi's default provider; /model inside
 *      the session to pick one). Loud warning, but the agent starts.
 *
 * Output (stdout, for the launcher):  MODEL=<id>  MODELS_JSON=<path>  LLM=<url>
 * Everything human-readable goes to stderr. A record of the decision is written
 * to .pi-session/model-resolution-<role>.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const arg = (k, d = "") => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const ROLE = arg("--role", "worker");
const REQUESTED = arg("--model");
const LLM = arg("--llm", process.env.LOCAL_LLM_BASE_URL || "http://host.docker.internal:8001/v1");
const MODELS_JSON = arg("--models-json");
const REPO = arg("--repo", process.cwd());
const FALLBACKS = arg("--fallbacks").split(",").map((s) => s.trim()).filter(Boolean);
const API_KEY = process.env.LOCAL_LLM_API_KEY || "";
const HARNESS_CONFIG_ROOT = process.env.HARNESS_CONFIG_ROOT || join(homedir(), ".harness", "config");

const notes = [];
const say = (m) => { notes.push(m); process.stderr.write(`model     : ${m}\n`); };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function emit(model, modelsJson, llm, outcome) {
	try {
		const dir = join(REPO, ".pi-session");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `model-resolution-${ROLE}.json`), JSON.stringify({
			at: new Date().toISOString(), role: ROLE, requested: REQUESTED, model, models_json: modelsJson, llm, outcome, notes,
		}, null, 2) + "\n");
	} catch { /* best effort */ }
	process.stdout.write(`MODEL=${model}\nMODELS_JSON=${modelsJson}\nLLM=${llm}\n`);
	process.exit(0);
}

const splitModel = (m) => { const i = m.indexOf("/"); return i < 0 ? ["", m] : [m.slice(0, i), m.slice(i + 1)]; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokens = (s) => String(s || "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

// The models file that is (or would be) inside the container.
function baseRegistry() {
	if (MODELS_JSON && existsSync(MODELS_JSON)) return readJson(MODELS_JSON);
	const dirs = [process.env.PI_CONTRACTS_DIR, join(REPO, "contracts"), join(REPO, "pi-contracts-research")].filter(Boolean);
	for (const d of dirs) { const j = readJson(join(d, "models.json")); if (j) return j; }
	return { providers: { local: { baseUrl: LLM, api: "openai-completions", apiKey: "$LOCAL_LLM_API_KEY", models: [] } } };
}
const declares = (reg, provider, id) => !!reg?.providers?.[provider]?.models?.some?.((m) => m.id === id);

// host.docker.internal is the Mac itself; from the host that is 127.0.0.1.
const hostSide = (u) => u.replace("host.docker.internal", "127.0.0.1");
function candidateUrls() {
	const urls = [LLM];
	const m = LLM.match(/:(\d+)(\/|$)/);
	for (const port of ["8001", "8000"]) if (m && m[1] !== port) urls.push(LLM.replace(`:${m[1]}`, `:${port}`));
	return [...new Set(urls)];
}

async function getJson(url, ms = 4000) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), ms);
	try {
		const r = await fetch(url, { signal: ctl.signal, headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {} });
		if (!r.ok) return { error: `HTTP ${r.status}` };
		return { json: await r.json() };
	} catch (e) {
		return { error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message) };
	} finally { clearTimeout(t); }
}

// What the server serves: oMLX's /models/status (has context window + alias),
// else the plain OpenAI /models list.
async function served(baseUrl) {
	const h = hostSide(baseUrl).replace(/\/+$/, "");
	const st = await getJson(`${h}/models/status`);
	if (st.json?.models?.length) {
		const out = st.json.models
			.filter((m) => m.id && (!m.model_type || ["llm", "vlm"].includes(String(m.model_type).toLowerCase())))
			.map((m) => ({ id: m.id, alias: m.model_alias || m.display_name || "", contextWindow: m.max_context_window, maxTokens: m.max_tokens, vision: String(m.model_type).toLowerCase() === "vlm" }));
		if (out.length) return { models: out };
	}
	const r = await getJson(`${h}/models`);
	if (r.error) return { error: r.error };
	const list = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json?.models) ? r.json.models : [];
	return {
		models: list.filter((m) => m && (m.id || m.key)).map((m) => ({
			id: m.id || m.key, alias: m.name || "",
			contextWindow: m.max_model_len || m.context_length || m.max_context_length || m.context_window,
		})),
	};
}

function pick(want, models) {
	if (!models.length) return null;
	const exact = models.find((m) => m.id === want) || models.find((m) => m.alias === want);
	if (exact) return { m: exact, how: "exact", id: want };
	const n = norm(want);
	const loose = models.find((m) => norm(m.id) === n || norm(m.alias) === n || norm(m.id.split("/").pop()) === n);
	if (loose) return { m: loose, how: "same name, different spelling", id: loose.id };
	const wt = tokens(want);
	const scored = models.map((m) => {
		const mt = new Set([...tokens(m.id), ...tokens(m.alias)]);
		const hit = wt.filter((t) => mt.has(t)).length;
		const contains = norm(m.id).includes(n) || n.includes(norm(m.id.split("/").pop())) ? 1 : 0;
		return { m, score: hit + contains * 2, need: Math.max(2, Math.ceil(wt.length * 0.6)) };
	}).filter((x) => x.score >= x.need).sort((a, b) => b.score - a.score || a.m.id.length - b.m.id.length);
	if (scored.length) return { m: scored[0].m, how: "closest name", id: scored[0].m.id };
	if (models.length === 1) return { m: models[0], how: "only model the server has loaded", id: models[0].id };
	return null;
}

function writeAuto(reg, localBase, served, extraProviders = {}) {
	const out = JSON.parse(JSON.stringify(reg || {}));
	out.providers ??= {};
	if (localBase) {
		const local = out.providers.local ?? { api: "openai-completions", apiKey: "$LOCAL_LLM_API_KEY" };
		local.baseUrl = localBase; // baseUrl is NOT env-interpolated by pi - bake in the port that answered
		local.api ??= "openai-completions";
		local.apiKey ??= "$LOCAL_LLM_API_KEY";
		const have = new Set((local.models || []).map((m) => m.id));
		local.models = [...(local.models || [])];
		for (const s of served) {
			if (have.has(s.id)) continue;
			const ctx = Number(s.contextWindow) > 0 ? Number(s.contextWindow) : Number(process.env.LOCAL_LLM_CONTEXT_WINDOW) || 32768;
			local.models.push({
				id: s.id, name: s.alias || s.id, reasoning: false,
				input: s.vision ? ["text", "image"] : ["text"],
				contextWindow: ctx,
				maxTokens: Number(s.maxTokens) > 0 ? Number(s.maxTokens) : Math.min(32768, Math.floor(ctx / 4)),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			have.add(s.id);
		}
		out.providers.local = local;
	}
	Object.assign(out.providers, extraProviders);
	const p = join(REPO, ".pi-session", `models.auto.${ROLE}.json`);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
	return p;
}

// Custom providers from the machine-wide file (~/.harness/config/pi/.pi/agent/models.json),
// only when their key is real - a "YOUR_API_KEY" placeholder would just fail later.
function harnessProvider(name) {
	const j = readJson(join(HARNESS_CONFIG_ROOT, "pi", ".pi", "agent", "models.json"));
	const p = j?.providers?.[name];
	if (!p) return null;
	if (!p.apiKey || /YOUR_API_KEY|^<|changeme/i.test(p.apiKey)) return { placeholder: true };
	return { provider: p };
}

// ---------------------------------------------------------------------------
const reg = baseRegistry();
const [prov, id] = splitModel(REQUESTED);

if (!REQUESTED) emit("", MODELS_JSON, LLM, "unset");
if (prov !== "local") emit(REQUESTED, MODELS_JSON, LLM, "not-local");
if (declares(reg, "local", id) && MODELS_JSON) emit(REQUESTED, MODELS_JSON, LLM, "declared");

say(`${REQUESTED} is not in any mounted models file - asking the local server what it serves`);
let localFound = null;
const errors = [];
for (const url of candidateUrls()) {
	let res;
	for (let attempt = 1; attempt <= 3; attempt++) { // a server that is still loading gets a few seconds
		res = await served(url);
		if (!res.error) break;
		if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
	}
	if (res.error) { errors.push(`${hostSide(url)}: ${res.error}`); continue; }
	const choice = pick(id, res.models);
	if (choice) { localFound = { url, choice, models: res.models }; break; }
	errors.push(`${hostSide(url)} serves ${res.models.map((m) => m.id).join(", ") || "nothing"} - no match for ${id}`);
}

if (localFound) {
	const { url, choice } = localFound;
	const file = writeAuto(reg, url, [{ ...choice.m, id: choice.id }]);
	if (choice.how !== "exact") say(`WARNING: ${id} not served as such - using local/${choice.id} (${choice.how})`);
	if (url !== LLM) say(`local server answered on ${url} (not ${LLM}) - using that`);
	say(`registered local/${choice.id} from ${url} -> ${file}`);
	emit(`local/${choice.id}`, file, url, choice.how === "exact" ? "probed" : "probed-substitute");
}

for (const e of errors) say(`local server: ${e}`);

for (const fb of FALLBACKS) {
	const [fp, fid] = splitModel(fb);
	if (!fp || !fid || fp === "local") continue;
	if (declares(reg, fp, fid)) { say(`WARNING: falling back to ${fb}`); emit(fb, MODELS_JSON, LLM, "fallback"); }
	const h = harnessProvider(fp);
	if (h?.placeholder) { say(`skipping fallback ${fb}: its apiKey in ${HARNESS_CONFIG_ROOT}/pi/.pi/agent/models.json is still a placeholder`); continue; }
	if (h?.provider) {
		const file = writeAuto(reg, null, [], { [fp]: h.provider });
		say(`WARNING: falling back to ${fb} (provider from ~/.harness/config) -> ${file}`);
		emit(fb, file, LLM, "fallback");
	}
	// Built-in provider (openrouter, anthropic, ...): auth comes from auth.json.
	say(`WARNING: falling back to ${fb}`);
	emit(fb, MODELS_JSON, LLM, "fallback");
}

say(`WARNING: no usable model for ${REQUESTED} - starting WITHOUT --model (pi's default provider). Start the local server or set ${ROLE.toUpperCase()}_MODEL_FALLBACKS; inside the session use /model to switch.`);
emit("", MODELS_JSON, LLM, "default-provider");
