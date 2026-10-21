/**
 * loop-checks — in-session loop detection on tool RESULTS (pure, no pi import).
 *
 * WHY THIS EXISTS
 * checks.mjs already blocks two loop shapes BEFORE a tool runs:
 *   - no_progress_loop: the literal same edit replayed;
 *   - redundant_test_rerun: the same test command with zero edits in between.
 * Neither can see what only the RESULT shows:
 *   - stuck_fix:   DIFFERENT edits, but the test/build keeps failing with the
 *                  SAME normalized diagnostic;
 *   - oscillation: a file's content returns to the state it had two edits ago
 *                  (A -> B -> A), or to any earlier state in the round (revert);
 *   - spinning:    N shell calls in a row that produce nothing new (no edit,
 *                  no new failure signature, no newly passing test).
 * It also shapes very long tool output (head + tail + rescued error lines).
 *
 * Same contract as checks.mjs: pure functions, plain node, imported by the pi
 * extension (contract-guard.ts), by the external-command hook adapters
 * (codex/claude-loop-adapter.mjs) and by verify-loop-guard.mjs, so the test
 * exercises the code that runs live.
 *
 * The guard never blocks or edits anything. It returns a finding + message;
 * the adapter decides how the message reaches the model. Escalation:
 *   1st time a signal fires -> nudge, 2nd -> restrict, 3rd (or MAX_STUCK
 *   findings in the round) -> handoff (file a `blocked` handoff report).
 * State resets when a handoff report is filed.
 */

import { createHash } from "node:crypto";

export const LOOP_DEFAULTS = Object.freeze({
	sigRepeat: 3,       // same failure signature N times, with edits in between
	spinCalls: 5,       // N consecutive no-progress shell calls
	maxStuck: 4,        // findings in a round before forcing a handoff
	maxOutputLines: 200,
	headLines: 20,
	tailLines: 60,
	maxRescued: 40,
});

export function loopConfig(env = process.env) {
	const n = (k, d) => { const v = Number.parseInt(env[k] ?? "", 10); return Number.isFinite(v) && v > 0 ? v : d; };
	const mode = String(env.LOOP_GUARD ?? "shadow").toLowerCase();
	return {
		mode: ["on", "shadow", "off"].includes(mode) ? mode : "shadow",
		sigRepeat: n("LOOP_GUARD_SIG_REPEAT", LOOP_DEFAULTS.sigRepeat),
		spinCalls: n("LOOP_GUARD_SPIN_CALLS", LOOP_DEFAULTS.spinCalls),
		maxStuck: n("LOOP_GUARD_MAX_STUCK", LOOP_DEFAULTS.maxStuck),
		maxOutputLines: n("LOOP_GUARD_MAX_OUTPUT_LINES", LOOP_DEFAULTS.maxOutputLines),
		headLines: LOOP_DEFAULTS.headLines,
		tailLines: LOOP_DEFAULTS.tailLines,
		maxRescued: LOOP_DEFAULTS.maxRescued,
		change: env.HARNESS_CHANGE || env.CHANGE_ID || "",
		role: env.PI_ROLE || "worker",
	};
}

export function newLoopState() {
	return {
		edits: 0,             // lifetime count of observed file mutations (monotonic)
		fileHashes: {},       // path -> [hash, ...] (last 8)
		sigs: {},             // failure sig -> { count, lastEdits }
		seenOutcomes: [],     // recent "exit|sig" keys (last 50)
		spin: 0,              // consecutive no-progress shell calls
		editsAtLastShell: 0,
		fired: {},            // finding key -> times fired
		findings: 0,          // findings this round
		lastLevel: "none",
	};
}

export const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Strip everything that varies between otherwise-identical failures. */
export function normalizeDiagnostic(text, repoRoot = "") {
	let s = String(text ?? "").replace(ANSI, "").replace(/\r/g, "");
	if (repoRoot) s = s.split(repoRoot.replace(/\/$/, "") + "/").join("");
	s = s
		.replace(/\b0x[0-9a-fA-F]{4,}\b/g, "0xADDR")
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "TS")
		.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "TIME")
		.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|µs|us|ns|m)\b/g, "DUR")
		.replace(/(?:\/tmp|\/var\/folders|\/private\/var)\/[^\s:'")]+/g, "TMP")
		.replace(/(?:\/[\w.@+-]+){2,}\/([\w.@+-]+)/g, "$1")  // absolute paths -> basename
		.replace(/:\d+:\d+\b/g, ":L:C")
		.replace(/:\d+\b/g, ":L")
		.replace(/\b(?:line|Line)\s+\d+/g, "line L")
		.replace(/\bpid[ =:]?\d+\b/gi, "pid N")
		.replace(/\b[0-9a-f]{12,40}\b/g, "HASH")
		.replace(/[ \t]+/g, " ");
	// Keep the lines that identify the failure; drop progress chatter.
	const keep = s.split("\n").map((l) => l.trim()).filter((l) => l && ERROR_LINE.test(l));
	const body = keep.length ? keep : s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-20);
	return [...new Set(body)].join("\n");
}

