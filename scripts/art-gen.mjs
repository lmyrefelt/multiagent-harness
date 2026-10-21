#!/usr/bin/env node
/**
 * art-gen.mjs - the art-job lane: generate image candidates from the game's prompt cards with an
 * image API, under a monthly budget, for the owner to pick from (owner, 2026-10-21).
 *
 * Tiers (herdr-plugin/art.config.json):
 *   draft -> gemini-free (AI Studio free tier; 429/quota => drafts wait for the daily reset, never paid)
 *   final -> openai (gpt-image, $20/month cap) -> gemini-paid (AI Studio credit) when OpenAI is
 *            over budget or down
 * Keys come from the macOS Keychain via scripts/secrets.mjs (harness.openai, harness.aistudio);
 * .pi/art.env (gitignored) can override: OPENAI_API_KEY, GEMINI_FREE_API_KEY, GEMINI_API_KEY (paid).
 *
 *   node scripts/art-gen.mjs cards                        list the prompt cards (docs/changes/_research/game-graphics-prompts.html)
 *   node scripts/art-gen.mjs prompt R3-1                  print the full prompt a card produces
 *   node scripts/art-gen.mjs run <request.json> [--dry]   generate every asset in a request
 *   node scripts/art-gen.mjs pending [--dry]              run every docs/changes/*\/art-request.json whose status is "pending"
 *   node scripts/art-gen.mjs approve <candidate.png> --to <research_docs/Graphics/...png>   (owner only; host only)
 *   node scripts/art-gen.mjs budget                       spend this month per backend
 *   node scripts/art-gen.mjs probe                        check the keys and whether the Gemini free tier generates images
 *   node scripts/art-gen.mjs --selftest
 *
 * Request file (a worker or the planner writes it; docs/changes/CHANGE-NNNN/art-request.json):
 *   { "status": "pending", "change": "CHANGE-0026",
 *     "assets": [ { "id": "amir_faces", "card": "R3-1",                  // or "text": "...", "suffix": "sprite|room|character|none"
 *                   "refs": ["research_docs/game_style_guide/refpack 5/amir.png"],
 *                   "purpose": "final", "n": 3, "size": "1536x1024", "quality": "medium" } ] }
 * Output: .pi-session/art/out/<request>/<asset>/<backend>-<k>.png + meta.json + contact.png
 * (light and dark panels). Nothing enters the game until the owner runs `approve`, which copies
 * the picked file into research_docs/Graphics and records its sha256 for the art_prep catalogue.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, basename, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getSecret } from "./secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
const ART = join(REPO, ".pi-session", "art");
const PROMPTS_HTML = join(REPO, "docs", "changes", "_research", "game-graphics-prompts.html");
const CONFIG = join(REPO, "herdr-plugin", "art.config.json");

export const DEFAULTS = {
	monthly_budget_usd: { openai: 20, "gemini-paid": 10 },
	tiers: { draft: ["gemini-free"], final: ["openai", "gemini-paid"] },
	openai: { model: "gpt-image-1", quality: "medium", size: "1536x1024", background: "transparent",
		// USD per 1M tokens (check https://openai.com/api/pricing and edit when it changes)
		rates: { text_in: 5, image_in: 10, image_out: 40 },
		// used before a call to check the budget; replaced by the real cost from the response usage
		estimate_per_image: { low: 0.02, medium: 0.07, high: 0.25 } },
	gemini: { model: "gemini-2.5-flash-image", estimate_per_image: 0.04 },
	free_reset_utc_hour: 8, // AI Studio daily quotas reset at midnight Pacific
	max_refs: 4,
};

export function loadConfig() {
	let c = {}; try { c = JSON.parse(readFileSync(CONFIG, "utf8")); } catch { /* defaults */ }
	const m = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? m(a[k], v) : v; return o; };
	return m(DEFAULTS, c);
}

