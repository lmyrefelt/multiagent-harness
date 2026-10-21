#!/usr/bin/env node
/**
 * notify.mjs - native macOS notifications with buttons for everything the harness needs from the
 * owner (owner, 2026-10-21). The HarnessNotify app (tools/harness-notify) shows them and calls
 * `node scripts/notify.mjs respond <id> <action> [text]` the moment a button is clicked.
 *
 * Kinds and their buttons (Dismiss is always there - closing the notification):
 *   decision  up to 3 suggestions (each a FIXED command the harness wrote), Reply (text) when the
 *             question can be answered in words, Details (opens the full text)
 *   run       Run (runs the stored script in the background, then notifies the result),
 *             Show script, Decline
 *   read      Open file, Show in Finder
 *   info      Open status (STATUS.md) when nothing else applies
 *
 * Safety: a command only ever comes from harness code (the builders below and fromMessage's
 * fixed patterns for handoff/art-gen commands with a CHANGE-NNNN argument). Text written by
 * agents (notes) is shown, never executed. Every record carries a sha256 of its commands;
 * `respond` refuses a record whose commands changed after it was posted. Records live in
 * ~/.harness/notify (outside every repository, so containers cannot write them).
 *
 *   node scripts/notify.mjs post --kind read --title T --body B --file <path>
 *   node scripts/notify.mjs post --kind run --title T --body B --cmd '<shell>' [--cwd dir]
 *   node scripts/notify.mjs test           one notification of each kind
 *   node scripts/notify.mjs respond <id> <action> [text]      (called by HarnessNotify)
 *   node scripts/notify.mjs --selftest
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, openSync, closeSync, renameSync } from "node:fs";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
export const BASE = process.env.HARNESS_NOTIFY_DIR || join(homedir(), ".harness", "notify");
const D = (k) => join(BASE, k);
export const APP_PATHS = [join(homedir(), "Applications", "HarnessNotify.app"), "/Applications/HarnessNotify.app"];
export const appInstalled = () => process.platform === "darwin" && APP_PATHS.some((p) => existsSync(p));

const sha = (s) => createHash("sha256").update(s).digest("hex");
const commandsOf = (rec) => JSON.stringify([rec.script ?? null, (rec.suggestions ?? []).map((s) => s.cmd ?? null), rec.reply ?? null]);
const abs = (p) => (p ? (isAbsolute(p) ? p : join(REPO, p)) : null);

/** Notification record -> what HarnessNotify shows: title, body and buttons. Pure. */
export function buttonsFor(rec) {
	const a = [];
	if (rec.kind === "decision") {
		(rec.suggestions ?? []).slice(0, 3).forEach((s, i) => a.push({ id: `s${i}`, label: s.label.slice(0, 40) }));
		if (rec.reply) a.push({ id: "reply", label: rec.reply.label ?? "Reply…", text: true, placeholder: rec.reply.placeholder ?? "Your answer" });
		if (rec.details || rec.file) a.push({ id: "details", label: "Details" });
	} else if (rec.kind === "run") {
		a.push({ id: "run", label: "Run" }, { id: "show", label: "Show script" }, { id: "decline", label: "Decline", destructive: true });
	} else if (rec.kind === "read" && rec.file) {
		a.push({ id: "open", label: "Open file" }, { id: "reveal", label: "Show in Finder" });
	} else if (rec.file) a.push({ id: "open", label: "Open" });
	return a;
}

