#!/usr/bin/env node
//
// task-plan - categorize a change's tasks.md, lint the breakdown, group tasks into
// worker batches, and say which model each batch would run on.
//
// WHY (owner, 2026-11-03): route by task, not just by change, so free/cheap tiers take
// the mechanical and local work and the strong models (Opus above all) are kept for the
// genuinely hard parts. WITHOUT over-splitting: every split adds a briefing, duplicated
// reading and a re-check (measured in Manuele-T/claude-model-router v1.0 - delegation
// cost up to 30% MORE on small jobs and only paid on big, separable ones). So the unit
// that gets a model is a BATCH of adjacent tasks of the same class, never a lone tiny
// task, and a split only stands when the cheap side is big enough and has its own check.
//
// tasks.md fields this reads (see docs/tasks.template.md):
//   ### T<n> — <description>
//   **Category:** mechanical | local | cross-cutting | ui | art
//   **Check:** <mechanical check that proves this task done: a command, a test id, "file exists">
//   **Reason:** <why it needs a strong model>   (required for cross-cutting / ui / art / Tier 4)
//   **Tier:** 4   (optional; only with a Reason - raises cross-cutting/art to frontier)
//   **Size:** XS | S | M | L      **Depends on:** T<n> | None     **Files:** ...
//
//   node scripts/task-plan.mjs CHANGE-NNNN            explain the plan
//   node scripts/task-plan.mjs CHANGE-NNNN --lint     exit 1 on errors (planner/integrator gate)
//   node scripts/task-plan.mjs CHANGE-NNNN --json
//   node scripts/task-plan.mjs --selftest
//
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { readRoutingFacts, routeWorker, findChangeYaml, ledgerEntries, routingContext } from "./route-worker.mjs";

/**
 * Category -> minimum worker tier. The floor is also the default: routeWorker always takes
 * the cheapest adequate model, so nothing climbs above the floor without an escalation.
 *   mechanical    rename, boilerplate, config, wiring, docs, moving code      -> tier 1 (local/free)
 *   local         logic inside one module, covered by its own tests           -> tier 2 (free/cheap)
 *   cross-cutting design across modules, security, concurrency, data model    -> tier 3, Reason required
 *   ui            layout, CSS, UI components (owner: Sonnet-level)            -> tier 3, Reason required
 *   art           SVG, sprites, shaders, illustration (owner: Opus/astra)     -> tier 3 + visual model, Reason required
 */