function loadEnv() {
	const f = join(REPO, ".pi", "art.env");
	const env = { ...process.env };
	try { for (const l of readFileSync(f, "utf8").split("\n")) { const mm = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (mm && !env[mm[1]]) env[mm[1]] = mm[2].replace(/^["']|["']$/g, ""); } } catch { /* none */ }
	// the Keychain (scripts/secrets.mjs) is the normal place; .pi/art.env only overrides it
	env.OPENAI_API_KEY ||= getSecret("openai");
	env.GEMINI_FREE_API_KEY ||= getSecret("aistudio");
	env.GEMINI_API_KEY ||= getSecret("aistudio"); // owner: the paid fallback is the same AI Studio key (its credit)
	return env;
}

// ---------- prompt cards ----------
/** BLOCKS and CARDS from the prompts page (its script defines them as plain literals). Pure on the html text. */
export function parseCards(html) {
	const s = (String(html).match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] ?? "";
	const b = s.indexOf("const BLOCKS"), c = s.indexOf("const CARDS");
	const endOf = (from) => { let depth = 0, i = s.indexOf("=", from) + 1, started = false, str = null;
		for (; i < s.length; i++) { const ch = s[i];
			if (str) { if (ch === "\\") i++; else if (ch === str) str = null; continue; }
			if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
			if (ch === "{" || ch === "[") { depth++; started = true; } else if (ch === "}" || ch === "]") { depth--; if (started && depth === 0) return i + 1; } }
		return -1; };
	const ctx = {};
	vm.runInNewContext(`BLOCKS = ${s.slice(s.indexOf("=", b) + 1, endOf(b))}; CARDS = ${s.slice(s.indexOf("=", c) + 1, endOf(c))};`, ctx, { timeout: 1000 });
	return { blocks: ctx.BLOCKS, cards: ctx.CARDS };
}
export function fullPrompt(blocks, asset, cards = []) {
	const card = asset.card ? cards.find((x) => x.id === asset.card) : null;
	if (asset.card && !card) throw new Error(`no prompt card ${asset.card}`);
	const text = asset.text ?? card.text;
	const suffix = asset.suffix ?? card?.suffix ?? "none";
	const parts = [blocks.style.text, text];
	if (suffix !== "none" && blocks[suffix]) parts.push(blocks[suffix].text);
	if (asset.extra) parts.push(asset.extra);
	if (asset.refs?.length) parts.push("Match the drawing style, outline weight, proportions and palette of the attached reference image(s) exactly; they show the approved look.");
	return parts.join("\n\n");
}

// ---------- budget ----------
const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
function spendFile() { return join(ART, "spend.json"); }
export function loadSpend() { try { return JSON.parse(readFileSync(spendFile(), "utf8")); } catch { return { months: {}, free_blocked_until: 0 }; } }
function saveSpend(s) { mkdirSync(ART, { recursive: true }); writeFileSync(spendFile(), JSON.stringify(s, null, 1)); }
export function spentThisMonth(s, backend, t) { return s.months?.[month(t)]?.[backend] ?? 0; }
export function canAfford(s, cfg, backend, est, t = Date.now()) {
	const cap = cfg.monthly_budget_usd?.[backend];
	if (cap == null) return true; // free
	return spentThisMonth(s, backend, t) + est <= cap + 1e-9;
}
function addSpend(s, backend, usd, t = Date.now()) { const m = (s.months[month(t)] ??= {}); m[backend] = Math.round(((m[backend] ?? 0) + usd) * 10000) / 10000; }
export function nextFreeReset(t, hour) { const d = new Date(t); const r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour); return r > t ? r : r + 86400e3; }
export function openaiCost(usage, rates) {
	if (!usage) return null;
	const d = usage.input_tokens_details ?? {};
	const text = d.text_tokens ?? usage.input_tokens ?? 0, img = d.image_tokens ?? 0;
	return (text * rates.text_in + img * rates.image_in + (usage.output_tokens ?? 0) * rates.image_out) / 1e6;
}

// ---------- backends ----------
const mime = (p) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(p).toLowerCase()] ?? "image/png";

async function callOpenAI({ key, prompt, refs, cfg, asset, fetchImpl }) {
	const o = cfg.openai;
	const common = { model: o.model, size: asset.size ?? o.size, quality: asset.quality ?? o.quality, n: 1 };
	let res;
	if (refs.length) {
		const fd = new FormData();
		for (const [k, v] of Object.entries({ ...common, prompt, background: asset.background ?? o.background })) fd.append(k, String(v));
		for (const r of refs) fd.append("image[]", new Blob([readFileSync(r)], { type: mime(r) }), basename(r));
		res = await fetchImpl("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
	} else {
		res = await fetchImpl("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...common, prompt, background: asset.background ?? o.background, output_format: "png" }) });
	}
	const j = await res.json().catch(() => ({}));
	if (!res.ok) return { error: j.error?.message ?? `HTTP ${res.status}`, status: res.status };
	const b64 = j.data?.[0]?.b64_json;
	if (!b64) return { error: "no image in the response" };
	return { png: Buffer.from(b64, "base64"), cost: openaiCost(j.usage, o.rates), model: o.model };
}

async function callGemini({ key, prompt, refs, cfg, fetchImpl }) {
	const parts = [{ text: prompt }, ...refs.map((r) => ({ inline_data: { mime_type: mime(r), data: readFileSync(r).toString("base64") } }))];
	const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini.model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }) });
	const j = await res.json().catch(() => ({}));
	if (!res.ok) return { error: j.error?.message ?? `HTTP ${res.status}`, status: res.status, quota: res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(j.error?.status ?? j.error?.message ?? "") };
	const p = j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData || x.inline_data);
	const d = p?.inlineData ?? p?.inline_data;
	if (!d) return { error: `no image in the response (${j.candidates?.[0]?.finishReason ?? j.promptFeedback?.blockReason ?? "?"})` };
	return { png: Buffer.from(d.data, "base64"), model: cfg.gemini.model, needsBgRemoval: true };
}

