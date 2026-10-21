#!/usr/bin/env node
/**
 * model-outcomes.mjs - what a worker model REALLY costs, counted per hand-over round.
 *
 * A model that never times out can still be the expensive one if its work keeps coming back
 * from review. So every worker round is rebuilt from the handoff ledger
 *   (integrator/runner sends work -> worker reports -> integrator/runner verdict)
 * and joined with what happened inside it:
 *   worker side   model, turns, tokens, error turns (stopReason error), tool errors,
 *                 "continue" injections (guard recovery messages + the watcher's AUTO-CONTINUE),
 *                 report reminders, guard violations / blocked calls, wall time
 *   review side   verdict (accepted / changes requested / qualification failed / ...),
 *                 findings in the integrator's review file, the integrator's OWN tokens for that
 *                 review (the hidden cost of faulty work), and its model
 * then aggregated per worker model:
 *   first-pass acceptance, worker reports per merged change, findings per review, continues
 *   per round, tool errors per 100 turns, and $ per merged change INCLUDING the review rounds
 *   (real $/Mtok from Real API Pricing via plan-pricing.mjs).
 *
 * OpenCode workers keep their sessions outside the repo, so their model comes from the routing
 * decision / launch record and their token counts stay empty (rounds and verdicts still count).
 *
 *   node scripts/model-outcomes.mjs           per-model table (+ writes .pi-session/routing/outcomes.json)
 *   node scripts/model-outcomes.mjs --rounds  every round
 *   node scripts/model-outcomes.mjs --json
 *   node scripts/model-outcomes.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SENDS_WORK = new Set(["plan-approved", "impl-changes-requested", "qualification-failed"]);
const WORKER_REPORTS = new Set(["impl-ready", "blocked", "needs-qualification", "needs-decision", "question"]);
const OUTCOME = { merged: "accepted", "impl-changes-requested": "changes", "qualification-failed": "qual-failed", "needs-human": "human", "plan-changes-requested": "replanned", "plan-approved": "replanned", qualified: "qualified" };

// ---------------------------------------------------------------------------
// rounds from the ledger (pure)
// ---------------------------------------------------------------------------
export function roundsFromLedger(entries) {
	const es = [...entries].sort((a, b) => String(a.at).localeCompare(String(b.at)));
	const rounds = [];
	let start = null;
	for (let i = 0; i < es.length; i++) {
		const e = es[i];
		if (e.role !== "worker" && SENDS_WORK.has(e.verdict)) { start = e; continue; }
		if (e.role !== "worker" || !WORKER_REPORTS.has(e.verdict) || !start) continue;
		const r = { change: e.change, start: start.at, startVerdict: start.verdict, report: e.at, reportVerdict: e.verdict, verdict: null, verdictAt: null, reviewFile: null, outcome: null };
		if (["blocked", "needs-decision", "question"].includes(e.verdict)) r.outcome = "stalled";
		// the verdict on this report: next integrator/runner entry (skip a runner's "qualified", keep looking for the integrator)
		for (let j = i + 1; j < es.length; j++) {
			const n = es[j];
			if (n.role === "worker") break;
			if (n.role === "runner" && n.verdict === "qualified") { r.qualified = true; continue; }
			if (n.role === "runner" && n.verdict === "blocked") continue;
			if (OUTCOME[n.verdict] || n.role === "integrator") {
				r.verdict = n.verdict; r.verdictAt = n.at; r.reviewFile = n.role === "integrator" ? n.file ?? null : null; r.reviewer = n.role;
				r.outcome ??= OUTCOME[n.verdict] ?? n.verdict;
				break;
			}
		}
		rounds.push(r);
		start = e.verdict === "impl-ready" || e.verdict === "needs-qualification" ? null : start; // a stalled worker keeps its window
		if (r.outcome === "stalled") start = { at: e.at, verdict: "resume" };
	}
	return rounds;
}

/** Rows in the "## Findings" table of an integrator review, with severities. */
export function countFindings(md) {
	const m = String(md ?? "").split(/^##\s+Findings\s*$/m)[1];
	if (!m) return null;
	const body = m.split(/^##\s+/m)[0];
	const rows = body.split("\n").filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-{2,}/.test(l)).slice(1) // drop header
		.filter((l) => !/^\s*\|\s*(none|-)?\s*\|/i.test(l) || /\|\s*\w+\s*\|\s*\w/.test(l));
	const sev = {};
	for (const l of rows) { const s = (l.split("|")[2] ?? "").trim().toLowerCase(); if (s) sev[s] = (sev[s] ?? 0) + 1; }
	return { total: rows.length, bySeverity: sev };
}

// ---------------------------------------------------------------------------
// session / evidence / event readers
// ---------------------------------------------------------------------------
const readLines = (f) => { try { return readFileSync(f, "utf8").split("\n"); } catch { return []; } };
const T = (s) => Date.parse(s ?? "") || null;

/** Assistant turns + tool errors from every pi session file in a dir. */
export function sessionEvents(dir) {
	const turns = [], toolErrors = [];
	let files = [];
	try { files = readdirSync(dir).filter((f) => /^\d{4}-.*\.jsonl$/.test(f)); } catch { return { turns, toolErrors }; }
	for (const f of files) {
		for (const line of readLines(join(dir, f))) {
			if (!line.includes('"message"')) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			const m = o.message; const t = T(o.timestamp);
			if (!m || !t) continue;
			if (m.role === "assistant") {
				const u = m.usage ?? {};
				turns.push({ t, model: m.provider && m.model ? `${m.provider}/${m.model}` : m.model ?? null, tokens: Number(u.totalTokens) || 0, error: m.stopReason === "error" });
			} else if (m.role === "toolResult" && m.isError) toolErrors.push(t);
		}
	}
	return { turns, toolErrors };
}
/** Every jsonl file under dir (depth-limited), optionally filtered by name. */
function walkJsonl(dir, test, depth = 6, out = []) {
	let ents = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of ents) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (depth > 0 && !["tool-results", "chunks", "node_modules"].includes(e.name)) walkJsonl(p, test, depth - 1, out); }
		else if (e.name.endsWith(".jsonl") && test(e.name, p)) out.push(p);
	}
	return out;
}