export const CATEGORIES = {
	mechanical: { floor: 1, visual: false, needsReason: false },
	local: { floor: 2, visual: false, needsReason: false },
	"cross-cutting": { floor: 3, visual: false, needsReason: true },
	ui: { floor: 3, visual: false, needsReason: true },
	art: { floor: 3, visual: true, needsReason: true },
};
const ALIASES = { "cross cutting": "cross-cutting", crosscutting: "cross-cutting", logic: "local", visual: "art" };
export const SIZE_POINTS = { XS: 1, S: 2, M: 4, L: 8 };
/** A batch never grows past this (an L task = the tasks.template.md upper bound before splitting). */
export const BATCH_CAP_POINTS = 8;
/** A batch smaller than this is not worth its own worker launch: it is folded into a neighbour. */
export const MIN_BATCH_POINTS = 2;
/** More tasks than this for the change's size = over-split (each task is a re-read and a re-check). */
export const MAX_TASKS = { S: 3, M: 6, L: 10, XL: 16 };
/** Above this share of task points at tier >= 3, most of the change runs on strong models. */
export const STRONG_SHARE_WARN = 0.5;

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------
export function parseTasks(text) {
	const tasks = [];
	let cur = null;
	const body = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
	// stop at the template's worked example if the planner left it in
	const cut = body.search(/^##\s+Worked example/im);
	for (const raw of (cut >= 0 ? body.slice(0, cut) : body).split(/\r?\n/)) {
		const h = raw.match(/^###\s+(T\d+)\s*[—–-]+\s*(.*)$/);
		if (h) { cur = { id: h[1], title: h[2].trim(), fields: {} }; tasks.push(cur); continue; }
		if (!cur) continue;
		const f = raw.match(/^\*\*([A-Za-z ]+):\*\*\s*(.*)$/);
		if (f) cur.fields[f[1].trim().toLowerCase()] = f[2].trim();
	}
	return tasks.map((t) => {
		const catRaw = String(t.fields.category ?? "").toLowerCase().trim();
		const category = CATEGORIES[catRaw] ? catRaw : ALIASES[catRaw] ?? null;
		const size = String(t.fields.size ?? "").toUpperCase().match(/\b(XS|S|M|L|XL)\b/)?.[1] ?? null;
		const dep = String(t.fields["depends on"] ?? "None");
		const tier = Number(String(t.fields.tier ?? "").match(/\d/)?.[0]) || null;
		const empty = (v) => !v || /^(none|n\/a|-|tbd|<.*>)$/i.test(v.trim());
		return {
			id: t.id, title: t.title, category, categoryRaw: catRaw || null, size,
			check: empty(t.fields.check) ? (empty(t.fields["verified by"]) ? null : `tests ${t.fields["verified by"]}`) : t.fields.check,
			reason: empty(t.fields.reason) ? null : t.fields.reason,
			tier, dependsOn: /none/i.test(dep) ? [] : dep.match(/T\d+/g) ?? [],
			files: (t.fields.files ?? "").match(/`[^`]+`/g)?.map((x) => x.slice(1, -1)) ?? [],
			status: (t.fields.status ?? "pending").toLowerCase(),
		};
	});
}

export function floorFor(t) {
	const c = CATEGORIES[t.category ?? "local"];
	let floor = c.floor;
	if (t.tier === 4 && t.reason) floor = 4;
	return { floor, visual: c.visual, cls: `${floor}${c.visual ? "v" : ""}` };
}

// ---------------------------------------------------------------------------
// lint: catch both under-splitting (strong models doing cheap work) and over-splitting
// ---------------------------------------------------------------------------
export function lintTasks(tasks, { changeSize = null } = {}) {
	const errors = [], warnings = [];
	if (!tasks.length) return { errors, warnings, stats: null };
	const ids = new Set();
	for (const t of tasks) {
		if (ids.has(t.id)) errors.push(`${t.id}: duplicate task id`);
		ids.add(t.id);
		if (!t.category) errors.push(`${t.id}: **Category:** missing or unknown (${t.categoryRaw ?? "none"}) - use ${Object.keys(CATEGORIES).join(" | ")}`);
		else if (CATEGORIES[t.category].needsReason && !t.reason) errors.push(`${t.id}: category ${t.category} runs on a strong model - add **Reason:** saying why a cheaper model cannot do it, or recategorize`);
		if (t.tier === 4 && !t.reason) errors.push(`${t.id}: **Tier:** 4 needs a **Reason:**`);
		if (t.tier === 4 && t.category && !["cross-cutting", "art"].includes(t.category)) errors.push(`${t.id}: **Tier:** 4 is only for cross-cutting or art tasks`);
		if (!t.size) errors.push(`${t.id}: **Size:** missing`);
		if (t.size === "XL") errors.push(`${t.id}: size XL - split it before routing (tasks.template.md)`);
		if (/\band\b/i.test(t.title) && t.category && t.category !== "mechanical") warnings.push(`${t.id}: the description needs "and" - likely two tasks`);
		for (const d of t.dependsOn) if (!ids.has(d)) errors.push(`${t.id}: depends on ${d}, which is not an earlier task`);
		if (!t.check) warnings.push(`${t.id}: no **Check:** or **Verified by:** - it cannot be routed on its own, so it rides with its neighbours`);
	}
	const pts = (t) => SIZE_POINTS[t.size] ?? 2;
	const total = tasks.reduce((s, t) => s + pts(t), 0);
	const strong = tasks.filter((t) => t.category && floorFor(t).floor >= 3).reduce((s, t) => s + pts(t), 0);
	const tiny = tasks.filter((t) => t.size === "XS").length;
	const strongShare = total ? strong / total : 0;
	if (changeSize && MAX_TASKS[changeSize] && tasks.length > MAX_TASKS[changeSize])
		warnings.push(`over-split: ${tasks.length} tasks for a size-${changeSize} change (more than ${MAX_TASKS[changeSize]}) - every task adds a briefing, a re-read and a re-check; merge adjacent tasks of the same category`);
	if (tasks.length >= 4 && tiny / tasks.length > 0.5)
		warnings.push(`over-split: ${tiny} of ${tasks.length} tasks are XS - merge XS tasks into the task they serve unless one has its own Check`);
	if (strongShare > STRONG_SHARE_WARN && tasks.length > 1)
		warnings.push(`${Math.round(strongShare * 100)}% of the work is on tier >= 3 - split the hard core out of each strong task so the routine parts can run on a cheaper model`);
	return { errors, warnings, stats: { tasks: tasks.length, points: total, strongPoints: strong, strongShare, tiny,
		byCategory: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, tasks.filter((t) => t.category === k).length])) } };
}

// ---------------------------------------------------------------------------
// batch: adjacent tasks of the same class share one worker; small or unchecked
// batches are folded into a neighbour instead of getting their own launch
// ---------------------------------------------------------------------------
export function batchTasks(tasks, { cap = BATCH_CAP_POINTS, minPoints = MIN_BATCH_POINTS } = {}) {
	const pts = (t) => SIZE_POINTS[t.size] ?? 2;
	const open = tasks.filter((t) => t.status !== "done");
	let batches = [];
	for (const t of open) {
		const f = floorFor(t);
		const last = batches[batches.length - 1];
		if (last && last.cls === f.cls && last.points + pts(t) <= cap) { last.tasks.push(t); last.points += pts(t); last.checked ||= !!t.check; continue; }
		batches.push({ cls: f.cls, floor: f.floor, visual: f.visual, tasks: [t], points: pts(t), checked: !!t.check, notes: [] });
	}
	// Fold: a batch too small to pay for its own launch, or with nothing to check it by, joins a
	// neighbour. It goes to the STRONGER neighbour (never makes a strong task run cheaper), and
	// art never absorbs non-visual work or vice versa unless there is no other neighbour.
	let changed = true;
	while (changed && batches.length > 1) {
		changed = false;
		for (let i = 0; i < batches.length; i++) {
			const b = batches[i];
			if (b.points >= minPoints && b.checked) continue;
			const nb = [batches[i - 1], batches[i + 1]].filter(Boolean);
			const sameVis = nb.filter((x) => x.visual === b.visual);
			const pool = sameVis.length ? sameVis : nb;
			const into = pool.sort((x, y) => y.floor - x.floor || x.points - y.points)[0];
			if (!into) continue;
			const why = b.points < minPoints ? `too small for its own launch (${b.points} pt)` : "no Check of its own";
			into.notes.push(`${b.tasks.map((t) => t.id).join(",")} folded in: ${why}`);
			into.tasks = i < batches.indexOf(into) ? [...b.tasks, ...into.tasks] : [...into.tasks, ...b.tasks];
			into.points += b.points; into.checked ||= b.checked;
			if (b.floor > into.floor) { into.floor = b.floor; into.cls = b.cls; }
			into.visual ||= b.visual;
			batches.splice(i, 1);
			changed = true;
			break;
		}
	}
	// merge neighbours that ended up in the same class and still fit
	batches = batches.reduce((acc, b) => {
		const last = acc[acc.length - 1];
		if (last && last.cls === b.cls && last.points + b.points <= cap) { last.tasks.push(...b.tasks); last.points += b.points; last.notes.push(...b.notes); last.checked ||= b.checked; }
		else acc.push(b);
		return acc;
	}, []);
	return batches.map((b, i) => ({ ...b, id: `B${i + 1}`, size: b.points <= 2 ? "S" : b.points <= 4 ? "M" : b.points <= 8 ? "L" : "XL",
		categories: [...new Set(b.tasks.map((t) => t.category ?? "local"))], reasons: b.tasks.map((t) => t.reason).filter(Boolean) }));
}

/** change.yaml facts narrowed to one batch: its size, its tier floor, its visual flag. */
export function batchFacts(changeFacts, b) {
	return { ...changeFacts, routing: { complexity: b.size, visual: b.visual, min_tier: b.floor, reason: b.reasons[0] ?? `${b.categories.join("+")} tasks` } };
}

export function planTasks({ tasksText, changeFacts, entries = [], ctx }) {
	const tasks = parseTasks(tasksText);
	const changeSize = changeFacts.routing?.complexity ?? null;
	const lint = lintTasks(tasks, { changeSize });
	if (!tasks.length) return { tasks, lint, batches: [], summary: null };
	const batches = batchTasks(tasks).map((b) => {
		// the change's struggle history applies to every batch (same escalation ladder as a whole-change launch)
		const r = routeWorker({ facts: batchFacts(changeFacts, b), entries, ...ctx });
		return { ...b, route: { pick: r.pick ?? null, human: !!r.escalateToHuman, wait: !!r.wait, minTier: r.minTier, reason: r.reason } };
	});
	const tierPts = {};
	for (const b of batches) { const t = b.route.pick?.tier ?? b.floor; tierPts[t] = (tierPts[t] ?? 0) + b.points; }
	const total = batches.reduce((s, b) => s + b.points, 0);
	const cheap = (tierPts[1] ?? 0) + (tierPts[2] ?? 0);
	return { tasks, lint, batches, summary: { batches: batches.length, points: total, tierPoints: tierPts, cheapShare: total ? cheap / total : 0, frontierPoints: tierPts[4] ?? 0 } };
}

// ---------------------------------------------------------------------------
// disk
// ---------------------------------------------------------------------------
export function planForChange(repoRoot, change, { entries = null } = {}) {
	try {
		const y = findChangeYaml(repoRoot, change);
		if (!y) return { change, error: "no change.yaml" };
		const tf = join(dirname(y), "tasks.md");
		if (!existsSync(tf)) return { change, tasksFile: null, lint: { errors: [], warnings: [], stats: null }, batches: [], summary: null };
		const plan = planTasks({ tasksText: readFileSync(tf, "utf8"), changeFacts: readRoutingFacts(readFileSync(y, "utf8")), entries: entries ?? ledgerEntries(repoRoot, change), ctx: routingContext(repoRoot) });
		return { change, tasksFile: tf, ...plan };
	} catch (e) { return { change, error: String(e.message ?? e) }; }
}

/** One line per plan in .pi-session/routing/task-plans.jsonl (for the dashboard's cheap-share view). */
export function logTaskPlan(repoRoot, p, extra = {}) {
	try {
		const dir = join(repoRoot, ".pi-session", "routing");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "task-plans.jsonl"), JSON.stringify({ at: new Date().toISOString(), change: p.change, ...extra,
			errors: p.lint?.errors?.length ?? 0, warnings: p.lint?.warnings ?? [], stats: p.lint?.stats ?? null, summary: p.summary,
			batches: (p.batches ?? []).map((b) => ({ id: b.id, tasks: b.tasks.map((t) => t.id), categories: b.categories, points: b.points, floor: b.floor, pick: b.route?.pick?.id ?? null, tier: b.route?.pick?.tier ?? null, human: b.route?.human ?? false })) }) + "\n");
	} catch { /* logging never blocks a launch */ }
}

export function explainPlan(p) {
	const L = [];
	if (p.error) return `${p.change}: ${p.error}`;
	if (!p.tasksFile) return `${p.change}: no tasks.md - routed as one change (scripts/route-worker.mjs)`;
	const s = p.lint.stats;
	L.push(`${p.change}: ${s?.tasks ?? 0} tasks, ${p.summary?.batches ?? 0} worker batches` + (p.summary ? `, ${Math.round(p.summary.cheapShare * 100)}% of the work on tier 1-2` : ""));
	if (s) L.push(`  categories: ${Object.entries(s.byCategory).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	for (const b of p.batches) {
		const pick = b.route.human ? "HUMAN" : b.route.wait ? "WAIT" : b.route.pick ? `${b.route.pick.id} (t${b.route.pick.tier})` : "-";
		L.push(`  ${b.id} [${b.tasks.map((t) => t.id).join(",")}] ${b.categories.join("+")} · ${b.points} pt (${b.size}) · floor t${b.floor}${b.visual ? " visual" : ""} -> ${pick}`);
		for (const n of b.notes) L.push(`      ${n}`);
	}
	for (const e of p.lint.errors) L.push(`  ERROR ${e}`);
	for (const w of p.lint.warnings) L.push(`  warn  ${w}`);
	return L.join("\n");
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const T = (id, f) => [`### ${id} — ${f.title ?? "do " + id}`, ...Object.entries(f).filter(([k]) => k !== "title").map(([k, v]) => `**${k}:** ${v}`), ""].join("\n");

	let ts = parseTasks(["<!-- c -->", T("T1", { Category: "mechanical", Size: "S", Check: "npm test", "Depends on": "None" }), T("T2", { Category: "Cross cutting", Size: "M", Reason: "auth model", "Verified by": "T3", "Depends on": "T1" }), "## Worked example", T("T9", { Category: "art" })].join("\n"));
	ok(ts.length === 2, "parses tasks and stops at the worked example");
	ok(ts[1].category === "cross-cutting" && ts[1].check === "tests T3" && ts[1].dependsOn[0] === "T1", "alias, Verified by as check, depends");

	let l = lintTasks(parseTasks(T("T1", { Category: "ui", Size: "S", Check: "x" })));
	ok(l.errors.some((e) => /Reason/.test(e)), "ui without Reason -> error (forced cheap default)");
	l = lintTasks(parseTasks(T("T1", { Category: "local", Size: "S", Check: "x", Tier: "4" })));
	ok(l.errors.some((e) => /Tier/.test(e)), "Tier 4 without reason -> error");
	l = lintTasks(parseTasks(T("T1", { Size: "S" })));
	ok(l.errors.some((e) => /Category/.test(e)), "missing category -> error");
	const many = Array.from({ length: 5 }, (_, i) => T(`T${i + 1}`, { Category: "mechanical", Size: "XS", Check: "x" })).join("\n");
	l = lintTasks(parseTasks(many), { changeSize: "S" });
	ok(l.warnings.some((w) => /over-split: 5 tasks/.test(w)) && l.warnings.some((w) => /XS/.test(w)), "over-split warnings");
	l = lintTasks(parseTasks([T("T1", { Category: "cross-cutting", Size: "L", Check: "x", Reason: "r" }), T("T2", { Category: "mechanical", Size: "S", Check: "x" })].join("\n")));
	ok(l.warnings.some((w) => /tier >= 3/.test(w)), "strong-heavy plan -> split-the-core warning");

	// batching
	let b = batchTasks(parseTasks([T("T1", { Category: "mechanical", Size: "S", Check: "a" }), T("T2", { Category: "mechanical", Size: "S", Check: "b" }), T("T3", { Category: "cross-cutting", Size: "M", Check: "c", Reason: "r" })].join("\n")));
	ok(b.length === 2 && b[0].tasks.length === 2 && b[0].floor === 1 && b[1].floor === 3, "adjacent same-class tasks share a batch; the hard one is separate");
	b = batchTasks(parseTasks([T("T1", { Category: "cross-cutting", Size: "M", Check: "a", Reason: "r" }), T("T2", { Category: "mechanical", Size: "XS", Check: "b" }), T("T3", { Category: "local", Size: "M", Check: "c" })].join("\n")));
	ok(b.length === 2 && b[0].tasks.map((t) => t.id).join() === "T1,T2" && b[0].floor === 3, "a lone XS folds into the STRONGER neighbour, not its own launch");
	b = batchTasks(parseTasks([T("T1", { Category: "local", Size: "M", Check: "a" }), T("T2", { Category: "mechanical", Size: "M" })].join("\n")));
	ok(b.length === 1 && b[0].floor === 2, "a task with no Check rides with its neighbour");
	b = batchTasks(parseTasks([T("T1", { Category: "mechanical", Size: "L", Check: "a" }), T("T2", { Category: "mechanical", Size: "M", Check: "b" })].join("\n")));
	ok(b.length === 2, "batch cap splits a too-large same-class run");
	b = batchTasks(parseTasks([T("T1", { Category: "art", Size: "M", Check: "a", Reason: "sprites" }), T("T2", { Category: "local", Size: "M", Check: "b" })].join("\n")));
	ok(b.length === 2 && b[0].visual && !b[1].visual, "art and logic stay apart");
	b = batchTasks(parseTasks([T("T1", { Category: "mechanical", Size: "M", Check: "a", Status: "done" }), T("T2", { Category: "local", Size: "M", Check: "b" })].join("\n")));
	ok(b.length === 1 && b[0].tasks[0].id === "T2", "done tasks are not routed again");

	// routing through routeWorker
	const catalog = { quota_floor_pct: 15, free_first: false, models: [
		{ id: "local/q", backend: "pi", tier: 1, cost: "local" },
		{ id: "free/flash", backend: "pi", tier: 2, cost: "free" },
		{ id: "sub/sonnet", backend: "pi", tier: 3, cost: "sub" },
		{ id: "sub/opus", backend: "pi", tier: 4, cost: "sub", visual: true },
	] };
	const ctx = { catalog, usage: { local: { up: true, models: ["q"] }, quotas: {}, breakers: {} }, logins: {} };
	const facts = readRoutingFacts("risk:\n  tier: medium\nrouting:\n  complexity: L\n");
	const p = planTasks({ tasksText: [T("T1", { Category: "mechanical", Size: "S", Check: "a" }), T("T2", { Category: "local", Size: "M", Check: "b" }), T("T3", { Category: "cross-cutting", Size: "M", Check: "c", Reason: "concurrency" }), T("T4", { Category: "art", Size: "S", Check: "d", Reason: "sprite sheet" })].join("\n"), changeFacts: facts, ctx });
	const picks = p.batches.map((x) => x.route.pick?.id);
	ok(picks.join() === "local/q,free/flash,sub/sonnet,sub/opus", `each batch on its own tier (${picks.join()})`);
	ok(p.summary.cheapShare === 0.5, `cheap share measured (${p.summary.cheapShare})`);
	const hard = planTasks({ tasksText: T("T1", { Category: "cross-cutting", Size: "M", Check: "c", Reason: "proof", Tier: "4" }), changeFacts: facts, ctx });
	ok(hard.batches[0].route.pick?.id === "sub/opus", "Tier 4 with a reason reaches the frontier model");
	const hi = planTasks({ tasksText: T("T1", { Category: "mechanical", Size: "S", Check: "a" }), changeFacts: readRoutingFacts("risk:\n  tier: high\n"), ctx });
	ok(hi.batches[0].route.pick?.tier >= 3, "high-risk change keeps its tier >= 3 floor for every batch");

	if (fails) { console.error(`\n${fails} self-test(s) FAILED`); process.exit(1); }
	console.log("task-plan self-test: all passed");
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const change = argv.find((a) => /^CHANGE-\d+/i.test(a));
	if (!change) { console.error("usage: task-plan.mjs CHANGE-NNNN [--lint] [--json] | --selftest"); process.exit(2); }
	const root = process.env.HARNESS_REPO ?? execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
	const p = planForChange(root, change.toUpperCase());
	if (argv.includes("--json")) console.log(JSON.stringify(p, (k, v) => (k === "candidates" ? undefined : v), 2));
	else console.log(explainPlan(p));
	if (argv.includes("--lint") && (p.error || p.lint?.errors?.length)) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("task-plan.mjs")) main();
