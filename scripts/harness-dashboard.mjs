#!/usr/bin/env node
/**
 * harness-dashboard.mjs - a live terminal dashboard for the harness, sized for a Herdr pane.
 *
 *   [1] Overview  capacity (subscription %, free requests, local server), provider health
 *                 (overload breaker), the handoff pipeline per change, panes
 *   [2] Routing   a tree of what each kind of change (risk, size, visual, struggling) would
 *                 launch right now, grouped by agent (opencode, pi, claude, codex ...), then
 *                 the router's decision for each active change: size points, visual,
 *                 minimum tier, every candidate with its score or why it was excluded,
 *                 plus the decision log (shadow vs live)
 *   [3] Models    audit per model: turns, tokens, $, guard violations / blocks / hard stops,
 *                 completion gate fired / passed / exhausted, catalog tier + cost class
 *   [4] Events    the lifecycle watcher's events.log, colour-coded
 *
 *   [5] Scores    public benchmark scores (Artificial Analysis, Arena) next to the harness's own
 *                 track record per catalog model, plus hints where they disagree with the tiers
 *
 *   [6] Outcomes  per worker model: rounds, first-pass acceptance, reports per merge, findings,
 *                 "continue" messages, error/tool/violation rates, $ per merged change incl. reviews
 *
 *   [7] Tokens    token-audit per backend: BEFORE / AFTER at each marker (token-audit.mjs --mark),
 *                 daily trend sparklines (context p95, cost per call), context size, cache hits,
 *                 avoidable share, biggest runs. Weighted tokens = what burns quota.
 *
 * Keys: 1-7 or tab = view, j/k or arrows = scroll, [ ] = previous/next change (Routing),
 *       r = refresh now (also refreshes usage), q = quit.
 *
 *   node scripts/harness-dashboard.mjs              interactive (open it in a pane: scripts/herdr-dashboard.sh)
 *   node scripts/harness-dashboard.mjs --once [--view 2] [--width 100]   print one frame, no colour
 *   node scripts/harness-dashboard.mjs --selftest
 *
 * Read-only: it never writes harness state (only asks route-worker to refresh the usage cache).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadUsage, usageIsOld, decideForChange, loadCatalog, TIER_NAMES, scenariosForRepo } from "./route-worker.mjs";
import { discoverSessionDirs, aggregateSessionDir, mergeFleet } from "./fleet-status.mjs";
import { discoverTrees, readAllEntries, readJson, statePath, eventsLogPath, lifecycleDir } from "./handoff.mjs";
import { loadScores, scoresAreOld, scoreTable, tierHints } from "./model-scores.mjs";
import { loadOutcomes } from "./model-outcomes.mjs";
import { loadCache as loadTokenCache } from "./token-audit.mjs";
import { loadPricing, pricingIsOld, priceFor, scoresFor as pricingScores, paretoIds, DEFAULT_PLANS, BOARDS } from "./plan-pricing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONCE = argv.includes("--once");
const COLOR = !ONCE && !process.env.NO_COLOR && process.stdout.isTTY;
const REPO = process.env.HARNESS_REPO_ROOT || (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return resolve(HERE, ".."); } })();

// ---------------------------------------------------------------------------
// tiny ANSI layer (16 base colours: follows the terminal's own light/dark theme)
// ---------------------------------------------------------------------------
const SGR = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, inverse: 7 };
const c = (style, s) => COLOR ? style.split(" ").map((k) => `\x1b[${SGR[k]}m`).join("") + s + "\x1b[0m" : String(s);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s) => [...strip(s)].length;
const pad = (s, n) => { s = String(s ?? ""); const l = vlen(s); return l >= n ? cut(s, n) : s + " ".repeat(n - l); };
const padL = (s, n) => { s = String(s ?? ""); const l = vlen(s); return l >= n ? s : " ".repeat(n - l) + s; };
function cut(s, n) {
	if (vlen(s) <= n) return s;
	let out = "", vis = 0;
	for (const part of String(s).split(/(\x1b\[[0-9;]*m)/)) {
		if (/^\x1b\[/.test(part)) { out += part; continue; }
		for (const ch of part) { if (vis >= n - 1) return out + "…" + (COLOR ? "\x1b[0m" : ""); out += ch; vis++; }
	}
	return out;
}
const pctColor = (used) => used == null ? "gray" : used >= 85 ? "red" : used >= 60 ? "yellow" : "green";
function bar(usedPct, width = 18) {
	if (usedPct == null) return c("gray", "·".repeat(width));
	const n = Math.max(0, Math.min(width, Math.round((usedPct / 100) * width)));
	return c(pctColor(usedPct), "█".repeat(n)) + c("gray", "░".repeat(width - n));
}
function ago(ms) {
	if (!ms) return "-";
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 0) return "in " + dur(-s);
	return dur(s) + " ago";
}
function dur(s) { s = Math.round(s); if (s < 90) return `${s}s`; if (s < 5400) return `${Math.round(s / 60)}m`; if (s < 172800) return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`; return `${Math.floor(s / 86400)}d${Math.round((s % 86400) / 3600)}h`; }
const inTime = (ms) => !ms ? "" : ms < Date.now() ? "reset" : "resets in " + dur((ms - Date.now()) / 1000);
const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "G" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n ?? 0);
const section = (title, W, extra = "") => c("bold", title) + " " + c("gray", "─".repeat(Math.max(0, W - vlen(title) - vlen(extra) - 2))) + (extra ? " " + extra : "");

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
const cache = { fleet: null, fleetAt: 0 };
function loadFleet(force = false) {
	if (!force && cache.fleet && Date.now() - cache.fleetAt < 60_000) return cache.fleet;
	try { cache.fleet = mergeFleet(discoverSessionDirs(REPO).map((d) => aggregateSessionDir(d))); } catch (e) { cache.fleet = { error: e.message, costByModel: {}, guardByModel: {} }; }
	cache.fleetAt = Date.now();
	return cache.fleet;
}
function refreshOutcomesInBackground() {
	try { spawn(process.execPath, [join(HERE, "cache-stats.mjs")], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ }
	try { spawn(process.execPath, [join(HERE, "model-outcomes.mjs")], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ }
}
function refreshPricingInBackground() {
	try { spawn(process.execPath, [join(HERE, "plan-pricing.mjs"), "--refresh"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ }
}
function refreshScoresInBackground() {
	try { spawn(process.execPath, [join(HERE, "model-scores.mjs"), "--refresh", "--json"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ }
}
let tokensSpawnedAt = 0;
function refreshTokensInBackground(force = false) {
	// the audit reads every transcript (seconds, ~100s of MB): at most every 10 min unless forced
	if (!force && Date.now() - tokensSpawnedAt < 10 * 60e3) return;
	tokensSpawnedAt = Date.now();
	try { spawn(process.execPath, [join(HERE, "token-audit.mjs"), "--cache"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO, NODE_NO_WARNINGS: "1" } }).unref(); } catch { /* best effort */ }
}
const tokensAreOld = (t) => !t?.at || Date.now() - t.at > 30 * 60e3;
function refreshUsageInBackground() {
	try { spawn(process.execPath, [join(HERE, "route-worker.mjs"), "--refresh-usage", "--quiet"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ }
}
const pipelineJson = () => readJson(join(REPO, "herdr-plugin", "pipeline.json"), {}) ?? {};
function tailFile(p, maxLines = 400) { try { const s = readFileSync(p, "utf8"); return s.split("\n").filter(Boolean).slice(-maxLines); } catch { return []; } }

function collect() {
	const trees = (() => { try { return discoverTrees(REPO); } catch { return []; } })();
	const byChange = (() => { try { return readAllEntries(REPO, trees); } catch { return new Map(); } })();
	const state = readJson(statePath(REPO), { changes: {} }) ?? { changes: {} };
	const snapshot = readJson(join(lifecycleDir(REPO), "panes-snapshot.json"), null);
	const changes = [...byChange.entries()].map(([id, list]) => {
		const last = list[list.length - 1];
		const st = state.changes?.[id] ?? {};
		return { id, list, last, st, done: last?.verdict === "merged" };
	}).sort((a, b) => String(b.last?.at).localeCompare(String(a.last?.at)));
	const decisions = tailFile(join(REPO, ".pi-session", "routing", "decisions.jsonl"), 50).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	return { sidebar: readJson(join(lifecycleDir(REPO), "sidebar-last.json"), null), usage: loadUsage(REPO), catalog: loadCatalog(REPO), pipeline: pipelineJson(), changes, snapshot, decisions, events: tailFile(eventsLogPath(REPO), 300), tokens: loadTokenCache(REPO) };
}

// ---------------------------------------------------------------------------
// views (each returns an array of lines; W = width)
// ---------------------------------------------------------------------------
const QUOTA_ROWS = [
	["claude_5h", "Claude Pro · 5h"], ["claude_weekly", "Claude Pro · week"],
	["codex_5h", "Codex Plus · 5h"], ["codex_weekly", "Codex Plus · week"],
	["gemini_5h", "Gemini AI Pro · 5h"], ["gemini_weekly", "Gemini AI Pro · week"],
	["agy3p_5h", "Antigravity 3p · 5h"], ["agy3p_weekly", "Antigravity 3p · week"],
	["opencodego_5h", "OpenCode Go · 5h"], ["opencodego_weekly", "OpenCode Go · week"], ["opencodego_monthly", "OpenCode Go · month"],
];

export function viewOverview(d, W) {
	const L = [];
	const u = d.usage ?? {};
	// What the harness says about every change (.pi-session/status.json, written by the watcher)
	const sj = readJson(join(REPO, ".pi-session", "status.json"), null);
	if (sj?.rows?.length) {
		const act = sj.rows.filter((r) => r.phase !== "done");
		L.push(section("CHANGES", W, c("gray", `STATUS.md · ${ago(Date.parse(sj.at))}`)));
		const col = { "needs you": "red bold", parked: "gray", waiting: "yellow", review: "cyan", "plan review": "cyan", implementing: "green", qualifying: "blue", planning: "magenta" };
		for (const r of act.slice(0, 12)) L.push(`  ${pad(r.change, 12)} ${pad(c(col[r.phase] ?? "reset", r.phase), 12)} ${pad(r.waiting ?? "-", 26)} ${padL(r.age, 6)}  ${c("gray", cut(r.next + (r.working ? " · " + r.working : ""), Math.max(20, W - 64)))}`);
		if (act.length > 12) L.push(c("gray", `  +${act.length - 12} more in .pi-session/STATUS.md`));
		L.push("");
	}
	L.push(section("CAPACITY", W, c("gray", u.at ? `usage ${ago(u.at)}` : "usage never refreshed - press r")));
	for (const [key, label] of QUOTA_ROWS) {
		const q = u.quotas?.[key];
		const reset = q?.resetsAt && q.resetsAt < Date.now();
		const used = q ? (reset ? 0 : q.usedPct) : null;
		const note = !q ? c("gray", key.startsWith("claude") ? `no data - ${u.sources?.quota_cli && !/^ok/.test(u.sources.quota_cli) ? "install quota-cli, or run a Claude Code session" : "appears after a Claude Code session or a quota-cli read"}` : key.startsWith("opencodego") ? `no data - ${u.sources?.opencode_go ?? "not read yet"}` : key.startsWith("codex") ? `no data - ${u.sources?.codex ?? "not read yet"}` : "no data")
			: c("gray", `${inTime(q.resetsAt)}${q.t ? ` · seen ${ago(q.t)}` : ""}`);
		if (!q && /^(agy3p|opencodego_monthly)/.test(key)) continue; // optional rows: only when there is data
		const pr = u.projections?.[key];
		const proj = pr?.beforeReset && pr.runOutAt ? c("red bold", `  runs out ${ago(pr.runOutAt)} at current pace`) : pr?.ratePerHour > 0 ? c("gray", `  ${pr.ratePerHour}%/h, lasts until reset`) : "";
		L.push(`  ${pad(label, 22)} ${bar(used)} ${padL(used == null ? "" : Math.round(used) + "%", 4)}  ${note}${q?.via ? c("gray", ` · ${q.via}`) : ""}${proj}`);
	}
	const of = u.quotas?.openrouter_free;
	L.push(`  ${pad("OpenRouter free/day", 22)} ${of ? bar(of.usedPct) + " " + padL(of.remaining + " left", 9) + c("gray", ` of ${of.limit}`) : bar(null) + "      " + c("gray", `no data - ${u.sources?.openrouter ?? "not read yet"}`)}`);
	if (u.quotas?.openrouter_usd) L.push(`  ${pad("OpenRouter credit", 22)} ${bar(u.quotas.openrouter_usd.usedPct)} ${padL("$" + u.quotas.openrouter_usd.remaining.toFixed(2), 9)} left`);
	const lo = u.local;
	L.push(`  ${pad("Local model server", 22)} ${!lo ? c("gray", "not probed") : lo.up ? c("green", "● up") + c("gray", `  ${(lo.models ?? []).slice(0, 4).join(", ")}`) : c("red", "● down") + c("gray", `  ${lo.error ?? ""}`)}`);
	L.push("");

	L.push(section("PROVIDER HEALTH", W, c("gray", "overload errors, last hour")));
	const br = Object.entries(u.breakers ?? {});
	if (!br.length) L.push(c("gray", "  no data"));
	for (const [name, b] of br) {
		const open = b.events >= (b.threshold ?? 6);
		L.push(`  ${pad(name, 14)} ${open ? c("red bold", "BREAKER OPEN") : c("green", "ok          ")}  ${padL(b.events, 4)} / ${b.threshold ?? 6}  ${c("gray", open ? "out of rotation until the storm passes" : "")}`);
	}
	L.push("");

	const mode = d.pipeline.mode ?? "?", rmode = d.pipeline.routing?.mode ?? "shadow";
	L.push(section("PIPELINE", W, c("gray", `handoff ${mode} · routing ${rmode}`)));
	if (!d.changes.length) L.push(c("gray", "  no handoff entries yet"));
	for (const ch of d.changes.slice(0, 8)) {
		const e = ch.last;
		const next = d.pipeline.routes?.[e.verdict]?.to ?? "human";
		const rounds = ch.st.rounds ? `plan ${ch.st.rounds.plan ?? 0} · impl ${ch.st.rounds.impl ?? 0}` : "";
		const aw = ch.st.awaiting ? `awaiting ${ch.st.awaiting.role} ${ago(Date.parse(ch.st.awaiting.since) || ch.st.awaiting.since)}` : "";
		const vcol = ch.done ? "green" : /changes-requested|blocked|question|needs-human/.test(e.verdict) ? "yellow" : "cyan";
		L.push(`  ${pad(c("bold", ch.id), 12)} ${pad(e.role, 10)} ${pad(c(vcol, e.verdict), 24)} ${pad(ch.done ? c("green", "✓ done") : "→ " + next, 12)} ${c("gray", `${ago(Date.parse(e.at))}  ${rounds}  ${aw}`)}`);
		if (e.note) L.push(c("gray", `  ${" ".repeat(12)} ${cut(String(e.note), W - 16)}`));
	}
	L.push("");

	L.push(section("PANES", W, c("gray", d.snapshot?.at ? `snapshot ${ago(Date.parse(d.snapshot.at))}` : "")));
	const panes = (d.snapshot?.panes ?? []).filter((p) => p.role);
	if (!panes.length) L.push(c("gray", "  no harness panes registered"));
	for (const p of panes) {
		const st = !p.alive ? (p.starting ? c("yellow", "starting") : c("gray", "dead")) : p.agent_status === "working" ? c("cyan", "working") : c("green", p.agent_status ?? "idle");
		const t = d.sidebar?.panes?.[p.pane_id] ?? {};
		const cacheTxt = t.cache_low ? c("red", t.cache_low) : t.cache_mid ? c("yellow", t.cache_mid) : c("gray", t.cache_hi ?? "");
		const lim = t.limit ? (/!/.test(t.limit) ? c("red bold", t.limit) : t.limit === "pay-per-token" ? c("yellow", t.limit) : t.limit) : "";
		L.push(`  ${pad(p.pane_id, 7)} ${pad(p.role, 11)} ${pad(p.change ?? "", 12)} ${pad(st, 10)} ${pad(c("gray", t.ctx ?? ""), 18)} ${pad(cacheTxt, 11)} ${pad(lim, 14)} ${c("gray", p.label ?? "")}`);
	}
	return L;
}

const short = (id) => String(id ?? "").replace(/^(opencode-go|opencode|openrouter|openai-codex|anthropic|antigravity)\//, (m) => m);
/** Which leaf of the tree a real decision sits on. */
function leafOf(r) {
	if (!r || r.pinned) return null;
	if (r.risk === "critical") return { key: "critical" };
	if (r.risk === "high") return { key: "high", size: r.size };
	if (r.visual?.visual) return { key: "visual", size: r.size };
	if (r.escalation?.levels) return { key: "struggling", size: r.size };
	return { key: r.risk === "low" ? "low" : "medium", size: r.size };
}

/** Tree: kind of change -> size -> the agent + model that would launch right now. */
export function routingTree(W, here = null, label = "") {
	const L = [];
	let sc;
	try { sc = scenariosForRepo(REPO); } catch (e) { return [c("red", `  routing tree failed: ${e.message}`)]; }
	const BE = { opencode: "cyan", pi: "blue", claude: "magenta", codex: "yellow", antigravity: "green" };
	const agent = (b) => c(`${BE[b] ?? "reset"} bold`, b);
	L.push(section("ROUTING TREE", W, c("gray", "what each kind of change would launch right now · lower score = picked first")));
	L.push(c("bold", "  change"));
	sc.branches.forEach((br, bi) => {
		const lastB = bi === sc.branches.length - 1;
		const hereB = here?.key === br.key;
		L.push(`  ${lastB ? "└─" : "├─"} ${c(hereB ? "bold" : "reset", br.label)}  ${c("gray", br.rule)}`);
		// fold neighbouring sizes that launch the same thing
		const groups = [];
		for (const l of br.leaves) {
			const key = l.human ? "human" : l.wait ? `wait|${l.waitUntil}` : `${l.pick.backend}|${l.pick.id}`;
			const g = groups[groups.length - 1];
			if (g && g.key === key) g.sizes.push(l.size); else groups.push({ key, sizes: [l.size], l });
		}
		groups.forEach((g, gi) => {
			const stem = `  ${lastB ? "   " : "│  "}${gi === groups.length - 1 ? "└─" : "├─"} `;
			const sizes = br.key === "critical" ? "any" : g.sizes.length > 1 ? `${g.sizes[0]}-${g.sizes[g.sizes.length - 1]}` : g.sizes[0];
			const tier = g.l.minTier ? c("gray", `t>=${g.l.minTier}`) : "";
			const isHere = hereB && (br.key === "critical" || g.sizes.includes(here.size));
			const mark = isHere ? c("green bold", `  ◀ ${label}`) : "";
			if (g.l.wait) {
				const nx = g.l.candidates.find((x) => x.quota && x.resetsAt === g.l.waitUntil);
				L.push(`${stem}${pad(sizes, 6)}${pad(tier, 6)}${c("yellow", "⏳ wait")} for ${c("bold", short(nx?.id ?? "?"))} ${c("gray", `until ${new Date(g.l.waitUntil).toTimeString().slice(0, 5)} (quota resets)`)}${mark}`);
			} else if (g.l.human) {
				const why = br.key === "critical" ? "" : c("gray", `no model at tier ${g.l.minTier}+ with a usable login and capacity`);
				L.push(`${stem}${pad(sizes, 6)}${pad(tier, 6)}${c("yellow bold", "✋ human")}  ${why}${mark}`);
			} else {
				const nx = g.l.next ? c("gray", `  then ${g.l.next.backend} ▸ ${short(g.l.next.id)} ${g.l.next.cost}`) : "";
				L.push(`${stem}${pad(sizes, 6)}${pad(tier, 6)}${agent(g.l.pick.backend)} ▸ ${c("bold", short(g.l.pick.id))} ${c("gray", String(g.l.pick.cost ?? ""))}${c("gray", ` (${g.l.eligible} eligible)`)}${g.l.fallback ? c("yellow", " fallback") : ""}${nx}${mark}`);
			}
		});
	});
	L.push("");
	L.push(section("AGENTS", W, c("gray", "backend priority order · ► wins a branch · ● ready · ✗ out")));
	sc.backends.forEach((b, bi) => {
		const lastB = bi === sc.backends.length - 1;
		const head = `${agent(b.name)}  ${c("gray", [b.priority ? `#${b.priority}` : null, b.weight ? `weight ${b.weight > 0 ? "+" : ""}${b.weight}` : null].filter(Boolean).join(" · "))}  ${b.allowed ? c("green", "auto-launch ✓") : c("gray", "not in auto_backends")}`;
		L.push(`  ${lastB ? "└─" : "├─"} ${head}`);
		const rank = { picked: 0, ready: 1, out: 2, off: 3 };
		const ms = [...b.models].sort((x, y) => rank[x.state] - rank[y.state] || (x.cost ?? 99) - (y.cost ?? 99) || x.tier - y.tier);
		const shown = ms.filter((m) => m.state !== "off" && m.state !== "out");
		const out = ms.filter((m) => m.state === "out" || m.state === "off");
		const rows = [...shown, ...out.slice(0, shown.length ? 2 : 3)];
		const more = out.length - (rows.length - shown.length);
		rows.forEach((m, mi) => {
			const lastM = mi === rows.length - 1 && !more;
			const stem = `  ${lastB ? "   " : "│  "}${lastM ? "└─" : "├─"} `;
			const icon = m.state === "picked" ? c("green bold", "►") : m.state === "ready" ? c("blue", "●") : c("gray", "✗");
			const name = m.state === "picked" ? c("green bold", short(m.id)) : m.state === "ready" ? short(m.id) : c("gray", short(m.id));
			const wins = m.wins?.length ? c("green", `wins ${m.wins.join(" ")}`) : "";
			const detail = m.state === "out" || m.state === "off" ? c("gray", cut(m.why ?? "", Math.max(20, W - 70))) : `${m.cost != null ? c("gray", `score ${m.cost}  `) : ""}${wins}`;
			L.push(`${stem}${icon} ${pad(name, 44)} ${c("gray", "t" + m.tier)}${m.visual ? c("magenta", "◆") : " "} ${detail}`);
		});
		if (more > 0) L.push(`  ${lastB ? "   " : "│  "}└─ ${c("gray", `+${more} more out (disabled, no login, or not allowed here)`)}`);
	});
	L.push(c("gray", "  ◆ = visual-capable · scores include price, quota scarcity, backend weight, preference and track record"));
	return L;
}

export function viewRouting(d, W, sel = 0) {
	const L = [];
	const active = d.changes.filter((ch) => !ch.done);
	const list = active.length ? active : d.changes;
	const rmode = d.pipeline.routing?.mode ?? "shadow";
	L.push(section("ROUTING", W, c(rmode === "live" ? "green" : "yellow", `mode: ${rmode}`) + c("gray", rmode === "live" ? "" : " (decides + logs; launches stay pinned)")));
	if (!list.length) { L.push(c("gray", "  no changes in the ledger yet")); return L; }
	const ch = list[((sel % list.length) + list.length) % list.length];
	L.push(c("gray", `  change ${list.indexOf(ch) + 1}/${list.length}  ([ ] to switch)  · lower score = picked first`));
	const r = decideForChange(REPO, ch.id, { entries: ch.list });
	L.push("");
	L.push(`  ${c("bold", ch.id)}  ${r.escalateToHuman ? c("yellow bold", "→ HUMAN") : r.wait ? c("yellow bold", `⏳ waits until ${new Date(r.waitUntil).toTimeString().slice(0, 5)}`) : c("green bold", "→ " + r.pick?.id) + c("gray", ` via ${r.pick?.backend}`)}`);
	if (r.difficulty) L.push(`  size     ${c("bold", r.size)}  ${c("gray", `${r.difficulty.points} pts: ${r.difficulty.reasons.join(", ") || "-"}`)}`);
	if (r.visual) L.push(`  visual   ${r.visual.visual ? c("magenta", "yes") : "no"}  ${c("gray", r.visual.why)}`);
	if (r.minTier) L.push(`  min tier ${c("bold", r.minTier)}  ${c("gray", TIER_NAMES[r.minTier] ?? "")}${r.escalation?.levels ? c("yellow", `  escalated +${r.escalation.levels} (${r.escalation.why.join(", ")})`) : ""}`);
	if (r.escalateToHuman || r.error || r.wait) L.push(c("yellow", `  ${r.reason}`));
	if (r.pinned) L.push(c("cyan", `  pinned in change.yaml - the tree below is skipped for this change`));
	L.push("");
	L.push(...routingTree(W, leafOf(r), ch.id));
	L.push("");
	L.push(section(`CANDIDATES FOR ${ch.id}`, W));
	const cat = Object.fromEntries((d.catalog.models ?? []).map((m) => [m.id, m]));
	const prc = loadPricing(REPO);
	const pub = Object.fromEntries((d.catalog.models ?? []).map((m) => {
		const sc = pricingScores(m, prc.rows ?? []);
		return [m.id, sc.aa_coding_agent_index ? `cA ${Math.round(sc.aa_coding_agent_index.score)}` : sc.terminal_bench_4 ? `TB ${Math.round(sc.terminal_bench_4.score)}` : sc.aa_intelligence_index ? `AA ${Math.round(sc.aa_intelligence_index.score)}` : ""];
	}));
	L.push(c("gray", `  ${pad("", 2)}${pad("tier", 5)}${pad("model", 46)}${pad("cost", 9)}${padL("score", 6)}${pad("", 10)} ${pad("coding", 8)}why`));
	const scores = (r.candidates ?? []).filter((x) => x.ok).map((x) => x.cost);
	const max = Math.max(1, ...scores);
	for (const x of r.candidates ?? []) {
		const m = cat[x.id] ?? {};
		const picked = r.pick?.id === x.id;
		const mark = picked ? c("green bold", "► ") : x.ok ? "  " : c("gray", "  ");
		const name = picked ? c("green bold", x.id) : x.ok ? x.id : c("gray", x.id);
		const sc = x.ok ? padL(x.cost.toFixed(1), 6) : c("gray", padL("-", 6));
		const mini = x.ok ? " " + c(picked ? "green" : "blue", "▮".repeat(Math.max(1, Math.round((1 - x.cost / (max + 1)) * 8)))) : "";
		L.push(`  ${mark}${pad("t" + x.tier, 5)}${pad(name, 46)}${pad(c(m.cost === "metered" ? "yellow" : "gray", m.cost ?? ""), 9)}${sc}${pad(mini, 10)} ${pad(c("cyan", pub[x.id] ?? ""), 8)}${c("gray", x.why ?? "")}${m.visual ? c("magenta", " ◆visual") : ""}`);
	}
	L.push("");
	L.push(section("DECISION LOG", W, c("gray", ".pi-session/routing/decisions.jsonl")));
	const dl = d.decisions.slice(-8).reverse();
	if (!dl.length) L.push(c("gray", "  no launches decided yet - they appear when a plan is approved"));
	for (const x of dl) L.push(`  ${c("gray", (x.at ?? "").slice(5, 16).replace("T", " "))} ${pad(x.change, 12)} ${pad(c(x.mode === "live" ? "green" : "yellow", x.mode), 7)} ${x.escalateToHuman ? c("yellow", "human") : pad(x.pick?.id ?? "-", 44)} ${c("gray", x.size ? "size " + x.size : "")}`);
	return L;
}

export function viewModels(d, W) {
	const L = [];
	const f = loadFleet();
	const cat = Object.fromEntries((d.catalog.models ?? []).map((m) => [m.id, m]));
	const norm = (x) => String(x).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
	const catFor = (model) => cat[model] ?? cat[Object.keys(cat).find((k) => {
		const [kp, ...kr] = k.split("/"), [mp, ...mr] = model.split("/");
		return kp === mp && norm(kr.join("/")) === norm(mr.join("/"));
	})] ?? null;
	L.push(section("MODEL AUDIT", W, c("gray", `all sessions · refreshed ${ago(cache.fleetAt)}`)));
	if (f.error) L.push(c("red", "  " + f.error));
	L.push(c("gray", `  ${pad("model", 44)}${padL("turns", 6)}${padL("tokens", 8)}${padL("$", 8)}${padL("viol", 6)}${padL("block", 6)}${padL("stop", 5)}  ${pad("gate f/p/x", 11)}${pad("tier·cost", 12)}`));
	const models = [...new Set([...Object.keys(f.costByModel ?? {}), ...Object.keys(f.guardByModel ?? {})])];
	const rows = models.map((m) => {
		const k = f.costByModel?.[m] ?? { messages: 0, totalTokens: 0, cost: 0 };
		const g = f.guardByModel?.[m]?.events ?? {};
		return { m, turns: k.messages ?? 0, tok: k.totalTokens ?? 0, usd: k.cost ?? 0, v: g.violation ?? 0, b: g.blocked ?? 0, h: g.hard_stop_engaged ?? 0, gf: g.completion_gate_fired ?? 0, gp: g.completion_gate_passed ?? 0, gx: g.completion_gate_exhausted ?? 0 };
	}).sort((a, b) => b.turns - a.turns);
	const T = { turns: 0, tok: 0, usd: 0, v: 0, b: 0, h: 0 };
	for (const r of rows) {
		for (const k of Object.keys(T)) T[k] += r[k];
		const ce = catFor(r.m);
		const per100 = r.turns ? (100 * r.v) / r.turns : 0;
		L.push(`  ${pad(r.m, 44)}${padL(r.turns, 6)}${padL(fmtTok(r.tok), 8)}${padL(r.usd ? r.usd.toFixed(2) : "0", 8)}${padL(c(r.v ? (per100 > 2 ? "red" : "yellow") : "gray", r.v), 6)}${padL(c(r.b ? "yellow" : "gray", r.b), 6)}${padL(c(r.h ? "red" : "gray", r.h), 5)}  ${pad(`${r.gf}/${r.gp}/${c(r.gx ? "red" : "gray", r.gx)}`, 11)}${pad(ce ? `t${ce.tier}·${ce.cost}${ce.visual ? "◆" : ""}` : c("gray", "not in catalog"), 14)}`);
	}
	L.push(c("gray", `  ${"─".repeat(Math.min(W - 4, 110))}`));
	L.push(`  ${pad(c("bold", "total"), 44)}${padL(T.turns, 6)}${padL(fmtTok(T.tok), 8)}${padL(T.usd.toFixed(2), 8)}${padL(T.v, 6)}${padL(T.b, 6)}${padL(T.h, 5)}`);
	L.push("");
	L.push(c("gray", "  viol = guard violations, block = blocked tool calls, stop = hard stops; gate f/p/x = completion gate fired/passed/exhausted"));
	L.push(c("gray", "  note: completion-gate numbers before 2026-10-15 are skewed by the since-fixed gate bug (bash validators were never recognised)"));
	L.push("");
	L.push(section("CATALOG", W, c("gray", "herdr-plugin/models.catalog.json")));
	for (const t of [1, 2, 3, 4]) {
		const ms = (d.catalog.models ?? []).filter((m) => m.tier === t);
		L.push(`  ${c("bold", "t" + t)} ${pad(c("gray", TIER_NAMES[t]), 18)} ${ms.map((m) => (m.enabled === false ? c("gray", m.id + " (off)") : m.id) + (m.visual ? c("magenta", "◆") : "")).join(c("gray", " · "))}`);
	}
	return L;
}

export function viewScores(d, W) {
	const L = [];
	const prc = loadPricing(REPO);
	const plans = { ...DEFAULT_PLANS, ...(d.catalog.pricing_plans ?? {}) };
	const own = Object.fromEntries(scoreTable(d.catalog, loadScores(REPO), loadFleet()).map((r) => [r.id, r]));
	const models = (d.catalog.models ?? []).filter((m) => m.enabled !== false);
	const rows = models.map((m) => {
		const p = priceFor(m, prc, plans);
		const sc = pricingScores(m, prc.rows ?? []);
		const o = own[m.id] ?? {};
		const val = (k) => sc[k]?.score ?? null;
		return { m, p, sc, aaIntel: val("aa_intelligence_index") ?? o.aa?.intelligence ?? null, cAgent: val("aa_coding_agent_index") ?? o.aa?.coding ?? null,
			tb4: val("terminal_bench_4") ?? val("aa_terminal_bench_4"), code: val("arena_code") ?? o.arena?.code?.score ?? null, design: val("open_design_arena"), own: o.own };
	});
	// best value: no other model at least as cheap AND at least as strong (AA intelligence, widest coverage)
	const best = paretoIds(rows.map((r) => ({ id: r.m.id, price: r.p?.usd_per_mtok ?? null, score: r.aaIntel })));
	const f = (v, w = 6, dp = 0) => v == null ? c("gray", padL("-", w)) : padL(dp ? v.toFixed(dp) : Math.round(v), w);
	const money = (v) => v == null ? c("gray", padL("-", 9)) : v === 0 ? padL("0", 9) : padL(v < 0.01 ? v.toFixed(4) : v.toFixed(3), 9);
	const conf = (x) => !x ? c("gray", pad("", 6)) : pad(c(x === "high" ? "green" : x === "medium" ? "yellow" : "red", x.slice(0, 4)), 6);
	const relCol = (v) => v == null ? c("gray", padL("-", 4)) : c(v >= 75 ? "green" : v >= 55 ? "yellow" : "red", padL(v, 4));
	L.push(section("MODEL SCORES & REAL PRICE", W, c("gray", prc.snapshot ? `Real API Pricing snapshot ${prc.snapshot}` : "pricing not fetched yet - press r")));
	L.push(c("gray", `  ${pad("tier model", 44)} ${padL("$/Mtok", 9)} ${padL("tok/mo", 7)} ${pad("conf", 6)}${padL("intel", 6)}${padL("cAgent", 7)}${padL("TB4", 6)}${padL("code", 6)}${padL("design", 7)}${padL("turns", 7)}${padL("rel", 5)}`));
	for (const t of [1, 2, 3, 4]) {
		for (const r of rows.filter((x) => x.m.tier === t).sort((a, b) => (a.p?.usd_per_mtok ?? 9) - (b.p?.usd_per_mtok ?? 9))) {
			const label = `${best.has(r.m.id) ? c("green bold", "★") : " "}t${r.m.tier} ${r.m.id}${r.m.visual || (r.design ?? 0) >= (d.catalog.visual_min_design ?? 85) ? c("magenta", "◆") : ""}`;
			const tok = r.p?.monthly_tokens ? (r.p.monthly_tokens >= 1e9 ? `${(r.p.monthly_tokens / 1e9).toFixed(1)}B` : `${Math.round(r.p.monthly_tokens / 1e6)}M`) : "";
			const priceTxt = r.p?.usd_per_mtok >= 0.1 ? c("red", money(r.p.usd_per_mtok)) : r.p?.usd_per_mtok >= 0.02 ? c("yellow", money(r.p.usd_per_mtok)) : money(r.p?.usd_per_mtok ?? null);
			L.push(`  ${pad(label, 44)} ${priceTxt} ${padL(tok, 7)} ${conf(r.p?.confidence)}${f(r.aaIntel)}${f(r.cAgent, 7)}${f(r.tb4)}${f(r.code)}${f(r.design, 7)}${padL(r.own?.turns ?? c("gray", "-"), 7)}${relCol(r.own?.reliability)}`);
		}
	}
	L.push("");
	L.push(section("HINTS", W, c("gray", "where price and scores disagree with the catalog")));
	const hints = [...tierHints(scoreTable(d.catalog, loadScores(REPO), loadFleet()))];
	// same tier: much pricier per token without a better coding score
	for (const a of rows) for (const b of rows) {
		if (a === b || a.m.tier !== b.m.tier || !a.p?.usd_per_mtok || !b.p?.usd_per_mtok) continue;
		const sa = a.cAgent ?? a.aaIntel, sb = b.cAgent ?? b.aaIntel;
		if (sa == null || sb == null) continue;
		const x = a.p.usd_per_mtok / b.p.usd_per_mtok;
		if (x >= 3 && sa <= sb + 1) hints.push(`${a.m.id} costs ${x.toFixed(1)}x more per token than ${b.m.id} for ${sa < sb ? "a lower" : "about the same"} score (${Math.round(sa)} vs ${Math.round(sb)})`);
	}
	for (const r of rows) if (!r.m.visual && (r.design ?? 0) >= (d.catalog.visual_min_design ?? 85) && r.m.tier >= 3) hints.push(`${r.m.id} counts as visual-capable: Open Design Arena ${r.design}`);
	if (!hints.length) L.push(c("gray", "  none"));
	for (const h of [...new Set(hints)].slice(0, 10)) L.push("  " + c("yellow", "• ") + h);
	L.push("");
	L.push(section("HOW TO READ THIS", W));
	L.push(c("gray", "  $/Mtok: real price per million tokens on the plan you use it through (monthly fee / usable tokens), list price for pay-per-token."));
	L.push(c("gray", "  tok/mo: usable tokens a month on that plan at full use (Real API Pricing convention: 97% cache reads). conf: their confidence."));
	L.push(c("gray", "  intel: AA Intelligence Index · cAgent: AA Coding Agent Index · TB4: Terminal-Bench 4 · code: Arena code ELO · design: Open Design Arena."));
	L.push(c("gray", "  ★ best value (nothing cheaper and stronger) · ◆ visual-capable (catalog or design >= " + (d.catalog.visual_min_design ?? 85) + ") · rel: own track record 0-100."));
	L.push(c("gray", "  The router ranks by tier, then $/Mtok, quota and token budget; scores decide tiers and hints, not picks."));
	L.push("");
	L.push(c("gray", `  Sources: Real API Pricing (github.com/FeiZhuLulu/real-api-pricing, MIT)${prc.error || prc.lastError ? ` - last fetch failed: ${prc.error ?? prc.lastError}` : ""}; benchmark data as published there by Artificial Analysis, Terminal-Bench, Arena, Open Design Arena, DeepSWE.`));
	return L;
}

export function viewOutcomes(d, W) {
	const L = [];
	const o = loadOutcomes(REPO);
	L.push(section("OUTCOMES PER WORKER MODEL", W, c("gray", o?.at ? `from the handoff ledger · ${ago(o.at)}` : "not computed yet - press r")));
	if (!o?.models?.length) { L.push(c("gray", "  no worker rounds yet")); return L; }
	const pct = (v, good, bad, lowerIsBetter = true) => v == null ? c("gray", padL("-", 6)) : c(lowerIsBetter ? (v <= good ? "green" : v >= bad ? "red" : "yellow") : (v >= good ? "green" : v <= bad ? "red" : "yellow"), padL(v, 6));
	L.push(c("gray", `  ${pad("worker model", 42)}${padL("rounds", 7)}${padL("chg", 4)}${padL("merged", 7)}${padL("1st ok", 7)}${padL("rep/mrg", 8)}${padL("finds", 6)}${padL("cont", 6)}${padL("err%", 6)}${padL("tool%", 6)}${padL("viol%", 6)}${padL("rev t", 6)}${padL("$/merged", 10)}`));
	for (const g of o.models) {
		L.push(`  ${pad(g.model.slice(0, 41), 42)}${padL(g.rounds, 7)}${padL(g.changes, 4)}${padL(g.merged, 7)}${pct(g.firstPassPct, 80, 40, false)} ${pct(g.reportsPerMerged, 1.5, 3)}  ${pct(g.findingsPerReview, 1, 3)}${pct(g.continuesPerRound, 0.5, 3)}${pct(g.errorTurnsPer100, 5, 25)}${pct(g.toolErrorsPer100, 5, 15)}${pct(g.violationsPer100, 1, 5)}${pct(g.reviewTurnsPerRound, 20, 60)}${padL(g.usdPerMerged != null ? "$" + g.usdPerMerged + (g.usdComplete ? "" : "+") : "-", 10)}`);
		const oc = Object.entries(g.outcomes).map(([k, v]) => `${k} ${v}`).join(" · ");
		L.push(c("gray", `  ${" ".repeat(4)}${oc}`));
	}
	L.push("");
	// prompt cache per model (scripts/cache-stats.mjs): cached input is billed at a fraction of fresh input
	const cs = readJson(join(REPO, ".pi-session", "routing", "cache-stats.json"), null);
	if (cs?.models?.length) {
		L.push(section("PROMPT CACHE", W, c("gray", `last ${cs.days} days · ${ago(cs.at)} · hit% = cached / all input`)));
		for (const m of cs.models.filter((x) => x.fresh + x.cached + x.written > 50000).slice(0, 12)) {
			const col = m.hitPct == null ? "gray" : m.hitPct >= 85 ? "green" : m.hitPct >= 60 ? "yellow" : "red";
			L.push(`  ${pad(m.model.slice(0, 46), 47)}${padL(c(col, (m.hitPct ?? "-") + "%"), 8)}  ${c("gray", `fresh ${fmtTok(m.fresh + m.written)} · cached ${fmtTok(m.cached)} · ${m.turns} turns`)}`);
		}
		L.push("");
	}
	L.push(section("LATEST ROUNDS", W));
	const col = { accepted: "green", changes: "yellow", "qual-failed": "red", human: "magenta", stalled: "gray", replanned: "gray" };
	for (const r of [...o.rounds].sort((a, b) => String(b.report).localeCompare(String(a.report))).slice(0, 14)) {
		L.push(`  ${c("gray", String(r.report).slice(5, 16).replace("T", " "))} ${pad(r.change, 12)} ${pad(r.model ?? "?", 40)} ${pad(r.reportVerdict, 20)} ${pad(c(col[r.outcome] ?? "reset", r.outcome ?? "open"), 12)} ${c("gray", `${r.turns}t ${r.continues}cont ${r.errorTurns}err ${r.toolErrors}toolErr${r.findings != null ? ` ${r.findings} findings` : ""}`)}`);
	}
	L.push("");
	L.push(section("HOW TO READ THIS", W));
	L.push(c("gray", "  A round = the integrator (or the qualification runner) hands work to a worker -> the worker reports -> a verdict."));
	L.push(c("gray", "  1st ok: the change's first report was accepted · rep/mrg: worker reports per merged change (1.0 = right first time)."));
	L.push(c("gray", "  finds: findings per code review · cont: \"continue\" messages per round (guard recovery + watcher AUTO-CONTINUE)."));
	L.push(c("gray", "  err%: turns ending in a provider error (timeouts, overload) · tool%: failed tool calls · viol%: guard violations, per 100 turns."));
	L.push(c("gray", "  rev t: integrator turns spent per round on this worker's report (the indirect cost; turns shared between parallel reviews are split)."));
	L.push(c("gray", "  $/merged: worker + integrator-review tokens (cache reads excluded) at real plan prices, per merged change (+ = some prices unknown)."));
	L.push(c("gray", "  OpenCode workers' sessions are not readable here: their rounds and verdicts count, their turns/tokens do not."));
	return L;
}


// ---- [7] Tokens -------------------------------------------------------------
const SPARK = "▁▂▃▄▅▆▇█";
function kfmt(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)); }
const pctf = (x) => x == null ? "-" : (100 * x).toFixed(x < 0.1 ? 1 : 0) + "%";
export function sparkline(values) {
	const v = values.filter((x) => x != null);
	if (!v.length) return values.map(() => "·").join("");
	const lo = Math.min(...v), hi = Math.max(...v);
	return values.map((x) => x == null ? c("gray", "·") : SPARK[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join("");
}
const TOKEN_NOISE = 0.3; // run-to-run cost swings are large; smaller changes are not evidence
function delta(before, after, { pct = false } = {}) {
	if (before == null || after == null) return c("gray", pad("-", 22));
	const d = before ? (after - before) / before : 0;
	const f = pct ? pctf : kfmt;
	const txt = `${f(before)}→${f(after)} ${(d >= 0 ? "+" : "") + Math.round(100 * d)}%`;
	return pad(Math.abs(d) <= TOKEN_NOISE ? c("gray", txt) : c(d < 0 ? "green" : "red", txt), 22);
}
export function viewTokens(d, W) {
	const L = [];
	const t = d.tokens;
	L.push(section("TOKENS", W, c("gray", t?.at ? `token-audit · ${ago(t.at)} · r = refresh` : "not computed yet - press r (reads every transcript; takes a few seconds)")));
	if (!t?.summary) return L;
	const s = t.summary, bb = s.byBackend ?? {};
	const backends = Object.keys(bb).sort((a, b) => bb[b].weighted - bb[a].weighted);
	L.push(c("gray", `  ${kfmt(s.weighted)} weighted tokens · ${s.sessions} sessions · ${kfmt(s.calls)} calls · weighted = fresh x1 + cache read x0.1 + cache write x1.25/2 + output x5`));
	L.push("");
	// BEFORE / AFTER at each marker, newest first
	const marks = [...(t.markers ?? [])].sort((a, b) => b.at - a.at);
	if (!marks.length) {
		L.push(section("BEFORE / AFTER", W));
		L.push(c("gray", "  no markers yet. When you change something (compaction, rules, a guard), record it:"));
		L.push(c("gray", `  node scripts/token-audit.mjs --mark "compaction at 200k"   - this view then splits every metric at that moment.`));
		L.push("");
	}
	for (const m of marks.slice(0, 2)) {
		L.push(section(`BEFORE / AFTER  ${m.label}`, W, c("gray", new Date(m.at).toISOString().slice(0, 16).replace("T", " ") + " UTC")));
		L.push(c("gray", `  ${pad("backend", 12)}${pad("sessions", 10)}${pad("ctx p50", 22)}${pad("ctx p95", 22)}${pad("calls >200k", 22)}${pad("weighted / session", 22)}${pad("cost above 200k", 22)}`));
		for (const b of backends) {
			const x = m.split?.[b]?.before, y = m.split?.[b]?.after;
			const n = (z) => z ? z.sessions - (z.subSessions ?? 0) : 0;
			const few = n(x) < 10 || n(y) < 10; // either side too thin = not evidence (see the noise note)
			L.push(`  ${pad(b, 12)}${pad(`${x?.sessions ?? 0}→${y?.sessions ?? 0}`, 10)}${delta(x?.ctxP50, y?.ctxP50)}${delta(x?.ctxP95, y?.ctxP95)}${delta(x?.over200k, y?.over200k, { pct: true })}${delta(x?.wPerSession, y?.wPerSession)}${delta(x?.above200k, y?.above200k, { pct: true })}${few ? c("yellow", ` <10 sessions ${n(x) < 10 ? "before" : "after"} - not yet evidence`) : ""}`);
		}
		L.push(c("gray", `  green/red = changed more than ${TOKEN_NOISE * 100}% (better/worse); grey = within normal run-to-run noise.`));
		L.push("");
	}
	// TREND
	const days = (() => {
		const all = new Set(); for (const b of Object.values(t.daily ?? {})) for (const k of Object.keys(b)) all.add(k);
		const sorted = [...all].sort(); if (!sorted.length) return [];
		const out = []; for (let x = Date.parse(sorted[0] + "T00:00:00Z"); x <= Date.parse(sorted[sorted.length - 1] + "T00:00:00Z"); x += 86400e3) out.push(new Date(x).toISOString().slice(0, 10));
		return out.slice(-Math.max(7, Math.min(28, W - 60)));
	})();
	if (days.length) {
		L.push(section("TREND", W, c("gray", `daily · ${days[0]} → ${days[days.length - 1]} · ▲ = marker`)));
		const markRow = days.map((dd) => (t.markers ?? []).some((m) => new Date(m.at).toISOString().slice(0, 10) === dd) ? c("yellow", "▲") : " ").join("");
		for (const b of backends) {
			const series = t.daily?.[b] ?? {};
			const p95 = days.map((dd) => series[dd]?.ctxP95 ?? null), cpc = days.map((dd) => series[dd] ? series[dd].weighted / series[dd].calls : null);
			const lastP95 = [...p95].reverse().find((v) => v != null), lastCpc = [...cpc].reverse().find((v) => v != null);
			L.push(`  ${pad(b, 12)}${c("gray", "ctx p95  ")}${sparkline(p95)}  ${c("gray", `last ${kfmt(lastP95)} · range ${kfmt(Math.min(...p95.filter((v) => v != null)))}–${kfmt(Math.max(...p95.filter((v) => v != null)))}`)}`);
			L.push(`  ${pad("", 12)}${c("gray", "w / call ")}${sparkline(cpc)}  ${c("gray", `last ${kfmt(lastCpc)}`)}`);
		}
		if (markRow.trim()) L.push(`  ${pad("", 12)}${" ".repeat(9)}${markRow}`);
		L.push("");
	}
	// NOW
	L.push(section("NOW (all sessions)", W));
	L.push(c("gray", `  ${pad("backend", 12)}${padL("share", 7)}${padL("ctx p50", 9)}${padL("ctx p95", 9)}${padL("ctx max", 9)}${padL(">200k", 7)}${padL("cache", 7)}${padL("w/sess", 8)}${padL("avoid", 7)}${padL("sub", 6)}${padL("$>200k", 8)}`));
	for (const b of backends) {
		const v = bb[b];
		const hot = v.above200k > 0.1 ? "red" : v.above200k > 0.03 ? "yellow" : "green";
		L.push(`  ${pad(b, 12)}${padL(pctf(v.share), 7)}${padL(kfmt(v.ctxP50), 9)}${padL(kfmt(v.ctxP95), 9)}${padL(kfmt(v.ctxMax), 9)}${padL(pctf(v.over200k), 7)}${padL(pctf(v.cacheHit), 7)}${padL(kfmt(v.wPerSession), 8)}${padL(pctf(v.leakShare), 7)}${padL(pctf(v.subShare), 6)}${c(hot, padL(pctf(v.above200k), 8))}`);
	}
	L.push("");
	L.push(section("BIGGEST RUNS", W));
	for (const [k, v] of Object.entries(s.byRun ?? {}).slice(0, 6))
		L.push(`  ${pad(k, 46)}${padL(kfmt(v.weighted), 8)}${padL(pctf(v.share), 7)}  ${c("gray", `ctx p95 ${kfmt(v.ctxP95)} · ${pctf(v.over200k)} of calls >200k`)}`);
	L.push("");
	L.push(section("HOW TO READ THIS", W));
	L.push(c("gray", "  Every call re-reads the whole context, so context size drives cost: $>200k is the share of a backend's weighted tokens"));
	L.push(c("gray", "  spent re-reading context above 200k (what compaction at HARNESS_COMPACT_AT=200000 targets). avoid = avoidable leaks"));
	L.push(c("gray", "  (big whole-file reads, unbounded output, re-reads). sub = subagents / review panel. w/sess = median per session."));
	L.push(c("gray", "  Agent cost varies up to ~50% between identical runs: trust a before/after only with 10+ sessions on each side."));
	return L;
}

export function viewEvents(d, W) {
	const L = [section("EVENTS", W, c("gray", ".pi-session/herdr-lifecycle/events.log"))];
	const color = (line) => /ERROR|FAILED|could not/.test(line) ? "red" : /NOTIFY|HUMAN|REFUS/.test(line) ? "yellow" : /PROMPT|LAUNCH /.test(line) ? "green" : /ROUTE/.test(line) ? "magenta" : /IDLE|SKIP/.test(line) ? "gray" : "reset";
	const ev = d.events.filter((l) => !/ IDLE /.test(l) || argv.includes("--all-events"));
	for (const line of ev.slice(-200).reverse()) {
		const m = line.match(/^(\S+)\s+(.*)$/);
		const t = m ? m[1].slice(5, 19).replace("T", " ") : "";
		L.push(`  ${c("gray", t)} ${c(color(line), m ? m[2] : line)}`);
	}
	if (ev.length === 0) L.push(c("gray", "  no events (idle reconciles hidden)"));
	return L;
}

// ---------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------
const VIEWS = [["Overview", viewOverview], ["Routing", viewRouting], ["Models", viewModels], ["Events", viewEvents], ["Scores", viewScores], ["Outcomes", viewOutcomes], ["Tokens", viewTokens]];
const ui = { view: Math.max(0, Math.min(VIEWS.length - 1, Number(arg("--view", 1)) - 1)), scroll: VIEWS.map(() => 0), sel: 0 };

function frame(W, H) {
	const d = collect();
	const [name, fn] = VIEWS[ui.view];
	const body = fn(d, W, ui.sel);
	const tabs = VIEWS.map(([n], i) => i === ui.view ? c("inverse bold", ` ${i + 1} ${n} `) : c("gray", ` ${i + 1} ${n} `)).join("");
	const title = c("bold", "HARNESS") + c("gray", ` · ${basename(REPO)} · ${new Date().toLocaleTimeString()}`);
	const head = [pad(title, Math.max(0, W - vlen(tabs))) + tabs, ""];
	if (ONCE) return [...head, ...body].map((l) => cut(l, W)).join("\n");
	const room = Math.max(3, H - head.length - 1);
	const maxScroll = Math.max(0, body.length - room);
	ui.scroll[ui.view] = Math.min(ui.scroll[ui.view], maxScroll);
	const shown = body.slice(ui.scroll[ui.view], ui.scroll[ui.view] + room);
	const foot = c("gray", `q quit · 1-7/tab view · j/k scroll${maxScroll ? ` (${ui.scroll[ui.view]}/${maxScroll})` : ""} · [ ] change · r refresh`);
	return [...head, ...shown, ...Array(Math.max(0, room - shown.length)).fill(""), foot].map((l) => cut(l, W)).join("\n");
}

function run() {
	const out = process.stdout;
	const draw = () => {
		const W = Math.max(60, out.columns || 100), H = Math.max(12, out.rows || 40);
		let s;
		try { s = frame(W, H); } catch (e) { s = c("red", "dashboard error: " + (e.stack || e)); }
		out.write("\x1b[H\x1b[2J" + s);
	};
	out.write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor
	const bye = () => { out.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };
	process.on("SIGINT", bye); process.on("SIGTERM", bye);
	if (usageIsOld(REPO)) refreshUsageInBackground();
	if (scoresAreOld(REPO)) refreshScoresInBackground();
	if (pricingIsOld(REPO)) refreshPricingInBackground();
	{ const oc = loadOutcomes(REPO); if (!oc?.at || Date.now() - oc.at > 10 * 60e3) refreshOutcomesInBackground(); }
	if (tokensAreOld(loadTokenCache(REPO))) refreshTokensInBackground();
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (b) => {
			const k = b.toString();
			if (k === "q" || k === "\x03") return bye();
			if (/^[1-7]$/.test(k)) ui.view = Number(k) - 1;
			else if (k === "\t") ui.view = (ui.view + 1) % VIEWS.length;
			else if (k === "j" || k === "\x1b[B") ui.scroll[ui.view] += 1;
			else if (k === "k" || k === "\x1b[A") ui.scroll[ui.view] = Math.max(0, ui.scroll[ui.view] - 1);
			else if (k === " " || k === "\x1b[6~") ui.scroll[ui.view] += 10;
			else if (k === "\x1b[5~") ui.scroll[ui.view] = Math.max(0, ui.scroll[ui.view] - 10);
			else if (k === "]") ui.sel += 1;
			else if (k === "[") ui.sel -= 1;
			else if (k === "r") { refreshUsageInBackground(); refreshScoresInBackground(); refreshPricingInBackground(); refreshOutcomesInBackground(); refreshTokensInBackground(true); loadFleet(true); }
			draw();
		});
	}
	out.on("resize", draw);
	draw();
	setInterval(() => { if (usageIsOld(REPO)) refreshUsageInBackground(); if (tokensAreOld(loadTokenCache(REPO))) refreshTokensInBackground(); draw(); }, 5000);
	// While the dashboard is open it also keeps Herdr's sidebar current and delivers any
	// pending handoff: a throttled reconcile once a minute (Herdr itself has no timer).
	const tick = () => { try { spawn(process.execPath, [join(REPO, "herdr-plugin", "lifecycle-watcher.mjs"), "--nudge", "dashboard"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: REPO } }).unref(); } catch { /* best effort */ } };
	tick(); setInterval(tick, 60000);
}