/**
 * The integrator's own turns, whatever ran it: pi sessions, pi review subagents
 * (subagent-artifacts/*_transcript.jsonl), Claude Code (claude-projects/**.jsonl) and
 * Antigravity (antigravity-brain/<id>/.system_generated/logs/transcript.jsonl).
 */
export function integratorEvents(dir) {
	const { turns, toolErrors } = sessionEvents(dir);
	// pi review subagents
	for (const f of walkJsonl(join(dir, "subagent-artifacts"), (n) => n.endsWith("_transcript.jsonl"), 1)) {
		for (const line of readLines(f)) {
			if (!line.includes('"assistant"')) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			if (o.role !== "assistant" || !o.usage) continue;
			const u = o.usage, t = T(o.timestamp) ?? o.ts;
			if (t) turns.push({ t, model: o.model ?? null, tokens: (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), error: o.stopReason === "error", sub: true });
		}
	}
	// Claude Code: one line per content block, same message id -> count once
	const seen = new Set();
	for (const f of walkJsonl(join(dir, "claude-projects"), () => true)) {
		for (const line of readLines(f)) {
			if (!line.includes('"type":"assistant"') && !line.includes('"is_error":true')) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			const t = T(o.timestamp);
			if (o.type === "assistant" && o.message?.usage && t) {
				const id = o.message.id ?? o.requestId ?? o.uuid;
				if (seen.has(id)) continue; seen.add(id);
				const u = o.message.usage;
				turns.push({ t, model: o.message.model ? `anthropic/${o.message.model}` : null, tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), error: o.isApiErrorMessage === true });
			} else if (o.type === "user" && t && Array.isArray(o.message?.content) && o.message.content.some((c) => c.type === "tool_result" && c.is_error)) toolErrors.push(t);
		}
	}
	// Antigravity: the main transcript only (chunks/ repeat it)
	for (const f of walkJsonl(join(dir, "antigravity-brain"), (n, p) => n === "transcript.jsonl" && p.includes(".system_generated"))) {
		for (const line of readLines(f)) {
			if (!line.includes("PLANNER_RESPONSE")) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			const t = T(o.created_at);
			if (t && o.type === "PLANNER_RESPONSE") turns.push({ t, model: "antigravity", tokens: Number(o.input_tokens || 0) + Number(o.output_tokens || 0) + Number(o.cache_read_tokens || 0), error: o.status === "ERROR" });
		}
	}
	return { turns, toolErrors };
}
export function evidenceEvents(dir) {
	const out = [];
	for (const line of readLines(join(dir, "evidence.jsonl"))) {
		if (!line.includes('"ev"')) continue;
		let o; try { o = JSON.parse(line); } catch { continue; }
		if (o.t && o.ev) out.push({ t: o.t, ev: o.ev });
	}
	return out;
}
export function watcherEvents(eventsLog) {
	const out = [];
	for (const line of readLines(eventsLog)) {
		const m = line.match(/^(\S+)\s+(AUTO-CONTINUE|REMIND)\s+.*?(CHANGE-\d+)/);
		if (m) out.push({ t: T(m[1]), kind: m[2], change: m[3] });
	}
	return out;
}

