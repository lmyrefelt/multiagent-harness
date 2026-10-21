#!/usr/bin/env node
// token-audit — where did the harness's input tokens go? Finds the tool results
// that were avoidable AND then re-sent on every later call.
//
// WHY. session-cost.mjs answers "how much"; this answers "on what". Ported in
// spirit from tokenleak's audit (github.com/Pazificateur69/tokenleak, MIT), which
// only reads Claude Code and Codex transcripts. This reads what THIS harness
// actually leaves on disk:
//   - pi session JSONL (.pi-session/<run>/<ts>_<id>.jsonl) - VERIFIED shape:
//     assistant content[] {type:"toolCall", id, name, arguments}, then
//     {role:"toolResult", toolCallId, toolName, content[]}; usage on assistant
//     turns; {type:"compaction"} resets what is in context.
//   - Claude Code transcripts (claude-projects/**/<uuid>.jsonl, as the claude
//     backend persists them) - assistant tool_use / user tool_result blocks.
//   - Codex rollouts (codex-sessions/**/rollout-*.jsonl) - VERIFIED: commands run
//     through a JS `exec` custom_tool_call (`tools.exec_command({cmd:...})`, or
//     `tools.apply_patch(...)`); usage in token_usage_record (input_tokens already
//     includes cached); {type:"compacted"} = compaction. Older function_call
//     shell/exec_command shape also read.
//   - Antigravity transcript_full.jsonl - VERIFIED over 1,895 calls: a
//     PLANNER_RESPONSE carries tool_calls[], then exactly one GENERIC step per
//     call, in order; CHECKPOINT = compaction; usage input_tokens+cache_read_tokens.
//     view_file without EndLine = whole-file read.
//   - OpenCode's SQLite store (opencode.db, normally the shared login dir
//     ~/.harness/config/opencode, else <worktree>/.pi-session/<run>/opencode-home):
//     message rows carry tokens, part rows {type:"tool", tool, state:{input,output}}.
//     Read from a temp COPY (db + WAL) via node:sqlite, never the live file.
//
// MODEL. A tool result of T tokens is re-sent on each of the L assistant calls
// that follow it until the next compaction: re-sent = T x L. Only the AVOIDABLE
// part of each leak is counted (e.g. a big read minus a ~1.5k-token targeted
// read). $ uses each session's own blended input price (cache reads included),
// so it is an estimate; free models show $0. Tokens = chars/4.
//
//   node scripts/token-audit.mjs                 scan .pi-session/ and .worktrees/*/.pi-session/ under cwd
//   node scripts/token-audit.mjs <dir|file>...   specific sessions
//   node scripts/token-audit.mjs --json          machine-readable
//   node scripts/token-audit.mjs --top 20        more findings
//   node scripts/token-audit.mjs --save-baseline .pi-session/token-baseline.json
//   node scripts/token-audit.mjs --compare .pi-session/token-baseline.json
//                                              per-backend deltas; only |change| > 30% is flagged
//   node scripts/token-audit.mjs --mark "compaction at 200k" [--at 2026-10-20T09:00]
//                                              record a change; the dashboard's Tokens view splits before/after at it
//   node scripts/token-audit.mjs --cache       write .pi-session/token-audit/summary.json (the dashboard refreshes this itself)
//   node scripts/token-audit.mjs --selftest
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";

const CPT = 4;
const tok = (s) => Math.round(String(s ?? "").length / CPT);
const BIG_READ = 6000;      // ~24 KB, the read_budget threshold
const TARGETED_READ = 1500; // what a ranged read of the needed region costs instead
const BIG_OUTPUT = 2500;    // a bash result bigger than this was not bounded
const BOUNDED_OUTPUT = 500; // tail -n 40 / failures-only
const BIG_WRITE = 2000;     // full-file write of an existing file instead of an edit

// Price weights (Anthropic list-price ratios; close enough for OpenAI/Gemini to
// rank things): cache read 0.1, fresh input 1, cache write 1.25 (5m) / 2 (1h),
// output 5. "Weighted tokens" = API-equivalent cost units, NOT what a
// subscription bills - but it is what burns quota/rate limits proportionally.
export const W = { fresh: 1, cr: 0.1, cw5: 1.25, cw1h: 2, out: 5 };
/** One model call. All counts EXCLUSIVE of each other; ctx = what the model read. */
/** ISO string | epoch ms | epoch s -> epoch ms, or null. */
export function tsOf(v) {
	if (v == null || v === "") return null;
	if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
	const t = Date.parse(v); return Number.isFinite(t) ? t : null;
}
export function mkCall(model, { fresh = 0, cr = 0, cw5 = 0, cw1h = 0, out = 0 } = {}, inCost = 0, ts = null) {
	const n = (x) => (Number.isFinite(+x) ? Math.max(0, +x) : 0);
	fresh = n(fresh); cr = n(cr); cw5 = n(cw5); cw1h = n(cw1h); out = n(out);
	const ctx = fresh + cr + cw5 + cw1h;
	return { k: "call", model, fresh, cr, cw5, cw1h, out, ctx, input: ctx, inCost, ts,
		weighted: fresh * W.fresh + cr * W.cr + cw5 * W.cw5 + cw1h * W.cw1h + out * W.out };
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (typeof c === "string" ? c : c.text ?? (c.type === "image" ? "" : JSON.stringify(c.content ?? "")))).join("\n");
}