/** Which backend to try next for a purpose, given keys, budget and the free-tier block. Pure. */
export function pickBackend(purpose, { cfg, env, spend, asset, tried = [], t = Date.now() }) {
	for (const b of cfg.tiers[purpose] ?? cfg.tiers.final) {
		if (tried.includes(b)) continue;
		if (b === "openai" && !env.OPENAI_API_KEY) continue;
		if (b === "gemini-free" && (!env.GEMINI_FREE_API_KEY || (spend.free_blocked_until ?? 0) > t)) continue;
		if (b === "gemini-paid" && !env.GEMINI_API_KEY) continue;
		const est = b === "openai" ? cfg.openai.estimate_per_image[asset.quality ?? cfg.openai.quality] ?? 0.1 : b === "gemini-paid" ? cfg.gemini.estimate_per_image : 0;
		if (!canAfford(spend, cfg, b, est, t)) continue;
		return { backend: b, est };
	}
	return null;
}

// ---------- run ----------
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

export async function runRequest(reqPath, { dry = false, fetchImpl = fetch, env = loadEnv(), cfg = loadConfig(), log = console.log } = {}) {
	const req = JSON.parse(readFileSync(reqPath, "utf8"));
	const { blocks, cards } = parseCards(readFileSync(PROMPTS_HTML, "utf8"));
	const name = req.change ?? basename(reqPath, ".json");
	const outRoot = join(ART, "out", name);
	const spend = loadSpend();
	const summary = { done: [], waiting: [], failed: [] };
	for (const asset of req.assets ?? []) {
		const prompt = fullPrompt(blocks, asset, cards);
		const refs = (asset.refs ?? []).slice(0, cfg.max_refs).map((r) => resolve(REPO, r));
		const missing = refs.filter((r) => !existsSync(r));
		if (missing.length) { summary.failed.push(`${asset.id}: reference not found: ${missing.map((m) => relative(REPO, m)).join(", ")}`); continue; }
		const dir = join(outRoot, asset.id);
		mkdirSync(dir, { recursive: true });
		const purpose = asset.purpose ?? "final";
		const n = Math.min(asset.n ?? 3, 8);
		const made = [];
		for (let k = 1; k <= n; k++) {
			const tried = [];
			let ok = null;
			for (;;) {
				const pick = pickBackend(purpose, { cfg, env, spend, asset, tried });
				if (!pick) break;
				tried.push(pick.backend);
				if (dry) { log(`[dry] ${asset.id} #${k} -> ${pick.backend} (est $${pick.est.toFixed(3)})`); ok = { dry: true }; break; }
				const key = { openai: env.OPENAI_API_KEY, "gemini-free": env.GEMINI_FREE_API_KEY, "gemini-paid": env.GEMINI_API_KEY }[pick.backend];
				const r = pick.backend === "openai" ? await callOpenAI({ key, prompt, refs, cfg, asset, fetchImpl }) : await callGemini({ key, prompt, refs, cfg, fetchImpl });
				if (r.error) {
					log(`  ${asset.id} #${k} ${pick.backend}: ${r.error}`);
					if (pick.backend === "gemini-free" && r.quota) { spend.free_blocked_until = nextFreeReset(Date.now(), cfg.free_reset_utc_hour); saveSpend(spend); }
					if (pick.backend !== "gemini-free" && r.status === 400) break; // prompt refused: other backends get the same prompt only for final
					continue;
				}
				if (!isPng(r.png)) { log(`  ${asset.id} #${k} ${pick.backend}: response is not a PNG`); continue; }
				const cost = r.cost ?? pick.est;
				if (pick.backend !== "gemini-free") { addSpend(spend, pick.backend, cost); saveSpend(spend); }
				const file = join(dir, `${pick.backend}-${k}.png`);
				writeFileSync(file, r.png);
				ok = { file: relative(REPO, file), backend: pick.backend, model: r.model, cost: Math.round(cost * 10000) / 10000, sha256: sha(r.png), needsBgRemoval: !!r.needsBgRemoval };
				log(`  ${asset.id} #${k} ${pick.backend} -> ${ok.file} ($${ok.cost.toFixed(3)})`);
				break;
			}
			if (!ok) break;
			if (!ok.dry) made.push(ok);
		}
		if (dry) continue;
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ asset, prompt, refs: refs.map((r) => relative(REPO, r)), candidates: made, at: new Date().toISOString() }, null, 1));
		if (made.length) {
			const sheet = join(REPO, "godot-project", "tools", "art_prep", "contact_sheet.mjs");
			if (existsSync(sheet)) spawnSync(process.execPath, [sheet, join(dir, "contact.png"), "--cell", "384", "--cols", "4", ...made.map((m) => join(REPO, m.file))], { encoding: "utf8" });
			summary.done.push(`${asset.id}: ${made.length}/${n}`);
		}
		if (made.length < n) {
			const why = purpose === "draft" && (spend.free_blocked_until ?? 0) > Date.now() ? `free tier used up until ${new Date(spend.free_blocked_until).toISOString().slice(0, 16)}Z` : "no backend left (keys, budget or errors)";
			summary.waiting.push(`${asset.id}: ${made.length}/${n} - ${why}`);
		}
	}
	if (!dry) {
		req.status = summary.waiting.length || summary.failed.length ? (summary.done.length ? "partial" : "waiting") : "generated";
		req.result = { ...summary, out: relative(REPO, outRoot), at: new Date().toISOString() };
		writeFileSync(reqPath, JSON.stringify(req, null, 1) + "\n");
	}
	return summary;
}