function dominant(arr) { const c = {}; for (const x of arr) if (x) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; }
const inWin = (t, a, b) => t >= a && t <= b;

/** Fill one round's numbers from the collected data. Pure (given the data). */
export function measureRound(r, { worker, evidence = [], watcher = [], integrator = { turns: [] }, decisions = [], review = null }) {
	const a = T(r.start), b = T(r.report), v = T(r.verdictAt);
	const wt = worker.turns.filter((x) => inWin(x.t, a, b));
	const out = { ...r };
	out.model = dominant(wt.map((x) => x.model)) ?? decisions.filter((d) => d.change === r.change && T(d.at) <= b && d.pick).map((d) => `${d.pick.id ?? d.pick.model}`).pop() ?? null;
	out.modelSource = wt.length ? "session" : out.model ? "routing decision" : null;
	out.turns = wt.length;
	out.tokens = wt.reduce((s, x) => s + x.tokens, 0);
	out.errorTurns = wt.filter((x) => x.error).length;
	out.toolErrors = worker.toolErrors.filter((t) => inWin(t, a, b)).length;
	const ev = evidence.filter((x) => inWin(x.t, a, b));
	const n = (name) => ev.filter((x) => x.ev === name).length;
	out.continues = n("disconnect_recovery_sent") + watcher.filter((x) => x.kind === "AUTO-CONTINUE" && x.change === r.change && inWin(x.t, a, b)).length;
	out.recoveredAlone = n("disconnect_recovery_not_needed");
	out.reminders = watcher.filter((x) => x.kind === "REMIND" && x.change === r.change && inWin(x.t, a, b)).length;
	out.violations = n("violation");
	out.blocked = n("blocked");
	out.gateExhausted = n("completion_gate_exhausted");
	out.workerMinutes = a && b ? Math.round((b - a) / 60000) : null;
	if (v) {
		const it = integrator.turns.filter((x) => inWin(x.t, b, v));
		out.reviewTokens = it.reduce((s, x) => s + x.tokens, 0);
		out.reviewTurns = it.length;
		out.reviewModel = dominant(it.map((x) => x.model));
		out.reviewMinutes = Math.round((v - b) / 60000);
	}
	// only a review of the worker's actual code counts (not a plan review after a blocked report)
	out.findings = review && ["changes", "accepted", "human"].includes(out.outcome) ? review.total : null;
	return out;
}