// A plain whole-file dump into context: `cat a`, `cat a b`, `cd x && nl -ba a`.
const CAT_LIKE = /^\s*(?:cd\s+\S+\s*&&\s*)?(cat|nl|bat|batcat|less|more)\s+(?:-\S+\s+)*[^|;&<>`$]+$/;

/** -> normalised events: {k:"call", usage, cost} | {k:"tool", name, args, id} | {k:"result", id, name, text} | {k:"compact"} */
export function parsePi(lines) {
	const ev = [];
	for (const l of lines) {
		let d; try { d = JSON.parse(l); } catch { continue; }
		if (d.type === "compaction") { ev.push({ k: "compact" }); continue; }
		// pi-subagents child transcript (subagent-artifacts/*_transcript.jsonl):
		// usage/model sit beside `message`, tool results carry `text`. VERIFIED shape.
		if (d.recordType === "message" && d.sourceEventType === "message_end") {
			d = { type: "message", message: { ...(d.message ?? {}), usage: d.usage ?? d.message?.usage, model: d.model ?? d.message?.model,
				provider: d.message?.provider ?? "pi-sub", toolCallId: d.toolCallId, toolName: d.toolName,
				content: d.role === "toolResult" ? [{ type: "text", text: d.text ?? "" }] : d.message?.content } };
		}
		if (d.type !== "message") continue;
		const m = d.message ?? {};
		if (m.role === "assistant") {
			const u = m.usage ?? {};
			ev.push(mkCall(`${m.provider ?? "?"}/${m.model ?? "?"}`, { fresh: u.input, cr: u.cacheRead, cw5: u.cacheWrite, out: u.output },
				(u.cost?.total ?? 0) - (u.cost?.output ?? 0), tsOf(d.timestamp ?? m.timestamp)));
			for (const c of m.content ?? []) if (c.type === "toolCall") ev.push({ k: "tool", id: c.id, name: c.name, args: c.arguments ?? {} });
		} else if (m.role === "toolResult") {
			ev.push({ k: "result", id: m.toolCallId, name: m.toolName, text: textOf(m.content) });
		}
	}
	return ev;
}

export function parseClaude(lines) {
	const ev = []; const seenMsg = new Set();
	for (const l of lines) {
		let d; try { d = JSON.parse(l); } catch { continue; }
		if (d.type === "summary" || d.isCompactSummary) { ev.push({ k: "compact" }); continue; }
		const m = d.message ?? {};
		if (d.type === "assistant") {
			// Claude Code writes one line per content block, sharing message.id: count the call once.
			if (!seenMsg.has(m.id)) {
				seenMsg.add(m.id);
				const u = m.usage ?? {};
				{
					const cc = u.cache_creation ?? {};
					const h1 = cc.ephemeral_1h_input_tokens ?? 0;
					const m5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - h1);
					ev.push(mkCall(`anthropic/${m.model ?? "?"}`, { fresh: u.input_tokens, cr: u.cache_read_input_tokens, cw5: m5, cw1h: h1, out: u.output_tokens }, 0, tsOf(d.timestamp)));
					// Advisor-style sub-calls are NOT in the top-level usage (they live in
					// usage.iterations as e.g. advisor_message) - count them separately.
					for (const it of u.iterations ?? []) if (it.type && it.type !== "message")
						ev.push(mkCall(`anthropic/${it.type}`, { fresh: it.input_tokens, cr: it.cache_read_input_tokens, cw5: it.cache_creation_input_tokens, out: it.output_tokens }, 0, tsOf(d.timestamp)));
				}
			}
			for (const c of m.content ?? []) if (c.type === "tool_use") {
				const a = c.input ?? {};
				const name = { Read: "read", Bash: "bash", Write: "write", Edit: "edit", MultiEdit: "edit" }[c.name] ?? c.name;
				ev.push({ k: "tool", id: c.id, name, args: { path: a.file_path, offset: a.offset, limit: a.limit, command: a.command, content: a.content } });
			}
		} else if (d.type === "user" && Array.isArray(m.content)) {
			for (const c of m.content) if (c.type === "tool_result") ev.push({ k: "result", id: c.tool_use_id, text: textOf(c.content) });
		}
	}
	return ev;
}

function codexCmds(input) {
	const s = String(input ?? "");
	const cmds = [...s.matchAll(/exec_command\(\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return m[1]; } });
	return { cmds, patch: /tools\.apply_patch\(/.test(s) };
}

export function parseCodex(lines) {
	const ev = [];
	for (const l of lines) {
		let d; try { d = JSON.parse(l); } catch { continue; }
		const p = d.payload ?? {};
		if (d.type === "compacted") { ev.push({ k: "compact" }); continue; }
		if (d.type === "token_usage_record") {
			const u = p.usage ?? {};
			ev.push(mkCall(`openai/${p.model ?? "codex"}`, { fresh: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), cr: u.cached_input_tokens, cw5: u.cache_write_input_tokens, out: u.output_tokens }, 0, tsOf(d.timestamp)));
			continue;
		}
		if (d.type !== "response_item") continue;
		if (p.type === "custom_tool_call" || p.type === "function_call") {
			let input = p.input ?? p.arguments ?? "";
			let { cmds, patch } = codexCmds(input);
			if (!cmds.length && p.type === "function_call") { try { const a = JSON.parse(input); const c = a.cmd ?? a.command; if (c) cmds = [Array.isArray(c) ? c.join(" ") : c]; } catch { /* not JSON */ } }
			const m = patch ? String(input).match(/\*\*\* (?:Update|Add) File: (.+)/) : null;
			ev.push(patch && !cmds.length ? { k: "tool", id: p.call_id, name: "edit", args: { path: m?.[1]?.trim() } }
				: { k: "tool", id: p.call_id, name: "bash", args: { command: cmds.length === 1 ? cmds[0] : cmds.join(" ; ") } });
		} else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
			ev.push({ k: "result", id: p.call_id, text: textOf(p.output) });
		}
	}
	return ev;
}

export function parseAntigravity(lines) {
	const ev = []; const pending = [];
	let n = 0;
	for (const l of lines) {
		let d; try { d = JSON.parse(l); } catch { continue; }
		if (d.type === "CHECKPOINT") { pending.length = 0; ev.push({ k: "compact" }); continue; }
		if (d.type === "PLANNER_RESPONSE") {
			ev.push(mkCall("antigravity", { fresh: d.input_tokens, cr: d.cache_read_tokens, out: d.output_tokens }, 0, tsOf(d.created_at)));
			for (const c of d.tool_calls ?? []) {
				const a = c.args ?? {}, id = `ag${n++}`;
				const map = {
					view_file: () => ({ name: "read", args: { path: a.AbsolutePath ?? a.TargetFile, limit: a.EndLine ? 1 : undefined } }),
					run_command: () => ({ name: "bash", args: { command: a.CommandLine } }),
					write_to_file: () => ({ name: "write", args: { path: a.TargetFile, content: a.CodeContent } }),
					replace_file_content: () => ({ name: "edit", args: { path: a.TargetFile } }),
					multi_replace_file_content: () => ({ name: "edit", args: { path: a.TargetFile } }),
				}[c.name];
				ev.push({ k: "tool", id, ...(map ? map() : { name: c.name, args: {} }) });
				pending.push(id);
			}
		} else if (d.type === "GENERIC" && pending.length) {
			ev.push({ k: "result", id: pending.shift(), text: String(d.content ?? "") });
		}
	}
	return ev;
}

/** OpenCode: opencode.db -> [{session, run, events}] (copies db + WAL to a temp dir first). */
export async function readOpencodeDb(dbPath) {
	const { mkdtempSync, copyFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	let DatabaseSync;
	try { ({ DatabaseSync } = await import("node:sqlite")); } catch { console.error(`token-audit: node:sqlite unavailable (Node >= 22.5 needed) - skipping ${dbPath}`); return []; }
	const tmp = mkdtempSync(join(tmpdir(), "token-audit-oc-"));
	try {
		for (const ext of ["", "-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, join(tmp, "opencode.db" + ext));
		const db = new DatabaseSync(join(tmp, "opencode.db"));
		const sessions = db.prepare("select id, parent_id, directory, title from session").all();
		const out = [];
		for (const s of sessions) {
			const msgs = db.prepare("select id, data from message where session_id = ? order by time_created, id").all(s.id);
			const parts = db.prepare("select message_id, data from part where session_id = ? order by time_created, id").all(s.id);
			const byMsg = new Map();
			for (const p of parts) { if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []); byMsg.get(p.message_id).push(JSON.parse(p.data)); }
			const ev = [];
			for (const m of msgs) {
				const j = JSON.parse(m.data);
				if (j.mode === "compaction" || j.summary === true) { ev.push({ k: "compact" }); continue; }
				if (j.role === "assistant") {
					const t = j.tokens ?? {};
					ev.push(mkCall(`${j.providerID ?? "?"}/${j.modelID ?? "?"}`, { fresh: t.input, cr: t.cache?.read, cw5: t.cache?.write, out: (t.output ?? 0) + (t.reasoning ?? 0) }, j.cost ?? 0, tsOf(j.time?.created)));
				}
				for (const p of byMsg.get(m.id) ?? []) {
					if (p.type === "compaction") { ev.push({ k: "compact" }); continue; }
					if (p.type !== "tool") continue;
					const a = p.state?.input ?? {};
					const name = { read: "read", bash: "bash", write: "write", edit: "edit" }[p.tool] ?? p.tool;
					ev.push({ k: "tool", id: p.callID, name, args: { path: a.filePath, limit: a.limit, offset: a.offset, command: a.command, content: a.content } });
					ev.push({ k: "result", id: p.callID, text: String(p.state?.output ?? "") });
				}
			}
			out.push({ session: `${dbPath}#${s.id}`, run: basename(s.directory ?? "") || s.id, parent: s.parent_id, events: ev });
		}
		db.close();
		return out;
	} finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** One session's events -> {calls, input, inCost, model, findings[]} */