export const ERROR_LINE = /\b(error|errors|fail|failed|failing|failure|panic|assert|assertion|exception|traceback|cannot|undefined|not found|expected|✗|✘)\b|^E\s|FAILED|ERR!/i;

export function failureSignature(command, output, repoRoot = "") {
	const cmd = String(command ?? "").replace(ANSI, "").trim().replace(/\s+/g, " ");
	return sha(cmd + "\n" + normalizeDiagnostic(output, repoRoot));
}

/**
 * Exit code when the output carries one (Codex's legacy shell header, pi's
 * own "exit code" line); otherwise null. Codex's unified-exec hook payload is
 * the raw output WITHOUT its header (verified in codex-rs tools/context.rs).
 */
export function parseExitCode(output) {
	const m = String(output ?? "").match(/(?:Process exited with code|Exit code:|exit code[: ]|exited with code)\s*(-?\d+)/i);
	return m ? Number(m[1]) : null;
}

/** Best effort "did this command fail?" when no exit code is available. */
export function looksFailed(output) {
	const s = String(output ?? "").replace(ANSI, "");
	if (/\b(\d+)\s+(?:failed|failing|errors?)\b/i.test(s) && !/\b0\s+(?:failed|failing|errors?)\b/i.test(s)) return true;
	return /(^|\n)\s*(FAIL\b|FAILED\b|Error:|error\[|Traceback \(most recent call last\)|panic:|npm ERR!|AssertionError|✗|✘)/.test(s)
		|| /\bcommand not found\b|\bNo such file or directory\b/.test(s);
}

export function looksPassed(output) {
	const s = String(output ?? "");
	return /\b(\d+)\s+(?:passed|passing)\b/i.test(s) && !looksFailed(s);
}

/** Loose test/build detection for the "newly passing test" progress signal. */
export function isTestCommand(command) {
	return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\b(?:pytest|jest|vitest|mocha|tap|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test|dotnet\s+test|godot\b.*--test|gut)\b|verify-[\w-]+\.mjs/.test(String(command ?? ""));
}

/** Paths an apply_patch blob touches (Codex format and unified diff). */
export function patchPaths(text) {
	const t = String(text ?? "");
	const out = new Set();
	let m;
	const a = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm; while ((m = a.exec(t))) out.add(m[1].trim());
	const b = /^\*\*\* Move to: (.+)$/gm; while ((m = b.exec(t))) out.add(m[1].trim());
	const c = /^\+\+\+ b\/(.+)$/gm; while ((m = c.exec(t))) out.add(m[1].trim());
	return [...out];
}

function push(arr, v, max) { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); }

/**
 * Record one tool result. `ev` = {
 *   kind: "shell" | "edit" | "other",
 *   command?, output?, exitCode? (null = unknown), failed? (bool, overrides),
 *   path?, contentHash? (for edits; null when the file was deleted),
 *   isTest? (bool), repoRoot?
 * }
 * Returns { finding: null | {signal, key, detail, subject}, level, message }.
 */
