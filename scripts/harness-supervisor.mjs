#!/usr/bin/env node
/**
 * harness-supervisor.mjs - the parts of the Herdr lifecycle watcher that keep work MOVING
 * without the owner having to ask (owner, 2026-10-18: "the integrator is too passive").
 *
 *   1. dependencies  depends_on in change.yaml: a worker is not launched (and a blocked
 *                    worker is parked) while a prerequisite is not merged; when the last
 *                    one merges the change is resumed automatically.
 *   2. sync          a worker that is blocked because its branch lacks main (its guard
 *                    forbids git merge) is synced by the harness (scripts/sync-worker.sh),
 *                    guards are regenerated, and the worker is told to continue.
 *   3. watchdog      a change that has not moved for watchdog.stall_minutes, or that failed
 *                    qualification twice in a row, is handed to the integrator with a
 *                    triage file (ledger, events, failing log tail) - it must act or decide.
 *   4. status        .pi-session/STATUS.md (+ status.json): one line per change - waiting
 *                    on whom, since when, last event, next step. Agents and the dashboard read it.
 *   5. digest        a short summary notification at pipeline.digest.hours (default 8, 20).
 *
 * Harness-written ledger entries use role "harness" (resume | stalled | repeated-failure),
 * so they flow through the normal pipeline.json routes and show up in the ledger like any
 * other handoff. Everything here is pure except the small I/O helpers at the bottom.
 *
 *   node scripts/harness-supervisor.mjs status      print the status table
 *   node scripts/harness-supervisor.mjs --selftest
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DONE_STATUSES = new Set(["complete", "completed", "merged", "done", "abandoned", "superseded", "cancelled", "canceled"]);
const TERMINAL_VERDICTS = new Set(["merged"]);
// who a verdict hands work to (mirrors pipeline.json; used for status + stall checks)
const NEXT_ROLE = {
	"plan-requested": "planner", "plan-ready": "integrator", "plan-changes-requested": "planner", "plan-approved": "worker",
	"impl-ready": "integrator", "impl-changes-requested": "worker", "needs-decision": "integrator", "needs-qualification": "runner",
	qualified: "requester", "qualification-failed": "worker", "needs-human": "human", question: "human", blocked: "integrator",
	resume: "worker", stalled: "integrator", "repeated-failure": "integrator", "merge-approved": "integrator", merged: null,
};
/** Who acts next on this entry. A planner's/integrator's own block or question is the owner's. */
export function nextRole(last) {
	if (!last) return "planner";
	if ((last.verdict === "blocked" || last.verdict === "question") && (last.role === "planner" || last.role === "integrator")) return "human";
	if (last.verdict === "question") return "human";
	if (last.verdict === "qualified") return last.requested_by ?? "integrator";
	return NEXT_ROLE[last.verdict] ?? "?";
}
export const DEFAULTS = { stall_minutes: 45, busy_stall_minutes: 40, check_minutes: 10, heartbeat_seconds: 120, triage_lines: 40 };