/** Turn a watcher message into a record. Only fixed, known command shapes become buttons. Pure. */
export function fromMessage(message, title = "Harness", { repo = REPO } = {}) {
	const msg = String(message);
	const rec = { kind: "info", title, body: msg, file: null };
	const ch = (msg.match(/CHANGE-\d{4}/) ?? [])[0] ?? null;
	const node = "node";
	let m;
	if ((m = msg.match(/handoff\.mjs approve-merge --change (CHANGE-\d{4})/))) {
		rec.kind = "decision"; rec.title = `${m[1]} needs you`;
		rec.suggestions = [{ label: "Approve merge", cmd: [node, "scripts/handoff.mjs", "approve-merge", "--change", m[1]] }];
		rec.reply = { label: "Reply…", placeholder: "Answer for the integrator", cmd: [node, "scripts/handoff.mjs", "answer", "--change", m[1], "--note"] };
		rec.body = msg.replace(/\s*\(if it is a merge the gate refused:.*\)\s*$/, "");
	} else if ((m = msg.match(/handoff\.mjs answer --change (CHANGE-\d{4})/))) {
		rec.kind = "decision"; rec.title = `${m[1]}: a question for you`;
		rec.reply = { label: "Answer…", placeholder: "Your answer", cmd: [node, "scripts/handoff.mjs", "answer", "--change", m[1], "--note"] };
		rec.body = msg.replace(/\s*-\s*answer with: node scripts\/handoff\.mjs answer.*$/, "");
	} else if ((m = msg.match(/handoff\.mjs reconcile --live --retry (CHANGE-\d{4})/))) {
		rec.kind = "run"; rec.title = `${m[1]}: start again?`;
		rec.script = { cmd: `node scripts/handoff.mjs reconcile --live --retry ${m[1]}`, cwd: repo };
		rec.body = msg.replace(/\s*Fix the cause, then run:.*$/, " - fix the cause first, then Run retries the launch.");
	} else if ((m = msg.match(/art-gen\.mjs approve (\S+\.png) --to (research_docs\/Graphics\/\S+\.png)/))) {
		rec.kind = "decision"; rec.title = "Approve generated art?";
		rec.suggestions = [{ label: "Approve", cmd: [node, "scripts/art-gen.mjs", "approve", m[1], "--to", m[2]] }];
		rec.file = m[1];
	}
	// a document the message points at: triage, report, contact sheet, STATUS.md
	if (!rec.file) {
		const f = (msg.match(/(?:triage:|see|file:?)\s+((?:\.pi-session|docs|research_docs)\/[^\s,)]+\.(?:md|png|html|json))/) ?? msg.match(/((?:\.pi-session|docs)\/[^\s,)]+\.(?:md|png|html))/) ?? [])[1];
		if (f) { rec.file = f; if (rec.kind === "info") rec.kind = "read"; }
	}
	if (rec.kind === "info" && /digest/i.test(title)) { rec.kind = "read"; rec.file = ".pi-session/STATUS.md"; }
	if (rec.kind === "info") rec.file = ".pi-session/STATUS.md";
	if (rec.kind === "decision" && !rec.file) rec.details = msg;
	rec.change = ch;
	return rec;
}

/** Write the record and the display file HarnessNotify picks up. Returns the id. */
export function post(rec) {
	for (const k of ["queue", "pending", "logs", "details"]) mkdirSync(D(k), { recursive: true });
	const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
	const full = { ...rec, id, repo: REPO, at: new Date().toISOString(), file: rec.file ? abs(rec.file) : null };
	if (full.script) { full.script.cwd = full.script.cwd ?? REPO; full.script.sha256 = sha(full.script.cmd); }
	full.commands_sha256 = sha(commandsOf(full));
	writeFileSync(join(D("pending"), `${id}.json`), JSON.stringify(full, null, 1), { mode: 0o600 });
	const show = { id, title: full.title.slice(0, 80), subtitle: full.change && !full.title.includes(full.change) ? full.change : "", body: full.body.slice(0, 400), actions: buttonsFor(full),
		handler: [process.execPath, join(HERE, "notify.mjs"), "respond", id], sound: full.kind === "decision" || full.kind === "run" };
	const tmp = join(D("queue"), `.${id}.tmp`);
	writeFileSync(tmp, JSON.stringify(show), { mode: 0o600 });
	renameSync(tmp, join(D("queue"), `${id}.json`));
	return id;
}

/** Post via HarnessNotify when installed; returns false so the caller can fall back. */
export function notifyRich(message, title) {
	if (!appInstalled()) return false;
	try { post(fromMessage(message, title)); return true; } catch { return false; }
}