function approve(cand, to) {
	if (existsSync("/.dockerenv") || process.env.HARNESS_CONTAINER) { console.error("approve is the owner's step - run it on the Mac, not in a container"); return 2; }
	const src = resolve(REPO, cand), dst = resolve(REPO, to);
	if (!relative(join(REPO, "research_docs", "Graphics"), dst).match(/^[^.]/)) { console.error("--to must be under research_docs/Graphics/"); return 2; }
	if (existsSync(dst)) { console.error(`${relative(REPO, dst)} exists - pick a new name (sources are hash-bound)`); return 2; }
	mkdirSync(dirname(dst), { recursive: true });
	copyFileSync(src, dst);
	const h = sha(readFileSync(dst));
	let meta = {}; try { meta = JSON.parse(readFileSync(join(dirname(src), "meta.json"), "utf8")); } catch { /* */ }
	const c = meta.candidates?.find((x) => x.file === relative(REPO, src)) ?? {};
	const line = `| ${new Date().toISOString().slice(0, 10)} | \`${relative(REPO, dst)}\` | ${c.backend ?? "?"} ${c.model ?? ""} | ${meta.asset?.card ?? meta.asset?.id ?? "?"} | \`${h}\` |\n`;
	const prov = join(REPO, "research_docs", "Graphics", "GENERATED.md");
	if (!existsSync(prov)) writeFileSync(prov, "# Generated art approved by the owner\n\nWritten by `scripts/art-gen.mjs approve`. Add each file to `godot-project/tools/art_prep/catalogue.json` with this sha256.\n\n| date | file | model | card | sha256 |\n|---|---|---|---|---|\n");
	appendFileSync(prov, line);
	console.log(`approved -> ${relative(REPO, dst)}\nsha256 ${h}${c.needsBgRemoval ? "\nnote: Gemini output has an opaque background - art_prep must remove it" : ""}`);
	return 0;
}