// ---------------------------------------------------------------------------
// change.yaml facts
// ---------------------------------------------------------------------------
/** depends_on: [A, B] or a block list. */
export function parseDependsOn(text) {
	const s = String(text ?? "");
	const inline = s.match(/^depends_on:\s*\[([^\]]*)\]/m);
	if (inline) return inline[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter((x) => /^CHANGE-\d+$/i.test(x)).map((x) => x.toUpperCase());
	const out = [];
	const m = s.match(/^depends_on:\s*(?:#.*)?\n((?:\s+-\s+.*\n?)+)/m);
	if (m) for (const l of m[1].split("\n")) { const v = l.match(/^\s+-\s+["']?(CHANGE-\d+)/i); if (v) out.push(v[1].toUpperCase()); }
	return out;
}
export function parseStatus(text) { return (String(text ?? "").match(/^status:\s*["']?([\w-]+)/m) || [])[1] ?? null; }
export function parseTitle(text) { const t = (String(text ?? "").match(/^title:\s*(.*)$/m) || [])[1]; return t == null ? null : t.replace(/\s+#.*$/, "").trim().replace(/^["'](.*)["']$/, "$1"); }

function changeYamlOnMain(repoRoot, id) {
	const dir = join(repoRoot, "docs", "changes");
	try {
		const d = readdirSync(dir).find((n) => n === id || n.startsWith(id + "-"));
		return d ? readFileSync(join(dir, d, "change.yaml"), "utf8") : null;
	} catch { return null; }
}

/** Is a prerequisite done? Merged in the ledger, or main's change.yaml says so. */
export function isDone(id, { byChange, yamlOf }) {
	// main's change.yaml decides when it has a status: the changes' own gates check `status: complete`,
	// so "merged in the ledger" alone resumed CHANGE-0022 too early (2026-10-20)
	const st = parseStatus(yamlOf(id));
	if (st) return DONE_STATUSES.has(st.toLowerCase());
	return (byChange.get(id) ?? []).some((e) => TERMINAL_VERDICTS.has(e.verdict));
}
export function pendingDeps(change, { byChange, yamlOf }) {
	const deps = parseDependsOn(yamlOf(change)).filter((d) => d !== change);
	// a dependency nobody has ever heard of (no folder, no ledger) cannot block forever
	return deps.filter((d) => (yamlOf(d) != null || byChange.has(d)) && !isDone(d, { byChange, yamlOf }));
}

// ---------------------------------------------------------------------------
// what a blocked worker needs
// ---------------------------------------------------------------------------
const DEP_RE = /\b(depends_on|prerequisite|not complete|still (?:status=)?approved|remain(?:s)? approved|exits 4|resume after)\b/i;
const SYNC_RE = /\b(sync|lacks main|behind main|merge main|main merged|forbids git merge|refuses git merge|relaunch .*sync)\b/i;
export function classifyBlock(note, { pending = [] } = {}) {
	if (pending.length && DEP_RE.test(note ?? "")) return "deps";
	if (SYNC_RE.test(note ?? "")) return "sync";
	if (pending.length) return "deps";
	return "other";
}

/**
 * What the harness itself should do for this change before normal routing. Pure.
 *   { action: "none" }
 *   { action: "park", deps }                         - do not launch / deliver; wait for deps
 *   { action: "resume", why, sync: true|false }      - deps done (or sync needed): sync + tell the worker
 *   { action: "sync", why }                          - blocked on a stale branch: sync + resume
 *   { action: "triage", kind, why }                  - hand the change to the integrator with facts
 */
export function superviseChange({ change, entries, cstate = {}, pending = [], now = Date.now(), cfg = DEFAULTS, workerBusy = false, targetBusy = false, workerQuiet = null }) {
	const last = entries[entries.length - 1];
	if (!last) return { action: "none" };
	const routed = (cstate.dispatched ?? []).includes(last.id);
	// 1) dependency gate: launching a worker, or a worker that is blocked
	const toWorker = last.verdict === "plan-approved" || (last.role === "worker" && last.verdict === "blocked");
	// (a blocked worker is parked even if its block was already routed - e.g. to the owner before this existed)
	if (toWorker && (!routed || last.verdict === "blocked") && pending.length && cstate.parked?.entry !== last.id) return { action: "park", deps: pending };
	if (toWorker && pending.length && cstate.parked?.entry === last.id) return { action: "park", deps: pending };
	if (cstate.parked && cstate.parked.entry === last.id && !pending.length) {
		return last.verdict === "plan-approved" ? { action: "unpark" } : { action: "resume", why: `prerequisites merged (${cstate.parked.deps.join(", ")})`, sync: true };
	}
	// 2) blocked on a stale branch -> the harness syncs it
	if (last.role === "worker" && last.verdict === "blocked" && !routed && classifyBlock(last.note) === "sync" && !(cstate.syncTried ?? []).includes(last.id)) {
		return { action: "sync", why: "worker is blocked on a branch that lacks main" };
	}
	// 3a) qualification failed twice in a row -> diagnose before another retry
	if (last.verdict === "qualification-failed" && !routed) {
		let n = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.role !== "runner") continue;
			if (e.verdict === "qualification-failed") n++; else break;
		}
		if (n >= 2) return { action: "triage", kind: "repeated-failure", why: `qualification failed ${n} times in a row` };
	}
	// 3c) the worker pane says "working" but nothing has happened (2026-10-20).
	// Herdr's busy flag cannot tell busy from stuck: an opencode request hung
	// 23:14-07:48 while the pane showed "working", and 3b skips busy panes.
	// workerQuiet comes from scripts/activity-probe.mjs (model output, session
	// logs, progress heartbeats of long tools, commits). A long render job that
	// still writes its heartbeat has workerQuiet.progress set and never trips this.
	if (routed && workerBusy && workerQuiet?.quiet_min != null && !workerQuiet.progress && !TERMINAL_VERDICTS.has(last.verdict) && nextRole(last) !== "human" && !cstate.parked && !cstate.waiting) {
		const lim = cfg.busy_stall_minutes ?? DEFAULTS.busy_stall_minutes;
		if (workerQuiet.quiet_min >= lim && cstate.triaged !== last.id) {
			const since = (now - Date.parse(last.at)) / 60000;
			if (last.role === "harness" && last.verdict === "stalled") {
				if (since >= lim) return { action: "escalate", why: `the worker is still silent ${Math.round(since)} min after the triage (${workerQuiet.summary})` };
			} else {
				return { action: "triage", kind: "stalled", why: `worker pane shows 'working' but ${workerQuiet.summary}` };
			}
		}
	}
	// 3b) nothing has moved for a while
	// (a change whose prerequisites are not merged is waiting, not stalled)
	if (routed && !pending.length && !TERMINAL_VERDICTS.has(last.verdict) && nextRole(last) !== "human" && !cstate.parked && !cstate.waiting && cstate.capped !== last.id) {
		const age = (now - Date.parse(last.at)) / 60000;
		if (age >= cfg.stall_minutes && !targetBusy && !workerBusy && cstate.triaged !== last.id) {
			if (last.role === "harness" && (last.verdict === "stalled" || last.verdict === "repeated-failure")) return { action: "escalate", why: `the integrator did not act on the triage for ${Math.round(age)} min` };
			return { action: "triage", kind: "stalled", why: `no progress for ${Math.round(age)} min (last: ${last.role} ${last.verdict})` };
		}
	}
	return { action: "none" };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${Math.round(m / 1440)}d`; };
export function phaseOf(last, cstate = {}, pending = []) {
	if (!last) return { phase: "new", waiting: "planner", next: "plan it" };
	if (last.verdict === "merged") return { phase: "done", waiting: null, next: "-" };
	if (cstate.parked || (pending.length && (last.verdict === "plan-approved" || last.verdict === "blocked"))) return { phase: "parked", waiting: `prerequisites ${pending.join(", ") || (cstate.parked?.deps ?? []).join(", ")}`, next: "resumes by itself when they merge" };
	if (cstate.capped && cstate.capped === last.id) return { phase: "needs you", waiting: "human", next: `round limit reached - review, then: node herdr-plugin/lifecycle-watcher.mjs --retry ${last.change ?? ""}` };
	if (cstate.waiting) return { phase: "waiting", waiting: "model quota", next: "launches by itself when the quota resets" };
	const to = nextRole(last);
	const phase = { planner: "planning", integrator: last.verdict === "impl-ready" ? "review" : last.verdict.startsWith("plan") ? "plan review" : "integrator", worker: "implementing", runner: "qualifying", human: "needs you" }[to] ?? to;
	const next = {
		"plan-ready": "integrator reviews the plan", "plan-changes-requested": "planner revises the plan", "plan-approved": "worker implements",
		"impl-ready": "integrator reviews the code", "impl-changes-requested": "worker fixes the findings", "needs-qualification": "Godot qualification runs",
		qualified: "requester checks the evidence", "qualification-failed": "worker fixes the failing job", blocked: "integrator unblocks it",
		"needs-decision": "integrator decides", "needs-human": "you", question: "you answer", resume: "worker continues", stalled: "integrator triages",
		"repeated-failure": "integrator diagnoses the failures", "merge-approved": "integrator merges", "plan-requested": "planner plans",
	}[last.verdict] ?? "-";
	return { phase, waiting: to, next };
}

export function buildStatus({ byChange, state = {}, yamlOf, panes = [], now = Date.now() }) {
	const rows = [];
	for (const [change, entries] of byChange) {
		const last = entries[entries.length - 1];
		const cstate = state.changes?.[change] ?? {};
		const pending = last && last.verdict !== "merged" ? pendingDeps(change, { byChange, yamlOf }) : [];
		const p = phaseOf(last, cstate, pending);
		const working = panes.filter((x) => x.agent_status === "working" && (x.change === change || (x.role !== "worker" && p.waiting === x.role))).map((x) => x.role);
		rows.push({ change, title: parseTitle(yamlOf(change)) ?? "", ...p, since: last?.at ?? null, age: last ? ago(now - Date.parse(last.at)) : "", last: last ? `${last.role} ${last.verdict}${last.note ? ": " + last.note.slice(0, 90) : ""}` : "", working: working.length ? working.join("+") + " working" : "" });
	}
	const order = { "needs you": 0, review: 1, "plan review": 1, integrator: 1, implementing: 2, qualifying: 2, planning: 3, waiting: 4, parked: 5, done: 9 };
	rows.sort((a, b) => (order[a.phase] ?? 6) - (order[b.phase] ?? 6) || String(a.change).localeCompare(b.change));
	const active = rows.filter((r) => r.phase !== "done");
	const recent = rows.filter((r) => r.phase === "done" && now - Date.parse(r.since) < 3 * 86400e3);
	const md = [
		"# Harness status", "",
		`Written by the Herdr lifecycle watcher at ${new Date(now).toISOString()} - read this instead of asking for a status.`, "",
		"| change | phase | waiting on | for | next step | last event |", "|---|---|---|---|---|---|",
		...active.map((r) => `| ${r.change} ${r.title ? "- " + r.title.slice(0, 40) : ""} | ${r.phase}${r.working ? " (" + r.working + ")" : ""} | ${r.waiting ?? "-"} | ${r.age} | ${r.next} | ${r.last.replace(/\|/g, "/")} |`),
		"", recent.length ? "Merged in the last 3 days: " + recent.map((r) => r.change).join(", ") : "", "",
	];
	return { rows, active, md: md.join("\n") };
}

export function digestText(status) {
	const c = (ph) => status.active.filter((r) => r.phase === ph).length;
	const needs = status.active.filter((r) => r.phase === "needs you").map((r) => r.change);
	const moving = status.active.filter((r) => ["review", "plan review", "integrator", "implementing", "qualifying", "planning"].includes(r.phase)).length;
	return `${moving} moving, ${c("parked")} parked on prerequisites, ${c("waiting")} waiting for quota${needs.length ? `; needs you: ${needs.join(", ")}` : "; nothing needs you"}. Details: .pi-session/STATUS.md`;
}

/** Is a digest due? Hours in local time; once per configured hour. */
export function digestDue(lastAt, hours = [8, 20], now = new Date()) {
	const today = new Date(now); today.setMinutes(0, 0, 0);
	for (const h of [...hours].sort((a, b) => b - a)) {
		const slot = new Date(today); slot.setHours(h);
		if (slot > now) continue;
		return !lastAt || lastAt < slot.getTime();
	}
	// before the first slot today: compare with yesterday's last slot
	const y = new Date(today); y.setDate(y.getDate() - 1); y.setHours(Math.max(...hours));
	return !lastAt || lastAt < y.getTime();
}

// ---------------------------------------------------------------------------
// triage file
// ---------------------------------------------------------------------------
export function triageMarkdown({ change, kind, why, entries, events = [], qualifyTail = null, statusLine = null }) {
	const L = [`# Triage - ${change} (${kind})`, "", `Why you are getting this: ${why}.`, ""];
	if (statusLine) L.push(`Status: ${statusLine}`, "");
	L.push("## Last ledger entries", "", ...entries.slice(-8).map((e) => `- ${e.at.slice(5, 16).replace("T", " ")} ${e.role} **${e.verdict}**${e.note ? ` - ${e.note}` : ""}${e.file ? ` (${e.file})` : ""}`), "");
	if (events.length) L.push("## Watcher events for this change", "", "```", ...events.slice(-15), "```", "");
	if (qualifyTail) L.push("## Latest qualification summary (tail)", "", "```", qualifyTail, "```", "");
	L.push("## What to do now", "",
		kind === "repeated-failure"
			? "The same qualification failed twice. Do NOT send the worker another blind retry. Read the failing job's log and evidence above, find the cause (test harness, environment, timing, or real defect), write it down in a review, then: impl-changes-requested with the diagnosed fix, or needs-qualification if it was a host problem, or needs-human if you cannot tell."
			: "Nothing has moved. Find out why (is a pane dead or waiting on an approval? a missing grant, sync, or decision? a stale lock?) and fix what you can yourself: sync/regenerate guards, grant paths, re-request qualification, relaunch the worker (impl-changes-requested with the instruction), re-plan (plan-requested), or decide (needs-decision is yours). Report a verdict when done.",
		"", "\"Waiting\" is only an answer if you name what you are waiting for and record it with --verdict blocked --note '<what, and who acts>'. Escalate with needs-human only for what only the owner can decide.", "");
	return L.join("\n");
}

// ---------------------------------------------------------------------------
// usage / session limits -> move the work to another agent (owner, 2026-10-18)
// ---------------------------------------------------------------------------
const USAGE_LIMIT_RE = /((5|five)[- ]hour|usage|weekly|daily|monthly|plan|session) limit (reached|hit|exceeded)|you('ve| have) (hit|reached) your (usage |session |weekly |5-hour )?limit|limit (will )?resets? (at|in)|out of (credits|usage)|quota (exceeded|exhausted)|insufficient_quota|RESOURCE_EXHAUSTED|credit balance is too low/i;
const CONTEXT_LIMIT_RE = /context (window|length|limit) (exceeded|is full|reached)|prompt is too long|conversation is too long|maximum context length|session (is )?too long|compaction failed/i;
/** Does the bottom of a pane show that the agent stopped on a limit? Pure. */
export function detectLimit(tail, now = Date.now()) {
	const lines = String(tail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	const bottom = lines.slice(-8).join("\n");
	const kind = USAGE_LIMIT_RE.test(bottom) ? "usage limit" : CONTEXT_LIMIT_RE.test(bottom) ? "session limit" : null;
	if (!kind) return null;
	let until = null;
	const inH = bottom.match(/resets? in (\d+)\s*(h|hour|hours|m|min|minutes)\b/i);
	if (inH) until = now + Number(inH[1]) * (/^h/i.test(inH[2]) ? 3600e3 : 60e3);
	const at = bottom.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
	if (!until && at) {
		let h = Number(at[1]) % 12 + (/pm/i.test(at[3] ?? "") ? 12 : 0); if (!at[3] && Number(at[1]) >= 12) h = Number(at[1]);
		const d = new Date(now); d.setHours(h, Number(at[2] ?? 0), 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1);
		until = d.getTime();
	}
	if (!until && kind === "usage limit") until = now + (/(5|five)[- ]hour/i.test(bottom) ? 5 : /weekly/i.test(bottom) ? 48 : 3) * 3600e3;
	return { kind, until, sig: bottom.slice(-300), line: lines[lines.length - 1]?.slice(0, 160) ?? "" };
}
// Server-side failures (OpenCode's "Internal Server Error", HTTP 500, provider API errors):
// transient once, an outage when they keep coming back. Pure.
const PROVIDER_ERROR_RE = /internal server error|InternalServerError|\b500\b[^\n]{0,40}(error|status|server)|\bserver_error\b|"type":\s*"api_error"|APIError|provider (returned|error)|upstream (error|connect)|bad response from (the )?(server|provider)/i;
export function detectProviderError(tail) {
	const lines = String(tail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	const bottom = lines.slice(-8).join("\n");
	if (!PROVIDER_ERROR_RE.test(bottom)) return null;
	const hit = lines.slice(-8).reverse().find((l) => PROVIDER_ERROR_RE.test(l)) ?? "";
	return { kind: "provider error", sig: bottom.slice(-300), line: hit.slice(0, 160) };
}
/** Count provider errors per pane; persistent = threshold distinct errors within windowMin. Pure. */
export function providerErrorPersists(history = [], sig, { now = Date.now(), threshold = 3, windowMin = 30 } = {}) {
	const recent = history.filter((h) => now - h.t < windowMin * 60e3);
	const next = recent.length && recent[recent.length - 1].sig === sig ? recent : [...recent, { t: now, sig }];
	return { persists: next.length >= threshold, history: next.slice(-10), count: next.length };
}

/**
 * Is the integrator ignoring its handoffs? Work was handed to it (awaiting.since), its pane sits
 * idle, and its session log has not moved since the OLDEST pending handoff + minutes. Pure.
 */
export function integratorUnresponsive({ awaits = [], lastActivity = null, paneIdle = false, now = Date.now(), minutes = 10, lastRestart = 0, cooldownMin = 30 }) {
	if (!awaits.length || !paneIdle) return null;
	if (now - lastRestart < cooldownMin * 60e3) return null;
	const oldest = Math.min(...awaits.map((a) => Date.parse(a.since)).filter(Number.isFinite));
	if (!Number.isFinite(oldest) || now - oldest < minutes * 60e3) return null;
	if (lastActivity && lastActivity > oldest) return null;
	return { since: oldest, changes: awaits.map((a) => a.change), why: `no activity in its session since ${Math.round((now - oldest) / 60000)} min ago, with ${awaits.length} handoff(s) waiting` };
}

// ---------------------------------------------------------------------------
// fresh session or continue? (owner 2026-10-20: "it might depend")
// ---------------------------------------------------------------------------
/** Context use and compactions from the tail of any agent's session log. Pure on the lines. */
export function sessionHealthFromLines(lines, defaultWindow = 200000) {
	let ctx = null, window = null, compactions = 0;
	for (const l of lines) {
		if (/"type":"compaction"|compact_boundary|"type":"compacted"|"subtype":"compact/.test(l)) compactions++;
		if (!/usage|token_count|input_tokens|"input"/.test(l)) continue;
		let o; try { o = JSON.parse(l); } catch { continue; }
		const u = o.message?.usage ?? o.usage;
		if (u && (u.input != null || u.input_tokens != null)) {
			const t = (u.input ?? u.input_tokens ?? 0) + (u.cacheRead ?? u.cache_read_input_tokens ?? 0) + (u.cacheWrite ?? u.cache_creation_input_tokens ?? 0);
			if (t > 0) ctx = t;
		}
		const info = o.payload?.type === "token_count" ? o.payload.info : null;
		if (info?.last_token_usage) { ctx = (info.last_token_usage.input_tokens ?? 0) + (info.last_token_usage.cached_input_tokens ?? 0) || ctx; if (info.model_context_window) window = info.model_context_window; }
		if (o.type === "PLANNER_RESPONSE" && o.input_tokens) ctx = Number(o.input_tokens);
	}
	// a session already past the default window runs a 1M-context model (Claude Opus/Sonnet 1M)
	const win = window ?? (ctx && ctx > defaultWindow ? 1000000 : defaultWindow);
	return { ctxTokens: ctx, window: win, ctxPct: ctx ? Math.round((100 * ctx) / win) : null, compactions };
}
export function sessionHealth(logPath, defaultWindow) {
	if (!logPath) return null;
	try { return sessionHealthFromLines(readFileSync(logPath, "utf8").split("\n").slice(-4000), defaultWindow); } catch { return null; }
}
/**
 * Continue the worker's session, or start a fresh one with a handoff brief? Pure.
 * Fresh when the session is heavy (context >= maxCtxPct of the window, or compacted twice), when
 * the integrator asks for a re-plan/diagnosis/redesign, or after two rounds of the same failure.
 */
export function freshOrContinue({ entries = [], health = null, cfg = {}, idleMin = null, backend = null }) {
	// a pause longer than the agent's prompt-cache lifetime means the old context is re-read at full
	// price anyway: then a heavy-ish session is cheaper to restart (owner 2026-10-20)
	const ttl = (cfg.cache_ttl_minutes ?? { claude: 5, pi: 5, antigravity: 30, codex: 30, opencode: 30 })[backend] ?? 10;
	const cold = idleMin != null && idleMin > ttl;
	const max = cold ? (cfg.cold_context_pct ?? 35) : (cfg.max_context_pct ?? 60), maxComp = cfg.max_compactions ?? 2, sameMax = cfg.same_failure_rounds ?? 2;
	const last = entries[entries.length - 1];
	if (!last || !["impl-changes-requested", "qualification-failed"].includes(last.verdict)) return { fresh: false, why: "" };
	if (health?.ctxPct != null && health.ctxPct >= max) return { fresh: true, why: `the session uses ${health.ctxPct}% of its context window${cold ? ` and its prompt cache has expired (idle ${Math.round(idleMin)} min)` : ""}` };
	if (health && health.compactions >= maxComp) return { fresh: true, why: `the session has been compacted ${health.compactions} times` };
	if (/\b(re-?plan|diagnos\w*|start (over|fresh)|redesign|rewrite|different approach)\b/i.test(last.note ?? "")) return { fresh: true, why: "the integrator asks for a new approach" };
	let n = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.role === "worker" && (e.verdict === "blocked" || e.verdict === "needs-decision")) break;
		if (e.verdict === last.verdict) n++;
		else if (e.role === "integrator" && e.verdict === "merged") break;
	}
	if (n >= sameMax) return { fresh: true, why: `${n} rounds of ${last.verdict} in a row` };
	return { fresh: false, why: health?.ctxPct != null ? `session is fine (${health.ctxPct}% context, ${health.compactions} compactions)` : "continue" };
}

/** Herdr agent name -> harness backend. */
export function backendOfAgent(agent) {
	const a = String(agent ?? "").toLowerCase();
	return a.includes("claude") ? "claude" : a.includes("codex") ? "codex" : a.includes("antigravity") || a === "agy" || a.includes("gemini") ? "antigravity" : a.includes("opencode") ? "opencode" : a.includes("pi") ? "pi" : null;
}
const limitsPath = (repoRoot) => join(repoRoot, ".pi-session", "routing", "limits.json");
export function loadLimits(repoRoot, now = Date.now()) {
	try { return JSON.parse(readFileSync(limitsPath(repoRoot), "utf8")).filter((l) => !l.until || l.until > now); } catch { return []; }
}
export function recordLimit(repoRoot, lim) {
	const all = [...loadLimits(repoRoot).filter((l) => !(l.backend === lim.backend && (l.model ?? null) === (lim.model ?? null))), { ...lim, at: Date.now() }];
	mkdirSync(dirname(limitsPath(repoRoot)), { recursive: true });
	writeFileSync(limitsPath(repoRoot), JSON.stringify(all, null, 1));
	return all;
}
/** A backend is out when a limit names it without a model (claude/codex/antigravity: one subscription). */
export function limitedBackends(limits) { return new Set(limits.filter((l) => !l.model).map((l) => l.backend)); }
/** Next backend for a non-routed role (integrator/planner) after its agent hit a limit. */
export function pickFallbackBackend(current, { order = ["codex", "claude", "pi", "antigravity", "opencode"], allowed = null, limits = [] } = {}) {
	const out = limitedBackends(limits);
	return order.find((b) => b !== current && !out.has(b) && (!allowed || allowed.includes(b))) ?? null;
}

// ---------------------------------------------------------------------------
// subscription windows (5h / weekly): track resets, show capacity, decide wait-or-move
// ---------------------------------------------------------------------------
export const AGENT_WINDOWS = {
	claude: { name: "Claude", five: "claude_5h", week: "claude_weekly" },
	codex: { name: "Codex", five: "codex_5h", week: "codex_weekly" },
	antigravity: { name: "Gemini/Antigravity", five: "gemini_5h", week: "gemini_weekly" },
	opencode: { name: "OpenCode Go", five: "opencodego_5h", week: "opencodego_weekly" },
};
const STALE_MIN = 30;
/** Capacity per agent from the usage snapshot + recorded limits. Pure. */
export function capacity(usage = {}, limits = [], now = Date.now()) {
	const q = usage.quotas ?? {};
	const st = (x) => {
		if (!x) return null;
		const reset = x.resetsAt && x.resetsAt < now;
		return { usedPct: reset ? 0 : x.usedPct ?? null, resetsAt: reset ? null : x.resetsAt ?? null, ageMin: x.t ? Math.round((now - x.t) / 60000) : null, reset };
	};
	return Object.entries(AGENT_WINDOWS).map(([agent, w]) => {
		const five = st(q[w.five]), week = st(q[w.week]);
		const lim = limits.find((l) => l.backend === agent && !l.model && (!l.until || l.until > now));
		const used = Math.max(five?.usedPct ?? 0, week?.usedPct ?? 0);
		const stale = !five || five.ageMin == null || five.ageMin > STALE_MIN;
		const state = lim ? "limited" : (five?.usedPct ?? 0) >= 95 || (week?.usedPct ?? 0) >= 95 ? "spent" : used >= 85 ? "low" : stale && !five?.reset ? "unknown" : "open";
		return { agent, name: w.name, five, week, limitUntil: lim?.until ?? null, state, stale };
	});
}
/** Windows that came back since the last pass (a reset passed, or a recorded limit expired). Pure. */
export function windowResets(prev = {}, caps, now = Date.now()) {
	const events = [], next = {};
	for (const c of caps) {
		const was = prev[c.agent];
		const blocked = c.state === "limited" || c.state === "spent";
		next[c.agent] = { blocked, until: c.limitUntil ?? c.five?.resetsAt ?? null };
		if (was?.blocked && !blocked) events.push({ agent: c.agent, name: c.name });
		else if (was?.blocked && was.until && was.until <= now && blocked && c.stale) events.push({ agent: c.agent, name: c.name, assumed: true });
	}
	return { events, next };
}
export function capacityMarkdown(caps, now = Date.now(), projections = {}) {
	const t = (ms) => ms ? new Date(ms).toTimeString().slice(0, 5) : "-";
	const pct = (w) => w?.usedPct == null ? "?" : `${Math.round(w.usedPct)}%`;
	return ["## Agent capacity", "", "| agent | state | 5h used | 5h resets | weekly used | pace | data age |", "|---|---|---|---|---|---|---|",
		...caps.map((c) => { const pl = paceLevel(c, projections, now); return `| ${c.name} | ${c.state}${c.limitUntil ? " until " + t(c.limitUntil) : ""} | ${pct(c.five)} | ${t(c.five?.resetsAt)} | ${pct(c.week)} | ${pl.level === "none" ? "ok" : pl.level + ": " + pl.why} | ${c.five?.ageMin != null ? c.five.ageMin + " min" : "no data"} |`; }), ""].join("\n");
}
/**
 * A worker's agent hit its usage limit: move the change now, or wait for the reset?
 * Move by default. Wait only for demanding work (high risk, XL, visual) when the reset is near
 * and the best other agent would be weaker than what the change was routed to. Pure.
 */
export function waitOrMove({ facts = {}, until = null, now = Date.now(), alternative = null, routedTier = null, waitMinutes = 90 }) {
	const demanding = facts.risk === "high" || facts.size === "XL" || facts.visual === true;
	const soon = until && until - now <= waitMinutes * 60e3;
	if (!alternative) return until ? { action: "wait", why: "no other agent can take it" } : { action: "human", why: "no other agent and no reset time" };
	if (demanding && soon && routedTier != null && (alternative.tier ?? 0) < routedTier) return { action: "wait", why: `demanding change, the reset is ${Math.round((until - now) / 60000)} min away and the other agents are weaker` };
	return { action: "move", why: demanding ? "the reset is too far away" : "another agent can take it" };
}

// ---------------------------------------------------------------------------
// handoff brief: what the stopped session was doing, for the agent that takes over
// ---------------------------------------------------------------------------
const PATH_KEYS = ["path", "file_path", "filePath", "AbsolutePath", "TargetFile", "file"];
/** Normalised events from any agent's session log line (pi, Claude Code, Codex, Antigravity). Pure. */
export function sessionLineEvents(o) {
	const out = [];
	const t = o.timestamp ?? o.created_at ?? o.at ?? null;
	const msg = o.message ?? (o.payload?.type === "message" ? o.payload : null) ?? o;
	const role = msg.role ?? (o.type === "assistant" || o.type === "user" ? o.type : o.source === "MODEL" ? "assistant" : o.source === "USER_EXPLICIT" ? "user" : null);
	const parts = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
	for (const c of parts) {
		if ((c.type === "text" || c.type === "output_text" || c.type === "input_text") && c.text && role) out.push({ t, kind: role === "assistant" ? "said" : role === "user" ? "asked" : null, text: c.text });
		if (c.type === "toolCall" || c.type === "tool_use" || c.type === "function_call") {
			const args = c.arguments ?? c.input ?? (typeof c.arguments === "string" ? JSON.parse(c.arguments) : {}) ?? {};
			const a = typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : args;
			const file = PATH_KEYS.map((k) => a?.[k]).find((x) => typeof x === "string");
			out.push({ t, kind: "tool", name: c.name, file, cmd: typeof a?.command === "string" ? a.command : null });
		}
		if ((c.type === "tool_result" && c.is_error) || (msg.role === "toolResult" && msg.isError)) out.push({ t, kind: "error", text: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? c.text ?? "").slice(0, 300) });
	}
	if (msg.role === "toolResult" && msg.isError && !parts.length) out.push({ t, kind: "error", text: String(msg.content ?? "").slice(0, 300) });
	if (o.tool_calls && typeof o.tool_calls !== "string") for (const c of o.tool_calls) out.push({ t, kind: "tool", name: c.name, file: PATH_KEYS.map((k) => c.args?.[k]).find((x) => typeof x === "string") });
	return out.filter((e) => e.kind);
}
/** Markdown brief from the tail of a session log + git state. Pure. */
export function briefMarkdown({ change, agent, why, events = [], git = {} }) {
	const said = events.filter((e) => e.kind === "said" && e.text.trim().length > 20).slice(-3);
	const asked = events.filter((e) => e.kind === "asked").slice(-1);
	const files = [...new Set(events.filter((e) => e.kind === "tool" && e.file).map((e) => e.file))].slice(-15);
	const cmds = events.filter((e) => e.kind === "tool" && e.cmd).slice(-6).map((e) => e.cmd.slice(0, 160));
	const errs = events.filter((e) => e.kind === "error").slice(-3);
	const clip = (x, n) => String(x).replace(/\s+/g, " ").trim().slice(0, n);
	return [`# Handoff brief - ${change}`, "", `The previous session (${agent}) stopped: ${why}. You continue its work. This brief is written by the harness from that session's log - check it against the repository before you act on it.`, "",
		"## What it was asked last", "", ...(asked.length ? asked.map((e) => "> " + clip(e.text, 700)) : ["(not found)"]), "",
		"## What it said last (newest last)", "", ...(said.length ? said.map((e) => "- " + clip(e.text, 600)) : ["(nothing found)"]), "",
		"## Files it touched", "", ...(files.length ? files.map((f) => "- " + f) : ["(none recorded)"]), "",
		"## Last commands", "", ...(cmds.length ? ["```", ...cmds, "```"] : ["(none recorded)"]), "",
		...(errs.length ? ["## Last errors", "", ...errs.map((e) => "- " + clip(e.text, 300)), ""] : []),
		"## Repository state", "", "```", `branch: ${git.branch ?? "?"}`, `last commits:\n${git.log ?? "?"}`, `uncommitted:\n${git.status || "(clean)"}`, "```", "",
		"First: read the newest integrator review and your last worker handoff in the change folder, run git status, then continue from where the session stopped. Do not redo committed work.", ""].join("\n");
}
/** Newest session log under a worktree's .pi-session (any agent). */
export function newestSessionLog(dir) {
	let best = null;
	const walk = (d, depth) => {
		let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of es) {
			const p = join(d, e.name);
			if (e.isDirectory()) { if (depth > 0 && !["handoff", "tool-results", "chunks", "subagent-artifacts", "triage", "qualify"].includes(e.name)) walk(p, depth - 1); }
			else if (/\.jsonl$/.test(e.name) && !/^(evidence|events|decisions)/.test(e.name)) { try { const m = statSync(p).mtimeMs; if (!best || m > best.m) best = { p, m }; } catch { /* */ } }
		}
	};
	walk(dir, 6);
	return best?.p ?? null;
}
export function writeHandoffBrief(repoRoot, { change, agent, why, worktree }) {
	const log = worktree ? newestSessionLog(join(worktree, ".pi-session")) : null;
	let events = [];
	if (log) {
		const lines = readFileSync(log, "utf8").split("\n").slice(-600);
		for (const l of lines) { try { events.push(...sessionLineEvents(JSON.parse(l))); } catch { /* torn */ } }
	}
	const git = {};
	const g = (...a) => { const r = spawnSync("git", a, { cwd: worktree ?? repoRoot, encoding: "utf8", timeout: 10000 }); return r.status === 0 ? r.stdout.trim() : null; };
	git.branch = g("symbolic-ref", "--short", "HEAD"); git.log = g("log", "--oneline", "-5"); git.status = g("status", "--short");
	const dir = join(repoRoot, ".pi-session", "briefs");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, `${change}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}.md`);
	writeFileSync(p, briefMarkdown({ change, agent, why, events, git }));
	return { file: relative(repoRoot, p), log: log ? relative(repoRoot, log) : null, events: events.length };
}

// ---------------------------------------------------------------------------
// pace: how fast a window is being used (from the usage history projections)
// ---------------------------------------------------------------------------
/** none | warning | high | critical for one agent, from projections + capacity. Pure. */
export function paceLevel(cap, projections = {}, now = Date.now()) {
	const w = AGENT_WINDOWS[cap.agent];
	let level = "none", why = "";
	for (const key of [w.five, w.week]) {
		const p = projections[key];
		if (!p?.beforeReset || !p.runOutAt) continue;
		const mins = (p.runOutAt - now) / 60000;
		const l = mins <= 30 ? "critical" : mins <= 90 ? "high" : "warning";
		const rank = { none: 0, warning: 1, high: 2, critical: 3 };
		if (rank[l] > rank[level]) { level = l; why = `${key} runs out in ${mins < 90 ? Math.max(0, Math.round(mins)) + " min" : (mins / 60).toFixed(1) + " h"} at the current pace, before it resets`; }
	}
	return { level, why };
}

// ---------------------------------------------------------------------------
// I/O helpers (used by the watcher)
// ---------------------------------------------------------------------------
export const yamlReader = (repoRoot) => { const c = new Map(); return (id) => { if (!c.has(id)) c.set(id, changeYamlOnMain(repoRoot, id)); return c.get(id); }; };

/** Sync the change's worker worktree with main and regenerate its guards. */
export function syncWorker(repoRoot, change) {
	const r = spawnSync("bash", [join(repoRoot, "scripts", "sync-worker.sh"), change], { cwd: repoRoot, encoding: "utf8", timeout: 180000 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	return { ok: r.status === 0, out: out.split("\n").slice(-6).join(" | ").slice(0, 400), head: (out.match(/^HEAD (\w+)/m) || [])[1] ?? null };
}

export function latestQualifyTail(repoRoot, change, lines = 40) {
	const base = join(repoRoot, ".pi-session", "qualify");
	let best = null;
	const walk = (d, depth) => {
		let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) {
			const p = join(d, e.name);
			if (e.isDirectory() && depth < 4) walk(p, depth + 1);
			else if (e.name === "summary.md" && p.includes(change)) { const t = statSync(p).mtimeMs; if (!best || t > best.t) best = { p, t }; }
		}
	};
	walk(base, 0);
	if (!best) return null;
	return `${relative(repoRoot, best.p)}\n` + readFileSync(best.p, "utf8").split("\n").slice(-lines).join("\n");
}

export function eventsFor(repoRoot, change, n = 15) {
	try {
		const lines = readFileSync(join(repoRoot, ".pi-session", "herdr-lifecycle", "events.log"), "utf8").split("\n");
		return lines.filter((l) => l.includes(change)).slice(-n).map((l) => l.slice(0, 260));
	} catch { return []; }
}

export function writeTriage(repoRoot, change, md) {
	const dir = join(repoRoot, ".pi-session", "triage");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, `${change}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}.md`);
	writeFileSync(p, md);
	return relative(repoRoot, p);
}

export function writeStatus(repoRoot, status, capsMd = "") {
	const dir = join(repoRoot, ".pi-session");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "STATUS.md"), status.md + (capsMd ? "\n" + capsMd : ""));
	writeFileSync(join(dir, "status.json"), JSON.stringify({ at: new Date().toISOString(), rows: status.rows }, null, 1));
}

// ---------------------------------------------------------------------------
// CLI + self-test
// ---------------------------------------------------------------------------
async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repoRoot = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
	if (argv[0] === "status") {
		const { readAllEntries, discoverTrees, readJson, statePath } = await import("./handoff.mjs");
		const st = buildStatus({ byChange: readAllEntries(repoRoot, discoverTrees(repoRoot)), state: readJson(statePath(repoRoot), {}), yamlOf: yamlReader(repoRoot) });
		console.log(st.md);
		console.log(digestText(st));
		return 0;
	}
	console.error("usage: harness-supervisor.mjs status | --selftest");
	return 2;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	ok(parseDependsOn("id: X\ndepends_on: [CHANGE-0003, CHANGE-0006]\n").join() === "CHANGE-0003,CHANGE-0006", "inline depends_on");
	ok(parseDependsOn("depends_on:\n  - CHANGE-0001\n  - \"CHANGE-0002\"\nrisk:\n").join() === "CHANGE-0001,CHANGE-0002", "block depends_on");
	ok(parseDependsOn("depends_on: []\n").length === 0, "empty depends_on");
	const yamls = { "CHANGE-0001": "status: complete\n", "CHANGE-0002": "status: approved\n", "CHANGE-0003": "status: approved\ndepends_on: [CHANGE-0001, CHANGE-0002, CHANGE-0099]\n" };
	const yamlOf = (id) => yamls[id] ?? null;
	const E = (role, verdict, min, extra = {}) => ({ id: `${role}-${verdict}-${min}`, at: new Date(Date.UTC(2026, 9, 18, 6, min)).toISOString(), change: "CHANGE-0003", role, verdict, note: "", ...extra });
	let byChange = new Map([["CHANGE-0002", [E("integrator", "plan-approved", 0)]]]);
	ok(pendingDeps("CHANGE-0003", { byChange, yamlOf }).join() === "CHANGE-0002", "pending: approved dep; complete dep and unknown dep ignored");
	byChange.set("CHANGE-0002", [E("integrator", "merged", 1)]);
	ok(pendingDeps("CHANGE-0003", { byChange, yamlOf }).join() === "CHANGE-0002", "merged but change.yaml still approved -> not done yet (the gate checks status)");
	yamls["CHANGE-0002"] = "status: complete\n";
	ok(pendingDeps("CHANGE-0003", { byChange, yamlOf }).length === 0, "status complete on main -> done");
	yamls["CHANGE-0002"] = "status: approved\n";
	ok(classifyBlock("Gate exits 4: CHANGE-0006 and CHANGE-0012 still status=approved on main", { pending: ["CHANGE-0006"] }) === "deps", "dependency block");
	ok(classifyBlock("Branch lacks main a95f41c; worker guard forbids git merge. Integrator: sync branch") === "sync", "sync block");
	ok(classifyBlock("cannot find the save format spec") === "other", "other block");
	const now = Date.UTC(2026, 9, 18, 8, 0);
	// park / resume
	let entries = [E("integrator", "plan-approved", 0)];
	ok(superviseChange({ change: "CHANGE-0003", entries, pending: ["CHANGE-0002"], now }).action === "park", "plan approved with a pending dep -> park");
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { parked: { entry: entries[0].id, deps: ["CHANGE-0002"] } }, pending: [], now }).action === "unpark", "dep merged -> unpark (normal launch)");
	entries = [E("integrator", "plan-approved", 0), E("worker", "blocked", 5, { note: "Gate exits 4: CHANGE-0002 still approved" })];
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id] }, pending: ["CHANGE-0002"], now }).action === "park", "blocked on a dep -> park, not the integrator");
	const r = superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id], parked: { entry: entries[1].id, deps: ["CHANGE-0002"] } }, pending: [], now });
	ok(r.action === "resume" && r.sync, "parked blocked worker -> resume with sync");
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id, entries[1].id] }, pending: ["CHANGE-0002"], now }).action === "park", "an already-routed dependency block is parked too");
	ok(superviseChange({ change: "CHANGE-0003", entries: [E("planner", "blocked", 0)], cstate: { dispatched: ["planner-blocked-0"] }, now }).action === "none", "a planner's block is the owner's - not a stall");
	entries = [E("integrator", "impl-changes-requested", 0), E("worker", "blocked", 5, { note: "Branch lacks main a95f41c; worker guard forbids git merge" })];
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id] }, now }).action === "sync", "stale branch -> harness sync");
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id], syncTried: [entries[1].id] }, now }).action === "none", "sync tried once -> normal routing (integrator)");
	// repeated failure
	entries = [E("worker", "needs-qualification", 0), E("runner", "qualification-failed", 10), E("worker", "needs-qualification", 20), E("runner", "qualification-failed", 30)];
	ok(superviseChange({ change: "CHANGE-0003", entries, now }).action === "triage", "two qualification failures in a row -> triage");
	ok(superviseChange({ change: "CHANGE-0003", entries: entries.slice(0, 2), now }).action === "none", "one failure -> back to the worker as usual");
	// stall
	entries = [E("worker", "impl-ready", 0)];
	const cs = { dispatched: [entries[0].id] };
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: cs, now }).action === "triage", "routed 2h ago, nothing since, nobody working -> triage");
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: cs, now, targetBusy: true }).action === "none", "integrator still working -> not stalled");
	// busy but silent (hung model request) - 2026-10-20
	{
		const ent = [E("integrator", "impl-changes-requested", 0)];
		const c2 = { dispatched: [ent[0].id] };
		const quiet = (min, progress = null) => ({ quiet_min: min, progress, summary: `last activity ${min} min ago` });
		const t = superviseChange({ change: "CHANGE-0003", entries: ent, cstate: c2, now, workerBusy: true, workerQuiet: quiet(55) });
		ok(t.action === "triage" && t.kind === "stalled" && /shows 'working'/.test(t.why), "worker 'working' but silent 55 min -> triage");
		ok(superviseChange({ change: "CHANGE-0003", entries: ent, cstate: c2, now, workerBusy: true, workerQuiet: quiet(20) }).action === "none", "busy and active 20 min ago -> not stalled");
		ok(superviseChange({ change: "CHANGE-0003", entries: ent, cstate: c2, now, workerBusy: true, workerQuiet: quiet(55, { tool: "godot-remote" }) }).action === "none", "long render job with a live heartbeat -> not stalled");
		ok(superviseChange({ change: "CHANGE-0003", entries: ent, cstate: c2, now, workerBusy: true }).action === "none", "no probe data -> old behaviour (not stalled)");
		ok(superviseChange({ change: "CHANGE-0003", entries: ent, cstate: { ...c2, triaged: ent[0].id }, now, workerBusy: true, workerQuiet: quiet(90) }).action === "none", "already triaged -> no repeat");
		const h = [...ent, E("harness", "stalled", 70)];
		const c3 = { dispatched: [ent[0].id, h[1].id] };
		ok(superviseChange({ change: "CHANGE-0003", entries: h, cstate: c3, now: Date.UTC(2026, 9, 18, 6, 90), workerBusy: true, workerQuiet: quiet(90) }).action === "none", "triaged 20 min ago -> wait");
		ok(superviseChange({ change: "CHANGE-0003", entries: h, cstate: c3, now: Date.UTC(2026, 9, 18, 6, 115), workerBusy: true, workerQuiet: quiet(115) }).action === "escalate", "still silent 45 min after triage -> escalate to the owner");
	}
	ok(superviseChange({ change: "CHANGE-0003", entries: [E("integrator", "plan-approved", 0)], cstate: { dispatched: ["integrator-plan-approved-0"] }, pending: ["CHANGE-0002"], now }).action === "none", "waiting for prerequisites is not a stall");
	ok(parseTitle("title: kiosk learning content      # retitled f\n") === "kiosk learning content", "title without comment");
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { ...cs, triaged: entries[0].id }, now }).action === "none", "triaged once per entry");
	ok(superviseChange({ change: "CHANGE-0003", entries: [E("integrator", "needs-human", 0)], cstate: { dispatched: ["integrator-needs-human-0"] }, now }).action === "none", "waiting on the owner is not a stall");
	entries = [E("harness", "stalled", 0)];
	ok(superviseChange({ change: "CHANGE-0003", entries, cstate: { dispatched: [entries[0].id] }, now }).action === "escalate", "integrator ignored the triage -> escalate to the owner");
	// status + digest
	byChange = new Map([["CHANGE-0003", [E("integrator", "plan-approved", 0)]], ["CHANGE-0002", [E("integrator", "plan-approved", 0, { change: "CHANGE-0002" })]], ["CHANGE-0004", [E("integrator", "needs-human", 0, { change: "CHANGE-0004" })]]]);
	const st = buildStatus({ byChange, yamlOf, now });
	ok(st.rows.find((x) => x.change === "CHANGE-0003").phase === "parked" && st.rows[0].change === "CHANGE-0004", "status: parked change, owner items first");
	ok(/needs you: CHANGE-0004/.test(digestText(st)), "digest names what needs the owner");
	const d = (h, m = 0) => new Date(2026, 9, 18, h, m);
	ok(digestDue(null, [8, 20], d(9)) && !digestDue(d(8, 5).getTime(), [8, 20], d(9)) && digestDue(d(8, 5).getTime(), [8, 20], d(20, 1)), "digest slots");
	ok(/Do NOT send the worker another blind retry/.test(triageMarkdown({ change: "CHANGE-0003", kind: "repeated-failure", why: "x", entries })), "triage text");
	const t0 = new Date(2026, 9, 18, 8, 0).getTime();
	let lim = detectLimit("working...\n  ⎿ 5-hour limit reached ∙ resets 1pm\n> ", t0);
	ok(lim?.kind === "usage limit" && new Date(lim.until).getHours() === 13, `claude 5-hour limit with reset time (got ${JSON.stringify(lim)})`);
	lim = detectLimit("You've hit your usage limit. Try again in 2 hours. limit resets in 2h", t0);
	ok(lim?.kind === "usage limit" && lim.until === t0 + 2 * 3600e3, "codex usage limit, resets in 2h");
	ok(detectLimit("Error: prompt is too long: 210000 tokens > 200000 maximum", t0)?.kind === "session limit", "context limit");
	ok(detectLimit("Service temporarily overloaded, retrying", t0) === null, "transient overload is not a limit (auto-continue handles it)");
	ok(backendOfAgent("claude") === "claude" && backendOfAgent("antigravity-cli") === "antigravity" && backendOfAgent("pi") === "pi", "agent -> backend");
	ok(pickFallbackBackend("claude", { limits: [{ backend: "codex" }] }) === "pi", "fallback skips the limited backends");
	{
		const now2 = Date.UTC(2026, 9, 18, 12, 0);
		const usage = { quotas: { claude_5h: { t: now2 - 60e3, usedPct: 97, resetsAt: now2 + 3600e3 }, claude_weekly: { t: now2, usedPct: 40 }, codex_5h: { t: now2 - 3 * 3600e3, usedPct: 20, resetsAt: now2 - 60e3 } } };
		const caps = capacity(usage, [], now2);
		ok(caps.find((c) => c.agent === "claude").state === "spent" && caps.find((c) => c.agent === "codex").state === "open" && caps.find((c) => c.agent === "antigravity").state === "unknown", `capacity states (got ${caps.map((c) => c.agent + ":" + c.state).join(" ")})`);
		const w1 = windowResets({}, caps, now2);
		const caps2 = capacity({ quotas: { ...usage.quotas, claude_5h: { t: now2 + 2 * 3600e3, usedPct: 3, resetsAt: now2 + 7 * 3600e3 } } }, [], now2 + 2 * 3600e3);
		const w2 = windowResets(w1.next, caps2, now2 + 2 * 3600e3);
		ok(w2.events.length === 1 && w2.events[0].agent === "claude", "claude window reset is detected");
		ok(/\| Claude \| spent/.test(capacityMarkdown(caps, now2)), "capacity table");
		const alt = { id: "codex/gpt-6.1-sol", tier: 3 };
		ok(waitOrMove({ facts: { risk: "medium", size: "M" }, until: now2 + 30 * 60e3, now: now2, alternative: alt, routedTier: 4 }).action === "move", "ordinary change moves even when the reset is near");
		ok(waitOrMove({ facts: { risk: "high", size: "L" }, until: now2 + 30 * 60e3, now: now2, alternative: alt, routedTier: 4 }).action === "wait", "high-risk change waits 30 min rather than drop to a weaker agent");
		ok(waitOrMove({ facts: { risk: "high", size: "L" }, until: now2 + 4 * 3600e3, now: now2, alternative: alt, routedTier: 4 }).action === "move", "but not 4 hours");
		ok(waitOrMove({ facts: {}, until: now2 + 4 * 3600e3, now: now2, alternative: null }).action === "wait", "nobody else -> wait for the reset");
	}
	{
		const ev = [
			...sessionLineEvents({ type: "assistant", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "Now wiring the caption probe into main.gd and rerunning the browser suite." }, { type: "tool_use", name: "Edit", input: { file_path: "godot-project/main.gd" } }] } }),
			...sessionLineEvents({ message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test -- voice" } }] }, timestamp: "y" }),
			...sessionLineEvents({ message: { role: "toolResult", isError: true, content: "Error: timeout waiting for canvas" }, timestamp: "z" }),
			...sessionLineEvents({ type: "user", message: { role: "user", content: "Fix F11 and F12 from review 9" } }),
		];
		const md = briefMarkdown({ change: "CHANGE-0013", agent: "claude", why: "usage limit", events: ev, git: { branch: "feature/x", log: "abc fix", status: " M a.gd" } });
		ok(/godot-project\/main\.gd/.test(md) && /npm test -- voice/.test(md) && /timeout waiting for canvas/.test(md) && /Fix F11 and F12/.test(md) && /caption probe/.test(md), "handoff brief: asked, said, files, commands, errors");
		const now3 = Date.UTC(2026, 9, 18, 12);
		ok(paceLevel({ agent: "claude" }, { claude_5h: { beforeReset: true, runOutAt: now3 + 20 * 60e3 } }, now3).level === "critical" && paceLevel({ agent: "claude" }, { claude_weekly: { beforeReset: true, runOutAt: now3 + 30 * 3600e3 } }, now3).level === "warning" && paceLevel({ agent: "codex" }, {}, now3).level === "none", "pace levels");
	}
	ok(detectProviderError("> working\n Error: Internal Server Error\n")?.kind === "provider error" && detectProviderError("APIError: 500 status code (no body)") && !detectProviderError("tests: 500 passed"), "provider/server errors (OpenCode Internal Server Error, 500)");
	{
		let h = [], r;
		r = providerErrorPersists(h, "a", { now: 0 }); h = r.history;
		r = providerErrorPersists(h, "a", { now: 60e3 }); h = r.history;
		ok(!r.persists && r.count === 1, "the same unchanged screen counts once");
		r = providerErrorPersists(h, "b", { now: 120e3 }); h = r.history;
		r = providerErrorPersists(h, "c", { now: 180e3 });
		ok(r.persists, "three errors within 30 min = outage");
		ok(!providerErrorPersists([{ t: 0, sig: "a" }, { t: 1, sig: "b" }], "c", { now: 3600e3 }).persists, "old errors expire");
	}
	{
		const n = Date.UTC(2026, 9, 18, 13);
		const aw = [{ change: "CHANGE-0012", since: new Date(n - 3 * 3600e3).toISOString() }];
		ok(integratorUnresponsive({ awaits: aw, lastActivity: n - 4 * 3600e3, paneIdle: true, now: n })?.changes[0] === "CHANGE-0012", "idle integrator, log older than the handoff -> unresponsive");
		ok(!integratorUnresponsive({ awaits: aw, lastActivity: n - 60e3, paneIdle: true, now: n }), "log moved after the handoff -> fine");
		ok(!integratorUnresponsive({ awaits: aw, lastActivity: null, paneIdle: false, now: n }), "pane working -> fine");
		ok(!integratorUnresponsive({ awaits: aw, lastActivity: 0, paneIdle: true, now: n, lastRestart: n - 5 * 60e3 }), "restarted 5 min ago -> wait");
	}
	{
		const L = [JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1000, cacheRead: 129000, output: 50 } } }), '{"type":"compaction","x":1}'];
		const h = sessionHealthFromLines(L, 200000);
		ok(h.ctxPct === 65 && h.compactions === 1, `session health (got ${JSON.stringify(h)})`);
		const E2 = (role, verdict, note = "") => ({ role, verdict, note });
		ok(freshOrContinue({ entries: [E2("integrator", "impl-changes-requested")], health: h }).fresh, "heavy context -> fresh");
		ok(!freshOrContinue({ entries: [E2("integrator", "impl-changes-requested")], health: { ctxPct: 30, compactions: 0 } }).fresh, "light session, first round -> continue");
		ok(freshOrContinue({ entries: [E2("integrator", "impl-changes-requested", "Diagnose the blank capture before any fix")], health: { ctxPct: 20, compactions: 0 } }).fresh, "diagnosis asked -> fresh");
		ok(freshOrContinue({ entries: [E2("integrator", "impl-changes-requested"), E2("worker", "impl-ready"), E2("integrator", "impl-changes-requested")], health: { ctxPct: 20, compactions: 0 } }).fresh, "two rounds of changes -> fresh");
		ok(!freshOrContinue({ entries: [E2("worker", "impl-ready")], health: h }).fresh, "only when work goes back to the worker");
		ok(!freshOrContinue({ entries: [E2("integrator", "impl-changes-requested")], health: { ctxPct: 45, compactions: 0 }, idleMin: 3, backend: "claude" }).fresh, "45% with a warm cache -> continue");
		const cf = freshOrContinue({ entries: [E2("integrator", "impl-changes-requested")], health: { ctxPct: 45, compactions: 0 }, idleMin: 40, backend: "claude" });
		ok(cf.fresh && /cache has expired/.test(cf.why), "45% after a 40 min pause on Claude -> fresh");
	}
	if (fails) { console.error(`${fails} supervisor self-test(s) FAILED`); return 1; }
	console.log("harness-supervisor self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) Promise.resolve(main()).then((c) => process.exit(c ?? 0));