/** Per worker model: rounds, acceptance, findings, continues, $ incl. reviews. Pure. */
export function aggregate(rounds, priceOf = () => null) {
	const by = {};
	for (const r of rounds) {
		const k = r.model ?? "unknown";
		const g = (by[k] ??= { model: k, rounds: 0, changes: new Set(), merged: new Set(), outcomes: {}, firstPass: 0, firstReports: 0, findings: 0, reviews: 0, continues: 0, recoveredAlone: 0, reminders: 0, errorTurns: 0, toolErrors: 0, turns: 0, tokens: 0, reviewTokens: 0, usd: 0, usdKnown: true, violations: 0, minutes: 0 });
		g.rounds++; g.changes.add(r.change);
		g.outcomes[r.outcome ?? "open"] = (g.outcomes[r.outcome ?? "open"] ?? 0) + 1;
		if (r.outcome === "accepted") g.merged.add(r.change);
		if (r.findings != null) { g.findings += r.findings; g.reviews++; }
		for (const f of ["continues", "recoveredAlone", "reminders", "errorTurns", "toolErrors", "turns", "tokens", "violations"]) g[f] += r[f] ?? 0;
		g.reviewTokens += r.reviewTokens ?? 0;
		g.reviewTurns = (g.reviewTurns ?? 0) + (r.reviewTurns ?? 0);
		g.minutes += r.workerMinutes ?? 0;
		const pw = priceOf(r.model), pr = priceOf(r.reviewModel);
		if (r.tokens) { if (pw != null) g.usd += (r.tokens / 1e6) * pw; else g.usdKnown = false; }
		if (r.reviewTokens) { if (pr != null) g.usd += (r.reviewTokens / 1e6) * pr; else g.usdKnown = false; }
	}
	// first pass: the change's FIRST worker report was accepted
	const firstByChange = {};
	for (const r of [...rounds].sort((a, b) => String(a.report).localeCompare(String(b.report)))) if (!(r.change in firstByChange) && r.outcome !== "stalled") firstByChange[r.change] = r;
	for (const r of Object.values(firstByChange)) { const g = by[r.model ?? "unknown"]; if (!g) continue; g.firstReports++; if (r.outcome === "accepted" || (r.outcome === "qualified")) g.firstPass++; }
	return Object.values(by).map((g) => ({
		model: g.model, rounds: g.rounds, changes: g.changes.size, merged: g.merged.size, outcomes: g.outcomes,
		firstPassPct: g.firstReports ? Math.round((100 * g.firstPass) / g.firstReports) : null,
		reportsPerMerged: g.merged.size ? Math.round((10 * (g.rounds)) / g.merged.size) / 10 : null,
		findingsPerReview: g.reviews ? Math.round((10 * g.findings) / g.reviews) / 10 : null,
		continuesPerRound: Math.round((10 * g.continues) / g.rounds) / 10,
		recoveredAlonePerRound: Math.round((10 * g.recoveredAlone) / g.rounds) / 10,
		remindersPerRound: Math.round((10 * g.reminders) / g.rounds) / 10,
		errorTurnsPer100: g.turns ? Math.round((1000 * g.errorTurns) / g.turns) / 10 : null,
		toolErrorsPer100: g.turns ? Math.round((1000 * g.toolErrors) / g.turns) / 10 : null,
		violationsPer100: g.turns ? Math.round((1000 * g.violations) / g.turns) / 10 : null,
		tokensPerRound: Math.round(g.tokens / g.rounds),
		reviewTokensPerRound: Math.round(g.reviewTokens / g.rounds),
		reviewTurnsPerRound: Math.round((10 * (g.reviewTurns ?? 0)) / g.rounds) / 10,
		usdPerMerged: g.merged.size && g.usd ? Math.round((1000 * g.usd) / g.merged.size) / 1000 : null,
		usdComplete: g.usdKnown,
		hoursPerRound: Math.round((10 * g.minutes) / 60 / g.rounds) / 10,
	})).sort((a, b) => b.rounds - a.rounds);
}