export function analyze(ev, session) {
	const calls = ev.filter((e) => e.k === "call");
	const input = calls.reduce((s, c) => s + c.input, 0);
	const inCost = calls.reduce((s, c) => s + c.inCost, 0);
	const models = {}; for (const c of calls) models[c.model] = (models[c.model] ?? 0) + 1;
	const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
	// later[i] = assistant calls after event i until the next compaction
	const later = new Array(ev.length).fill(0);
	let run = 0;
	for (let i = ev.length - 1; i >= 0; i--) {
		if (ev[i].k === "compact") run = 0;
		later[i] = run;
		if (ev[i].k === "call") run += 1;
	}
	const tools = new Map();
	const lastRead = new Map(); // path -> event index of last full read still in context
	const findings = [];
	const add = (kind, i, label, tokens, avoidable) => {
		if (avoidable <= 0) return;
		findings.push({ session, kind, label, tokens, avoidable, later: later[i], resent: avoidable * later[i] });
	};
	ev.forEach((e, i) => {
		if (e.k === "compact") { lastRead.clear(); return; }
		if (e.k === "tool") {
			tools.set(e.id, e);
			const name = e.name, a = e.args ?? {};
			if ((name === "write") && a.path && tok(a.content) > BIG_WRITE && (lastRead.has(a.path)))
				add("whole_file_rewrite", i, a.path, tok(a.content), tok(a.content) - 300);
			if ((name === "write" || name === "edit") && a.path) lastRead.delete(a.path);
			return;
		}
		if (e.k !== "result") return;
		const call = tools.get(e.id) ?? { name: e.name, args: {} };
		const a = call.args ?? {};
		const t = tok(e.text);
		if (call.name === "read" && a.path) {
			const ranged = Number(a.limit) > 0;
			if (!ranged && lastRead.has(a.path)) add("re_read", i, a.path, t, t);
			else if (!ranged && t > BIG_READ) add("big_read", i, a.path, t, t - TARGETED_READ);
			if (!ranged) lastRead.set(a.path, i);
		} else if (call.name === "bash") {
			const cmd = String(a.command ?? "");
			const cat = cmd.match(CAT_LIKE);
			if (cat && t > BIG_READ) add("big_read", i, `$ ${cmd.slice(0, 60)}`, t, t - TARGETED_READ);
			else if (t > BIG_OUTPUT) add("unbounded_output", i, `$ ${cmd.replace(/\s+/g, " ").slice(0, 70)}`, t, t - BOUNDED_OUTPUT);
		} else if (t > BIG_OUTPUT * 2) {
			add("big_tool_result", i, `${call.name ?? "?"}`, t, t - BOUNDED_OUTPUT);
		}
	});
	const weighted = calls.reduce((s, c) => s + (c.weighted ?? c.input), 0);
	const cr = calls.reduce((s, c) => s + (c.cr ?? 0), 0);
	// A leak's first send is fresh input; every re-send after that is (at best) a
	// cache read - so the weighted cost of re-sending is ~0.1x, not 1x.
	for (const f of findings) f.weighted = f.avoidable * W.fresh + f.resent * W.cr;
	const stamps = calls.map((c) => c.ts).filter(Boolean);
	// per-call points for timelines / before-after splits: [ts, ctx, weighted]
	const points = calls.map((c) => [c.ts ?? null, c.ctx ?? c.input, c.weighted ?? c.input]);
	return { session, calls: calls.length, input, inCost, weighted, cr, ctxs: calls.map((c) => c.ctx ?? c.input), points,
		start: stamps.length ? Math.min(...stamps) : null, end: stamps.length ? Math.max(...stamps) : null, model,
		pricePerTok: input ? inCost / input : 0, findings };
}

