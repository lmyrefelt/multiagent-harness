/**
 * read-budget.mjs — the `read_budget` check: stop whole-file reads of big text
 * files and hand the model an outline instead.
 *
 * WHY. Every tool result stays in context and is re-sent on EVERY later call
 * until compaction. A 6k-token file read at call 5 of a 60-call worker session
 * is paid ~55 more times. Ported from tokenleak's Claude-Code-only read guard
 * (github.com/Pazificateur69/tokenleak, MIT) onto this harness's one shared
 * engine, so pi, Claude, OpenCode, Antigravity AND Codex all get it through
 * their existing adapters - no per-agent hook.
 *
 * NOT A REFUSAL. This check runs with on_violation: "redirect" (see
 * evaluateDuring in checks.mjs): the call is stopped and the model gets the
 * outline, but it does NOT count toward consecutive/total refusal caps and can
 * never trigger a hard stop. A redirected read is not misbehaviour.
 *
 * ESCAPE HATCHES (never trap a model that genuinely needs the whole file):
 *   1. any ranged read passes (limit / EndLine / sed -n, head, tail ...);
 *   2. the SAME path asked for a second time passes - the redirect fires once
 *      per path per session (state in ctx.counters.read_redirected).
 *
 * FAILS OPEN, deliberately - the opposite of the boundary guards. A read guard
 * that errors must not stop a worker from reading; every unexpected condition
 * (stat fails, binary, unknown tool shape) returns null = allow.
 */
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";

export const READ_BUDGET_DEFAULTS = {
	max_bytes: 24000,
	outline_max: 60,
	// logs and data: no structure worth a map, grep is the way in. Still guarded.
	no_outline: [".log", ".txt", ".out", ".json", ".jsonl", ".ndjson", ".xml", ".html", ".htm", ".css", ".lock", ".map", ".min.js", ".sql"],
	// never guarded: binaries/media the read tool handles itself
	skip: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".svg", ".ico", ".wasm", ".zip", ".gz"],
};
const CHARS_PER_TOKEN = 4;

const CODE = new RegExp(
	String.raw`\s*(?:export\s+|pub(?:\([^)]*\))?\s+|async\s+|default\s+|abstract\s+|static\s+)*` +
	String.raw`(?:def|class|func|fn|function|interface|struct|enum|trait|impl|type|module|signal|extends|class_name|@export|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)` +
	String.raw`|(?:public|private|protected|internal|static|override)\s[^;=]*\()`);