// ---------------------------------------------------------------------------
// glue
// ---------------------------------------------------------------------------
export async function computeOutcomes(repoRoot) {
	const { discoverTrees, readAllEntries } = await import("./handoff.mjs");
	const trees = discoverTrees(repoRoot);
	const byChange = readAllEntries(repoRoot, trees);
	const wtRoot = join(repoRoot, ".worktrees");
	const sessionDirs = [];
	const scan = (base) => { try { for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory() && !["handoff", "herdr-lifecycle", "routing", "qualify"].includes(d.name)) sessionDirs.push({ name: d.name, dir: join(base, d.name) }); } catch { /* none */ } };
	scan(join(repoRoot, ".pi-session"));
	try { for (const w of readdirSync(wtRoot)) scan(join(wtRoot, w, ".pi-session")); } catch { /* none */ }
	const integratorTurns = sessionDirs.filter((s) => /^integrator-/.test(s.name)).flatMap((s) => integratorEvents(s.dir).turns);
	const watcher = watcherEvents(join(repoRoot, ".pi-session", "herdr-lifecycle", "events.log"));
	const decisions = readLines(join(repoRoot, ".pi-session", "routing", "decisions.jsonl")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const reviewText = (file) => { if (!file) return null; for (const p of [join(repoRoot, file), file]) { try { return readFileSync(p, "utf8"); } catch { /* next */ } } return null; };
	const rounds = [];
	for (const [change, entries] of byChange) {
		const id = change.toLowerCase();
		const wdirs = sessionDirs.filter((s) => s.name.toLowerCase().includes(id));
		const worker = { turns: [], toolErrors: [] };
		const evidence = [];
		for (const s of wdirs) { const e = sessionEvents(s.dir); worker.turns.push(...e.turns); worker.toolErrors.push(...e.toolErrors); evidence.push(...evidenceEvents(s.dir)); }
		for (const r of roundsFromLedger(entries)) rounds.push(measureRound(r, { worker, evidence, watcher, integrator: { turns: integratorTurns }, decisions, review: countFindings(reviewText(r.reviewFile)) }));
	}
	// $ per model via real plan price
	let priceOf = () => null;
	try {
		const [{ loadPricing, priceFor, DEFAULT_PLANS }, { loadCatalog }, { catalogEntryFor }] = await Promise.all([import("./plan-pricing.mjs"), import("./route-worker.mjs"), import("./usage-meters.mjs")]);
		const pricing = loadPricing(repoRoot), catalog = loadCatalog(repoRoot);
		const plans = { ...DEFAULT_PLANS, ...(catalog.pricing_plans ?? {}) };
		priceOf = (model) => { if (!model) return null; const [prov, ...rest] = String(model).split("/"); const e = catalogEntryFor(catalog, prov, rest.join("/")); return e ? priceFor(e, pricing, plans)?.usd_per_mtok ?? null : null; };
	} catch { /* no prices */ }
	const out = { at: Date.now(), rounds, models: aggregate(rounds, priceOf) };
	try { const p = join(repoRoot, ".pi-session", "routing", "outcomes.json"); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(out, null, 1)); } catch { /* best effort */ }
	return out;
}
export function loadOutcomes(repoRoot) { try { return JSON.parse(readFileSync(join(repoRoot, ".pi-session", "routing", "outcomes.json"), "utf8")); } catch { return null; } }

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repoRoot = process.env.HARNESS_REPO_ROOT || (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return resolve(HERE, ".."); } })();
	const o = await computeOutcomes(repoRoot);
	if (argv.includes("--json")) { console.log(JSON.stringify(o, null, 2)); return 0; }
	if (argv.includes("--rounds")) {
		for (const r of o.rounds) console.log(`${r.change} ${String(r.report).slice(5, 16)} ${String(r.model ?? "?").padEnd(44)} ${String(r.reportVerdict).padEnd(19)} -> ${String(r.outcome ?? "open").padEnd(12)} turns ${String(r.turns).padStart(4)} cont ${r.continues} err ${r.errorTurns} toolErr ${r.toolErrors} find ${r.findings ?? "-"} review ${Math.round((r.reviewTokens ?? 0) / 1e3)}k`);
		return 0;
	}
	console.log(`${"worker model".padEnd(44)} rounds chg merged 1st-pass rep/merge find/rev cont/rnd err%  tool%  viol%  $/merged`);
	for (const g of o.models) console.log(`${g.model.slice(0, 43).padEnd(44)} ${String(g.rounds).padStart(6)} ${String(g.changes).padStart(3)} ${String(g.merged).padStart(6)} ${(g.firstPassPct != null ? g.firstPassPct + "%" : "-").padStart(8)} ${String(g.reportsPerMerged ?? "-").padStart(8)} ${String(g.findingsPerReview ?? "-").padStart(8)} ${String(g.continuesPerRound).padStart(8)} ${String(g.errorTurnsPer100 ?? "-").padStart(4)} ${String(g.toolErrorsPer100 ?? "-").padStart(6)} ${String(g.violationsPer100 ?? "-").padStart(6)} ${g.usdPerMerged != null ? "$" + g.usdPerMerged + (g.usdComplete ? "" : "+") : "-"}`);
	return 0;
}