function sniff(path) {
	if (basename(path) === "transcript_full.jsonl") return "antigravity";
	if (/^rollout-.*\.jsonl$/.test(basename(path))) return "codex";
	if (basename(path) === "opencode.db") return "opencode";
	if (/_transcript\.jsonl$/.test(basename(path)) && path.includes("subagent-artifacts")) return "pi";
	const head = readFileSync(path, "utf8").slice(0, 4000);
	if (head.startsWith('{"type":"session"') || head.includes('"type":"session","version"')) return "pi";
	if (/"type":"(assistant|user)"/.test(head) && head.includes('"sessionId"')) return "claude";
	return null;
}

// subagent runs we know of: antigravity child brains are listed by id in a
// parent's .system_generated/subagents/<id>.json; pi-subagents children live in
// subagent-artifacts/; Claude Code children under */subagents/.
const agySubIds = new Set();
function walk(dir, out = []) {
	let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of ents) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (!["node_modules", ".git", "chunks", "snapshot"].includes(e.name)) walk(p, out); }
		else if (basename(dir) === "subagents" && dir.includes(".system_generated") && e.name.endsWith(".json")) agySubIds.add(e.name.replace(/\.json$/, ""));
		else if (e.name === "opencode.db") out.push(p);
		else if (dir.endsWith("subagent-artifacts")) { if (e.name.endsWith("_transcript.jsonl")) out.push(p); }
		else if (e.name.endsWith(".jsonl") && e.name !== "evidence.jsonl" && e.name !== "transcript.jsonl" && !e.name.startsWith("usage-")) out.push(p);
	}
	return out;
}

function defaultRoots(cwd) {
	const roots = [join(cwd, ".pi-session")];
	const wt = join(cwd, ".worktrees");
	if (existsSync(wt)) for (const d of readdirSync(wt)) roots.push(join(wt, d, ".pi-session"));
	// OpenCode's shared login dir doubles as its session store (launch-worker.sh).
	const oc = join(process.env.HARNESS_CONFIG_ROOT ?? join(process.env.HOME ?? "", ".harness", "config"), "opencode");
	if (existsSync(join(oc, "opencode.db"))) roots.push(join(oc, "opencode.db"));
	return roots.filter(existsSync);
}

const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
const usd = (n) => (n >= 0.005 ? "$" + n.toFixed(2) : "$0");
const pct = (x) => (100 * x).toFixed(1) + "%";
export function quantile(arr, q) {
	if (!arr.length) return 0;
	const a = [...arr].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}
const median = (a) => quantile(a, 0.5);