export function observe(state, ev, cfg = loopConfig({})) {
	const none = { finding: null, level: "none", message: "" };
	if (!ev || cfg.mode === "off") return none;

	if (ev.kind === "edit") {
		state.edits += 1;
		if (!ev.path || ev.contentHash === undefined) return none;
		const hist = state.fileHashes[ev.path] ?? (state.fileHashes[ev.path] = []);
		const h = ev.contentHash ?? "<deleted>";
		let finding = null;
		if (hist.length >= 2 && hist[hist.length - 2] === h && hist[hist.length - 1] !== h) {
			finding = { signal: "oscillation", subject: ev.path, key: `oscillation:${ev.path}`,
				detail: `"${ev.path}" is back to the content it had two edits ago (A -> B -> A)` };
		} else if (hist.slice(0, -1).includes(h) && hist[hist.length - 1] !== h) {
			finding = { signal: "revert", subject: ev.path, key: `oscillation:${ev.path}`,
				detail: `"${ev.path}" was reverted to an earlier state from this round` };
		}
		push(hist, h, 8);
		return finding ? escalate(state, finding, cfg) : none;
	}

	if (ev.kind !== "shell") return none;

	const exit = ev.exitCode ?? null;
	const failed = typeof ev.failed === "boolean" ? ev.failed : (exit !== null ? exit !== 0 : looksFailed(ev.output));
	const editedSinceLast = state.edits !== state.editsAtLastShell;
	state.editsAtLastShell = state.edits;

	// The handoff report itself resets the round.
	if (/\bhandoff\.mjs\s+report\b/.test(String(ev.command ?? "")) && !failed) {
		Object.assign(state, newLoopState(), { edits: state.edits, editsAtLastShell: state.edits });
		return none;
	}

	let progress = editedSinceLast;
	let finding = null;

	if (failed) {
		const sig = failureSignature(ev.command, ev.output, ev.repoRoot);
		const outcome = `${exit ?? "?"}|${sig}`;
		if (!state.seenOutcomes.includes(outcome)) { progress = true; push(state.seenOutcomes, outcome, 50); }
		const rec = state.sigs[sig] ?? (state.sigs[sig] = { count: 0, lastEdits: -1 });
		// Only count a repeat when something was edited since this sig was last
		// seen: a plain rerun is redundant_test_rerun's job (checks.mjs), not ours.
		if (rec.count === 0 || state.edits !== rec.lastEdits) rec.count += 1;
		rec.lastEdits = state.edits;
		if (rec.count >= cfg.sigRepeat) {
			finding = { signal: "stuck_fix", subject: sig.slice(0, 8), key: `stuck_fix:${sig}`,
				detail: `the same failure (sig ${sig.slice(0, 8)}) came back ${rec.count} times despite edits in between` };
			rec.count = 0; // re-arm: fire again only after another sigRepeat occurrences
		}
	} else if (ev.isTest && looksPassed(ev.output)) {
		progress = true;
	}

	if (progress) state.spin = 0; else state.spin += 1;
	if (!finding && state.spin >= cfg.spinCalls) {
		finding = { signal: "spinning", subject: "", key: "spinning",
			detail: `${state.spin} shell calls in a row produced nothing new (no edit, no new failure, no newly passing test)` };
		state.spin = 0;
	}
	return finding ? escalate(state, finding, cfg) : none;
}

function escalate(state, finding, cfg) {
	state.findings += 1;
	const n = (state.fired[finding.key] = (state.fired[finding.key] ?? 0) + 1);
	const level = n >= 3 || state.findings >= cfg.maxStuck ? "handoff" : n === 2 ? "restrict" : "nudge";
	state.lastLevel = level;
	return { finding, level, message: loopMessage(level, finding, cfg) };
}

export function handoffCommand(finding, cfg) {
	const change = cfg.change || "<CHANGE-NNNN>";
	const note = `loop-guard: ${finding.signal}${finding.subject ? " " + finding.subject : ""}`;
	return `node /repo/scripts/handoff.mjs report --change ${change} --role ${cfg.role || "worker"} --verdict blocked --note "${note}"`;
}

export function loopMessage(level, finding, cfg) {
	const head = `LOOP GUARD (${level}) — ${finding.signal}: ${finding.detail}.`;
	if (level === "nudge") {
		return `${head}\nChange strategy instead of repeating: inspect the callers/assumptions, write a small isolated test that reproduces the failure, or re-read the specification for this requirement.`;
	}
	if (level === "restrict") {
		return `${head}\nThis is the second time. Before any further edit${finding.signal === "stuck_fix" || finding.signal === "spinning" ? "" : ` of ${finding.subject}`}, write a NEW hypothesis (what you think is actually wrong and how you will check it) in your round notes, then act on that hypothesis only.`;
	}
	return `${head}\nYou are stuck. Stop editing and hand this round back so it can be escalated:\n${handoffCommand(finding, cfg)}\nInclude in the note what you tried and the failing signature.`;
}

/**
 * Head + tail + every error-looking line from the middle, deduplicated.
 * Returns { text, shaped, omitted } — text unchanged when under the limit.
 */
export function shapeOutput(text, cfg = loopConfig({}), logHint = "") {
	const s = String(text ?? "");
	const lines = s.split("\n");
	if (lines.length <= cfg.maxOutputLines) return { text: s, shaped: false, omitted: 0 };
	const head = lines.slice(0, cfg.headLines);
	const tail = lines.slice(-cfg.tailLines);
	const middle = lines.slice(cfg.headLines, lines.length - cfg.tailLines);
	const seen = new Set();
	const rescued = [];
	for (const l of middle) {
		if (!ERROR_LINE.test(l)) continue;
		const k = l.trim();
		if (!k || seen.has(k)) continue;
		seen.add(k);
		rescued.push(l);
		if (rescued.length >= cfg.maxRescued) break;
	}
	const omitted = middle.length - rescued.length;
	const marker = `[loop-guard: ${omitted} of ${lines.length} lines omitted${logHint ? `; full output in ${logHint}` : ""}]`;
	const parts = [...head, marker];
	if (rescued.length) parts.push("[loop-guard: error lines from the omitted part]", ...rescued, "[loop-guard: end of rescued lines]");
	parts.push(...tail);
	return { text: parts.join("\n"), shaped: true, omitted };
}