async function probe(env, cfg) {
	const show = (k, v) => console.log(`${k.padEnd(14)} ${v}`);
	if (env.OPENAI_API_KEY) { const r = await fetch("https://api.openai.com/v1/models/" + cfg.openai.model, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }); show("openai", r.ok ? `key ok, ${cfg.openai.model} available` : `HTTP ${r.status} ${(await r.json().catch(() => ({}))).error?.message ?? ""}`); } else show("openai", "no key (Keychain harness.openai, or OPENAI_API_KEY in .pi/art.env) - run: node scripts/secrets.mjs list");
	for (const [b, k] of [["gemini-free", env.GEMINI_FREE_API_KEY], ["gemini-paid", env.GEMINI_API_KEY]]) {
		if (!k) { show(b, "no key"); continue; }
		if (b === "gemini-paid") { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini.model}`, { headers: { "x-goog-api-key": k } }); show(b, r.ok ? `key ok, ${cfg.gemini.model} available` : `HTTP ${r.status}`); continue; }
		const r = await callGemini({ key: k, prompt: "A small red wooden toy ball with a bold dark outline on a plain white background. No text.", refs: [], cfg, fetchImpl: fetch });
		show(b, r.error ? `${r.quota ? "NO free image quota" : "error"}: ${r.error}` : `generates images for free (${r.png.length} bytes)`);
	}
	return 0;
}

async function main() {
	const argv = process.argv.slice(2);
	const cmd = argv[0];
	const cfg = loadConfig();
	if (cmd === "--selftest") return selftest();
	if (cmd === "cards" || cmd === "prompt") {
		const { blocks, cards } = parseCards(readFileSync(PROMPTS_HTML, "utf8"));
		if (cmd === "cards") { for (const c of cards) console.log(`${c.id.padEnd(8)} ${String(c.suffix).padEnd(10)} ${c.title}`); return 0; }
		console.log(fullPrompt(blocks, { card: argv[1] }, cards)); return 0;
	}
	if (cmd === "run") { const s = await runRequest(resolve(argv[1]), { dry: argv.includes("--dry") }); console.log(JSON.stringify(s, null, 1)); return s.failed.length ? 1 : 0; }
	if (cmd === "pending") {
		const cd = join(REPO, "docs", "changes");
		for (const d of readdirSync(cd)) { const f = join(cd, d, "art-request.json"); if (!existsSync(f)) continue;
			let st; try { st = JSON.parse(readFileSync(f, "utf8")).status; } catch { continue; }
			if (st === "pending" || st === "waiting" || st === "partial") { console.log(`== ${d}`); console.log(JSON.stringify(await runRequest(f, { dry: argv.includes("--dry") }))); } }
		return 0;
	}
	if (cmd === "approve") { const i = argv.indexOf("--to"); if (!argv[1] || i < 0) { console.error("usage: approve <candidate.png> --to research_docs/Graphics/<dir>/<name>.png"); return 2; } return approve(argv[1], argv[i + 1]); }
	if (cmd === "budget") { const s = loadSpend(); for (const b of Object.keys(cfg.monthly_budget_usd)) console.log(`${b.padEnd(12)} $${spentThisMonth(s, b).toFixed(2)} of $${cfg.monthly_budget_usd[b]} (${month()})`); if (s.free_blocked_until > Date.now()) console.log(`gemini-free  used up until ${new Date(s.free_blocked_until).toISOString()}`); return 0; }
	if (cmd === "probe") return probe(loadEnv(), cfg);
	console.error("usage: art-gen.mjs cards | prompt <card> | run <request.json> [--dry] | pending [--dry] | approve <png> --to <path> | budget | probe | --selftest");
	return 2;
}

async function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const html = `<script>\nconst BLOCKS = { style: { name: "S", text: "STYLE \\"q\\" {x}" }, sprite: { text: "SPRITE" } };\nconst CARDS = [\n{"id": "A-1", "suffix": "sprite", "title": "t", "text": "a [b] thing"},\n{"id": "A-2", "suffix": "none", "title": "u", "text": "other"}\n];\nfunction x(){}\n</script>`;
	const { blocks, cards } = parseCards(html);
	ok(cards.length === 2 && blocks.style.text.includes('"q"'), "parses BLOCKS and CARDS");
	const p = fullPrompt(blocks, { card: "A-1", refs: ["r.png"] }, cards);
	ok(p.startsWith("STYLE") && p.includes("a [b] thing") && p.includes("SPRITE") && /reference/.test(p), "style + card + suffix + reference line");
	ok(!fullPrompt(blocks, { card: "A-2" }, cards).includes("SPRITE"), "suffix none");
	const cfg = DEFAULTS, t = Date.UTC(2026, 9, 21, 12);
	const env = { OPENAI_API_KEY: "k", GEMINI_FREE_API_KEY: "f", GEMINI_API_KEY: "g" };
	ok(pickBackend("draft", { cfg, env, spend: { months: {} }, asset: {}, t })?.backend === "gemini-free", "draft -> free tier");
	ok(pickBackend("draft", { cfg, env, spend: { months: {}, free_blocked_until: t + 1 }, asset: {}, t }) === null, "free tier used up -> drafts wait, never paid");
	ok(pickBackend("final", { cfg, env, spend: { months: {} }, asset: {}, t })?.backend === "openai", "final -> openai");
	ok(pickBackend("final", { cfg, env, spend: { months: { "2026-10": { openai: 19.97 } } }, asset: {}, t })?.backend === "gemini-paid", "openai over budget -> gemini paid");
	ok(pickBackend("final", { cfg, env, spend: { months: { "2026-10": { openai: 19.97, "gemini-paid": 9.99 } } }, asset: {}, t }) === null, "everything over budget -> wait");
	ok(pickBackend("final", { cfg, env: { GEMINI_API_KEY: "g" }, spend: { months: {} }, asset: {}, t })?.backend === "gemini-paid", "no OpenAI key -> gemini paid");
	ok(pickBackend("final", { cfg, env, spend: { months: { "2026-09": { openai: 20 } } }, asset: {}, t })?.backend === "openai", "budget is per month");
	ok(Math.abs(openaiCost({ input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 1000 }, cfg.openai.rates) - 0.0405) < 1e-9, "cost from usage");
	ok(nextFreeReset(Date.UTC(2026, 9, 21, 9), 8) === Date.UTC(2026, 9, 22, 8) && nextFreeReset(Date.UTC(2026, 9, 21, 7), 8) === Date.UTC(2026, 9, 21, 8), "free-tier reset time");
	if (fails) { console.error(`${fails} art-gen self-test(s) FAILED`); return 1; }
	console.log("art-gen self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c ?? 0), (e) => { console.error(e.message); process.exit(1); });
