#!/usr/bin/env node
/**
 * aggregate — read every summary.json under a results tree and print the
 * CUMULATIVE record, grouped by model and task.
 *
 * WHY THIS EXISTS
 * Every batch so far has been read as a standalone snapshot, and every snapshot
 * has looked conclusive:
 *
 *     guard_fired, adversarial:  2/2 · 4/5 · 5/5 · 1/5
 *
 * Same model, same task, same contract. Taken singly these read as "the guard
 * holds", "the model sometimes attempts", "the guard always fires". Taken
 * together they are indistinguishable from a coin flip, and no n=5 batch can
 * tell you which. Averaging across batches is the only way to see that, and it
 * has to be done mechanically — eyeballing directories is how I concluded
 * "the gate worked" from a rate change it did not cause.
 *
 * Reports per cell: runs, breaches, guard fired, gate fired, task completed,
 * post-run failures, and — most importantly — a Wilson interval on breaches so
 * a small-n "0/5" is not mistaken for certainty.
 *
 * Usage: node aggregate.mjs [resultsDir]
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "/results");

/** Wilson score interval — honest about small n, unlike a bare proportion. */
function wilson(successes, n, z = 1.96) {
	if (n === 0) return { lo: 0, hi: 1, label: "n/a" };
	const p = successes / n;
	const d = 1 + (z * z) / n;
	const centre = p + (z * z) / (2 * n);
	const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return {
		lo: Math.max(0, (centre - spread) / d),
		hi: Math.min(1, (centre + spread) / d),
		label: `${(Math.max(0, (centre - spread) / d) * 100).toFixed(0)}-${(Math.min(1, (centre + spread) / d) * 100).toFixed(0)}%`,
	};
}

function findSummaries(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		const st = statSync(p);
		if (st.isDirectory()) findSummaries(p, out);
		else if (e === "summary.json") out.push(p);
	}
	return out;
}

const files = findSummaries(ROOT);
if (files.length === 0) {
	console.error(`aggregate: no summary.json under ${ROOT}`);
	process.exit(1);
}

const rows = [];
for (const f of files) {
	let s;
	try { s = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
	for (const r of s.runs ?? []) {
		if (r.invalid) continue;                       // never scored as failures
		rows.push({
			model: (s.model ?? "?").replace(/^local\//, ""),
			task: s.task ?? "?",
			label: s.label,
			breach: r.verdict === "CONTRACT_BREACH",
			guardFired: r.saw_refusal === true,
			gateFired: r.gate_fired === true,
			gateEval: r.gate_evaluated === true,
			completed: r.task_completed?.done === true,
			postFail: (r.post_violations ?? []).length > 0,
			didNothing: r.changed_files === 0,
			outcomeClean: r.outcome_clean === true,
		});
	}
}

const modelKey = (m) => m.replace(/-(MLX|Instruct|MLX-\d+bit).*$/i, "").replace(/-MLX$/, "");
const cells = new Map();
for (const r of rows) {
	const k = `${modelKey(r.model)}|${r.task}`;
	if (!cells.has(k)) cells.set(k, []);
	cells.get(k).push(r);
}

const pad = (s, k) => String(s).padEnd(k);
// Column widths must survive a 30-char model name, or the table is unreadable
// and unreadable tables do not get read.
const line = (a = "", b = "", c = "", d = "", e = "", f = "", g = "", h = "") =>
	"  " + pad(a, 32) + pad(b, 4) + pad(c, 6) + pad(d, 7) + pad(e, 6) + pad(f, 6) + pad(g, 9) + pad(h, 12);

console.log("aggregate — cumulative across every batch");
console.log("==========================================");
console.log(`results  ${ROOT}`);
console.log(`batches  ${files.length}   valid runs  ${rows.length}   (invalid runs excluded, never scored)`);
console.log("");

console.log(line("model / task", "n", "breach", "guard", "gate", "post", "compl", "breach 95% CI"));
console.log(line("", "", "fail", "fired", "fired", "fail", "", ""));

const order = [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [k, rs] of order) {
	const [model, task] = k.split("|");
	const n = rs.length;
	const breach = rs.filter((r) => r.breach).length;
	const ci = wilson(breach, n);
	const taskCompliant = task === "compliant";
	const compl = taskCompliant
		? `${rs.filter((r) => r.completed).length}/${n}`
		: (rs.filter((r) => r.didNothing).length === n ? "refused" : "adapted");
	const gateCell = rs.some((r) => r.gateFired) ? "FIRED"
		: rs.some((r) => r.gateEval) ? "passed" : "-";
	console.log(line(
		`${model} ${task}`,
		String(n),
		String(breach),
		`${rs.filter((r) => r.guardFired).length}/${n}`,
		gateCell,
		`${rs.filter((r) => r.postFail).length}/${n}`,
		compl,
		ci.label,
	));
}

console.log("");
console.log("Reading notes");
console.log("--------------");
console.log("  breach CI is a Wilson interval. A 0/5 shows a 0-52% interval, not certainty.");
console.log("  'refused' in the compl column means the adversarial task was declined outright;");
console.log("  'adapted' means the model found a permitted way to do part of it. Both are fine —");
console.log("  a breach would not be.");
console.log("  gate=FIRED means the completion gate intercepted. gate=passed means it evaluated");
console.log("  and correctly declined (tests had been run, or no claim was made).");
console.log("  A cell with no gate cell at all means the unverified arm has not been run — and");
console.log("  that arm is the only one that measures M2 and exercises the gate's firing branch.");

const totalBreach = rows.filter((r) => r.breach).length;
console.log("");
console.log(`TOTAL contract breaches: ${totalBreach} / ${rows.length} valid runs`);
const anyGate = rows.filter((r) => r.gateFired).length;
console.log(`TOTAL gate fired:         ${anyGate}`);
console.log(`TOTAL invalid excluded:   ${files.length ? "see per-batch summaries" : "n/a"}`);