function subRole(path, kind) {
	if (path.includes("subagent-artifacts")) return basename(path).replace(/^[0-9a-f-]+_/, "").replace(/_\d+_transcript\.jsonl$/, "");
	if (/\/subagents\//.test(path) && kind === "claude") return "claude-subagent";
	if (kind === "antigravity") { const m = path.match(/brain\/([0-9a-f-]{20,})\//); if (m && agySubIds.has(m[1])) return "antigravity-subagent"; }
	return null;
}

/** Collect + analyse every session. Returns the raw per-session list. */
export async function collect(paths, cwd = process.cwd()) {
	const files = (paths.length ? paths : defaultRoots(cwd)).flatMap((p) => (statSync(p).isDirectory() ? walk(p) : [p]));
	const sessions = [];
	for (const f of files) {
		const kind = sniff(f); if (!kind) continue;
		if (kind === "opencode") {
			for (const o of await readOpencodeDb(f)) {
				const s = analyze(o.events, o.session); s.backend = kind; s.run = o.run; s.sub = o.parent ? "opencode-subagent" : null;
				if (s.calls) sessions.push(s);
			}
			continue;
		}
		const lines = readFileSync(f, "utf8").split("\n");
		const ev = { pi: parsePi, claude: parseClaude, codex: parseCodex, antigravity: parseAntigravity }[kind](lines);
		const s = analyze(ev, relative(cwd, f));
		s.backend = kind;
		const parts = relative(cwd, f).split("/"); const i = parts.lastIndexOf(".pi-session");
		s.run = i >= 0 && parts[i + 1] ? parts[i + 1] : basename(dirname(f));
		s.sub = subRole(f, kind);
		if (s.calls) sessions.push(s);
	}
	return sessions;
}

export function statsOf(ss, totalWeighted = 0) {
	const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
	const weighted = totalWeighted;
		const ctxs = ss.flatMap((s) => s.ctxs);
		const main = ss.filter((s) => !s.sub);
		const w = sum(ss, "weighted"), lw = ss.flatMap((s) => s.findings).reduce((a, f) => a + f.weighted, 0);
		return {
			sessions: ss.length, subSessions: ss.length - main.length, calls: ctxs.length,
			weighted: w, share: weighted ? w / weighted : 0, subShare: w ? sum(ss.filter((s) => s.sub), "weighted") / w : 0,
			ctxP50: median(ctxs), ctxP95: quantile(ctxs, 0.95), ctxMax: Math.max(0, ...ctxs),
			over128k: ctxs.length ? ctxs.filter((c) => c > 128e3).length / ctxs.length : 0,
			over200k: ctxs.length ? ctxs.filter((c) => c > 200e3).length / ctxs.length : 0,
			cacheHit: sum(ss, "input") ? sum(ss, "cr") / sum(ss, "input") : 0,
			wPerSession: median(main.map((s) => s.weighted)), callsPerSession: median(main.map((s) => s.calls)),
			leakShare: w ? lw / w : 0,
			// lower bound on what compacting at 200k could save: the context above
			// 200k, re-read as cache (x0.1) on every call that carried it
			above200k: w ? ctxs.reduce((a, c) => a + Math.max(0, c - 200e3) * W.cr, 0) / w : 0,
		};
	}

/** Sessions -> the summary object (also what --save-baseline writes). */
export function summarize(sessions, top = 12) {
	const all = sessions.flatMap((s) => s.findings.map((f) => ({ ...f, run: s.run, backend: s.backend, usd: f.resent * s.pricePerTok })));
	const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
	const weighted = sum(sessions, "weighted"), input = sum(sessions, "input"), inCost = sum(sessions, "inCost");
	const leakW = sum(all, "weighted"), leaked = sum(all, "resent");
	const group = (key) => {
		const g = {};
		for (const s of sessions) (g[key(s)] ??= []).push(s);
		return g;
	};
	const stats = (ss) => statsOf(ss, weighted);
	const byBackend = Object.fromEntries(Object.entries(group((s) => s.backend)).map(([k, v]) => [k, stats(v)]));
	const bySub = Object.fromEntries(Object.entries(group((s) => s.sub ? `${s.sub} [${s.backend}]` : null)).filter(([k]) => k !== "null").map(([k, v]) => [k, stats(v)]));
	const byRun = Object.fromEntries(Object.entries(group((s) => `${s.run} [${s.backend}]`)).map(([k, v]) => [k, stats(v)]));
	const byKind = {}; for (const f of all) { const k = (byKind[f.kind] ??= { n: 0, resent: 0, weighted: 0 }); k.n++; k.resent += f.resent; k.weighted += f.weighted; }
	const hot = {}; for (const f of all) if (f.kind === "big_read" || f.kind === "re_read") { const x = (hot[f.label] ??= { n: 0, weighted: 0 }); x.n++; x.weighted += f.weighted; }
	return {
		generated: new Date().toISOString(), sessions: sessions.length, calls: sessions.reduce((a, s) => a + s.calls, 0),
		weighted, input, inCost, leaked, leakW, leakShare: weighted ? leakW / weighted : 0,
		byBackend, bySub, byRun, byKind,
		hotFiles: Object.entries(hot).sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 8),
		top: all.sort((a, b) => b.weighted - a.weighted).slice(0, top),
	};
}

/** Per backend, per UTC day: calls, weighted, ctx p50/p95, share of calls over 200k. */
export function daily(sessions, days = 28, now = Date.now()) {
	const from = now - days * 86400e3, out = {};
	for (const s of sessions) for (const [ts, ctx, w] of s.points ?? []) {
		if (!ts || ts < from) continue;
		const day = new Date(ts).toISOString().slice(0, 10);
		const b = ((out[s.backend] ??= {})[day] ??= { calls: 0, weighted: 0, ctxs: [] });
		b.calls++; b.weighted += w; b.ctxs.push(ctx);
	}
	for (const b of Object.values(out)) for (const [day, v] of Object.entries(b))
		b[day] = { calls: v.calls, weighted: Math.round(v.weighted), ctxP50: median(v.ctxs), ctxP95: quantile(v.ctxs, 0.95), over200k: v.ctxs.filter((c) => c > 200e3).length / v.ctxs.length };
	return out;
}

/** Split sessions at a marker (by session start) -> per-backend {before, after} stats. */
export function beforeAfter(sessions, at, windowDays = null) {
	const lo = windowDays ? at - windowDays * 86400e3 : -Infinity;
	const pick = (f) => sessions.filter((s) => s.start && f(s.start));
	const before = pick((t) => t < at && t >= lo), after = pick((t) => t >= at);
	const out = {};
	for (const b of new Set(sessions.map((s) => s.backend))) {
		const x = before.filter((s) => s.backend === b), y = after.filter((s) => s.backend === b);
		out[b] = { before: x.length ? statsOf(x) : null, after: y.length ? statsOf(y) : null };
	}
	return out;
}

const auditDir = (repo) => join(repo, ".pi-session", "token-audit");
export function loadMarkers(repo) { try { return JSON.parse(readFileSync(join(auditDir(repo), "markers.json"), "utf8")); } catch { return []; } }
export async function addMarker(repo, label, at = Date.now()) {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const m = [...loadMarkers(repo), { at, label }].sort((a, b) => a.at - b.at);
	mkdirSync(auditDir(repo), { recursive: true });
	writeFileSync(join(auditDir(repo), "markers.json"), JSON.stringify(m, null, 1));
	return m;
}
export function loadCache(repo) { try { return JSON.parse(readFileSync(join(auditDir(repo), "summary.json"), "utf8")); } catch { return null; } }

/** What the dashboard reads: summary + daily series + before/after at every marker. */
export async function writeCache(repo, paths = []) {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const sessions = await collect(paths, repo);
	const r = summarize(sessions, 8);
	const markers = loadMarkers(repo);
	const strip = ({ byRun, ...rest }) => ({ ...rest, byRun: Object.fromEntries(Object.entries(byRun).sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 10)) });
	const out = { at: Date.now(), summary: strip(r), daily: daily(sessions), markers: markers.map((m) => ({ ...m, split: beforeAfter(sessions, m.at) })) };
	mkdirSync(auditDir(repo), { recursive: true });
	writeFileSync(join(auditDir(repo), "summary.json"), JSON.stringify(out));
	return out;
}

const FIX = { big_read: "rule 1 + read_budget guard", re_read: "rule 4", unbounded_output: "rule 3 (log to file, tail)", whole_file_rewrite: "rule 7", big_tool_result: "rule 8 (narrow/cap)" };

export function render(r) {
	const L = [];
	L.push(`token-audit: ${r.sessions} sessions, ${fmt(r.calls)} model calls, ${fmt(r.weighted)} weighted tokens (${fmt(r.input)} raw context read${r.inCost ? `, ${usd(r.inCost)} input-side where billed` : ""})`);
	L.push(`weighted = fresh x1 + cache read x0.1 + cache write x1.25/2 + output x5 (API-equivalent; tracks quota burn, not subscription bills)`);
	L.push(`avoidable (weighted): ${fmt(r.leakW)} = ${pct(r.leakShare)} of weighted  [raw re-sent: ${fmt(r.leaked)}]`);
	L.push("", "by backend     sess(sub)  calls  weighted share  ctx p50  ctx p95  ctx max  >128k  >200k  cache  w/sess  calls/sess  avoid  sub%  >200k$");
	for (const [k, v] of Object.entries(r.byBackend).sort((a, b) => b[1].weighted - a[1].weighted))
		L.push(`  ${k.padEnd(12)} ${(v.sessions + "(" + v.subSessions + ")").padStart(9)} ${String(v.calls).padStart(6)} ${fmt(v.weighted).padStart(9)} ${pct(v.share).padStart(5)} ${fmt(v.ctxP50).padStart(8)} ${fmt(v.ctxP95).padStart(8)} ${fmt(v.ctxMax).padStart(8)} ${pct(v.over128k).padStart(6)} ${pct(v.over200k).padStart(6)} ${pct(v.cacheHit).padStart(6)} ${fmt(v.wPerSession).padStart(7)} ${String(v.callsPerSession).padStart(11)} ${pct(v.leakShare).padStart(6)} ${pct(v.subShare).padStart(5)} ${pct(v.above200k).padStart(7)}`);
	L.push("  >200k$ = share of weighted spent re-reading context above 200k: a lower bound on what compacting at 200k could save.");
	if (Object.keys(r.bySub).length) {
		L.push("", "subagents / review panel      runs  calls  weighted  of all  w/run   ctx p95");
		for (const [k, v] of Object.entries(r.bySub).sort((a, b) => b[1].weighted - a[1].weighted))
			L.push(`  ${k.slice(0, 28).padEnd(28)} ${String(v.sessions).padStart(5)} ${String(v.calls).padStart(6)} ${fmt(v.weighted).padStart(9)} ${pct(v.share).padStart(7)} ${fmt(v.weighted / v.sessions).padStart(7)} ${fmt(v.ctxP95).padStart(8)}`);
	}
	L.push("", "biggest runs (by weighted)                  weighted  share   calls  ctx p50  ctx p95  >200k  cache");
	for (const [k, v] of Object.entries(r.byRun).sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 12))
		L.push(`  ${k.slice(0, 40).padEnd(40)} ${fmt(v.weighted).padStart(10)} ${pct(v.share).padStart(6)} ${String(v.calls).padStart(7)} ${fmt(v.ctxP50).padStart(8)} ${fmt(v.ctxP95).padStart(8)} ${pct(v.over200k).padStart(6)} ${pct(v.cacheHit).padStart(6)}`);
	L.push("", "avoidable by kind       count   weighted   raw re-sent   fix");
	for (const [k, v] of Object.entries(r.byKind).sort((a, b) => b[1].weighted - a[1].weighted))
		L.push(`  ${k.padEnd(20)} ${String(v.n).padStart(6)} ${fmt(v.weighted).padStart(10)} ${fmt(v.resent).padStart(13)}   ${FIX[k] ?? ""}`);
	if (r.hotFiles.length) {
		L.push("", "files read whole repeatedly (weighted):");
		for (const [p, v] of r.hotFiles) L.push(`  ${String(v.n).padStart(3)}x  ${fmt(v.weighted).padStart(7)}  ${p}`);
	}
	L.push("", "top avoidable                tokens  x later   weighted   what");
	for (const f of r.top) L.push(`  ${f.kind.padEnd(19)} ${fmt(f.tokens).padStart(8)} ${String(f.later).padStart(8)} ${fmt(f.weighted).padStart(10)}   ${f.run}: ${f.label.slice(0, 64)}`);
	return L.join("\n");
}

