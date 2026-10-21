#!/usr/bin/env node
/**
 * verify-loop-guard — deterministic self-tests for loop-checks.mjs and the
 * external-command hook adapter (scripts/loop-guard-hook.mjs).
 *
 * Imports the SAME modules that run live. Fixture payloads follow the shapes
 * verified on 2026-10-20 (see loop-guard-hook.mjs header).
 *
 * Usage: node verify-loop-guard.mjs     Exit 0 = all passed.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./extensions/loop-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0, skipped = 0;
async function t(name, fn) {
	try { await fn(); passed++; console.log(`  ok    ${name}`); }
	catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const cfg = (o = {}) => ({ ...core.loopConfig({ LOOP_GUARD: "on", HARNESS_CHANGE: "CHANGE-0042" }), ...o });
const shell = (command, output, exitCode = 1, extra = {}) => ({ kind: "shell", command, output, exitCode, isTest: core.isTestCommand(command), repoRoot: "/repo", ...extra });
const edit = (path, content) => ({ kind: "edit", path, contentHash: core.sha(content) });

const FAIL_A = (run) => `> godot --test\nrun ${run} at 2026-10-20T07:${10 + run}:00Z took ${run * 13}ms\n/repo/src/player.gd:${40 + run}:7: Error: Invalid call 'jump' on base 'Nil'\npid=${1000 + run} tmp=/tmp/gut-${run}x/out\n1 failed, 12 passed`;
const FAIL_B = "/repo/src/enemy.gd:10:3: Error: Identifier 'speed' not declared\n1 failed, 12 passed";

console.log("loop-checks core");

await t("normalizer: same failure with different paths/lines/timing/pids/tmp -> same signature", () => {
	const a = core.failureSignature("npm test", FAIL_A(1), "/repo");
	const b = core.failureSignature("npm test", FAIL_A(7), "/repo");
	assert(a === b, `signatures differ:\n${core.normalizeDiagnostic(FAIL_A(1), "/repo")}\n---\n${core.normalizeDiagnostic(FAIL_A(7), "/repo")}`);
});

await t("normalizer: different failing error -> different signature", () => {
	assert(core.failureSignature("npm test", FAIL_A(1), "/repo") !== core.failureSignature("npm test", FAIL_B, "/repo"), "same sig for different errors");
});

await t("stuck_fix: same failure 3x with edits in between -> nudge on the 3rd", () => {
	const s = core.newLoopState(), c = cfg();
	const levels = [];
	for (let i = 1; i <= 3; i++) {
		core.observe(s, edit("src/player.gd", `v${i}`), c);
		levels.push(core.observe(s, shell("npm test", FAIL_A(i)), c));
	}
	assert(!levels[0].finding && !levels[1].finding, "fired too early");
	assert(levels[2].finding?.signal === "stuck_fix" && levels[2].level === "nudge", `got ${JSON.stringify(levels[2])}`);
});

await t("stuck_fix: plain reruns WITHOUT edits never count (that is redundant_test_rerun's job)", () => {
	const s = core.newLoopState(), c = cfg({ spinCalls: 99 });
	core.observe(s, edit("src/player.gd", "v1"), c);
	for (let i = 1; i <= 6; i++) {
		const r = core.observe(s, shell("npm test", FAIL_A(i)), c);
		assert(r.finding?.signal !== "stuck_fix", `stuck_fix fired on rerun ${i}`);
	}
});

await t("stuck_fix: changing failures (real progress) never fire", () => {
	const s = core.newLoopState(), c = cfg();
	for (let i = 1; i <= 6; i++) {
		core.observe(s, edit("src/x.gd", `v${i}`), c);
		const r = core.observe(s, shell("npm test", `src/x.gd:${i}:1: Error: problem number ${"abcdef"[i - 1]}\n1 failed`), c);
		assert(!r.finding, `fired on distinct failure ${i}: ${r.finding?.detail}`);
	}
});

await t("oscillation: A -> B -> A fires; A -> B -> C does not", () => {
	const s = core.newLoopState(), c = cfg();
	assert(!core.observe(s, edit("a.gd", "A"), c).finding, "A");
	assert(!core.observe(s, edit("a.gd", "B"), c).finding, "B");
	const r = core.observe(s, edit("a.gd", "A"), c);
	assert(r.finding?.signal === "oscillation", `expected oscillation, got ${JSON.stringify(r.finding)}`);
	const s2 = core.newLoopState();
	for (const v of ["A", "B", "C"]) assert(!core.observe(s2, edit("a.gd", v), c).finding, `fired on ${v}`);
});

await t("revert: back to an older state (A B C A) fires as revert", () => {
	const s = core.newLoopState(), c = cfg();
	for (const v of ["A", "B", "C"]) core.observe(s, edit("a.gd", v), c);
	const r = core.observe(s, edit("a.gd", "A"), c);
	assert(r.finding?.signal === "revert", `got ${JSON.stringify(r.finding)}`);
});

await t("spinning: 5 shell calls with nothing new -> nudge; resets after firing", () => {
	const s = core.newLoopState(), c = cfg();
	core.observe(s, shell("ls", "a b", 0), c); // first call: no edit, no failure -> spin 1
	let r;
	for (let i = 0; i < 4; i++) r = core.observe(s, shell("cat README.md", "hello", 0), c);
	assert(r.finding?.signal === "spinning", `expected spinning, got ${JSON.stringify(r.finding)}`);
	assert(s.spin === 0, "spin counter not reset");
});

await t("spinning: an edit or a newly passing test counts as progress", () => {
	const s = core.newLoopState(), c = cfg();
	for (let i = 0; i < 4; i++) core.observe(s, shell("ls", "x", 0), c);
	core.observe(s, edit("a.gd", "z"), c);
	assert(!core.observe(s, shell("ls", "x", 0), c).finding, "edit not counted as progress");
	for (let i = 0; i < 3; i++) core.observe(s, shell("ls", "x", 0), c);
	assert(!core.observe(s, shell("npm test", "13 passed", 0), c).finding, "passing test not counted as progress");
});

await t("escalation: same signal nudge -> restrict -> handoff", () => {
	const s = core.newLoopState(), c = cfg({ maxStuck: 99 });
	const lv = [];
	for (let i = 1; i <= 9; i++) {
		core.observe(s, edit("src/player.gd", `v${i}`), c);
		const r = core.observe(s, shell("npm test", FAIL_A(i)), c);
		if (r.finding) lv.push(r.level);
	}
	assert(lv.join(",") === "nudge,restrict,handoff", `got ${lv.join(",")}`);
});

await t("escalation: MAX_STUCK findings across signals -> handoff", () => {
	const s = core.newLoopState(), c = cfg({ maxStuck: 2 });
	core.observe(s, edit("a.gd", "A"), c); core.observe(s, edit("a.gd", "B"), c);
	assert(core.observe(s, edit("a.gd", "A"), c).level === "nudge", "first");
	core.observe(s, edit("b.gd", "A"), c); core.observe(s, edit("b.gd", "B"), c);
	assert(core.observe(s, edit("b.gd", "A"), c).level === "handoff", "second finding should force handoff");
});

await t("handoff message contains a valid handoff.mjs command with the change id", () => {
	const m = core.loopMessage("handoff", { signal: "stuck_fix", subject: "abcd1234", detail: "x" }, cfg());
	assert(/node \/repo\/scripts\/handoff\.mjs report --change CHANGE-0042 --role worker --verdict blocked --note "loop-guard: stuck_fix abcd1234"/.test(m), m);
});

await t("a filed handoff report resets the round", () => {
	const s = core.newLoopState(), c = cfg();
	core.observe(s, edit("a.gd", "A"), c); core.observe(s, edit("a.gd", "B"), c); core.observe(s, edit("a.gd", "A"), c);
	assert(s.findings === 1, "precondition");
	core.observe(s, shell("node /repo/scripts/handoff.mjs report --change CHANGE-0042 --role worker --verdict blocked --note x", "recorded", 0), c);
	assert(s.findings === 0 && Object.keys(s.fileHashes).length === 0, "state not reset");
});

await t("mode off -> never fires", () => {
	const s = core.newLoopState(), c = cfg({ mode: "off" });
	core.observe(s, edit("a.gd", "A"), c); core.observe(s, edit("a.gd", "B"), c);
	assert(!core.observe(s, edit("a.gd", "A"), c).finding, "fired while off");
});

await t("shapeOutput: short output untouched; long output keeps head, tail and mid-output error lines", () => {
	const c = cfg();
	assert(!core.shapeOutput("a\nb", c).shaped, "short output shaped");
	const lines = Array.from({ length: 1000 }, (_, i) => `progress line ${i}`);
	lines[500] = "src/player.gd:12:3: Error: Invalid call 'jump'";
	lines[501] = "src/player.gd:12:3: Error: Invalid call 'jump'"; // duplicate
	const r = core.shapeOutput(lines.join("\n"), c, ".pi-session/logs/x.log");
	const out = r.text.split("\n");
	assert(r.shaped, "not shaped");
	assert(out[0] === "progress line 0" && out[out.length - 1] === "progress line 999", "head/tail lost");
	assert(out.filter((l) => l.includes("Invalid call 'jump'")).length === 1, "error line not rescued exactly once");
	assert(out.length < 120, `too long: ${out.length}`);
	assert(r.text.includes("full output in .pi-session/logs/x.log"), "log hint missing");
});

await t("parseExitCode / looksFailed", () => {
	assert(core.parseExitCode("Wall time: 1s\nProcess exited with code 2\nOutput:") === 2, "codex header");
	assert(core.parseExitCode("Exit code: 0") === 0, "legacy header");
	assert(core.parseExitCode("all good") === null, "no code");
	assert(core.looksFailed("1 failed, 12 passed"), "1 failed");
	assert(!core.looksFailed("0 failed, 12 passed"), "0 failed");
	assert(core.looksFailed("Traceback (most recent call last):\n  x"), "traceback");
	assert(!core.looksFailed("13 passed"), "passing");
});

await t("patchPaths: Codex patch envelope and unified diff", () => {
	const p = core.patchPaths("*** Begin Patch\n*** Update File: src/a.gd\n@@\n-x\n+y\n*** Add File: src/b.gd\n+z\n*** End Patch");
	assert(p.join(",") === "src/a.gd,src/b.gd", p.join(","));
	assert(core.patchPaths("--- a/src/c.gd\n+++ b/src/c.gd\n").join() === "src/c.gd", "unified diff");
});

// ---- external-command hook adapter (Codex / Claude Code) -------------------
const hookPath = join(HERE, "../../scripts/loop-guard-hook.mjs");
if (!existsSync(hookPath)) {
	skipped++;
	console.log(`\n  skip  hook adapter tests (${hookPath} not present in this tree)`);
} else {
	console.log("\nloop-guard-hook adapter");
	const hook = await import(hookPath);
	const dir = mkdtempSync(join(tmpdir(), "loop-guard-"));
	process.env.CONTRACT_EVIDENCE = join(dir, ".contract-evidence.jsonl");
	process.env.REPO_ROOT = dir;
	process.env.HARNESS_CHANGE = "CHANGE-0042";
	process.env.LOOP_CHECKS_MJS_PATH = join(HERE, "extensions/loop-checks.mjs");
	const env = (o) => JSON.stringify({ session_id: "s1", cwd: dir, hook_event_name: "PostToolUse", tool_use_id: "t", ...o });
	const patch = (f) => `*** Begin Patch\n*** Update File: ${f}\n@@\n-a\n+b\n*** End Patch`;

	await t("codex: apply_patch A->B->A on disk -> additionalContext oscillation nudge (mode on)", async () => {
		process.env.LOOP_GUARD = "on";
		const f = join(dir, "osc.gd");
		let out;
		for (const v of ["A", "B", "A"]) {
			writeFileSync(f, v);
			out = await hook.run("codex", env({ tool_name: "apply_patch", tool_input: { command: patch("osc.gd") }, tool_response: "Success. Updated the following files:\nM osc.gd" }));
		}
		assert(out?.hookSpecificOutput?.hookEventName === "PostToolUse", JSON.stringify(out));
		assert(/LOOP GUARD \(nudge\) — oscillation/.test(out.hookSpecificOutput.additionalContext), out.hookSpecificOutput.additionalContext);
	});

	await t("codex: Bash with string tool_response (no exit code) -> stuck_fix via looksFailed", async () => {
		process.env.LOOP_GUARD = "on";
		const f = join(dir, "player.gd");
		let out;
		for (let i = 1; i <= 3; i++) {
			writeFileSync(f, `v${i}`);
			await hook.run("codex", env({ session_id: "s2", tool_name: "apply_patch", tool_input: { command: patch("player.gd") }, tool_response: "ok" }));
			out = await hook.run("codex", env({ session_id: "s2", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: FAIL_A(i) }));
		}
		assert(/stuck_fix/.test(out?.hookSpecificOutput?.additionalContext ?? ""), JSON.stringify(out));
	});

	await t("shadow mode: finding is logged to evidence but nothing is returned to the model", async () => {
		process.env.LOOP_GUARD = "shadow";
		const f = join(dir, "sh.gd");
		let out;
		for (const v of ["A", "B", "A"]) {
			writeFileSync(f, v);
			out = await hook.run("codex", env({ session_id: "s3", tool_name: "apply_patch", tool_input: { command: patch("sh.gd") }, tool_response: "ok" }));
		}
		assert(out === null, `returned ${JSON.stringify(out)}`);
		const rows = readFileSync(process.env.CONTRACT_EVIDENCE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert(rows.some((r) => r.ev === "loop_guard" && r.mode === "shadow" && r.signal === "oscillation"), "no shadow evidence row");
	});

	await t("claude: PostToolUseFailure on Bash counts as failed; Edit paths hashed from disk", async () => {
		process.env.LOOP_GUARD = "on";
		const f = join(dir, "enemy.gd");
		let out;
		for (let i = 1; i <= 3; i++) {
			writeFileSync(f, `w${i}`);
			await hook.run("claude", env({ session_id: "c1", tool_name: "Edit", tool_input: { file_path: f }, tool_response: { filePath: f } }));
			out = await hook.run("claude", env({ session_id: "c1", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: FAIL_B }));
		}
		assert(out?.hookSpecificOutput?.hookEventName === "PostToolUseFailure", JSON.stringify(out));
		assert(/stuck_fix/.test(out.hookSpecificOutput.additionalContext), out.hookSpecificOutput.additionalContext);
	});

	await t("fails open: garbage stdin returns nothing and does not throw from main", async () => {
		const { execFileSync } = await import("node:child_process");
		const r = execFileSync(process.execPath, [hookPath, "codex"], { input: "{not json", env: process.env });
		assert(String(r) === "", `stdout: ${r}`);
	});

	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