const hist = (o) => { try { appendFileSync(D("history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n"); } catch { /* */ } };
const openPath = (p, reveal = false) => spawnSync("open", reveal ? ["-R", p] : [p], { stdio: "ignore" });

export function respond(id, action, text = "") {
	const pf = join(D("pending"), `${id}.json`);
	let rec; try { rec = JSON.parse(readFileSync(pf, "utf8")); } catch { console.error(`no notification ${id}`); return 1; }
	if (sha(commandsOf(rec)) !== rec.commands_sha256 || (rec.script && sha(rec.script.cmd) !== rec.script.sha256)) { hist({ id, action, refused: "commands changed after posting" }); post({ kind: "info", title: "Refused", body: `The notification "${rec.title}" was changed after it was posted - nothing was run.` }); return 2; }
	hist({ id, action, title: rec.title, text: text ? text.slice(0, 200) : undefined });
	const done = (status) => { rec.response = { action, status, at: new Date().toISOString() }; writeFileSync(pf, JSON.stringify(rec, null, 1), { mode: 0o600 }); };
	const runArgv = (argv, label) => {
		const r = spawnSync(argv[0] === "node" ? process.execPath : argv[0], argv.slice(1), { cwd: rec.repo, encoding: "utf8", timeout: 120e3 });
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
		post({ kind: "info", title: r.status === 0 ? `Done: ${label}` : `Failed: ${label}`, body: out.slice(-300) || `exit ${r.status}`, change: rec.change });
		done(r.status === 0 ? "ok" : `exit ${r.status}`);
		return r.status === 0 ? 0 : 1;
	};
	switch (action) {
		case "dismiss": case "decline": done(action); return 0;
		case "open": case "default": if (rec.file) openPath(rec.file); else if (rec.details) { const f = join(D("details"), `${id}.md`); writeFileSync(f, `# ${rec.title}\n\n${rec.details}\n`); openPath(f); } done("opened"); return 0;
		case "reveal": if (rec.file) openPath(rec.file, true); done("revealed"); return 0;
		case "details": {
			if (rec.file) { openPath(rec.file); done("opened"); return 0; }
			const f = join(D("details"), `${id}.md`);
			writeFileSync(f, `# ${rec.title}\n\n${rec.details ?? rec.body}\n${(rec.suggestions ?? []).map((s) => `\n- **${s.label}**: \`${s.cmd.join(" ")}\``).join("")}\n`);
			openPath(f); done("opened"); return 0;
		}
		case "show": { const f = join(D("details"), `${id}.sh`); writeFileSync(f, `# ${rec.title}\n# runs in: ${rec.script?.cwd}\n${rec.script?.cmd ?? ""}\n`); spawnSync("open", ["-t", f]); done("shown"); return 0; }
		case "run": {
			if (!rec.script) return 1;
			const log = join(D("logs"), `${id}.log`);
			const fd = openSync(log, "a");
			const self = join(HERE, "notify.mjs");
			// run detached; when it ends, post the result with a button to open the log
			const wrapper = `${rec.script.cmd}\nrc=$?\n"${process.execPath}" "${self}" finished "${id}" "$rc"\nexit $rc`;
			spawn("/bin/bash", ["-lc", wrapper], { cwd: rec.script.cwd, detached: true, stdio: ["ignore", fd, fd] }).unref();
			closeSync(fd); done("running"); return 0;
		}
		case "reply": {
			if (!rec.reply?.cmd || !text.trim()) { done("empty reply"); return 0; }
			return runArgv([...rec.reply.cmd, text.trim()], rec.title);
		}
		default: {
			const m = action.match(/^s(\d)$/);
			const s = m ? rec.suggestions?.[Number(m[1])] : null;
			if (!s?.cmd) { done(`unknown action ${action}`); return 1; }
			return runArgv(s.cmd, s.label);
		}
	}
}

function finished(id, rc) {
	let rec = {}; try { rec = JSON.parse(readFileSync(join(D("pending"), `${id}.json`), "utf8")); } catch { /* */ }
	post({ kind: "read", title: Number(rc) === 0 ? `Finished: ${rec.title ?? id}` : `Failed (exit ${rc}): ${rec.title ?? id}`, body: "The output is in the log.", file: join(D("logs"), `${id}.log`), change: rec.change });
	return 0;
}

function main() {
	const argv = process.argv.slice(2);
	const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
	if (argv[0] === "--selftest") return selftest();
	if (argv[0] === "respond") return respond(argv[1], argv[2], argv.slice(3).join(" "));
	if (argv[0] === "finished") return finished(argv[1], argv[2]);
	if (argv[0] === "post") {
		const kind = opt("--kind") ?? "info";
		const rec = { kind, title: opt("--title") ?? "Harness", body: opt("--body") ?? "", file: opt("--file") };
		if (kind === "run") rec.script = { cmd: opt("--cmd"), cwd: opt("--cwd") ?? REPO };
		console.log(post(rec)); return 0;
	}
	if (argv[0] === "test") {
		post(fromMessage("CHANGE-0026 needs you: the merge gate refused (medium risk, reviewer required) (if it is a merge the gate refused: node scripts/handoff.mjs approve-merge --change CHANGE-0026)", "Harness"));
		post({ kind: "run", title: "Test: run a script?", body: "Prints the date and the repository status.", script: { cmd: "date; git status --short | head -5" } });
		post({ kind: "read", title: "Test: something to read", body: "The current harness status.", file: ".pi-session/STATUS.md" });
		console.log(appInstalled() ? "posted 3 test notifications" : "posted 3, but HarnessNotify.app is not installed - run tools/harness-notify/build.sh");
		return 0;
	}
	console.error("usage: notify.mjs post --kind decision|run|read|info --title T --body B [--file F] [--cmd C] | test | respond <id> <action> [text] | --selftest");
	return 2;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const a = fromMessage("CHANGE-0026 needs you: gate refused (if it is a merge the gate refused: node scripts/handoff.mjs approve-merge --change CHANGE-0026)");
	ok(a.kind === "decision" && a.suggestions[0].cmd.join(" ") === "node scripts/handoff.mjs approve-merge --change CHANGE-0026" && !/approve-merge/.test(a.body), "approve-merge -> decision button, hint removed from the text");
	ok(buttonsFor(a).map((b) => b.id).join(",") === "s0,reply,details", "decision buttons");
	const q = fromMessage("CHANGE-0022: the worker has a question for you: which font? - answer with: node scripts/handoff.mjs answer --change CHANGE-0022 --note '<answer>'");
	ok(q.kind === "decision" && q.reply.cmd.includes("CHANGE-0022") && buttonsFor(q).some((b) => b.text), "question -> reply field");
	const r = fromMessage("CHANGE-0020: the worker did not start. Fix the cause, then run: node scripts/handoff.mjs reconcile --live --retry CHANGE-0020");
	ok(r.kind === "run" && r.script.cmd.endsWith("--retry CHANGE-0020") && buttonsFor(r)[0].id === "run", "retry -> run script");
	const evil = fromMessage("CHANGE-0001 is blocked: run: rm -rf ~ ; node scripts/handoff.mjs approve-merge --change $(curl x)");
	ok(evil.kind !== "run" && !evil.script && !evil.suggestions, "agent text never becomes a command");
	const t = fromMessage("CHANGE-0001: stalled - have a look (triage: .pi-session/triage/CHANGE-0001.md)");
	ok(t.kind === "read" && t.file === ".pi-session/triage/CHANGE-0001.md", "triage file -> read");
	ok(fromMessage("x", "Harness digest").file === ".pi-session/STATUS.md", "digest -> STATUS.md");
	ok(buttonsFor({ kind: "read", file: "/x" }).map((b) => b.id).join() === "open,reveal", "read buttons");
	if (fails) { console.error(`${fails} notify self-test(s) FAILED`); return 1; }
	console.log("notify self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
