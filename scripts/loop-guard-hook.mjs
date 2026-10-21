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
