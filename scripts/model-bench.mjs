#!/usr/bin/env node
/**
 * model-bench.mjs - one fixed task with hidden tests, run once per model, so the router has a
 * clean first score for a model before it has any track record (owner, 2026-10-20; idea from
 * a Reddit setup that scored every model on the same rate-limiter spec with 11 hidden tests).
 *
 *   node scripts/model-bench.mjs --model opencode/deepseek-v4.1-flash-free [--backend opencode]
 *   node scripts/model-bench.mjs --catalog [--backend opencode]     every enabled catalog model (that backend)
 *   node scripts/model-bench.mjs --show                             the scores so far
 *   node scripts/model-bench.mjs --selftest
 *
 * The model gets ONLY scripts/model-bench/<task>/spec.md in an empty folder and is run headless
 * with the agent CLI installed on this Mac (opencode run / codex exec / claude -p / pi -p), with
 * its own login. Then the hidden tests run. Result -> .pi-session/routing/bench.json:
 *   results[<catalog id>] = { passed, total, seconds, backend, task, at, failed: [...] }
 * The router uses it as the prior while a model has fewer than outcome_min_rounds real rounds
 * (route-worker.mjs benchFor): below 60% +4 cost points, 100% -1.
 * The work folders stay in .pi-session/bench/ so you can read what each model wrote.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PROMPT = "Read spec.md in this folder and implement exactly what it asks. Work only inside this folder. When the file is written, stop.";

/** Headless command for one agent CLI. Pure. */
export function benchCommand(backend, model, effort = "medium") {
	switch (backend) {
		case "opencode": return ["opencode", ["run", ...(model ? ["--model", model] : []), PROMPT]];
		case "codex": return ["codex", ["exec", "--skip-git-repo-check", "--full-auto", ...(model ? ["--model", model] : []), "-c", `model_reasoning_effort="${effort}"`, PROMPT]];
		case "claude": return ["claude", ["-p", PROMPT, "--dangerously-skip-permissions", ...(model ? ["--model", model] : [])]];
		case "pi": return ["pi", ["-p", ...(model ? ["--model", model] : []), "--thinking", effort, PROMPT]];
		default: return null;
	}
}
/** Catalog entry -> { backend, launch model } the bench uses (antigravity has no headless mode here). Pure. */
export function benchTarget(m, forced = null) {
	const backends = forced ? [forced] : m.backends ?? [m.backend ?? "pi"];
	for (const b of backends) {
		if (b === "opencode") return { backend: b, model: m.opencode_model ?? m.id };
		if (b === "pi") return { backend: b, model: m.pi_model ?? m.id };
		if (b === "codex" || b === "claude") return { backend: b, model: m.model ?? null };
	}
	return null;
}
export function parseResult(stdout) {
	const line = String(stdout).trim().split("\n").reverse().find((l) => l.startsWith("{"));
	try { const j = JSON.parse(line); return { passed: j.passed, total: j.total, failed: Object.entries(j.results ?? {}).filter(([, v]) => !v).map(([k]) => k) }; } catch { return null; }
}

const benchPath = join(REPO, ".pi-session", "routing", "bench.json");
const loadBench = () => { try { return JSON.parse(readFileSync(benchPath, "utf8")); } catch { return { results: {} }; } };

function runOne(id, backend, model, task, timeoutMin) {
	const tdir = join(HERE, "model-bench", task);
	const work = join(REPO, ".pi-session", "bench", `${id.replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`);
	mkdirSync(join(work, "src"), { recursive: true });
	copyFileSync(join(tdir, "spec.md"), join(work, "spec.md"));
	writeFileSync(join(work, "package.json"), JSON.stringify({ name: "bench", type: "module", private: true }, null, 1));
	const cmd = benchCommand(backend, model);
	if (!cmd) return { error: `no headless mode for ${backend}` };
	const which = spawnSync("/bin/sh", ["-c", `command -v ${cmd[0]}`], { encoding: "utf8" });
	if (which.status !== 0) return { error: `${cmd[0]} is not installed on this machine` };
	console.log(`=== ${id} via ${backend}${model ? " (" + model + ")" : ""} - ${work}`);
	const t0 = Date.now();
	const r = spawnSync(cmd[0], cmd[1], { cwd: work, encoding: "utf8", timeout: timeoutMin * 60e3, maxBuffer: 64e6, stdio: ["ignore", "pipe", "pipe"] });
	const seconds = Math.round((Date.now() - t0) / 1000);
	writeFileSync(join(work, "agent-output.log"), `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`);
	if (r.error?.code === "ETIMEDOUT") console.log(`  timed out after ${timeoutMin} min`);
	copyFileSync(join(tdir, "hidden.test.mjs"), join(work, "hidden.test.mjs"));
	const t = spawnSync(process.execPath, ["hidden.test.mjs"], { cwd: work, encoding: "utf8", timeout: 60e3 });
	const res = parseResult(t.stdout) ?? { passed: 0, total: 11, failed: ["(module did not load)"] };
	return { ...res, seconds, backend, model, task, at: new Date().toISOString(), timedOut: r.error?.code === "ETIMEDOUT" };
}