const CONST = /^[A-Z_][A-Z0-9_]*\s*(?::[^=]*)?=(?!=)/;
const MD = /^#{1,4}\s+\S/;
const TSCN = /^\[(?:node|sub_resource|ext_resource|connection|gd_scene|resource)\b/; // Godot scene/resource sections

/** The lines of a big file worth jumping to, as `line: text` (1-based). */
export function outline(path, text, max = READ_BUDGET_DEFAULTS.outline_max, noOutline = READ_BUDGET_DEFAULTS.no_outline) {
	const low = path.toLowerCase();
	if (noOutline.some((e) => low.endsWith(e))) return [];
	const lines = text.replace(/^﻿/, "").split("\n");
	if (low.endsWith(".csv") || low.endsWith(".tsv")) return lines[0]?.trim() ? [`1: ${lines[0].trim().slice(0, 160)}  (header)`] : [];
	const md = /\.(md|markdown|mdx)$/.test(low);
	const godot = /\.(tscn|tres|godot)$/.test(low);
	const groups = new Map(); // "depth|isConst" -> [[n, text]]
	const add = (k, n, t) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push([n, t]); };
	let fence = false;
	lines.forEach((raw, i) => {
		const line = raw.replace(/\r$/, "");
		const n = i + 1;
		if (md) {
			if (/^\s*(```|~~~)/.test(line)) fence = !fence;
			else if (!fence && MD.test(line)) add(`${line.length - line.replace(/^#+/, "").length}|0`, n, line.slice(0, 70));
		} else if (godot) {
			if (TSCN.test(line)) add("0|0", n, line.slice(0, 90));
		} else {
			const isCode = new RegExp("^" + CODE.source).test(line);
			if (isCode || CONST.test(line)) add(`${line.length - line.trimStart().length}|${isCode ? 0 : 1}`, n, line.trim().slice(0, 70));
		}
	});
	const keys = [...groups.keys()].sort((a, b) => {
		const [da, ca] = a.split("|").map(Number), [db, cb] = b.split("|").map(Number);
		return da - db || ca - cb;
	});
	let keep = [], step = 1;
	for (const k of keys) {
		let g = groups.get(k);
		if (keep.length && keep.length + g.length > max) break;
		if (g.length > max) { step = Math.ceil(g.length / max); g = g.filter((_, j) => j % step === 0); }
		keep = keep.concat(g);
	}
	const total = [...groups.values()].reduce((s, g) => s + g.length, 0);
	const rows = keep.sort((a, b) => a[0] - b[0]).map(([n, t]) => `${n}: ${t}`);
	const more = total - keep.length;
	if (more) rows.push(`... ${more} more not shown (${step > 1 ? `1 in ${step} outer ones listed, the rest nested or constants` : "nested or constants"}); grep -n for them`);
	return rows;
}

const CAT_LIKE = new Set(["cat", "nl", "bat", "batcat", "less", "more", "view"]);

/**
 * Codex (and any agent reading through the shell): the files a plain
 * whole-file read like `cat a b` / `nl -ba path` / `cd dir && cat path` dumps
 * into context, as {dir, files}, else null. MEASURED (token-audit over 45 real
 * sessions): the `cd X && cat a b` form was the most common shell leak, so a
 * leading `cd <dir> &&` and several files are both handled. Anything piped,
 * redirected or otherwise chained is NOT a whole-file read (or the model is
 * already bounding it) -> null.
 */
export function bashReadTarget(command) {
	let cmd = String(command ?? "").trim();
	let dir = null;
	const cd = cmd.match(/^cd\s+('[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/);
	if (cd) { dir = cd[1].replace(/^(['"])(.*)\1$/, "$2"); cmd = cmd.slice(cd[0].length); }
	if (!cmd || /[|;&<>`]|\$\(/.test(cmd)) return null;
	const argv = cmd.match(/'[^']*'|"[^"]*"|\S+/g)?.map((a) => a.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
	if (!CAT_LIKE.has(basename(argv[0] ?? ""))) return null;
	const files = argv.slice(1).filter((a) => a !== "--" && !a.startsWith("-"));
	return files.length ? { dir, files } : null;
}

/** Normalise one canonical read event -> { path, ranged } or null if it isn't a read. */
export function readIntent(tool, input = {}) {
	if (tool === "read") {
		const path = input.path ?? input.file_path ?? input.filePath;
		const lim = Number(input.limit ?? 0), end = Number(input.end_line ?? input.endLine ?? 0);
		return path ? { path: String(path), ranged: lim > 0 || end > 0 } : null;
	}
	if (tool === "bash") {
		const t = bashReadTarget(input.command);
		if (!t) return null;
		const base = t.dir ? (isAbsolute(t.dir) || !input.cwd ? t.dir : join(input.cwd, t.dir)) : input.cwd;
		const files = t.files.map((f) => (base && !isAbsolute(f) ? join(base, f) : f));
		return { path: files[0], files, ranged: false, viaShell: true };
	}
	return null;
}

/**
 * The check. Returns null (allow) or the redirect message. Mutates
 * ctx.counters.read_redirected (the once-per-path escape hatch).
 */
export function evaluateReadBudget(tool, input, ctx, params = {}) {
	try {
		const intent = readIntent(tool, input);
		if (!intent || intent.ranged) return null;
		const p = { ...READ_BUDGET_DEFAULTS, ...params };
		const envMax = Number(process.env.READ_BUDGET_BYTES ?? "");
		if (process.env.READ_BUDGET === "0") return null;
		const maxBytes = envMax > 0 ? envMax : p.max_bytes;
		const low = intent.path.toLowerCase();
		if (p.skip.some((e) => low.endsWith(e))) return null;
		const absOf = (f) => (isAbsolute(f) ? f : join(ctx.repoRoot ?? process.cwd(), f));
		if (intent.files?.length > 1) {
			// several files in one cat: redirect on the combined size, no outline (one per file would be noise)
			let total = 0;
			for (const f of intent.files) { try { const s2 = statSync(absOf(f)); if (s2.isFile()) total += s2.size; } catch { /* missing: cat will say so */ } }
			if (total <= maxBytes) return null;
			const key = "multi:" + intent.files.map(absOf).join("|");
			const seen = (ctx.counters.read_redirected ??= []);
			if (seen.includes(key)) return null;
			seen.push(key);
			return `READ BUDGET (not a violation, nothing counted against you): those ${intent.files.length} files are ~${Math.round(total / CHARS_PER_TOKEN / 1000)}k tokens together and every later call would re-send them. ` +
				`Read each one only as far as you need: \`wc -l\` them, \`rg -n <pattern>\` across them, then \`sed -n 'A,Bp' <file>\`. If you really need all of them whole, repeat the exact same command - it will go through.`;
		}
		const abs = absOf(intent.path);
		const st = statSync(abs);
		if (!st.isFile() || st.size <= maxBytes) return null;
		const seen = (ctx.counters.read_redirected ??= []);
		if (seen.includes(abs)) return null; // second ask for the same file: let it through
		const fd = openSync(abs, "r");
		const buf = Buffer.alloc(Math.min(st.size, 1 << 22));
		try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
		if (buf.subarray(0, 4096).includes(0)) return null; // binary: the read tool decides
		const text = buf.toString("utf8");
		const headLines = (text.match(/\n/g) ?? []).length;
		const lines = buf.length < st.size ? Math.round(headLines * st.size / buf.length) : headLines + 1;
		seen.push(abs);
		if (seen.length > 200) seen.splice(0, seen.length - 200);
		const rows = outline(intent.path, text, p.outline_max, p.no_outline);
		const name = basename(intent.path);
		const how = intent.viaShell
			? `Read only the part you need: \`sed -n 'A,Bp' ${intent.path}\`, or \`rg -n <pattern> ${intent.path}\` first`
			: `Read only the part you need with offset and limit${rows.length ? " (outline below)" : ""}, or grep -n first`;
		let msg = `READ BUDGET (not a violation, nothing counted against you): ${name} is ${lines.toLocaleString("en")} lines ` +
			`(~${Math.round(st.size / CHARS_PER_TOKEN / 1000)}k tokens) and every later call would re-send it. ${how}. ` +
			`If you really need the whole file, repeat the exact same read - it will go through.`;
		if (rows.length) msg += `\nOutline (line: text${buf.length < st.size ? ", first 4 MB only" : ""}):\n` + rows.map((r) => "  " + r).join("\n");
		return msg;
	} catch {
		return null; // fail OPEN - see header
	}
}