function selftest() {
	let fails = 0;
	const ok = (cond, m) => { if (!cond) { fails++; console.error("FAIL " + m); } };
	ok(vlen(c("red", "abc")) === 3, "visible length ignores colour codes");
	ok(vlen(cut("abcdefghij", 5)) === 5, "cut keeps the visible width");
	ok(vlen(pad("ab", 6)) === 6 && vlen(padL("ab", 6)) === 6, "pad / padL");
	ok(vlen(bar(50, 10)) === 10 && vlen(bar(null, 10)) === 10, "bar width is fixed");
	const d = { usage: { at: Date.now(), quotas: { gemini_weekly: { usedPct: 22, resetsAt: Date.now() + 86400e3, t: Date.now() } }, breakers: { nvidia: { events: 9, threshold: 6 } }, local: { up: false, error: "ECONNREFUSED" }, sources: {} },
		catalog: { models: [{ id: "a/b", tier: 2, cost: "free" }] }, pipeline: { mode: "live", routes: { "plan-ready": { to: "integrator" } } },
		changes: [{ id: "CHANGE-0009", list: [], last: { role: "planner", verdict: "plan-ready", at: new Date().toISOString(), note: "x" }, st: {}, done: false }], snapshot: { panes: [] }, decisions: [], events: ["2026-10-15T12:00:00Z PROMPT CHANGE-0009 x", "2026-10-15T12:00:01Z IDLE w1:p1 (idle) -> reconcile"] };
	const ov = viewOverview(d, 100).map(strip).join("\n");
	ok(/BREAKER OPEN/.test(ov) && /Gemini AI Pro · week/.test(ov) && /CHANGE-0009/.test(ov) && /down/.test(ov), "overview shows quotas, breaker, pipeline, local");
	const evs = viewEvents(d, 100).map(strip).join("\n");
	ok(/PROMPT/.test(evs) && !/IDLE/.test(evs), "events hide idle reconciles");
	const tk = { at: Date.now(), summary: { weighted: 1e6, sessions: 30, calls: 900, byBackend: { claude: { weighted: 1e6, share: 1, ctxP50: 2e5, ctxP95: 6e5, ctxMax: 8e5, over200k: 0.5, cacheHit: 0.98, wPerSession: 3e6, leakShare: 0.04, subShare: 0, above200k: 0.22 } }, byRun: { "planner [claude]": { weighted: 1e6, share: 1, ctxP95: 6e5, over200k: 0.5 } } },
		daily: { claude: { "2026-10-18": { calls: 10, weighted: 1e5, ctxP95: 6e5 }, "2026-10-20": { calls: 10, weighted: 5e4, ctxP95: 2e5 } } },
		markers: [{ at: Date.parse("2026-10-20T08:00:00Z"), label: "compaction at 200k", split: { claude: { before: { sessions: 12, ctxP50: 3e5, ctxP95: 6e5, over200k: 0.55, wPerSession: 3e6, above200k: 0.22 }, after: { sessions: 3, subSessions: 0, ctxP50: 1.5e5, ctxP95: 2.1e5, over200k: 0.05, wPerSession: 2.9e6, above200k: 0.01 } } } }] };
	const tv = viewTokens({ tokens: tk }, 160).map(strip).join("\n");
	ok(/BEFORE \/ AFTER  compaction at 200k/.test(tv) && /300k→150k -50%/.test(tv) && /<10 sessions after/.test(tv), "tokens: before/after with change % and a too-few warning");
	ok(/ctx p95  /.test(tv) && /▲/.test(tv) && /\$>200k/.test(tv), "tokens: trend sparkline, marker and NOW table");
	ok(/press r/.test(viewTokens({ tokens: null }, 100).map(strip).join("\n")), "tokens: empty state explains how to fill it");
	ok(sparkline([1, null, 8]).length >= 3 && strip(sparkline([5, 5])) === "▄▄", "sparkline");
	if (fails) { console.error(`${fails} dashboard self-test(s) FAILED`); return 1; }
	console.log("harness-dashboard self-test: all passed");
	return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	if (argv.includes("--selftest")) process.exit(selftest());
	else if (ONCE) { console.log(frame(Number(arg("--width", process.stdout.columns || 110)), 999)); process.exit(0); }
	else run();
}
