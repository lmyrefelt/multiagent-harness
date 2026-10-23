#!/usr/bin/env node
//
// loop-guard-hook — PostToolUse adapter for the external-command hook backends
// (Codex CLI and Claude Code). A PROTOCOL adapter only: all detection lives in
// pi-contracts-research/prototype/extensions/loop-checks.mjs (pure, shared with the pi
// extension and verify-loop-guard.mjs).
//
// Usage (from the backend's hooks config):
//   node /repo/scripts/loop-guard-hook.mjs codex     # Codex PostToolUse
//   node /repo/scripts/loop-guard-hook.mjs claude    # Claude Code PostToolUse + PostToolUseFailure
//
// VERIFIED 2026-10-20:
//   Codex (learn.chatgpt.com/docs/hooks + codex-rs source, main branch):
//     - hooks are on by default; PostToolUse fires for Bash/unified exec
//       (incl. non-zero exit), apply_patch and MCP tools;
//     - stdin: {session_id, cwd, tool_name, tool_input, tool_response, ...};
//       Bash + apply_patch put their payload in tool_input.command;
//     - tool_response for unified exec is the model-facing output STRING,
//       WITHOUT the "Process exited with code N" header (codex-rs
//       tools/context.rs post_tool_use_response) -> exit code is usually
//       unknown here, so failure falls back to looksFailed(output);
//     - output: hookSpecificOutput.additionalContext adds context next to the
//       result. decision:"block" would REPLACE the result; deliberately not
//       used (Codex already truncates exec output itself, and a "block" reads
//       like a refusal to the model).
//   Claude Code (code.claude.com/docs/en/hooks):
//     - PostToolUse (success) and PostToolUseFailure (failure) both accept
//       hookSpecificOutput.additionalContext;
//     - updatedToolOutput exists for PostToolUse but its scope (all tools vs
//       MCP only) could not be confirmed -> not used.
//   ASSUMED: Claude's Bash tool_response is {stdout, stderr, ...} and the
//   failure payload has an `error` string. Both are read defensively.
//
// FAILS OPEN: any error -> exit 0 with no output. The loop guard is advisory;
// it must never break a tool call.
//
// Env: CONTRACT_EVIDENCE (log + state location), REPO_ROOT, LOOP_GUARD
// (on|shadow|off, default shadow), LOOP_GUARD_* knobs, HARNESS_CHANGE, PI_ROLE,
// LOOP_CHECKS_MJS_PATH (default /opt/contracts/extensions/loop-checks.mjs, then
// the repo copy).

import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadCore() {
	const candidates = [
		process.env.LOOP_CHECKS_MJS_PATH,
		"/opt/contracts/extensions/loop-checks.mjs",
		join(HERE, "../contracts/prototype/extensions/loop-checks.mjs"),
	].filter(Boolean);
	for (const p of candidates) if (existsSync(p)) return import(p);
	throw new Error("loop-checks.mjs not found");
}

function log(rec) {
	const p = process.env.CONTRACT_EVIDENCE;
	if (!p) return;
	try { appendFileSync(p, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); } catch { /* best effort */ }
}

export function statePath(sessionId) {
	const safe = String(sessionId || "nosession").replace(/[^\w.-]/g, "_");
	const ev = process.env.CONTRACT_EVIDENCE;
	return ev ? `${ev}.loop-${safe}.json` : `/tmp/loop-guard-${safe}.json`;
}

function readState(path, fresh) {
	try { return { ...fresh(), ...JSON.parse(readFileSync(path, "utf8")) }; } catch { return fresh(); }
}

function writeState(path, state) {
	try { writeFileSync(path + ".tmp", JSON.stringify(state)); renameSync(path + ".tmp", path); } catch { /* best effort */ }
}

function textOf(v) {
	if (v == null) return "";
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(textOf).join("\n");
	if (typeof v === "object") {
		const parts = [v.stdout, v.stderr, v.output, v.error, v.text, v.content].filter((x) => x != null).map(textOf);
		return parts.length ? parts.join("\n") : JSON.stringify(v);
	}
	return String(v);
}

function fileHash(core, repoRoot, rel) {
	const abs = isAbsolute(rel) ? rel : join(repoRoot, rel);
	try { return core.sha(readFileSync(abs)); } catch { return null; } // null = deleted / unreadable
}

/** Envelope -> list of loop-checks events. Exported for verify-loop-guard.mjs. */
export function toLoopEvents(core, backend, env, repoRoot) {
	const tool = String(env.tool_name ?? "");
	const input = env.tool_input ?? {};
	const out = textOf(env.tool_response ?? env.error);
	const rel = (p) => (repoRoot && String(p).startsWith(repoRoot + "/") ? String(p).slice(repoRoot.length + 1) : String(p));

	if (/^(Bash|unified_exec|exec_command|shell)$/i.test(tool)) {
		const command = String(input.command ?? "");
		const failure = env.hook_event_name === "PostToolUseFailure";
		const exitCode = failure ? null : core.parseExitCode(out);
		return [{ kind: "shell", command, output: out, exitCode,
			failed: failure ? true : undefined, isTest: core.isTestCommand(command), repoRoot }];
	}
	if (backend === "codex" && /^(apply_patch|Edit|Write)$/.test(tool) && typeof input.command === "string") {
		return core.patchPaths(input.command).map((p) => ({ kind: "edit", path: rel(p), contentHash: fileHash(core, repoRoot, p) }));
	}
	if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
		const p = input.file_path ?? input.path ?? input.notebook_path;
		if (!p) return [{ kind: "edit" }];
		return [{ kind: "edit", path: rel(p), contentHash: fileHash(core, repoRoot, p) }];
	}
	return [];
}