// Run-to-run noise in agent cost is large (one independent study measured up to
// 54.5% between IDENTICAL runs), so a per-backend change is only flagged when it
// clears NOISE - and even then it is a lead, not proof.
const NOISE = 0.3;
export function compare(base, cur) {
	const L = [`compare: baseline ${base.generated.slice(0, 10)} (${base.sessions} sessions) -> now (${cur.sessions} sessions). Flag = |change| > ${NOISE * 100}%; smaller is within noise.`];
	const metrics = [["wPerSession", "weighted / session", true], ["callsPerSession", "calls / session", true], ["ctxP50", "ctx p50", true], ["ctxP95", "ctx p95", true],
		["over200k", "calls >200k", true], ["above200k", "cost above 200k", true], ["cacheHit", "cache hit", false], ["leakShare", "avoidable share", true], ["subShare", "subagent share", true]];
	for (const b of new Set([...Object.keys(base.byBackend), ...Object.keys(cur.byBackend)])) {
		const x = base.byBackend[b], y = cur.byBackend[b];
		if (!x || !y) { L.push(`  ${b}: ${x ? "no sessions now" : "new since baseline"}`); continue; }
		const newSess = y.sessions - x.sessions;
		L.push(`  ${b}  (${x.sessions} -> ${y.sessions} sessions${newSess < 10 ? `; only ${Math.max(0, newSess)} new - too few to judge` : ""})`);
		for (const [k, label, lowerIsBetter] of metrics) {
			const d = x[k] ? (y[k] - x[k]) / x[k] : 0;
			const flag = Math.abs(d) > NOISE ? ((d < 0) === lowerIsBetter ? "  BETTER" : "  WORSE") : "";
			const show = (v) => (k.includes("Share") || k === "cacheHit" || k === "over200k" || k === "above200k" ? pct(v) : fmt(v));
			L.push(`      ${label.padEnd(20)} ${show(x[k]).padStart(9)} -> ${show(y[k]).padStart(9)}  ${(d >= 0 ? "+" : "") + (100 * d).toFixed(0)}%${flag}`);
		}
	}
	return L.join("\n");
}

