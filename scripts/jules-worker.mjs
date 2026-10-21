#!/usr/bin/env node
/**
 * jules-worker.mjs - Google Jules as a worker backend (owner, 2026-10-21). Jules runs in Google's
 * cloud against the GitHub repo and opens a pull request; this script starts the session, follows
 * it, and brings the result back into the normal harness flow (the change branch + an impl-ready
 * handoff for the integrator). Key: Keychain harness.jules (scripts/secrets.mjs).
 *
 *   node scripts/jules-worker.mjs sources                 the GitHub repos Jules can see (set one in herdr-plugin/jules.json)
 *   node scripts/jules-worker.mjs start CHANGE-NNNN       push the change branch, start a session (the watcher does this)
 *   node scripts/jules-worker.mjs poll                    follow every active session (the watcher does this every few minutes)
 *   node scripts/jules-worker.mjs status                  sessions and today's count
 *   node scripts/jules-worker.mjs reply CHANGE-NNNN <text>    answer Jules (also a notification button)
 *   node scripts/jules-worker.mjs approve-plan CHANGE-NNNN
 *   node scripts/jules-worker.mjs --selftest
 *
 * Flow: start -> Jules works from the change branch (pushed to origin) -> PR -> poll fetches the PR
 * head, fast-forwards the change branch (or its worktree) and records worker impl-ready with the
 * PR link -> the integrator reviews and merges as for any worker. A failed session records
 * worker `blocked`; questions and plan approvals reach the owner as notifications with buttons.
 * Pro plan: about 100 sessions a day; usage key jules_daily for the router.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSecret } from "./secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
const API = "https://jules.googleapis.com/v1alpha";
const DIR = join(REPO, ".pi-session", "jules");
const SESS = join(DIR, "sessions.json");
const DONE_STATES = ["COMPLETED", "FAILED"];

export function loadConfig(repo = REPO) {
	let c = {}; try { c = JSON.parse(readFileSync(join(repo, "herdr-plugin", "jules.json"), "utf8")); } catch { /* defaults */ }
	return { source: null, daily_limit: 100, require_plan_approval: false, poll_minutes: 3, remote: "origin", ...c };
}
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
export const loadSessions = (repo = REPO) => readJson(join(repo, ".pi-session", "jules", "sessions.json"), {});
const saveSessions = (s) => { mkdirSync(DIR, { recursive: true }); writeFileSync(SESS, JSON.stringify(s, null, 1)); };
const git = (args, cwd = REPO) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120e3 });