async function main() {
	if (argv.includes("--selftest")) return selftest();
	const bench = loadBench();
	if (argv.includes("--show")) {
		for (const [id, r] of Object.entries(bench.results ?? {}).sort((a, b) => b[1].passed / b[1].total - a[1].passed / a[1].total || a[1].seconds - b[1].seconds)) console.log(`${id.padEnd(46)} ${String(r.passed).padStart(2)}/${r.total}  ${String(r.seconds).padStart(4)}s  ${r.at.slice(0, 10)}${r.failed?.length ? "  failed: " + r.failed.join(", ") : ""}`);
		return 0;
	}
	const task = arg("--task", "rate-limiter"), timeoutMin = Number(arg("--timeout", 15)), forced = arg("--backend");
	const catalog = JSON.parse(readFileSync(join(REPO, "herdr-plugin", "models.catalog.json"), "utf8"));
	let targets = [];
	if (arg("--model")) {
		const id = arg("--model");
		const m = catalog.models.find((x) => x.id === id) ?? { id, backends: [forced ?? (id.startsWith("opencode") ? "opencode" : "pi")] };
		targets = [{ id, ...(benchTarget(m, forced) ?? {}) }];
	} else if (argv.includes("--catalog")) {
		targets = catalog.models.filter((m) => m.enabled !== false).map((m) => ({ id: m.id, ...(benchTarget(m, forced) ?? {}) })).filter((t) => t.backend && (!forced || t.backend === forced));
		if (!argv.includes("--rerun")) targets = targets.filter((t) => !bench.results?.[t.id]);
	} else { console.error("usage: model-bench.mjs --model <catalog id> [--backend b] | --catalog [--backend b] [--rerun] | --show"); return 2; }
	for (const t of targets) {
		if (!t.backend) { console.log(`skip ${t.id}: no headless backend`); continue; }
		const r = runOne(t.id, t.backend, t.model, task, timeoutMin);
		if (r.error) { console.log(`skip ${t.id}: ${r.error}`); continue; }
		console.log(`  ${r.passed}/${r.total} in ${r.seconds}s${r.failed.length ? " - failed: " + r.failed.join(", ") : ""}`);
		const b = loadBench(); b.results ??= {}; b.results[t.id] = r; b.at = new Date().toISOString();
		mkdirSync(dirname(benchPath), { recursive: true }); writeFileSync(benchPath, JSON.stringify(b, null, 1));
	}
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	ok(benchCommand("opencode", "opencode/x")[1].includes("--model") && benchCommand("codex", "gpt-6.1-sol")[1].includes("exec") && benchCommand("claude", "sonnet")[1][0] === "-p" && benchCommand("pi", "a/b")[1].includes("--thinking") && benchCommand("antigravity") === null, "headless commands");
	ok(benchTarget({ id: "opencode/deepseek-v4.1-flash-free", backends: ["opencode", "pi"] }).backend === "opencode" && benchTarget({ id: "claude/sonnet", backend: "claude", model: "sonnet" }).model === "sonnet" && benchTarget({ id: "antigravity/x", backend: "antigravity" }) === null, "catalog targets");
	ok(parseResult('noise\n{"passed":5,"total":11,"results":{"a":true,"b":false}}').failed[0] === "b", "parses the hidden test result");
	// the reference solution must pass the hidden tests (keeps the task honest)
	const ref = join(HERE, "model-bench", "rate-limiter", "ref");
	if (existsSync(ref)) {
		copyFileSync(join(HERE, "model-bench", "rate-limiter", "hidden.test.mjs"), join(ref, "hidden.test.mjs"));
		const t = spawnSync(process.execPath, ["hidden.test.mjs"], { cwd: ref, encoding: "utf8" });
		const r = parseResult(t.stdout);
		ok(r && r.passed === r.total && r.total === 11, `reference solution passes 11/11 (got ${r?.passed}/${r?.total})`);
	}
	if (fails) { console.error(`${fails} model-bench self-test(s) FAILED`); return 1; }
	console.log("model-bench self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c ?? 0));
