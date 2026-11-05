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

/**
 * Mistral Vibe post_tool envelope -> the Claude-shaped fields toLoopEvents reads.
 * MEASURED (vibe 3.1.0, real run): tool_name is qualified (file_system.bash,
 * file_system.write_file, file_system.edit); bash tool_output is structured
 * {command, stdout, stderr, returncode, ...} and a non-zero exit is still
 * tool_status "success" - so the exit code comes from returncode, never from
 * parsing text; tool_status "failure" + tool_error when the tool itself failed.
 */
export function fromVibe(env) {
	const raw = String(env.tool_name ?? "");
	const short = raw.startsWith("mcp_") ? raw : raw.slice(raw.lastIndexOf(".") + 1);
	const name = { bash: "Bash", git_bash: "Bash", process_start: "Bash", start: "Bash",
		write_file: "Write", edit: "Edit" }[short] ?? raw;
	const out = env.tool_output && typeof env.tool_output === "object" ? env.tool_output : null;
	const failure = env.tool_status === "failure";
	return {
		...env,
		tool_name: name,
		tool_response: failure ? undefined : (out ?? env.tool_output_text),
		error: failure ? (env.tool_error ?? env.tool_output_text ?? "tool failed") : undefined,
		hook_event_name: failure ? "PostToolUseFailure" : "PostToolUse",
		vibe_exit_code: !failure && typeof out?.returncode === "number" ? out.returncode : null,
	};
}

/** Envelope -> list of loop-checks events. Exported for verify-loop-guard.mjs. */
export function toLoopEvents(core, backend, env, repoRoot) {
	if (backend === "vibe") {
		const v = fromVibe(env);
		const evs = toLoopEvents(core, "claude", v, repoRoot);
		for (const e of evs) if (e.kind === "shell" && v.vibe_exit_code !== null) e.exitCode = v.vibe_exit_code;
		return evs;
	}
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
	// Vibe: post_tool's hook_specific_output.additional_context appends to the result.
	if (backend === "vibe") return { hook_specific_output: { additional_context: best.message } };
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
		selftest();
		process.exit(0);
	}
	const backend = ["claude", "vibe"].includes(process.argv[2]) ? process.argv[2] : "codex";
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

	// Test statePath
	const oldEv = process.env.CONTRACT_EVIDENCE;
	process.env.CONTRACT_EVIDENCE = "/tmp/ev";
	ok(statePath("foo/bar") === "/tmp/ev.loop-foo_bar.json", "statePath uses CONTRACT_EVIDENCE and sanitizes");
	delete process.env.CONTRACT_EVIDENCE;
	ok(statePath("a b") === "/tmp/loop-guard-a_b.json", "statePath falls back to /tmp");
	if (oldEv) process.env.CONTRACT_EVIDENCE = oldEv;

	// Mock core
	const core = {
		parseExitCode: (out) => (out.includes("exit 1") ? 1 : (out.includes("exit 0") ? 0 : null)),
		isTestCommand: (cmd) => cmd.includes("npm test"),
		patchPaths: (cmd) => ["file1.txt", "file2.txt"]
	};

	// Test toLoopEvents
	// 1. Shell success
	let evs = toLoopEvents(core, "claude", {
		tool_name: "Bash",
		tool_input: { command: "echo hi && npm test" },
		tool_response: { stdout: "hi\nexit 0" }
	}, "/repo");
	ok(evs.length === 1 && evs[0].kind === "shell" && evs[0].command === "echo hi && npm test" && evs[0].exitCode === 0 && evs[0].isTest === true && evs[0].failed === undefined, "shell success event");

	// 2. Shell failure (PostToolUseFailure)
	evs = toLoopEvents(core, "claude", {
		tool_name: "unified_exec",
		hook_event_name: "PostToolUseFailure",
		error: "timeout"
	}, "/repo");
	ok(evs.length === 1 && evs[0].kind === "shell" && evs[0].output === "timeout" && evs[0].exitCode === null && evs[0].failed === true, "shell failure event");

	// 3. Edit (codex)
	evs = toLoopEvents(core, "codex", {
		tool_name: "apply_patch",
		tool_input: { command: "patch stuff" }
	}, "/repo");
	ok(evs.length === 2 && evs[0].kind === "edit" && evs[0].path === "file1.txt", "codex apply_patch");

	// 4. Edit (Write)
	evs = toLoopEvents(core, "claude", {
		tool_name: "Write",
		tool_input: { file_path: "/repo/src/main.js" }
    }, "/repo");
	ok(evs.length === 1 && evs[0].kind === "edit" && evs[0].path === "src/main.js", "write absolute path resolved to relative");

	// 5. Vibe shapes (measured on vibe 3.1.0): exit code from returncode, not text
	evs = toLoopEvents(core, "vibe", {
		hook_event_name: "post_tool", tool_name: "file_system.bash",
		tool_input: { command: "npm test", timeout: 120 }, tool_status: "success",
		tool_output: { command: "npm test", stdout: "boom", stderr: "", returncode: 2 },
	}, "/repo");
	ok(evs.length === 1 && evs[0].kind === "shell" && evs[0].exitCode === 2 && evs[0].isTest === true && evs[0].output.includes("boom"), "vibe bash: exit code from returncode");

	evs = toLoopEvents(core, "vibe", {
		tool_name: "file_system.bash", tool_input: { command: "x" }, tool_status: "failure", tool_error: "timed out",
	}, "/repo");
	ok(evs.length === 1 && evs[0].failed === true && evs[0].output === "timed out", "vibe tool failure -> failed shell event");

	evs = toLoopEvents(core, "vibe", { tool_name: "file_system.edit", tool_input: { file_path: "/repo/src/a.gd" }, tool_status: "success" }, "/repo");
	ok(evs.length === 1 && evs[0].kind === "edit" && evs[0].path === "src/a.gd", "vibe edit -> edit event");

	evs = toLoopEvents(core, "vibe", { tool_name: "file_system.write_file", tool_input: { file_path: "b.txt" }, tool_status: "success" }, "/repo");
	ok(evs.length === 1 && evs[0].kind === "edit" && evs[0].path === "b.txt", "vibe write_file -> edit event");

	evs = toLoopEvents(core, "vibe", { tool_name: "file_system.read_file", tool_input: { path: "a" }, tool_status: "success" }, "/repo");
	ok(evs.length === 0, "vibe read_file -> no loop event");

	if (fails > 0) process.exit(1);
}