/** Is a Jules session for this change still running? (the watcher skips stall checks then) */
export function julesActive(repo, change) { const s = loadSessions(repo)[change]; return !!s && !s.handled; }
/** Sessions started in the last 24 h against the daily limit -> usage quota. Pure on its inputs. */
export function julesQuota(starts, limit, now = Date.now()) {
	const recent = starts.filter((t) => now - t < 86400e3).sort((a, b) => a - b);
	return { jules_daily: { t: now, used: recent.length, limit, usedPct: Math.round((1000 * recent.length) / limit) / 10, resetsAt: recent.length ? recent[0] + 86400e3 : null, via: "jules starts" } };
}
export function julesUsage(repo = REPO) {
	let starts = [];
	try { starts = readFileSync(join(repo, ".pi-session", "jules", "starts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).t); } catch { /* none */ }
	return julesQuota(starts, loadConfig(repo).daily_limit);
}
/** Ready to take work: key + a configured source. */
export function julesReady(repo = REPO) { return !!getSecret("jules") && !!loadConfig(repo).source; }

async function api(method, path, body) {
	const key = getSecret("jules");
	if (!key) throw new Error("no Jules key (Keychain harness.jules)");
	const r = await fetch(`${API}/${path}`, { method, headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const txt = await r.text();
	let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt }; }
	if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${j.error?.message ?? ""}`);
	return j;
}

function changeInfo(change) {
	const cd = join(REPO, "docs", "changes");
	const d = readdirSync(cd).find((x) => x.startsWith(change + "-") || x === change);
	if (!d) throw new Error(`no folder for ${change} under docs/changes`);
	const y = readFileSync(join(cd, d, "change.yaml"), "utf8");
	const f = (k) => (y.match(new RegExp(`^${k}:\\s*["']?([^"'#\\n]+?)["']?\\s*(#.*)?$`, "m")) ?? [])[1]?.trim() ?? null;
	return { dir: `docs/changes/${d}`, branch: f("branch") ?? `feature/${d}`, base: f("base_branch") ?? "main", title: f("title") ?? d, test: f("command") };
}

/** The task text Jules gets. Pure. */
export function buildPrompt(change, info) {
	return [
		`Implement ${change} ("${info.title}") in this repository.`,
		`Everything you need is in ${info.dir}/: read change.yaml first (owned_paths, requirements, test cases, risk), then the spec and any requirement or test-case files it points to. Read AGENTS.md and .pi-session/CONTEXT.md (if present) for the project's rules and layout.`,
		"Rules: change only files inside the change's owned_paths; follow the decisions in docs/decisions/; do not edit other changes' folders; keep commits small with clear messages.",
		info.test ? `Run the change's tests (${info.test}) and make them pass before you finish. Godot engine/render checks that cannot run in your environment: say so in the PR description instead of skipping silently.` : "Run the tests named in change.yaml and make them pass before you finish.",
		`Finish with a pull request into ${info.branch}. In its description list: what you changed (by requirement ID), how you tested it, and anything left open.`,
	].join("\n\n");
}

async function start(change) {
	const cfg = loadConfig();
	if (!cfg.source) throw new Error("no Jules source set - run `node scripts/jules-worker.mjs sources` and put the repo's name in herdr-plugin/jules.json as \"source\"");
	const ses = loadSessions();
	if (ses[change] && !ses[change].handled) { console.log(`${change} already has a Jules session: ${ses[change].name}`); return 0; }
	const info = changeInfo(change);
	// the change branch must exist on GitHub: Jules starts from it and opens its PR into it
	if (git(["rev-parse", "--verify", info.branch]).status !== 0) { const b = git(["branch", info.branch, info.base]); if (b.status !== 0) throw new Error(`could not create ${info.branch}: ${b.stderr}`); }
	const p = git(["push", cfg.remote, `${info.branch}:${info.branch}`]);
	if (p.status !== 0) throw new Error(`git push ${cfg.remote} ${info.branch} failed: ${p.stderr.trim().split("\n").pop()}`);
	const body = { prompt: buildPrompt(change, info), title: `${change}: ${info.title}`.slice(0, 120), sourceContext: { source: cfg.source, githubRepoContext: { startingBranch: info.branch } }, requirePlanApproval: !!cfg.require_plan_approval, automationMode: "AUTO_CREATE_PR" };
	const s = await api("POST", "sessions", body);
	ses[change] = { name: s.name, id: s.id, url: s.url ?? null, branch: info.branch, at: new Date().toISOString(), state: s.state ?? "QUEUED" };
	saveSessions(ses);
	appendFileSync(join(DIR, "starts.jsonl"), JSON.stringify({ t: Date.now(), change, session: s.name }) + "\n");
	console.log(`started ${s.name} for ${change}${s.url ? " - " + s.url : ""}`);
	return 0;
}

async function lastAgentMessage(name) {
	try { const a = await api("GET", `${name}/activities?pageSize=20`); const m = [...(a.activities ?? [])].reverse().find((x) => x.agentMessaged || x.planGenerated); return m?.agentMessaged?.agentMessage ?? (m?.planGenerated ? (m.planGenerated.plan?.steps ?? []).map((s, i) => `${i + 1}. ${s.title ?? ""}`).join("\n") : null); } catch { return null; }
}

/** Bring the PR head into the change branch (fast-forward only). */
function bringBack(change, rec, prUrl) {
	const n = (String(prUrl).match(/\/pull\/(\d+)/) ?? [])[1];
	const cfg = loadConfig();
	if (!n) return { ok: false, why: `no PR number in ${prUrl}` };
	const f = git(["fetch", cfg.remote, `pull/${n}/head`]);
	if (f.status !== 0) return { ok: false, why: `git fetch PR ${n}: ${f.stderr.trim().split("\n").pop()}` };
	const head = git(["rev-parse", "FETCH_HEAD"]).stdout.trim();
	if (git(["merge-base", "--is-ancestor", rec.branch, head]).status !== 0) return { ok: false, why: `PR #${n} is not a fast-forward of ${rec.branch} (the branch moved) - merge it by hand or let the integrator` , head };
	const wt = git(["worktree", "list", "--porcelain"]).stdout.split("\n\n").find((b) => b.includes(`branch refs/heads/${rec.branch}`));
	const wtPath = wt ? (wt.match(/^worktree (.+)$/m) ?? [])[1] : null;
	const r = wtPath ? git(["merge", "--ff-only", head], wtPath) : git(["branch", "-f", rec.branch, head]);
	return r.status === 0 ? { ok: true, head, pr: n } : { ok: false, why: `updating ${rec.branch}: ${r.stderr.trim()}`, head };
}

async function record(change, verdict, note, file) {
	const { appendEntry } = await import("./handoff.mjs");
	appendEntry(REPO, { change, role: "worker", verdict, note, file, extra: { backend: "jules" } });
}
async function notify(message, title) { try { const n = await import("./notify.mjs"); if (n.notifyRich(message, title)) return; } catch { /* */ } console.log(`NOTIFY ${title}: ${message}`); }

async function poll() {
	const ses = loadSessions();
	let changed = false;
	for (const [change, rec] of Object.entries(ses)) {
		if (rec.handled) continue;
		let s; try { s = await api("GET", rec.name); } catch (e) { console.log(`${change}: ${e.message}`); continue; }
		if (s.state !== rec.state) { console.log(`${change}: ${rec.state} -> ${s.state}`); rec.state = s.state; changed = true; }
		if ((s.state === "AWAITING_PLAN_APPROVAL" || s.state === "AWAITING_USER_FEEDBACK") && rec.asked !== s.state + (s.updateTime ?? "")) {
			rec.asked = s.state + (s.updateTime ?? ""); changed = true;
			const msg = (await lastAgentMessage(rec.name)) ?? "(see the session)";
			const reports = join(DIR, `${change}-question.md`);
			writeFileSync(reports, `# ${change}: Jules ${s.state === "AWAITING_PLAN_APPROVAL" ? "plan" : "question"}\n\n${msg}\n\nSession: ${s.url ?? rec.name}\n`);
			if (s.state === "AWAITING_PLAN_APPROVAL") await postDecision(change, "Jules has a plan - approve it?", msg, [{ label: "Approve plan", cmd: ["node", "scripts/jules-worker.mjs", "approve-plan", change] }], reports);
			else await postDecision(change, "Jules asks you", msg, [], reports);
		}
		if (s.state === "COMPLETED") {
			const pr = (s.outputs ?? []).map((o) => o.pullRequest).find(Boolean);
			const report = join(DIR, `${change}-report.md`);
			if (!pr?.url) { writeFileSync(report, `# ${change}: Jules finished without a pull request\n\nSession: ${s.url ?? rec.name}\n`); await record(change, "blocked", "Jules finished without a pull request - nothing to review", relative(REPO, report)); }
			else {
				const b = bringBack(change, rec, pr.url);
				writeFileSync(report, `# ${change}: Jules result\n\n- Pull request: ${pr.url}\n- Title: ${pr.title ?? ""}\n- Session: ${s.url ?? rec.name}\n- Change branch: ${rec.branch}${b.ok ? ` fast-forwarded to ${b.head}` : ` NOT updated: ${b.why}`}\n\n## PR description\n\n${pr.description ?? "(none)"}\n`);
				if (b.ok) await record(change, "impl-ready", `Jules PR #${b.pr} (${pr.url}) - ${rec.branch} is at ${b.head.slice(0, 9)}; review it like any worker branch`, relative(REPO, report));
				else await record(change, "blocked", `Jules PR ${pr.url} could not be brought into ${rec.branch}: ${b.why}`, relative(REPO, report));
			}
			rec.handled = new Date().toISOString(); rec.pr = pr?.url ?? null; changed = true;
		}
		if (s.state === "FAILED") {
			const report = join(DIR, `${change}-report.md`);
			writeFileSync(report, `# ${change}: Jules session failed\n\nSession: ${s.url ?? rec.name}\n\n${(await lastAgentMessage(rec.name)) ?? ""}\n`);
			await record(change, "blocked", "the Jules session failed - re-route the change to another worker", relative(REPO, report));
			rec.handled = new Date().toISOString(); changed = true;
		}
	}
	if (changed) saveSessions(ses);
	writeFileSync(join(DIR, "last-poll"), new Date().toISOString());
	return 0;
}
async function postDecision(change, title, msg, suggestions, file) {
	try {
		const n = await import("./notify.mjs");
		if (n.appInstalled()) { n.post({ kind: "decision", title: `${change}: ${title}`, body: String(msg).slice(0, 300), change, file, suggestions, reply: { label: "Reply…", placeholder: "Your answer to Jules", cmd: ["node", "scripts/jules-worker.mjs", "reply", change] } }); return; }
	} catch { /* */ }
	await notify(`${change}: ${title} - ${String(msg).slice(0, 150)} (answer: node scripts/jules-worker.mjs reply ${change} '<text>')`, "Jules");
}

async function main() {
	const [cmd, a1, ...rest] = process.argv.slice(2);
	if (cmd === "--selftest") return selftest();
	if (cmd === "sources") { const j = await api("GET", "sources?pageSize=50"); for (const s of j.sources ?? []) console.log(`${s.name}   ${s.githubRepo ? `${s.githubRepo.owner}/${s.githubRepo.repo}` : ""}`); if (!(j.sources ?? []).length) console.log("no sources - install the Jules GitHub app on the repo at jules.google.com"); return 0; }
	if (cmd === "start") return start(a1);
	if (cmd === "poll") return poll();
	if (cmd === "status") { const u = julesUsage().jules_daily; console.log(`today: ${u.used}/${u.limit} sessions`); for (const [c, r] of Object.entries(loadSessions())) console.log(`${c.padEnd(12)} ${String(r.state).padEnd(24)} ${r.handled ? "done" : "active"}  ${r.url ?? r.name}`); return 0; }
	const rec = loadSessions()[a1];
	if ((cmd === "reply" || cmd === "approve-plan") && !rec) { console.error(`no Jules session for ${a1}`); return 1; }
	if (cmd === "reply") { await api("POST", `${rec.name}:sendMessage`, { prompt: rest.join(" ") }); console.log("sent"); return 0; }
	if (cmd === "approve-plan") { await api("POST", `${rec.name}:approvePlan`, {}); console.log("plan approved"); return 0; }
	console.error("usage: jules-worker.mjs sources | start CHANGE-NNNN | poll | status | reply CHANGE-NNNN <text> | approve-plan CHANGE-NNNN | --selftest");
	return 2;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const p = buildPrompt("CHANGE-0030", { dir: "docs/changes/CHANGE-0030-x", branch: "feature/CHANGE-0030-x", title: "X", test: "bash godot-project/tests/run_qualification.sh x" });
	ok(p.includes("docs/changes/CHANGE-0030-x/") && p.includes("owned_paths") && p.includes("into feature/CHANGE-0030-x") && p.includes("run_qualification.sh x"), "prompt names folder, rules, PR target and tests");
	const now = Date.UTC(2026, 9, 21, 12);
	const q = julesQuota([now - 25 * 3600e3, now - 3600e3, now - 7200e3], 100, now).jules_daily;
	ok(q.used === 2 && q.usedPct === 2 && q.resetsAt === now - 7200e3 + 86400e3, "daily count is a rolling 24 h");
	if (fails) { console.error(`${fails} jules-worker self-test(s) FAILED`); return 1; }
	console.log("jules-worker self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c ?? 0), (e) => { console.error(e.message); process.exit(1); });