async function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const E = (role, verdict, at, extra = {}) => ({ change: "CHANGE-0006", role, verdict, at: `2026-10-15T${at}:00.000Z`, ...extra });
	const led = [
		E("integrator", "plan-approved", "10:00"),
		E("worker", "impl-ready", "11:00"),
		E("integrator", "impl-changes-requested", "11:30", { file: "r1.md" }),
		E("worker", "impl-ready", "12:30"),
		E("runner", "qualified", "12:40"),
		E("integrator", "merged", "13:00", { file: "r2.md" }),
	];
	const rs = roundsFromLedger(led);
	ok(rs.length === 2 && rs[0].outcome === "changes" && rs[1].outcome === "accepted" && rs[1].qualified, `two rounds: changes requested, then accepted (got ${JSON.stringify(rs.map((r) => r.outcome))})`);
	ok(rs[1].start === led[2].at, "round 2 starts when the integrator sent the work back");
	const stall = roundsFromLedger([E("integrator", "plan-approved", "10:00"), E("worker", "blocked", "10:30"), E("integrator", "impl-changes-requested", "11:00"), E("worker", "impl-ready", "12:00"), E("integrator", "merged", "12:10")]);
	ok(stall[0].outcome === "stalled" && stall[1].outcome === "accepted", "a blocked report is its own (stalled) round");
	const md = "# Integrator review\n## Findings\n| ID | Severity | Finding | Required fix |\n|---|---|---|---|\n| F1 | High | a | b |\n| F2 | Low | c | d |\n\n## Verified\nx\n";
	const f = countFindings(md);
	ok(f.total === 2 && f.bySeverity.high === 1 && f.bySeverity.low === 1, `counts findings rows (got ${JSON.stringify(f)})`);
	ok(countFindings("## Findings\n| ID | Severity | Finding | Required fix |\n|---|---|---|---|\nnone\n").total === 0, "an empty table = 0 findings");
	const t = (hm) => Date.parse(`2026-10-15T${hm}:00.000Z`);
	const worker = { turns: [{ t: t("10:10"), model: "opencode-go/mimo-v2.6-flash", tokens: 1e6, error: false }, { t: t("10:20"), model: "opencode-go/mimo-v2.6-flash", tokens: 1e6, error: true }, { t: t("11:40"), model: "opencode-go/deepseek-v4.1-flash", tokens: 2e6, error: false }], toolErrors: [t("10:15")] };
	const evidence = [{ t: t("10:21"), ev: "disconnect_recovery_sent" }, { t: t("10:22"), ev: "disconnect_recovery_not_needed" }];
	const watcher = [{ t: t("10:30"), kind: "AUTO-CONTINUE", change: "CHANGE-0006" }, { t: t("10:40"), kind: "REMIND", change: "CHANGE-0006" }];
	{
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const d = mkdtempSync(join(tmpdir(), "mo-"));
		mkdirSync(join(d, "claude-projects", "-repo"), { recursive: true });
		const cl = (id, u) => JSON.stringify({ type: "assistant", timestamp: "2026-10-16T10:00:00Z", message: { id, model: "claude-opus-5-5", usage: u } });
		writeFileSync(join(d, "claude-projects", "-repo", "x.jsonl"), [cl("m1", { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 }), cl("m1", { input_tokens: 2, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 }),
			JSON.stringify({ type: "user", timestamp: "2026-10-16T10:01:00Z", message: { content: [{ type: "tool_result", is_error: true }] } })].join("\n"));
		mkdirSync(join(d, "antigravity-brain", "b", ".system_generated", "logs"), { recursive: true });
		writeFileSync(join(d, "antigravity-brain", "b", ".system_generated", "logs", "transcript.jsonl"), JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-10-16T10:02:00Z", input_tokens: "40", output_tokens: "10", cache_read_tokens: "0" }));
		mkdirSync(join(d, "subagent-artifacts"));
		writeFileSync(join(d, "subagent-artifacts", "r_review-heavy_0_transcript.jsonl"), JSON.stringify({ recordType: "message", role: "assistant", model: "gpt-6.1-sol", timestamp: "2026-10-16T10:03:00Z", usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } }));
		const ie = integratorEvents(d);
		ok(ie.turns.length === 3 && ie.turns.reduce((s, x) => s + x.tokens, 0) === 100 + 50 + 25 && ie.toolErrors.length === 1, "integrator turns from Claude Code (deduped), Antigravity and pi review subagents");
		rmSync(d, { recursive: true, force: true });
	}
	const integrator = { turns: [{ t: t("11:10"), model: "openrouter/nvidia/nemotron", tokens: 3e5 }, { t: t("11:20"), model: "openrouter/nvidia/nemotron", tokens: 2e5 }] };
	const m1 = measureRound(rs[0], { worker, evidence, watcher, integrator, review: f });
	ok(m1.model === "opencode-go/mimo-v2.6-flash" && m1.turns === 2 && m1.errorTurns === 1 && m1.toolErrors === 1 && m1.continues === 2 && m1.reminders === 1 && m1.recoveredAlone === 1, `round 1 worker side (got ${JSON.stringify(m1)})`);
	ok(m1.reviewTokens === 5e5 && m1.reviewModel === "openrouter/nvidia/nemotron" && m1.findings === 2, "round 1 review side: integrator tokens in the review window");
	const m2 = measureRound(rs[1], { worker, evidence, watcher, integrator, review: { total: 0 } });
	const agg = aggregate([m1, m2], (model) => (model?.includes("mimo") ? 0.001 : model?.includes("deepseek") ? 0.002 : model?.includes("nemotron") ? 0 : null));
	const mimo = agg.find((g) => g.model.includes("mimo")), ds = agg.find((g) => g.model.includes("deepseek"));
	ok(mimo.firstPassPct === 0 && mimo.findingsPerReview === 2 && mimo.continuesPerRound === 2 && ds.merged === 1, `per-model aggregate (got ${JSON.stringify(agg)})`);
	if (fails) { console.error(`${fails} model-outcomes self-test(s) FAILED`); return 1; }
	console.log("model-outcomes self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((c) => process.exit(c ?? 0), (e) => { console.error(e); process.exit(1); });
}