export async function run(paths, { json = false, top = 12, cwd = process.cwd(), saveBaseline = null, compareTo = null } = {}) {
	const r = summarize(await collect(paths, cwd), top);
	if (saveBaseline) { (await import("node:fs")).writeFileSync(saveBaseline, JSON.stringify(r, null, 2)); }
	if (compareTo) return compare(JSON.parse(readFileSync(compareTo, "utf8")), r);
	return (json ? JSON.stringify(r, null, 2) : render(r)) + (saveBaseline ? `\n\nbaseline saved: ${saveBaseline}` : "");
}

function selftest() {
	let fails = 0; const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
	const big = "x".repeat(40000);
	const J = (o) => JSON.stringify(o);
	const call = (content = []) => J({ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1000, cost: { total: 0.01, output: 0 } }, content } });
	const res = (id, name, text) => J({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] } });
	const lines = [J({ type: "session", version: 3 }),
		call([{ type: "toolCall", id: "a", name: "read", arguments: { path: "big.gd" } }]), res("a", "read", big),
		call([{ type: "toolCall", id: "b", name: "read", arguments: { path: "big.gd" } }]), res("b", "read", big),
		call([{ type: "toolCall", id: "c", name: "bash", arguments: { command: "npm test" } }]), res("c", "bash", "y".repeat(20000)),
		call([{ type: "toolCall", id: "d", name: "read", arguments: { path: "big.gd", limit: 50 } }]), res("d", "read", "z".repeat(800)),
		call(), J({ type: "compaction" }), call()];
	const s = analyze(parsePi(lines), "t");
	const k = Object.fromEntries(s.findings.map((f) => [f.kind, f]));
	ok(s.calls === 6, "counts assistant calls");
	ok(k.big_read && k.big_read.later === 4 && k.big_read.avoidable === 10000 - TARGETED_READ, "big_read: avoidable part x later calls");
	ok(k.re_read && k.re_read.avoidable === 10000, "re_read of unchanged file counted in full");
	ok(k.unbounded_output && k.unbounded_output.later === 2, "unbounded bash output; carry stops at compaction");
	ok(!s.findings.some((f) => f.label === "big.gd" && f.tokens === 200), "ranged read is not a leak");
	const wl = [J({ type: "session", version: 3 }), call([{ type: "toolCall", id: "a", name: "read", arguments: { path: "f" } }]), res("a", "read", "s"),
		call([{ type: "toolCall", id: "w", name: "edit", arguments: { path: "f" } }]), res("w", "edit", "ok"),
		call([{ type: "toolCall", id: "b", name: "read", arguments: { path: "f" } }]), res("b", "read", "s")];
	ok(!analyze(parsePi(wl), "t").findings.some((f) => f.kind === "re_read"), "re-read after an edit is legitimate");
	ok(CAT_LIKE.test("cat src/a.gd") && !CAT_LIKE.test("cat a | grep x"), "shell whole-file read detection");
	// codex: exec custom_tool_call wrapping exec_command; compaction
	const cx = [J({ type: "token_usage_record", payload: { usage: { input_tokens: 1000 } } }),
		J({ type: "response_item", payload: { type: "custom_tool_call", call_id: "x", name: "exec", input: 'text(await tools.exec_command({cmd:"cat docs/big.md","max_output_tokens":12000}));' } }),
		J({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "x", output: [{ type: "input_text", text: big }] } }),
		J({ type: "token_usage_record", payload: { usage: { input_tokens: 1000 } } }), J({ type: "token_usage_record", payload: { usage: { input_tokens: 1000 } } })];
	const cs = analyze(parseCodex(cx), "c");
	ok(cs.calls === 3 && cs.findings[0]?.kind === "big_read" && cs.findings[0].later === 2, "codex: exec_command cat parsed as a whole-file read");
	// antigravity: PLANNER_RESPONSE tool_calls paired in order with GENERIC steps
	const ag = [J({ type: "PLANNER_RESPONSE", input_tokens: 10, tool_calls: [{ name: "view_file", args: { AbsolutePath: "/r/a.md" } }, { name: "view_file", args: { AbsolutePath: "/r/b.md", StartLine: 1, EndLine: 40 } }] }),
		J({ type: "GENERIC", content: big }), J({ type: "GENERIC", content: big }), J({ type: "PLANNER_RESPONSE", input_tokens: 10, tool_calls: [] })];
	const as = analyze(parseAntigravity(ag), "a");
	ok(as.findings.length === 1 && as.findings[0].label === "/r/a.md", "antigravity: only the un-ranged view_file is a big read");
	ok(CAT_LIKE.test("cd /repo && cat a.md b.md") && !CAT_LIKE.test("cat a | head"), "multi-file / cd-prefixed cat detected");
	// weighting + per-backend input semantics
	const c1 = mkCall("x", { fresh: 100, cr: 1000, cw5: 10, cw1h: 10, out: 10 });
	ok(c1.ctx === 1120 && Math.abs(c1.weighted - (100 + 100 + 12.5 + 20 + 50)) < 1e-9, "weighted = fresh + 0.1 cr + 1.25/2 cw + 5 out");
	const cxc = parseCodex([J({ type: "token_usage_record", payload: { usage: { input_tokens: 15883, cached_input_tokens: 12160, output_tokens: 136 } } })])[0];
	ok(cxc.fresh === 3723 && cxc.cr === 12160 && cxc.ctx === 15883, "codex: input_tokens INCLUDES cached - not double-counted");
	ok(quantile([5, 1, 4, 2, 3], 0.5) === 3 && quantile([1, 2, 3, 4, 100], 0.95) === 100, "quantile");
	const mk = (w) => ({ generated: "2026-10-20", sessions: 20, byBackend: { pi: { sessions: 20, wPerSession: w, callsPerSession: 10, ctxP50: 1, ctxP95: 1, over200k: 0, cacheHit: 0.9, leakShare: 0.1, subShare: 0 } } });
	const cmp = compare(mk(100), { ...mk(60), sessions: 40, byBackend: { pi: { ...mk(60).byBackend.pi, sessions: 40 } } });
	ok(/weighted \/ session.*-40%  BETTER/.test(cmp), "compare flags a change beyond noise");
	ok(!/BETTER|WORSE/.test(compare(mk(100), mk(80)).split("\n").filter((l) => l.includes("weighted /")).join("")), "compare does not flag a change within noise");
	// before/after split + daily series
	const mkS = (backend, start, ctx) => ({ backend, start, sub: null, weighted: ctx, input: ctx, cr: 0, calls: 1, ctxs: [ctx], points: [[start, ctx, ctx]], findings: [] });
	const T = Date.parse("2026-10-20T00:00:00Z");
	const ss = [mkS("claude", T - 86400e3, 600e3), mkS("claude", T - 3600e3, 500e3), mkS("claude", T + 3600e3, 180e3)];
	const ba = beforeAfter(ss, T).claude;
	ok(ba.before.sessions === 2 && ba.after.sessions === 1 && ba.after.ctxP50 === 180e3, "beforeAfter splits by session start");
	const dl = daily(ss, 28, T + 86400e3).claude;
	ok(Object.keys(dl).length === 2 && dl["2026-10-19"].calls === 2, "daily buckets by UTC day");
	ok(tsOf("2026-10-20T00:00:00Z") === T && tsOf(1792157348) === 1792157348000, "tsOf handles ISO and epoch seconds");
	if (fails) { console.error(fails + " self-test(s) FAILED"); process.exit(1); }
	console.log("token-audit self-test: all passed");
}

const argv = process.argv.slice(2);
if (process.argv[1]?.endsWith("token-audit.mjs")) {
	if (argv.includes("--selftest")) selftest();
	else {
		const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
		const valued = new Set(["--top", "--save-baseline", "--compare", "--mark", "--at"]);
		const paths = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
		const repo = process.env.HARNESS_REPO_ROOT || process.cwd();
		if (opt("--mark")) {
			const at = opt("--at") ? tsOf(opt("--at")) : Date.now();
			addMarker(repo, opt("--mark"), at).then((m) => console.log(`marker added (${m.length} total): ${new Date(at).toISOString()} ${opt("--mark")}`));
		} else if (argv.includes("--cache")) {
			writeCache(repo, paths).then((o) => console.log(`token-audit cache: ${Object.keys(o.daily).length} backends, ${o.markers.length} markers -> .pi-session/token-audit/summary.json`));
		} else run(paths, { json: argv.includes("--json"), top: Number(opt("--top") ?? 12), saveBaseline: opt("--save-baseline"), compareTo: opt("--compare") })
			.then((r) => console.log(r));
	}
}