export async function run(backend, raw) {
	const core = await loadCore();
	const cfg = core.loopConfig(process.env);
	if (cfg.mode === "off") return null;
	const env = JSON.parse(raw || "{}");
	const repoRoot = (process.env.REPO_ROOT || env.cwd || process.cwd()).replace(/\/$/, "");
	const sp = statePath(env.session_id);
	const state = readState(sp, core.newLoopState);

	let best = null;
	for (const ev of toLoopEvents(core, backend, env, repoRoot)) {
		const r = core.observe(state, ev, cfg);
		if (r.finding) {
			log({ ev: "loop_guard", backend, mode: cfg.mode, signal: r.finding.signal, level: r.level,
				subject: r.finding.subject, detail: r.finding.detail, tool: env.tool_name, tool_use_id: env.tool_use_id });
			if (!best || rank(r.level) > rank(best.level)) best = r;
		}
	}
	writeState(sp, state);
	if (!best || cfg.mode !== "on") return null;
	return {
		hookSpecificOutput: {
			hookEventName: env.hook_event_name || "PostToolUse",
			additionalContext: best.message,
		},
	};
}

const rank = (l) => ({ none: 0, nudge: 1, restrict: 2, handoff: 3 }[l] ?? 0);

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	if (process.argv.includes("--selftest")) {
		process.exit(selftest());
	}
	const backend = process.argv[2] === "claude" ? "claude" : "codex";
	let raw = "";
	try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
	try {
		const out = await run(backend, raw);
		if (out) process.stdout.write(JSON.stringify(out));
	} catch (e) {
		log({ ev: "loop_guard_error", backend, err: String(e?.message ?? e) });
	}
	process.exit(0);
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };

	const savedEv = process.env.CONTRACT_EVIDENCE;

	try {
		delete process.env.CONTRACT_EVIDENCE;
		ok(statePath("test-session") === "/tmp/loop-guard-test-session.json", "statePath falls back to /tmp");
		ok(statePath("bad/name:1") === "/tmp/loop-guard-bad_name_1.json", "statePath sanitizes session ID");

		process.env.CONTRACT_EVIDENCE = "/var/log/evidence.log";
		ok(statePath("foo") === "/var/log/evidence.log.loop-foo.json", "statePath uses CONTRACT_EVIDENCE");
	} finally {
		if (savedEv === undefined) delete process.env.CONTRACT_EVIDENCE;
		else process.env.CONTRACT_EVIDENCE = savedEv;
	}

	const core = {
		parseExitCode: (out) => (out.includes("exit 1") ? 1 : 0),
		isTestCommand: (cmd) => cmd.includes("npm test"),
		patchPaths: (cmd) => {
			if (cmd.includes("bar.txt")) return ["/repo/foo/bar.txt"];
			return [];
		},
		sha: (buf) => "mock-sha-" + buf.length
	};

	// Mock fileHash implicitly by testing paths that don't trigger readFileSync throws (or let them catch and return null)
	// We'll test with non-existent files which naturally return null via the try/catch in fileHash.

	// Test Bash tools
	const bashEnv = {
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		tool_response: { stdout: "files", stderr: "", exit_code: 0 }
	};
	const bashEvents = toLoopEvents(core, "claude", bashEnv, "/repo");
	ok(bashEvents.length === 1 && bashEvents[0].kind === "shell", "toLoopEvents maps Bash to shell");
	ok(bashEvents[0].command === "ls -la", "extracts command");
	ok(bashEvents[0].output.includes("files"), "textOf flattens output object");
	ok(bashEvents[0].exitCode === 0, "parses exit code");
	ok(bashEvents[0].isTest === false, "checks isTestCommand");

	const failEnv = {
		hook_event_name: "PostToolUseFailure",
		tool_name: "unified_exec",
		tool_input: { command: "npm test" },
		error: "Process exited with code 1\nexit 1"
	};
	const failEvents = toLoopEvents(core, "codex", failEnv, "/repo");
	ok(failEvents[0].failed === true, "PostToolUseFailure sets failed: true");
	ok(failEvents[0].exitCode === null, "PostToolUseFailure ignores parseExitCode");
	ok(failEvents[0].isTest === true, "identifies test commands");

	// Test Codex patches
	const patchEnv = {
		tool_name: "apply_patch",
		tool_input: { command: "patch for bar.txt" }
	};
	const patchEvents = toLoopEvents(core, "codex", patchEnv, "/repo");
	ok(patchEvents.length === 1 && patchEvents[0].kind === "edit", "maps apply_patch to edit");
	ok(patchEvents[0].path === "foo/bar.txt", "makes path relative to repoRoot");
	ok(patchEvents[0].contentHash === null, "fileHash handles missing files gracefully (returns null)");

	// Test Claude files
	const editEnv = {
		tool_name: "Edit",
		tool_input: { file_path: "/repo/src/main.js" }
	};
	const editEvents = toLoopEvents(core, "claude", editEnv, "/repo");
	ok(editEvents.length === 1 && editEvents[0].kind === "edit", "maps Edit to edit");
	ok(editEvents[0].path === "src/main.js", "strips absolute path based on repoRoot");

	const notebookEnv = {
		tool_name: "NotebookEdit",
		tool_input: { notebook_path: "notebooks/data.ipynb" }
	};
	const notebookEvents = toLoopEvents(core, "claude", notebookEnv, "/repo");
	ok(notebookEvents[0].path === "notebooks/data.ipynb", "handles notebook_path");

	const unknownEnv = { tool_name: "SomeUnknownTool" };
	ok(toLoopEvents(core, "claude", unknownEnv, "/repo").length === 0, "unknown tools return empty events");

	if (fails) { console.error(`${fails} loop-guard-hook self-test(s) FAILED`); return 1; }
	console.log("loop-guard-hook self-test: all passed");
	return 0;
}
