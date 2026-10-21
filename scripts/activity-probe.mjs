#!/usr/bin/env node
/**
 * activity-probe — "when did this change's worker last DO something?"
 *
 * WHY (2026-10-20): the watchdog skipped any change whose worker pane showed
 * agent_status "working". A model request that never returns also shows
 * "working" - on 2026-10-19 an opencode worker request (gpt-6-luna via
 * opencode-go) hung from 23:14 to 07:48 and the harness stayed silent all
 * night. Herdr's busy flag cannot tell "busy" from "stuck", so the watchdog
 * now asks for real activity instead.
 *
 * Activity sources (newest wins), all read-only:
 *   1. <worktree>/.pi-session/activity/*.json   progress heartbeats written by
 *      long-running tools (scripts/godot-remote.sh writes one every 60 s), so
 *      a 30-minute render job that is still reporting is NOT quiet;
 *   2. <worktree>/.pi-session/**.jsonl          session logs / evidence (pi,
 *      Codex rollouts, Claude transcripts, the contract evidence log);
 *   3. opencode's SQLite store                  newest message part for the
 *      session whose directory is this worktree, plus whether a model request
 *      is still open (opencode keeps no per-worktree log file);
 *   4. the worktree's HEAD commit time.
 *
 * Every source fails soft: an unreadable one is skipped, never fatal.
 *
 * CLI: node scripts/activity-probe.mjs CHANGE-NNNN   (prints the probe as JSON)
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function worktreeOf(repoRoot, change) {
	const lc = String(change).toLowerCase();
	try {
		const d = readdirSync(join(repoRoot, ".worktrees")).find((n) => n === `harness-${lc}` || n.startsWith(`harness-${lc}-`));
		return d ? join(repoRoot, ".worktrees", d) : null;
	} catch { return null; }
}

function newestMtime(dir, { depth = 6, test = () => true, skip = [] } = {}) {
	let best = null;
	const walk = (d, left) => {
		let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of es) {
			const p = join(d, e.name);
			if (e.isDirectory()) { if (left > 0 && !skip.includes(e.name)) walk(p, left - 1); continue; }
			if (!test(e.name)) continue;
			try { const m = statSync(p).mtimeMs; if (!best || m > best.at) best = { at: m, path: p }; } catch { /* gone */ }
		}
	};
	walk(dir, depth);
	return best;
}

/** Progress heartbeats from long-running tools (see godot-remote.sh). */
export function progressFiles(worktree, now = Date.now()) {
	const dir = join(worktree, ".pi-session", "activity");
	let names = []; try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
	const out = [];
	for (const n of names) {
		const p = join(dir, n);
		try {
			const j = JSON.parse(readFileSync(p, "utf8"));
			out.push({ ...j, file: p, mtime: statSync(p).mtimeMs, age_min: (now - statSync(p).mtimeMs) / 60000 });
		} catch { /* half-written */ }
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

export const opencodeDbPath = () => process.env.HARNESS_OPENCODE_DB || join(homedir(), ".harness", "config", "opencode", "opencode.db");

function sqliteJson(db, sql) {
	// macOS ships /usr/bin/sqlite3; fall back to node:sqlite (node >= 22.5).
	try {
		const out = execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		return out.trim() ? JSON.parse(out) : [];
	} catch { /* try node:sqlite */ }
	try {
		const req = globalThis.process.getBuiltinModule?.("node:sqlite");
		if (!req) return null;
		const c = new req.DatabaseSync(db, { readOnly: true });
		try { return c.prepare(sql).all(); } finally { c.close(); }
	} catch { return null; }
}

/** Newest opencode part + any still-open model request for sessions in this worktree. */
export function opencodeActivity(worktree, db = opencodeDbPath()) {
	if (!worktree || !existsSync(db)) return null;
	const name = basename(worktree);
	if (!/^[\w.-]+$/.test(name)) return null;
	const like = `%/.worktrees/${name}`;
	const parts = sqliteJson(db, `select max(p.time_updated) as at from part p join session s on p.session_id = s.id where s.directory like '${like}'`);
	const msgs = sqliteJson(db, `select m.time_created as created, m.data as data from message m join session s on m.session_id = s.id where s.directory like '${like}' order by m.time_created desc limit 1`);
	if (!parts && !msgs) return null;
	let open = null;
	const m = msgs?.[0];
	if (m) {
		try {
			const j = JSON.parse(m.data);
			if (j.role === "assistant" && !j.time?.completed && !j.error) open = { since: j.time?.created ?? m.created, provider: j.providerID, model: j.modelID };
		} catch { /* unparseable */ }
	}
	const at = Number(parts?.[0]?.at) || null;
	return { at, open };
}

function headCommitTime(worktree) {
	try { return Number(execFileSync("git", ["-C", worktree, "log", "-1", "--format=%ct"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim()) * 1000 || null; }
	catch { return null; }
}

/**
 * @returns {{ at: number|null, source: string|null, quiet_min: number|null,
 *            progress: object|null, open_request: object|null, worktree: string|null }}
 */
export function lastActivity(repoRoot, change, { now = Date.now(), db = opencodeDbPath() } = {}) {
	const worktree = worktreeOf(repoRoot, change);
	if (!worktree) return { at: null, source: null, quiet_min: null, progress: null, open_request: null, worktree: null };
	const cands = [];
	const prog = progressFiles(worktree, now);
	if (prog[0]) cands.push({ at: prog[0].mtime, source: `progress ${basename(prog[0].file)}` });
	const logs = newestMtime(join(worktree, ".pi-session"), { test: (n) => n.endsWith(".jsonl"), skip: ["activity", "handoff", "qualify", "triage"] });
	if (logs) cands.push({ at: logs.at, source: `session log ${basename(logs.path)}` });
	const oc = opencodeActivity(worktree, db);
	if (oc?.at) cands.push({ at: oc.at, source: "opencode session" });
	const head = headCommitTime(worktree);
	if (head) cands.push({ at: head, source: "commit" });
	const best = cands.sort((a, b) => b.at - a.at)[0] ?? null;
	// A heartbeat younger than 5 minutes means a long tool is genuinely running.
	const running = prog.find((p) => p.age_min < 5 && !/^done/.test(String(p.state ?? ""))) ?? null;
	return {
		at: best?.at ?? null,
		source: best?.source ?? null,
		quiet_min: best ? (now - best.at) / 60000 : null,
		progress: running,
		open_request: oc?.open ? { ...oc.open, open_min: (now - oc.open.since) / 60000 } : null,
		worktree,
	};
}

/** One line for the triage note. */
export function describeQuiet(a) {
	if (!a || a.quiet_min == null) return "no activity source found";
	const parts = [`last activity ${Math.round(a.quiet_min)} min ago (${a.source})`];
	if (a.open_request) parts.push(`a model request to ${a.open_request.provider}/${a.open_request.model} has been open for ${Math.round(a.open_request.open_min)} min`);
	return parts.join("; ");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const change = process.argv[2];
	if (!/^CHANGE-\d+$/.test(change ?? "")) { console.error("usage: activity-probe.mjs CHANGE-NNNN"); process.exit(2); }
	const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	const a = lastActivity(repoRoot, change);
	console.log(JSON.stringify({ ...a, summary: describeQuiet(a) }, null, 2));
}
