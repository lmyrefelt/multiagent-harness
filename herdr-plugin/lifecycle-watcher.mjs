#!/usr/bin/env node
//
// harness-lifecycle-watcher - routes the planner -> integrator -> worker loop
// in Herdr so the owner does not have to relay every turn by hand.
//
// v2 DESIGN (2026-10-13). What was borrowed, and from where (ideas only; no
// code copied):
//   - "Agents report, the dispatcher moves" (virtualboard/herdr-virtualboard,
//     marvingygas/spoolway): an agent ends its turn with
//     `node scripts/handoff.mjs report ... --verdict <v>`; this file decides
//     who goes next from herdr-plugin/pipeline.json. v1 inferred the next turn
//     from change.yaml `status` on main, which was never updated during
//     planning (it lives on planning/*), so nothing ever fired.
//   - Routing table with loop-back + bounded rounds (spoolway on_pass/on_fail,
//     `loop: N`) -> pipeline.json `routes` + `max_rounds`.
//   - Prompt the LIVE session instead of relaunching it (native
//     `herdr agent prompt`, as used by KarthusLorin/herdr-turn-coordinator):
//     the planner/integrator keep their context between rounds. Never resend
//     blindly - a failed delivery is reported to the owner, not retried.
//   - Pane registry instead of label parsing (GODVvVZzz/herdr-agent-chat's
//     manifest, ribbons-digital/pi-herd's run dir); labels are only a
//     fallback, matched case-insensitively (v1's case-sensitive regex never
//     matched herdr-launch.sh's lowercased integrator labels).
//   - Idle-without-report -> one reminder after a delay, then the owner
//     (ellingtonsp/herdr-orch). Never auto-redispatch on silence.
//   - React to pane.exited / pane.closed to keep the registry honest
//     (herdr-agent-chat's guardian).
//
// WHAT THIS STILL DOES NOT DO (unchanged from v1, on purpose)
//   - Decide whether a merge is safe: integrator_merge_gate does that.
//   - Edit change.yaml: the roles keep owning status per COORDINATION.md.
//   - Guess: an unknown pane, unknown verdict or unreadable ledger is logged
//     and left alone.
//
// Every decision is appended to .pi-session/herdr-lifecycle/events.log.
// pipeline.json `mode: "dry-run"` (the default) logs what WOULD happen and
// touches nothing - flip it to "live" once the log looks right.
//
//   node lifecycle-watcher.mjs                 (Herdr event hook; reads HERDR_PLUGIN_EVENT_JSON)
//   node lifecycle-watcher.mjs --reconcile     run once by hand (also: node scripts/handoff.mjs reconcile)
//   node lifecycle-watcher.mjs --panes         show Herdr panes and the role each maps to
//   node lifecycle-watcher.mjs --selftest
//
import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodeOs from "node:os";
import { readChangeConfig } from "../scripts/verify-change.mjs";
import { decideForChange, logDecision, usageIsOld, loadUsage, loadCatalog } from "../scripts/route-worker.mjs";
import { superviseChange, pendingDeps, yamlReader, syncWorker, triageMarkdown, latestQualifyTail, eventsFor, writeTriage, buildStatus, writeStatus, digestText, digestDue, phaseOf, DEFAULTS as SUPERVISOR_DEFAULTS, detectLimit, backendOfAgent, recordLimit, loadLimits, pickFallbackBackend, capacity, windowResets, capacityMarkdown, waitOrMove, writeHandoffBrief, paceLevel, detectProviderError, providerErrorPersists, integratorUnresponsive, newestSessionLog, freshOrContinue, sessionHealth } from "../scripts/harness-supervisor.mjs";
import { lastActivity, describeQuiet } from "../scripts/activity-probe.mjs";
import { notifyRich, appInstalled as notifyAppInstalled } from "../scripts/notify.mjs";
import { julesActive, loadSessions as julesSessions, loadConfig as julesConfig } from "../scripts/jules-worker.mjs";
import { sessionMeters, loadMeterCache, saveMeterCache, contextWindowFrom, paneLimit, paneMeterTokens, usageBlock, quotaAlerts } from "../scripts/usage-meters.mjs";
import { discoverSessionDirs, aggregateSessionDir, mergeFleet } from "../scripts/fleet-status.mjs";
import {
  ROLES, VERDICTS_BY_ROLE, normChange, discoverTrees, findChangeDir, readAllEntries,
  loadRegistry, forgetPane, withLock, readJson, writeJsonAtomic, statePath, logEvent, appendEntry,
} from "../scripts/handoff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEEKLY_QUOTA_FLOOR_PCT = 20;
const SNAPSHOT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LOCAL_MODEL_RAM_BYTES = 22 * 1024 ** 3; // rough estimate, see COORDINATION.md
const LOCAL_CAPACITY_SAFETY_MARGIN_PCT = 20;

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export function unwrapEventPayload(envelope) {
  if (!envelope || typeof envelope !== "object") return {};
  return envelope.data ?? envelope;
}

/** First value of `key` anywhere in the event (breadth-first). 2026-10-13 REAL INCIDENT:
 *  Herdr 0.9.3 delivered pane_id/agent_status nested deeper than `.data`, so the
 *  flat read found nothing and the hook silently did nothing on every event. */
export function findField(obj, key) {
  const queue = [obj];
  while (queue.length) {
    const o = queue.shift();
    if (!o || typeof o !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(o, key) && (typeof o[key] === "string" || typeof o[key] === "number")) return String(o[key]);
    for (const v of Object.values(o)) if (v && typeof v === "object") queue.push(v);
  }
  return undefined;
}

/** "pane.agent_status_changed" and "pane_agent_status_changed" -> "pane_agent_status_changed". */
export const eventKey = (name) => (name ? String(name).trim().toLowerCase().replace(/[.\-]/g, "_") : "");

/** pane id + agent status + event name from whatever shape Herdr sends. */
export function readHookEvent(envelope, envEventName) {
  const data = unwrapEventPayload(envelope);
  const event = (typeof envelope?.event === "string" ? envelope.event : null) ?? (typeof envelope?.type === "string" ? envelope.type : null) ?? envEventName ?? null;
  const paneId = data.pane_id ?? findField(envelope, "pane_id");
  const agentStatus = data.agent_status ?? findField(envelope, "agent_status") ?? findField(envelope, "status");
  return { event, paneId, agentStatus };
}

/** Role + change for one Herdr pane: registry first, label as fallback. */
export function roleOfPane(pane, registry = {}) {
  const reg = registry[pane.pane_id];
  if (reg && ROLES.includes(reg.role)) return { role: reg.role, change: reg.change ?? null, source: "registry" };
  const label = String(pane.label ?? "");
  const m = /(?:^|[-_])(planner|integrator|worker)(?:[-_]|$)/i.exec(label);
  if (!m) return { role: null, change: null, source: null };
  return { role: m[1].toLowerCase(), change: normChange(label), source: "label" };
}

const STARTING_GRACE_MS = 120 * 1000;

/** Role/change plus liveness. A pane is `alive` when Herdr detects an agent in it;
 *  a freshly launched pane gets STARTING_GRACE_MS before it counts as dead.
 *  2026-10-13 REAL INCIDENT: a worker launch died with "permission denied", the
 *  pane stayed behind as a plain shell, and it kept being treated as "the
 *  CHANGE-0001 worker" - blocking the change and making a second approval look
 *  like it would launch a duplicate. */
export function annotatePanes(panes, registry = {}, now = Date.now(), building = false) {
  return (panes ?? []).map((p) => {
    const r = roleOfPane(p, registry);
    const regAt = registry[p.pane_id]?.at ? Date.parse(registry[p.pane_id].at) : null;
    const alive = Boolean(p.agent) || (p.agent_status != null && p.agent_status !== "unknown");
    // still starting: inside the grace period, or an image build (ensure-image.sh) is running
    const starting = !alive && regAt != null && (now - regAt < STARTING_GRACE_MS || building);
    return { ...p, ...r, alive, starting };
  });
}

const READY = new Set(["idle", "done"]);

export function fillTemplate(tpl, vars) {
  return String(tpl ?? "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
}

/** Pick the pane that should receive work for (role, change). */
export function pickTargetPane(panes, role, change) {
  // Dead panes (no agent, past the start-up grace) are never targets: the role
  // gets a fresh launch instead. A pane still starting up is a target (-> defer).
  const cands = panes.filter((p) => p.role === role && (role !== "worker" || p.change === change) && (p.alive !== false || p.starting));
  if (!cands.length) return null;
  const score = (p) => (p.change === change ? 4 : p.change == null ? 2 : 0) + (p.source === "registry" ? 1 : 0) + (READY.has(p.agent_status) ? 1 : 0);
  return [...cands].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Retire a change's worker once the integrator has MERGED it: stop its
 * container and close its Herdr pane. Pure. Only `merged` counts - after
 * impl-ready the integrator may still send impl-changes-requested back to the
 * same worker. A worker pane that is still `working` is left alone (retried on
 * a later idle event). Disable with pipeline.close_worker_on_merge: false.
 * Returns { action: "none" } | { action: "defer" } | { action: "retire", panes, entryId }.
 */
export function planRetire({ change, entries, cstate = {}, panes = [], pipeline = {} }) {
  if (pipeline.close_worker_on_merge === false) return { action: "none" };
  const last = entries?.[entries.length - 1];
  if (!last || last.verdict !== "merged") return { action: "none" };
  if (cstate.retired === last.id) return { action: "none" };
  const mine = panes.filter((p) => p.role === "worker" && p.change === change);
  if (mine.some((p) => p.alive && p.agent_status === "working")) return { action: "defer", entryId: last.id };
  return { action: "retire", panes: mine.map((p) => p.pane_id), entryId: last.id };
}

/**
 * Auto-continue after a TRANSIENT model/API error. Pure.
 * 2026-10-16: agents stopped dead on "Error: Retry failed after 3 attempts: A
 * Timeout Occurred" and sat idle until the owner typed "continue". On an idle
 * event the watcher reads the pane's last lines; if the error is at the very
 * bottom (not scrolled history) it sends `continue` - at most max_per_hour per
 * pane, and never twice for the exact same screen (no loop on a hard failure).
 * Returns { action: "none" } | { action: "continue", sig, message } | { action: "notify", message }.
 */
export const DEFAULT_TRANSIENT_ERRORS = [
  "Retry failed after \\d+ attempts",
  "A Timeout Occurred",
  "\\b(timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up)\\b",
  "\\b(429|502|503|504|529)\\b.*(error|status|too many|overloaded|unavailable|gateway)",
  "\\b(overloaded|rate.?limit(ed)?|Service Unavailable|Bad Gateway|stream (error|disconnected))\\b",
  "\\b(Internal Server Error|InternalServerError|server_error|APIError)\\b|\\b500\\b.{0,40}(error|status|server)",
];
// A completion hard stop is a failed obligation, never a transient API error.
export function completionGateStop(tail) {
  const bottom = String(tail ?? "").split("\n").slice(-16).join(" ").replace(/\s+/g, " ");
  const hit = bottom.match(/CONTRACT GATE \([^)]*\)\s*[-–—]\s*STOPPED after \d+ attempts:[\s\S]*?This run did NOT complete/i);
  return hit ? hit[0] : null;
}

export function planAutoContinue({ tail, history = {}, cfg = {}, now = Date.now() }) {
  if (completionGateStop(tail)) return { action: "none" };
  if (cfg.enabled === false) return { action: "none" };
  const lines = String(tail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const bottom = lines.slice(-(cfg.bottom_lines ?? 6)).join("\n");
  const pats = (cfg.patterns ?? DEFAULT_TRANSIENT_ERRORS).map((x) => new RegExp(x, "i"));
  if (!pats.some((re) => re.test(bottom))) return { action: "none" };
  const sig = bottom.slice(-400);
  if (history.lastSig === sig) return { action: "none" };           // screen unchanged since our last continue
  const max = cfg.max_per_hour ?? 3;
  const recent = (history.sent ?? []).filter((t) => now - t < 3600e3);
  if (recent.length >= max) {
    if (history.notifiedSig === sig) return { action: "none" };
    return { action: "notify", sig, message: `pane hit a transient error ${recent.length + 1} times within an hour and auto-continue gave up - have a look: ${lines[lines.length - 1].slice(0, 160)}` };
  }
  return { action: "continue", sig, message: cfg.message ?? "continue" };
}

/** Docker container names launch-worker.sh gives this change: harness-<change>[-label][-NN]. */
export function workerContainerPattern(change) {
  return new RegExp(`^harness-${String(change).toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}(-|$)`);
}

/**
 * The routing decision for ONE change. Pure: no fs, no Herdr, no clock.
 * Returns { action, ... , stateUpdate } where action is one of
 *   none | defer | prompt | launch | notify
 */
export function planDispatch({ change, entries, cstate = {}, panes = [], pipeline, now, reportCounts = null }) {
  const last = entries?.[entries.length - 1];
  if (!last) return { action: "none", reason: "no handoff entries" };
  if ((cstate.dispatched ?? []).includes(last.id)) return { action: "none", reason: `latest entry ${last.id} already routed` };

  let route = pipeline.routes?.[last.verdict];
  // to: "requester" -> back to whichever role asked (runner entries carry requested_by).
  if (route?.to === "requester") {
    const who = ["worker", "integrator"].includes(last.requested_by) ? last.requested_by : "integrator";
    route = { ...route, ...(route.by_requester?.[who] ?? {}), to: who };
  }
  // to: "asker" -> the role whose question this answers
  if (route?.to === "asker") {
    const q = [...entries.slice(0, -1)].reverse().find((e) => e.verdict === "question" || e.verdict === "needs-human");
    route = { ...route, to: ["planner", "integrator", "worker"].includes(q?.role) ? q.role : "integrator" };
  }
  // routes[<verdict>].by_role.<role>: e.g. a WORKER's "blocked" goes to the integrator, a planner's to the owner
  if (route?.by_role?.[last.role]) route = { ...route, ...route.by_role[last.role] };
  const done = (extra = {}) => ({ dispatched: [...(cstate.dispatched ?? []), last.id].slice(-200), ...extra });
  if (!route) return { action: "notify", entry: last, message: `${change}: unknown verdict '${last.verdict}' from ${last.role} - not routed`, stateUpdate: done() };

  // The reporting agent must have finished its turn (it reports as its LAST action; wait for it to settle).
  const sourceBusy = panes.some((p) => p.role === last.role && (last.role !== "worker" || p.change === change) && p.agent_status === "working");
  if (sourceBusy) return { action: "defer", entry: last, reason: `${last.role} pane still working after reporting ${last.verdict}` };

  const rounds = { plan: 0, impl: 0, ...(cstate.rounds ?? {}) };
  // Report paths are stored repo-relative; every container mounts the main checkout at /repo.
  const reportPath = last.file ? (last.file.startsWith("/") ? last.file : `/repo/${last.file}`) : "";
  const branch = last.tree_branch || "its branch";
  const vars = {
    change, role: last.role, verdict: last.verdict, note: last.note || "(no note)",
    note_hint: last.note ? ` - "${last.note}"` : "",
    file: reportPath, file_hint: reportPath ? ` Read their report first: ${reportPath}.` : "",
    branch, sha: last.sha ? ` @ ${last.sha}` : "",
    report: `${pipeline.report_cmd ?? "node /repo/scripts/handoff.mjs report"} --change ${change}`,
    new: `${pipeline.new_cmd ?? "node /repo/scripts/handoff.mjs new"} --change ${change}`,
  };

  if (route.to === "human") {
    return { action: "notify", entry: last, message: fillTemplate(route.notify, vars), stateUpdate: done({ awaiting: null }) };
  }

  // Host job (scripts/godot-qualify.mjs etc.): run on this machine, never in an agent pane.
  // The job records its own verdict (role runner), which the next idle event routes.
  if (route.to === "runner") {
    return { action: "run", entry: last, command: route.command, message: fillTemplate(route.notify ?? "{change}: running host job", vars), stateUpdate: done({ awaiting: null }) };
  }

  // A round is a NEW report from the reporting side answered with a rejection. A re-send of the
  // same instruction (watchdog/stall nudges, integrator repeating itself) is not a new round
  // (2026-10-20: CHANGE-0020 hit "10 rounds" on re-sends and the worker never got the fix list).
  let roundMark = cstate.roundMark ?? {};
  if (route.loop) {
    const reporter = route.loop === "plan" ? "planner" : "worker";
    const prevReport = [...entries.slice(0, -1)].reverse().find((e) => e.role === reporter || (route.loop === "impl" && e.role === "runner"));
    const isNewRound = !prevReport || roundMark[route.loop] !== prevReport.id;
    const max = pipeline.max_rounds?.[route.loop] ?? 5;
    if (isNewRound && rounds[route.loop] >= max) {
      // owner 2026-10-22: at the impl round limit the worker writes a handover, its session ends and a
      // FRESH worker continues from that handover + the integrator's latest review (fresh_restarts times,
      // then the owner decides). The restart itself happens in reconcile (capHandover).
      const restarts = cstate.capRestarts ?? 0;
      const maxRestarts = pipeline.round_cap?.fresh_restarts ?? 2;
      if (route.loop === "impl" && route.to === "worker" && restarts < maxRestarts) {
        const dir = last.file ? last.file.replace(/\/[^/]+$/, "") : null;
        const hfile = dir ? `${dir}/worker-handover-cap-${restarts + 1}.md` : `.pi-session/handover-${change}-cap-${restarts + 1}.md`;
        const base = fillTemplate(route.prompt, { ...vars, round: "1 (fresh worker)" }).replace(/[^\x20-\x7E]/g, " ");
        const cap = { entry: last.id, since: now, file: hfile, review: last.file ?? null, text: base, restart: restarts + 1, asked: false };
        const wp = pickTargetPane(panes, "worker", change);
        if (wp && READY.has(wp.agent_status)) {
          const ask = `[handoff] ${change}: the round limit is reached (${rounds.impl} implementation rounds without the integrator accepting). Do NOT continue fixing. Write a handover for the worker who takes over to /repo/${hfile}: (1) what is done and committed, (2) every open finding from the integrator's latest review${reportPath ? ` (${reportPath})` : ""} by ID with its status, (3) what you tried that did not work and why, (4) what you would do next. Commit nothing else. When the file is written, stop - your session ends and a fresh worker continues from it.`;
          return { action: "prompt", capAsk: true, entry: last, pane: wp.pane_id, role: "worker", text: ask, stateUpdate: done({ awaiting: null, capHandover: { ...cap, asked: true } }) };
        }
        if (wp) return { action: "defer", entry: last, reason: "round limit: waiting for the worker to settle before asking for its handover" };
        // no worker pane: nothing to ask - reconcile starts the fresh worker from the review + harness brief
        return { action: "cap-handover", entry: last, stateUpdate: done({ awaiting: null, capHandover: cap }) };
      }
      return { action: "notify", entry: last, message: `${change}: ${rounds[route.loop]} ${route.loop} rounds without agreement (max ${max}) - needs you. Last: ${last.role} ${last.verdict}${vars.note_hint}. To let it continue: node herdr-plugin/lifecycle-watcher.mjs --retry ${change}`, stateUpdate: done({ awaiting: null, capped: last.id }) };
    }
    if (isNewRound) { rounds[route.loop] += 1; if (prevReport) roundMark = { ...roundMark, [route.loop]: prevReport.id }; }
  }
  // A loop route (a rejection) has just bumped its counter; a forward route
  // reports the round the reviewer is about to look at.
  vars.round = String(route.loop ? rounds[route.loop] : rounds[last.verdict.startsWith("plan") ? "plan" : "impl"] + 1);
  // Prefer the round the numbered report files show (planner-handoff-N /
  // integrator-review-N / worker-handoff-N), so prompt, sidebar and file names agree
  // even for rounds that happened before the watcher was counting.
  if (reportCounts) vars.round = String(last.verdict.startsWith("plan") ? (reportCounts.reviews ?? 0) + 1 : (reportCounts.worker ?? 0) + (last.verdict === "impl-changes-requested" ? 1 : 0) || 1);
  const text = fillTemplate(route.prompt, vars).replace(/[^\x20-\x7E]/g, " ");

  const target = pickTargetPane(panes, route.to, change);
  const awaiting = { role: route.to, change, since: now, entry: last.id, pane: target?.pane_id ?? null, reminded: false, reminderScheduled: false, escalated: false };

  if (target && route.delivery !== "launch-always") {
    if (READY.has(target.agent_status)) {
      return { action: "prompt", entry: last, pane: target.pane_id, role: route.to, text, stateUpdate: done({ rounds, awaiting, roundMark }) };
    }
    if (target.agent_status === "blocked") {
      return { action: "notify", once: `blocked:${last.id}`, entry: last, message: `${change}: ${route.to} pane ${target.pane_id} is waiting on an approval/question - answer it and the handoff (${last.verdict}) will be delivered on its next idle.`, stateUpdate: null };
    }
    return { action: "defer", entry: last, reason: `target ${route.to} pane ${target.pane_id} is '${target.agent_status ?? "unknown"}' - will deliver when it settles` };
  }
  return { action: "launch", entry: last, role: route.to, text, stateUpdate: done({ rounds, awaiting, roundMark }) };
}

/** Should an idle pane get a "you forgot to report" reminder? Pure. */
export function planReminder({ pane, cstate, entries }) {
  const aw = cstate?.awaiting;
  if (!aw || aw.role !== pane.role) return { action: "none" };
  if (pane.role === "worker" && pane.change && pane.change !== aw.change) return { action: "none" };
  if (aw.pane && aw.pane !== pane.pane_id) return { action: "none" };
  const reported = (entries ?? []).some((e) => e.role === aw.role && e.at > aw.since);
  if (reported) return { action: "none" };
  if (aw.escalated) return { action: "none" };
  if (aw.reminded) return { action: "notify", message: `${aw.change}: the ${aw.role} went idle twice without recording a handoff - have a look at pane ${pane.pane_id}.` };
  if (aw.reminderScheduled) return { action: "none" };
  return { action: "schedule" };
}

// --- backend routing (unchanged from v1, now filtered by pipeline.auto_backends) ---

export function buildWeeklySnapshots(fleet) {
  const out = {};
  if (fleet?.rateLimit?.seven_day_pct != null) out.weekly_claude = { usedPct: fleet.rateLimit.seven_day_pct, t: fleet.rateLimit.t };
  if (fleet?.quota?.quota) {
    const weeklyKey = Object.keys(fleet.quota.quota).find((k) => /weekly/i.test(k));
    if (weeklyKey) out.weekly_gemini = { usedPct: fleet.quota.quota[weeklyKey].used_pct, t: fleet.quota.t };
  }
  return out;
}

export function hasLocalCapacity({ freeBytes, totalBytes, requiredBytes = DEFAULT_LOCAL_MODEL_RAM_BYTES, safetyMarginPct = LOCAL_CAPACITY_SAFETY_MARGIN_PCT }) {
  if (typeof freeBytes !== "number" || typeof totalBytes !== "number" || !Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return true;
  return freeBytes >= requiredBytes + totalBytes * (safetyMarginPct / 100);
}

export function readSystemMemory(osModule = nodeOs) {
  try { return { freeBytes: osModule.freemem(), totalBytes: osModule.totalmem() }; } catch { return { freeBytes: null, totalBytes: null }; }
}

export function defaultOrder(riskTier) {
  return riskTier === "high" || riskTier === "critical" ? ["claude", "codex"] : ["antigravity", "local", "pi", "claude", "codex"];
}

export function pickBackend({ riskTier, snapshots, localAvailable = true, now = Date.now(), weeklyFloorPct = WEEKLY_QUOTA_FLOOR_PCT, staleMs = SNAPSHOT_STALE_MS, order: orderOverride, quotaKeyFor: quotaKeyForOverride }) {
  const order = orderOverride ?? defaultOrder(riskTier);
  const quotaKeyFor = quotaKeyForOverride ?? { antigravity: "weekly_gemini", claude: "weekly_claude" };
  const isAvailable = (backend) => {
    if (backend === "local") return localAvailable;
    const key = quotaKeyFor[backend];
    if (!key) return true;
    const snap = snapshots?.[key];
    if (!snap) return true;
    if (now - snap.t > staleMs) return true;
    return (100 - snap.usedPct) >= weeklyFloorPct;
  };
  for (const backend of order) if (isAvailable(backend)) return { backend, escalate: false, reason: `${backend} selected (risk=${riskTier ?? "unknown"})` };
  return { backend: null, escalate: true, reason: `no eligible backend clears the ${weeklyFloorPct}% weekly quota floor for a ${riskTier}-risk change - escalating` };
}

/** pipeline.worker_backend_by_risk -> concrete backend (or escalate). Pure apart from injected inputs. */
export function chooseWorkerBackend({ riskTier, pipeline, snapshots = {}, localAvailable = false }) {
  const tier = riskTier || "medium";
  const rule = pipeline.worker_backend_by_risk?.[tier] ?? "auto";
  if (rule === "human") return { backend: null, escalate: true, reason: `${tier}-risk change: pipeline.json says a human launches the worker` };
  if (rule !== "auto") return { backend: rule, escalate: false, reason: `pipeline.json pins ${tier} -> ${rule}` };
  const allowed = pipeline.auto_backends ?? ["pi", "claude", "codex"];
  const order = defaultOrder(tier).filter((b) => allowed.includes(b === "local" ? "pi" : b));
  if (!order.length) return { backend: null, escalate: true, reason: `no backend in auto_backends [${allowed}] is eligible for ${tier} risk` };
  const r = pickBackend({ riskTier: tier, snapshots, localAvailable, order });
  return { ...r, backend: r.backend === "local" ? "pi" : r.backend };
}

// --- sidebar (display only) -------------------------------------------------
// Herdr renders pane tokens as `$name` in agent rows and workspace tokens in
// space rows (~/.config/herdr/config.toml, see herdr-plugin/sidebar.config.toml).
// Tokens: $role $change $round $branch $model $handoff (pane), $pipeline (space).

export const SIDEBAR_SOURCE = "harness-handoff";
const NEXT_TASK = { "plan-ready": "review plan", "plan-changes-requested": "revise plan", "plan-approved": "implement", "impl-ready": "review code", "impl-changes-requested": "fix code", "needs-decision": "decide" };

/** "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" -> "nemotron-3-ultra-550b-a55b (free)" */
export function shortModel(id) {
  if (!id) return "";
  let s = String(id).trim();
  const free = /:free$/i.test(s);
  s = s.replace(/:free$/i, "");
  s = s.slice(s.lastIndexOf("/") + 1);
  return (free ? `${s} (free)` : s).slice(0, 60);
}

/** Who acts next on a change, from its newest ledger entry. */
export function nextRoleFor(last, pipeline) {
  if (!last) return null;
  return pipeline.routes?.[last.verdict]?.to ?? "human";
}

/** "integrator-integrator-pi" for label "pi-integrator-integrator-pi"; worker -> its change id. */
function paneNamePart(pane) {
  const m = /(planner|integrator|worker)[-_](.+)$/i.exec(String(pane.label ?? ""));
  return m ? `${m[1]}-${m[2]}`.toLowerCase() : null;
}

/** Match a pane to the pi session directory it writes (gives branch + model). */
export function sessionForPane(pane, sessions) {
  if (!pane.role) return null;
  const name = paneNamePart(pane);
  const ch = pane.change ? pane.change.toLowerCase() : null;
  const cands = sessions.filter((s) => {
    const n = s.name.toLowerCase();
    if (pane.role === "worker") return ch && n.includes(ch);
    return name ? n.endsWith(name) : n.includes(pane.role);
  });
  return cands.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0] ?? null;
}

/**
 * Pure: every token to show, per pane and per workspace.
 * @returns { panes: {paneId: {role, change, round, branch, model, handoff}}, workspaces: {wsId: {pipeline}} }
 */
export function computeSidebar({ panes, byChange, state = {}, pipeline, sessions = [], reviewCounts = {}, meters = {}, usage = null, catalog = null, now = Date.now() }) {
  const lastOf = (c) => { const l = byChange.get(c) ?? []; return l[l.length - 1] ?? null; };
  const changes = [...byChange.keys()];
  const roundOf = (c) => {
    const last = lastOf(c);
    if (last?.verdict === "merged") return "done";
    const impl = last && /^impl-/.test(last.verdict) || last?.verdict === "plan-approved" || last?.role === "worker";
    return impl ? `impl r${(state.changes?.[c]?.rounds?.impl ?? 0) + 1}` : `plan r${(reviewCounts[c] ?? 0) + 1}`;
  };
  const changeForPane = (p) => {
    if (p.role === "worker") return p.change;
    const byRecency = [...changes].sort((a, b) => ((lastOf(b)?.at ?? "") > (lastOf(a)?.at ?? "") ? 1 : -1));
    return byRecency.find((c) => nextRoleFor(lastOf(c), pipeline) === p.role)
      ?? byRecency.find((c) => (byChange.get(c) ?? []).some((e) => e.role === p.role))
      ?? byRecency[0] ?? null;
  };

  const out = { panes: {}, workspaces: {} };
  for (const p of panes) {
    if (!p.role) continue;
    const change = changeForPane(p);
    const last = change ? lastOf(change) : null;
    const next = nextRoleFor(last, pipeline);
    const sess = sessionForPane(p, sessions);
    let handoff = "";
    if (last) {
      if (next === p.role) handoff = `> your turn: ${NEXT_TASK[last.verdict] ?? last.verdict}`;
      else if (next === "human") handoff = `waiting on you (${last.verdict})`;
      else handoff = `waiting on ${next}`;
    }
    out.panes[p.pane_id] = {
      role: p.role,
      change: change ?? "",
      round: change ? roundOf(change) : "",
      branch: sess?.branch ?? (p.role === "integrator" ? "main" : ""),
      model: shortModel(sess?.model),
      handoff,
      // usage meters (scripts/usage-meters.mjs): context in use, prompt-cache hit rate, tightest quota
      ...paneMeterTokens(sess ? meters[sess.dir] : null),
      limit: sess && usage && catalog ? paneLimit(catalog, usage, meters[sess.dir]?.provider, meters[sess.dir]?.model ?? sess.model, now) : "",
    };
    if (p.workspace_id) out.workspaces[p.workspace_id] ??= {};
  }
  const summary = changes
    .filter((c) => lastOf(c)?.verdict !== "merged")
    .map((c) => { const n = nextRoleFor(lastOf(c), pipeline); return `${c} ${roundOf(c)}: ${n === "human" ? "you" : n}`; })
    .join(" | ");
  for (const ws of Object.keys(out.workspaces)) out.workspaces[ws] = { pipeline: summary };
  // Account usage block on ONE workspace row (the integrator's, else the first): the same
  // numbers on every workspace would just repeat. Configure: pipeline.sidebar.usage_workspace.
  if (usage) {
    const home = pipeline?.sidebar?.usage_workspace
      ?? panes.find((p) => p.role === "integrator" && p.workspace_id)?.workspace_id
      ?? Object.keys(out.workspaces).sort()[0];
    if (home) {
      out.workspaces[home] ??= { pipeline: summary };
      const block = usageBlock(usage, now);
      for (let i = 1; i <= 5; i++) out.workspaces[home][`usage_${i}`] = block[`usage_${i}`] ?? "";
      out.workspaces[home].usage_hdr = block.usage_hdr ?? "";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Herdr / host glue
// ---------------------------------------------------------------------------

function herdrBin() {
  if (process.env.HERDR_BIN_PATH && existsSync(process.env.HERDR_BIN_PATH)) return process.env.HERDR_BIN_PATH;
  if (process.env.HERDR_BIN && existsSync(process.env.HERDR_BIN)) return process.env.HERDR_BIN;
  const ptr = join(process.env.HARNESS_CONFIG_ROOT || join(nodeOs.homedir(), ".harness", "config"), "herdr", "bin_path");
  try { const p = readFileSync(ptr, "utf8").trim(); if (p && existsSync(p)) return p; } catch { /* fall through */ }
  return "herdr";
}

function herdr(args, { timeoutMs = 15000 } = {}) {
  try {
    const out = execFileSync(herdrBin(), args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const j = out.trim() ? JSON.parse(out.trim().split("\n").pop()) : {};
    if (j.error) return { ok: false, error: j.error.code || j.error.message || "error", raw: out };
    return { ok: true, result: j.result ?? j };
  } catch (e) {
    const txt = String(e.stderr || e.stdout || e.message || "");
    let code = txt.trim().slice(0, 300);
    try { const j = JSON.parse(txt.trim().split("\n").pop()); code = j.error?.code || j.error?.message || code; } catch { /* plain text */ }
    return { ok: false, error: code };
  }
}

/** herdr pane read prints plain text, not JSON. */
function execHerdrText(args, timeoutMs = 5000) {
  try { return { ok: true, text: execFileSync(herdrBin(), args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, error: String(e.stderr || e.message).slice(0, 200) }; }
}

function listPanes() {
  const r = herdr(["pane", "list"]);
  if (!r.ok) return { ok: false, error: r.error, panes: [] };
  return { ok: true, panes: r.result?.panes ?? [] };
}

function docker(args, timeoutMs = 30000) {
  for (const bin of [process.env.DOCKER_BIN, "docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker", join(nodeOs.homedir(), ".orbstack", "bin", "docker")].filter(Boolean)) {
    try { return { ok: true, out: execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { if (e.code !== "ENOENT") return { ok: false, error: String(e.stderr || e.message).trim().slice(0, 200) }; }
  }
  return { ok: false, error: "docker not found" };
}

/** Stop the change's worker container(s), then close its pane(s). Best-effort; returns a log line. */
function retireWorker(repoRoot, change, paneIds, { forget = true } = {}) {
  const parts = [];
  const ps = docker(["ps", "--format", "{{.Names}}"]);
  if (ps.ok) {
    const re = workerContainerPattern(change);
    const names = ps.out.split("\n").map((x) => x.trim()).filter((n) => re.test(n));
    for (const n of names) { const r = docker(["stop", "-t", "15", n]); parts.push(`container ${n} ${r.ok ? "stopped" : "stop FAILED (" + r.error + ")"}`); }
    if (!names.length) parts.push("no running container");
  } else parts.push(`docker unavailable (${ps.error}) - container not stopped`);
  for (const id of paneIds) {
    const r = herdr(["pane", "close", id], { timeoutMs: 5000 });
    if (r.ok && forget) forgetPane(repoRoot, id);   // under the handoff lock (reconcile) the next pass drops it as PANE-GONE
    parts.push(`pane ${id} ${r.ok ? "closed" : "close FAILED (" + r.error + ")"}`);
  }
  if (!paneIds.length) parts.push("no worker pane open");
  return parts.join(", ");
}

/** Start a pipeline host job detached ({change} substituted), logging to .pi-session/qualify/<change>/runner.log. */
function runHostJob(repoRoot, change, command) {
  if (!command) return { ok: false, error: "route has no command" };
  try {
    const dir = join(repoRoot, ".pi-session", "qualify", change);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "runner.log");
    const cmd = command.replace(/\{change\}/g, change);
    const child = spawn("/bin/sh", ["-c", `${cmd} >> "${log}" 2>&1`], { cwd: repoRoot, detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, log };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

function notifyHumanNow(repoRoot, message, title) { return notifyHuman(repoRoot, message, title); }
function notifyHuman(repoRoot, message, title = "Harness handoff") {
  // native notification with buttons (HarnessNotify.app, scripts/notify.mjs) when installed
  if (notifyRich(message, title)) { logEvent(repoRoot, `NOTIFY(native) ${message}`); return true; }
  const tries = [["notification", "show", `${title}: ${message}`.slice(0, 240)]];
  for (const args of tries) { const r = herdr(args, { timeoutMs: 5000 }); if (r.ok) { logEvent(repoRoot, `NOTIFY(herdr) ${message}`); return true; } }
  if (process.platform === "darwin") {
    try {
      execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message.slice(0, 220))} with title ${JSON.stringify(title)}`], { timeout: 5000, stdio: "ignore" });
      logEvent(repoRoot, `NOTIFY(osascript) ${message}`); return true;
    } catch { /* fall through */ }
  }
  logEvent(repoRoot, `NOTIFY(failed - only in this log) ${message}`);
  return false;
}

function changeConfigFor(trees, change) {
  for (const t of trees) {
    const d = findChangeDir(t.path, change);
    if (d && existsSync(join(d, "change.yaml"))) { try { return readChangeConfig(readFileSync(join(d, "change.yaml"), "utf8")); } catch { /* next */ } }
  }
  return {};
}

function computeFleetSnapshots(repoRoot) {
  try { return buildWeeklySnapshots(mergeFleet(discoverSessionDirs(repoRoot).map((d) => aggregateSessionDir(d)))); } catch { return {}; }
}

/** Newest model id named in a pi session file (model_change records / assistant messages). Reads the tail first. */
function latestModelIn(file) {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      for (const [start, len] of [[Math.max(0, size - 512 * 1024), Math.min(size, 512 * 1024)], [0, size]]) {
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        const hits = [...buf.toString("utf8").matchAll(/"(?:modelId|model)":"([^"]{2,120})"/g)];
        if (hits.length) return hits[hits.length - 1][1];
      }
    } finally { closeSync(fd); }
  } catch { /* unreadable */ }
  return null;
}

/** Every pi session dir in every tree: {name, dir, branch, model, mtimeMs}. */
function gatherSessions(trees) {
  const out = [];
  for (const t of trees) {
    const base = join(t.path, ".pi-session");
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "handoff" || e.name === "herdr-lifecycle") continue;
      const dir = join(base, e.name);
      const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.jsonl$/.test(f)).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      if (!files.length) continue;
      out.push({ name: e.name, dir, file: join(dir, files[0].f), branch: t.branch ?? null, model: latestModelIn(join(dir, files[0].f)), mtimeMs: files[0].m });
    }
  }
  return out;
}

/** Highest integrator-review-N and worker-handoff-N for one change, across every tree. */
function gatherReportCounts(trees, change) {
  let reviews = 0, worker = 0;
  for (const t of trees) {
    const d = findChangeDir(t.path, change);
    if (!d) continue;
    for (const f of readdirSync(d)) {
      let m = /^integrator-review-(\d+)\.md$/.exec(f); if (m) reviews = Math.max(reviews, Number(m[1]));
      m = /^worker-handoff-(\d+)\.md$/.exec(f); if (m) worker = Math.max(worker, Number(m[1]));
    }
  }
  return { reviews, worker };
}

/** Highest N of integrator-review-N.md for each change, across every tree. */
function gatherReviewCounts(trees, changes) {
  const out = {};
  for (const c of changes) {
    let max = 0;
    for (const t of trees) {
      const d = findChangeDir(t.path, c);
      if (!d) continue;
      for (const f of readdirSync(d)) { const m = /^integrator-review-(\d+)\.md$/.exec(f); if (m) max = Math.max(max, Number(m[1])); }
    }
    out[c] = max;
  }
  return out;
}

const SIDEBAR_REFRESH_MS = 10 * 60 * 1000; // Herdr does not restore tokens after a restart - re-send now and then even if unchanged
const asciiToken = (v) => String(v ?? "").replace(/[^\x20-\x7E]/g, "").slice(0, 80);

/** Push sidebar tokens to Herdr; skips unchanged values (cached in state.sidebar). Display-only, never fatal. */
function reportSidebar(repoRoot, { panes, trees, byChange, state, pipeline }) {
  const sessions = gatherSessions(trees);
  const catalog = loadCatalog(repoRoot);
  const usage = loadUsage(repoRoot);
  const meters = {};
  try {
    const cache = loadMeterCache(repoRoot);
    const cw = contextWindowFrom(catalog);
    for (const sess of sessions) if (sess.file && panes.some((p) => sessionForPane(p, [sess]))) meters[sess.dir] = sessionMeters(sess.file, cache, cw);
    saveMeterCache(repoRoot, cache);
  } catch (e) { logEvent(repoRoot, `METERS-ERROR ${e.message}`); }
  checkQuotaAlerts(repoRoot, usage, pipeline);
  const sb = computeSidebar({ panes, byChange, state, pipeline, sessions, reviewCounts: gatherReviewCounts(trees, [...byChange.keys()]), meters, usage: usage?.at ? usage : null, catalog });
  state.sidebar ??= {};
  const now = Date.now();
  const send = (kind, id, tokens) => {
    const key = `${kind}:${id}`;
    const hash = JSON.stringify(tokens);
    const prev = state.sidebar[key];
    if (prev && prev.hash === hash && now - prev.at < SIDEBAR_REFRESH_MS) return;
    const args = [kind, "report-metadata", id, "--source", SIDEBAR_SOURCE, ...Object.entries(tokens).flatMap(([k, v]) => ["--token", `${k}=${asciiToken(v)}`])];
    const r = herdr(args, { timeoutMs: 5000 });
    if (r.ok) state.sidebar[key] = { hash, at: now };
    else logEvent(repoRoot, `SIDEBAR-FAILED ${key}: ${r.error}`);
  };
  try { writeFileSync(join(repoRoot, ".pi-session", "herdr-lifecycle", "sidebar-last.json"), JSON.stringify({ at: new Date().toISOString(), ...sb }, null, 2)); } catch { /* dashboard only */ }
  for (const [id, t] of Object.entries(sb.panes)) send("pane", id, t);
  for (const [id, t] of Object.entries(sb.workspaces)) send("workspace", id, t);
  for (const key of Object.keys(state.sidebar)) if (key.startsWith("pane:") && !panes.some((p) => `pane:${p.pane_id}` === key)) delete state.sidebar[key];
  return sb;
}

/** One notification per quota threshold crossed (pipeline.routing.alerts: true/false, alert_thresholds). */
function checkQuotaAlerts(repoRoot, usage, pipeline) {
  if (!usage?.quotas || pipeline?.routing?.alerts === false) return;
  const p = join(repoRoot, ".pi-session", "routing", "alerts.json");
  let prev = {};
  try { prev = JSON.parse(readFileSync(p, "utf8")); } catch { /* first time */ }
  const { messages, state } = quotaAlerts(usage, prev, pipeline?.routing?.alert_thresholds ?? [50, 20, 10, 5]);
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(state, null, 2) + "\n"); } catch { /* best effort */ }
  for (const m of messages) notifyHuman(repoRoot, m, "Harness quota");
}

/** Spawn scripts/herdr-launch.sh detached; it registers the new pane itself. */
function launchRole(repoRoot, { role, change, text, backend, splitTarget, plannerName, routedModel = null, routedWhy = null, layout = null, routedEffort = null }) {
  const script = join(repoRoot, "scripts", "herdr-launch.sh");
  // Jules works in Google's cloud: no pane, no container - start the session and follow it by polling
  if (role === "worker" && backend === "jules") {
    const log = join(repoRoot, ".pi-session", "jules", "start.log");
    try { mkdirSync(dirname(log), { recursive: true }); } catch { /* */ }
    const child = spawn("/bin/sh", ["-c", `"${process.execPath}" scripts/jules-worker.mjs start "${change}" >> "${log}" 2>&1`], { cwd: repoRoot, detached: true, stdio: "ignore" });
    child.unref();
    return ["jules", change];
  }
  let args;
  if (role === "worker") args = ["worker", change, backend || "pi"];
  // an integrator needs a NAME (its session folder .pi-session/integrator-<name>, container, lock holder):
  // the owner's existing names per backend, pipeline.integrator_names overrides (2026-10-18: "auto" hung the launch)
  else if (role === "integrator") {
    let names = {};
    try { names = loadPipeline(repoRoot).integrator_names ?? {}; } catch { /* defaults */ }
    const b = backend || "pi";
    const name = names[b] ?? { codex: "codex-sol", claude: "claude-opus", pi: "integrator-pi", antigravity: "integrator-agy" }[b] ?? `${b}-integrator`;
    args = ["integrator", name, b];
  }
  else args = ["planner", plannerName || "pi"];
  const env = { ...process.env, TASK: text, HANDOFF_CHANGE: change, HERDR_SPLIT_TARGET: splitTarget || "" };
  if (layout) env.HERDR_ROLE_LAYOUT = layout;
  if (routedEffort) env.HARNESS_ROUTED_EFFORT = routedEffort;
  if (routedModel) { env.HARNESS_ROUTED_MODEL = routedModel; env.HARNESS_ROUTED_WHY = String(routedWhy ?? "").slice(0, 300); }
  // via bash, not exec: a lost execute bit / macOS ACL on the script cannot block a launch
  const child = spawn("/usr/bin/env", ["bash", script, ...args], { cwd: repoRoot, detached: true, stdio: "ignore", env });
  child.unref();
  return args;
}

/** ensure-image.sh leaves this marker while it builds/refreshes images (first builds take minutes). */
export function imageBuildRunning(repoRoot, now = Date.now()) {
  try {
    const f = join(repoRoot, ".pi-session", "herdr-lifecycle", "image-build-running");
    return existsSync(f) && now - statSync(f).mtimeMs < 45 * 60 * 1000; // a marker older than 45 min is a leftover
  } catch { return false; }
}

const LAUNCH_CHECK_SECONDS = 90;
const MAX_LAUNCH_ATTEMPTS = 2;

function scheduleLaunchCheck(repoRoot, change, role, entryId, sinceIso) {
  const since = sinceIso ?? new Date(Date.now() - 5000).toISOString();
  const child = spawn("/bin/sh", ["-c", `sleep ${LAUNCH_CHECK_SECONDS}; exec "${process.execPath}" "${join(HERE, "lifecycle-watcher.mjs")}" --check-launch "${change}" "${role}" "${entryId}" "${since}"`], {
    cwd: HERE, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: repoRoot },
  });
  child.unref();
}

/** 90 s after a launch: did an agent actually start in the new pane? If not, say so,
 *  drop the dead pane, and allow one more automatic attempt (then stop). */
function checkLaunch(repoRoot, change, role, entryId, since) {
  const lp = listPanes();
  if (!lp.ok) return;
  const registry = loadRegistry(repoRoot);
  const panes = annotatePanes(lp.panes, registry);
  const mine = panes.filter((p) => p.role === role && (role !== "worker" || p.change === change) && registry[p.pane_id]?.at >= since);
  if (mine.some((p) => p.alive)) { logEvent(repoRoot, `LAUNCH-OK ${change} ${role} pane ${mine.find((p) => p.alive).pane_id}`); return; }
  if (imageBuildRunning(repoRoot) && mine.length) {
    // the launcher is still building its image - look again later, do not call it failed
    logEvent(repoRoot, `LAUNCH-WAIT ${change} ${role} pane ${mine[0].pane_id} - image build running, checking again in ${LAUNCH_CHECK_SECONDS}s`);
    scheduleLaunchCheck(repoRoot, change, role, entryId, since);
    return;
  }
  // Keep the dead pane's last lines: the real error (e.g. an unknown CLI flag or a
  // missing login) otherwise only exists in a pane that is about to be replaced.
  for (const p of mine) {
    const rd = execHerdrText(["pane", "read", p.pane_id, "--source", "recent", "--lines", "25"]);
    const tail = rd.ok ? rd.text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-12).join("\n    | ") : `(could not read: ${rd.error})`;
    logEvent(repoRoot, `LAUNCH-OUTPUT ${change} ${role} pane ${p.pane_id}:\n    | ${tail}`);
  }
  for (const p of mine) forgetPane(repoRoot, p.pane_id);
  withLock(repoRoot, () => {
    const state = loadState(repoRoot);
    const cstate = (state.changes ??= {})[change] ??= {};
    cstate.launchFailures ??= {};
    const n = (cstate.launchFailures[entryId] ?? 0) + 1;
    cstate.launchFailures[entryId] = n;
    const where = mine.length ? ` (pane ${mine.map((p) => p.pane_id).join(", ")} - read its output)` : " (no pane was created)";
    if (n < MAX_LAUNCH_ATTEMPTS) {
      cstate.dispatched = (cstate.dispatched ?? []).filter((id) => id !== entryId); // route it again on the next idle event
      cstate.awaiting = null;
      logEvent(repoRoot, `LAUNCH-FAILED ${change} ${role}${where} - attempt ${n}/${MAX_LAUNCH_ATTEMPTS}, will retry on the next idle event`);
    } else {
      cstate.awaiting = null;
      logEvent(repoRoot, `LAUNCH-FAILED ${change} ${role}${where} - attempt ${n}/${MAX_LAUNCH_ATTEMPTS}, giving up`);
      notifyHuman(repoRoot, `${change}: the ${role} did not start${where}. Fix the cause, then run: node scripts/handoff.mjs reconcile --live --retry ${change}`);
    }
    writeJsonAtomic(statePath(repoRoot), state);
  });
}

function scheduleReminder(repoRoot, pipeline, pane, change) {
  const delay = Math.max(30, Number(pipeline.remind_after_seconds ?? 180));
  const child = spawn("/bin/sh", ["-c", `sleep ${delay}; exec "${process.execPath}" "${join(HERE, "lifecycle-watcher.mjs")}" --remind "${pane}" "${change}"`], {
    cwd: HERE, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: repoRoot },
  });
  child.unref();
}

function loadPipeline(repoRoot) {
  const p = [join(repoRoot, "herdr-plugin", "pipeline.json"), join(HERE, "pipeline.json")].find(existsSync);
  const pipeline = p ? readJson(p, null) : null;
  if (!pipeline) throw new Error("pipeline.json missing or unreadable");
  if (process.env.HANDOFF_FORCE_LIVE === "1") pipeline.mode = "live";
  return pipeline;
}

const loadState = (repoRoot) => readJson(statePath(repoRoot), { changes: {} });

/** One full pass: route every change whose newest ledger entry is not yet routed. */
// Explicit owner-requested backend changes use the same retirement/resume flow
// as detected limits. Match the exact old pane; never stop an active writer or
// a replacement pane. The queue is run-state, not a command-execution surface.
export function requestedWorkerMigrations(requests, panes) {
  if (!Array.isArray(requests)) return [];
  return requests.flatMap((r) => {
    if (r?.owner_authorized !== true || typeof r.id !== "string" || !/^CHANGE-\d{4}$/.test(r.change ?? "")
        || !["claude", "opencode"].includes(r.source) || !["opencode", "antigravity"].includes(r.target) || r.source === r.target) return [];
    const pane = panes.find((p) => p.pane_id === r.pane_id && p.change === r.change && p.role === "worker"
      && (backendOfAgent(p.agent) ?? backendOfAgent(String(p.label ?? "").split("-")[0])) === r.source && p.alive && !p.starting && ["idle", "done"].includes(p.agent_status));
    return pane ? [{ request: r, pane }] : [];
  });
}

export function migrationRoutingReady(yaml, target) {
  return ["opencode", "antigravity"].includes(target) && new RegExp(`^  backend: ${target}\s*$`, "m").test(yaml ?? "");
}

export function reconcile(repoRoot, { echo = false } = {}) {
  const say = (m) => { logEvent(repoRoot, m); if (echo) console.log(m); };
  // Owner notifications from one pass are batched into one message (flushOutbox at the end).
  const outbox = [];
  const notifyHuman = (_root, msg, title) => { outbox.push({ msg, title }); return true; };
  const pipeline = loadPipeline(repoRoot);
  const live = pipeline.mode === "live";
  const lp = listPanes();
  if (!lp.ok) { say(`SKIP cannot list Herdr panes (${lp.error}) - nothing routed`); return; }
  const registry = loadRegistry(repoRoot);
  const panes = annotatePanes(lp.panes, registry, Date.now(), imageBuildRunning(repoRoot));
  if (live) {
    const requests = readJson(join(repoRoot, ".pi-session", "herdr-lifecycle", "worker-backend-migrations.json"), []);
    let migrated = false;
    const yamlOf = yamlReader(repoRoot);
    for (const { request, pane } of requestedWorkerMigrations(requests, panes)) {
      // Commit the routing choice before asking the host to retire anything.
      if (!migrationRoutingReady(yamlOf(request.change), request.target)) continue;
      const sig = `owner-backend-migration:${request.id}`;
      if (loadState(repoRoot).migrations?.[pane.pane_id] === sig) continue;
      logEvent(repoRoot, `OWNER-MIGRATE ${request.change} ${request.source} -> ${request.target}: ${request.reason ?? "owner request"}`);
      migrateOnLimit(repoRoot, pipeline, { ...pane, backend: request.source }, { kind: "session limit", until: null, sig, line: request.reason ?? "owner-authorized backend migration" });
      migrated = true;
    }
    if (migrated) return; // retirement changed the pane list; the queued nudge re-reads it
  }
  const trees = discoverTrees(repoRoot);
  const byChange = readAllEntries(repoRoot, trees);
  if ((pipeline.routing?.mode ?? "shadow") !== "off" && usageIsOld(repoRoot)) {
    try {
      const child = spawn(process.execPath, [join(repoRoot, "scripts", "route-worker.mjs"), "--refresh-usage", "--quiet"], { cwd: repoRoot, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: repoRoot } });
      child.unref();
    } catch { /* usage stays unknown - routing still works */ }
  }

  // Registered panes that are gone, or dead past the start-up grace, are dropped
  // from the registry so they can never be mistaken for a live role again.
  if (live) {
    for (const [paneId, reg] of Object.entries(registry)) {
      const p = panes.find((x) => x.pane_id === paneId);
      if (!p) { forgetPane(repoRoot, paneId); say(`PANE-GONE ${paneId} (${reg.role} ${reg.change ?? ""}) - no longer in Herdr, unregistered`); }
      else if (!p.alive && !p.starting) {
        forgetPane(repoRoot, paneId);
        // keep the last screen of a pane whose agent never started or died - that is where a launch error is
        const rd = execHerdrText(["pane", "read", paneId, "--source", "recent", "--lines", "25"]);
        const tail = rd.ok ? rd.text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-12).join(" | ").slice(0, 1500) : `(could not read: ${rd.error})`;
        say(`PANE-DEAD ${paneId} (${reg.role} ${reg.change ?? ""}) - no agent running in it, unregistered. Last screen: ${tail}`);
      }
    }
  }
  // What Herdr shows right now, for agents in containers (they cannot reach Herdr;
  // every container mounts the main checkout at /repo).
  try {
    writeJsonAtomic(join(repoRoot, ".pi-session", "herdr-lifecycle", "panes-snapshot.json"), {
      at: new Date().toISOString(),
      note: "Written by the Herdr lifecycle watcher on every idle event. alive=false means no agent is running in that pane.",
      panes: panes.filter((p) => p.role).map((p) => ({ pane_id: p.pane_id, role: p.role, change: p.change, label: p.label ?? null, agent: p.agent ?? null, agent_status: p.agent_status ?? null, alive: p.alive, starting: p.starting })),
    });
  } catch { /* best-effort */ }

  const yamlOf = yamlReader(repoRoot);
  const wd = { ...SUPERVISOR_DEFAULTS, ...(pipeline.watchdog ?? {}) };
  const depsOn = pipeline.dependencies?.enabled !== false;
  let mergedThisPass = false;

  withLock(repoRoot, () => {
    const state = loadState(repoRoot);
    state.changes ??= {};
    const watchNow = wd.enabled !== false && Date.now() - (state.watchdogAt ?? 0) >= wd.check_minutes * 60e3;
    for (const [change, entries] of byChange) {
      const cstate = state.changes[change] ?? {};
      // --- harness-supervisor.mjs: dependencies, branch sync, watchdog (live mode only) ---
      if (live && entries.length) {
        const sv = superviseStep({ repoRoot, change, entries, cstate, panes, byChange, yamlOf, depsOn, wd, watchNow, say, notifyHuman });
        if (sv === "skip") { state.changes[change] = cstate; continue; }
      }
      let d = null;
      const ch = cstate.capHandover;
      if (live && ch) {
        // round-limit handover (planDispatch): restart with a fresh worker once the handover is written,
        // the worker pane is gone/idle after 10 min, or 25 min passed (the harness brief covers the rest)
        const mins = (Date.now() - Date.parse(ch.since)) / 60000;
        const written = ch.file && existsSync(join(repoRoot, ch.file));
        const wps = panes.filter((p) => p.role === "worker" && p.change === change);
        const busy = wps.some((p) => p.agent_status === "working");
        if (written ? !busy : (mins >= 25 || (!busy && mins >= 10) || !wps.length)) {
          const last = entries[entries.length - 1];
          const lc = change.toLowerCase();
          let wt = null; try { wt = readdirSync(join(repoRoot, ".worktrees")).filter((x) => x === `harness-${lc}` || x.startsWith(`harness-${lc}-`)).map((x) => join(repoRoot, ".worktrees", x))[0] ?? null; } catch { /* none */ }
          let briefFile = null;
          try { briefFile = writeHandoffBrief(repoRoot, { change, agent: "previous worker session", why: `round limit reached - fresh worker #${ch.restart}`, worktree: wt }).file; } catch (e) { say(`CAP-BRIEF-ERROR ${change}: ${e.message}`); }
          const retired = wps.length ? retireWorker(repoRoot, change, wps.map((p) => p.pane_id), { forget: false }) : "no worker pane";
          const reads = [ch.review ? `the integrator's latest review /repo/${ch.review}` : null, written ? `the previous worker's handover /repo/${ch.file}` : null, briefFile ? `the harness brief /repo/${briefFile}` : null].filter(Boolean);
          const text = `[handoff] ${change}: you take over from a previous worker session that reached the round limit. Start by reading ${reads.join(", then ")}. ${ch.text}`;
          say(`CAP-RESTART ${change}: fresh worker #${ch.restart} (${written ? "handover written" : `no handover after ${Math.round(mins)} min`}); ${retired}`);
          notifyHuman(repoRoot, `${change}: round limit reached - ${written ? "the worker wrote a handover" : "no handover from the worker"}; a fresh worker takes over (restart ${ch.restart} of ${pipeline.round_cap?.fresh_restarts ?? 2}).${written ? ` Handover: ${ch.file}` : ""}`, "Harness");
          d = { action: "launch", entry: last, role: "worker", text, stateUpdate: { capHandover: null, capRestarts: ch.restart, rounds: { ...(cstate.rounds ?? {}), impl: 0 }, awaiting: { role: "worker", change, since: new Date().toISOString(), entry: last.id, pane: null, reminded: false, reminderScheduled: false, escalated: false } } };
        } else continue;
      }
      d ??= planDispatch({ change, entries, cstate, panes, pipeline, now: new Date().toISOString(), reportCounts: gatherReportCounts(trees, change) });
      const tag = d.entry ? `${change} ${d.entry.role}:${d.entry.verdict}` : change;
      if (d.action === "none") continue;
      // fresh worker session or continue the old one (harness-supervisor.mjs freshOrContinue)
      if (live && d.action === "prompt" && d.role === "worker" && !d.capAsk && pipeline.fresh_sessions?.enabled !== false) {
        try {
          const lc = change.toLowerCase();
          const wt = readdirSync(join(repoRoot, ".worktrees")).filter((x) => x === `harness-${lc}` || x.startsWith(`harness-${lc}-`)).map((x) => join(repoRoot, ".worktrees", x))[0] ?? null;
          const log = wt ? newestSessionLog(join(wt, ".pi-session")) : null;
          const wp = panes.find((x) => x.pane_id === d.pane);
          const idleMin = log ? (Date.now() - statSync(log).mtimeMs) / 60000 : null;
          const fo = freshOrContinue({ entries, health: sessionHealth(log, pipeline.fresh_sessions?.default_context_window ?? 200000), cfg: pipeline.fresh_sessions ?? {}, idleMin, backend: wp?.backend ?? backendOfAgent(wp?.agent) });
          if (fo.fresh) {
            const brief = writeHandoffBrief(repoRoot, { change, agent: "previous worker session", why: `fresh session for the next round: ${fo.why}`, worktree: wt });
            say(`FRESH-SESSION ${change}: ${fo.why} - brief ${brief.file}; ${retireWorker(repoRoot, change, [d.pane], { forget: false })}`);
            d.action = "launch";
            d.text = `${d.text} You start in a FRESH session (${fo.why}): read the handoff brief /repo/${brief.file} first - it has what the previous session was doing.`;
            delete d.pane;
            if (d.stateUpdate?.awaiting) d.stateUpdate.awaiting.pane = null;
          }
        } catch (e) { say(`FRESH-CHECK-ERROR ${change}: ${e.message}`); }
      }

      if (!live) {
        const key = `${d.entry?.id}:${d.action}:${d.pane ?? ""}`;
        if (cstate.dryRunSeen === key && !echo) continue;
        cstate.dryRunSeen = key; state.changes[change] = cstate;
        say(`DRY-RUN ${tag} -> would ${d.action}${d.pane ? " " + d.pane : ""}${d.role ? " (" + d.role + ")" : ""}${d.reason ? ": " + d.reason : ""}${d.message ? ": " + d.message : ""}${d.text ? "\n    prompt: " + d.text : ""}`);
        continue;
      }

      if (d.action === "defer") {
        if (cstate.deferred !== `${d.entry.id}:${d.reason}`) { say(`DEFER ${tag}: ${d.reason}`); cstate.deferred = `${d.entry.id}:${d.reason}`; }
        state.changes[change] = cstate; continue;
      }
      if (d.action === "notify") {
        if (d.once && (cstate.notified ?? []).includes(d.once)) continue;
        if (d.entry?.verdict === "merged") mergedThisPass = true;
        notifyHuman(repoRoot, d.message);
        if (d.once) cstate.notified = [...(cstate.notified ?? []), d.once].slice(-50);
        say(`NOTIFY ${tag}: ${d.message}`);
      } else if (d.action === "run") {
        const r = runHostJob(repoRoot, change, d.command);
        say(r.ok ? `RUN ${tag} -> ${d.command} (log ${r.log})` : `RUN-FAILED ${tag}: ${r.error}`);
        if (!r.ok) notifyHuman(repoRoot, `${change}: could not start host job: ${r.error}`);
      } else if (d.action === "prompt") {
        const r = herdr(["agent", "prompt", d.pane, d.text]);
        if (r.ok) say(`PROMPT ${tag} -> ${d.role} pane ${d.pane}`);
        else {
          // Never resend on failure: a timeout does not prove nothing was typed. But a pane/agent that
          // is GONE received nothing: let the next pass launch a new one (2026-10-20, CHANGE-0026).
          if (/agent_not_found|pane_not_found/.test(String(r.error))) {
            say(`PROMPT-FAILED ${tag} -> ${d.pane}: ${r.error} - the pane is gone, a new ${d.role} is launched on the next pass`);
            continue;   // entry stays undelivered (no stateUpdate), the next pass sees no pane and launches
          }
          say(`PROMPT-FAILED ${tag} -> ${d.pane}: ${r.error}`);
          notifyHuman(repoRoot, `${change}: could not hand ${d.entry.verdict} to the ${d.role} (pane ${d.pane}: ${r.error}). Check the pane; not retried automatically.`);
          d.stateUpdate.awaiting = null;
        }
      } else if (d.action === "launch") {
        let backend = null;
        let routed = null;
        // Model routing (scripts/route-worker.mjs, herdr-plugin/models.catalog.json).
        // pipeline.routing.mode: "shadow" = decide + log only, "live" = launch what it picks, "off".
        const routingMode = pipeline.routing?.mode ?? "shadow";
        if (d.role === "worker" && routingMode !== "off") {
          const rd = decideForChange(repoRoot, change, { entries });
          logDecision(repoRoot, { change, mode: routingMode, entry: d.entry.id, pick: rd.pick ?? null, escalateToHuman: !!rd.escalateToHuman, reason: rd.reason, size: rd.size, minTier: rd.minTier, visual: rd.visual, candidates: rd.candidates });
          if (routingMode === "live") {
            if (rd.escalateToHuman) {
              notifyHuman(repoRoot, `${change}: plan approved, but no worker launched - ${rd.reason}.`);
              say(`NOTIFY ${tag}: ${rd.reason}`);
              Object.assign(cstate, d.stateUpdate, { awaiting: null }); state.changes[change] = cstate; continue;
            }
            if (rd.pick) routed = rd;
          } else {
            say(`ROUTE(shadow) ${tag}: would launch ${rd.escalateToHuman ? "nothing (human)" : `${rd.pick?.id} via ${rd.pick?.backend}`} - ${rd.reason}`);
          }
        }
        if (routed) {
          backend = routed.pick.backend;
          say(`ROUTE ${tag}: ${routed.pick.id} via ${backend} - ${routed.reason}`);
        } else if (d.role === "worker") {
          const cfg = changeConfigFor(trees, change);
          const pick = chooseWorkerBackend({ riskTier: cfg.risk_tier, pipeline, snapshots: computeFleetSnapshots(repoRoot), localAvailable: hasLocalCapacity(readSystemMemory()) });
          if (pick.escalate) {
            notifyHuman(repoRoot, `${change}: plan approved, but no worker launched - ${pick.reason}.`);
            say(`NOTIFY ${tag}: ${pick.reason}`);
            Object.assign(cstate, d.stateUpdate, { awaiting: null }); state.changes[change] = cstate; continue;
          }
          backend = pick.backend;
        }
        const plannerEntry = [...entries].reverse().find((e) => e.role === "planner" && /^planning\//.test(e.tree_branch ?? ""));
        const plannerName = plannerEntry ? plannerEntry.tree_branch.replace(/^planning\//, "") : "pi";
        const splitTarget = (panes.find((p) => p.role === d.entry.role) ?? panes.find((p) => p.focused) ?? panes[0])?.pane_id;
        const args = launchRole(repoRoot, { role: d.role, change, text: d.text, backend, splitTarget, plannerName, routedModel: routed?.pick?.model ?? null, routedWhy: routed?.reason ?? null, routedEffort: routed?.pick?.effort ?? null });
        say(`LAUNCH ${tag} -> scripts/herdr-launch.sh ${args.join(" ")}`);
        if (args[0] !== "jules") scheduleLaunchCheck(repoRoot, change, d.role, d.entry.id);
      }
      if (d.stateUpdate) Object.assign(cstate, d.stateUpdate, { deferred: null });
      state.changes[change] = cstate;
    }
    // Merged -> stop the worker's container and close its pane (live mode only).
    for (const [change, entries] of byChange) {
      const cstate = state.changes[change] ?? {};
      const rt = planRetire({ change, entries, cstate, panes, pipeline });
      if (rt.action === "none") continue;
      if (rt.action === "defer") { if (cstate.retireDeferred !== rt.entryId) { say(`RETIRE-DEFER ${change}: worker still working - will close it on its next idle`); cstate.retireDeferred = rt.entryId; state.changes[change] = cstate; } continue; }
      if (!live) { say(`DRY-RUN ${change} -> would retire worker: ${rt.panes.join(" ") || "(no pane)"}`); continue; }
      say(`RETIRE ${change} (merged): ${retireWorker(repoRoot, change, rt.panes)}`);
      cstate.retired = rt.entryId; cstate.retireDeferred = null; state.changes[change] = cstate;
    }
    try { reportSidebar(repoRoot, { panes, trees, byChange, state, pipeline }); } catch (e) { logEvent(repoRoot, `SIDEBAR-ERROR ${e.message}`); }
    // --- integrator stopped reacting to its handoffs -> replace it (owner, 2026-10-18) ---
    if (live && pipeline.watchdog?.restart_integrator !== false) {
      try {
        // two harness-started integrators (a slow image build made one look dead): keep the first, close the rest
        const autos = panes.filter((p) => p.role === "integrator" && (p.alive || p.starting) && /-integrator-/.test(p.label ?? ""));
        for (const extra of autos.slice(1)) { const rc = herdr(["pane", "close", extra.pane_id], { timeoutMs: 5000 }); say(`INTEGRATOR-DUPLICATE ${extra.pane_id} closed=${rc.ok} (keeping ${autos[0].pane_id})`); }
        // a launched integrator that has not started an agent yet: log its screen (every 5 min) so a stuck launch is visible
        for (const sp of panes.filter((p) => p.role === "integrator" && !p.alive && /-integrator-/.test(p.label ?? ""))) {
          state.launchScreens ??= {};
          state.launchFirstSeen ??= {};
          state.launchFirstSeen[sp.pane_id] ??= Date.now();
          if (Date.now() - state.launchFirstSeen[sp.pane_id] > 10 * 60e3) {
            // never started an agent in 10 min: close it, so the restart below can try again
            const rc = herdr(["pane", "close", sp.pane_id], { timeoutMs: 5000 });
            say(`INTEGRATOR-LAUNCH-STUCK ${sp.pane_id} closed=${rc.ok} - no agent after 10 min`);
            delete state.launchFirstSeen[sp.pane_id];
            if (rc.ok) state.integratorRestartAt = Date.now() - 31 * 60e3;   // retry on the next pass
            continue;
          }
          if (Date.now() - (state.launchScreens[sp.pane_id] ?? 0) < 5 * 60e3) continue;
          state.launchScreens[sp.pane_id] = Date.now();
          const rd = execHerdrText(["pane", "read", sp.pane_id, "--source", "recent", "--lines", "30"]);
          { const dv = docker(["version", "--format", "{{.Server.Version}}"], 10000); const dp = docker(["ps", "--format", "{{.Names}}|{{.Status}}"], 10000); say(`DOCKER-CHECK server=${dv.ok ? dv.out.trim() : "FAILED " + dv.error} ps=${dp.ok ? dp.out.trim().split("\n").filter((l) => /integrator/.test(l)).join(", ") || "(no integrator container)" : "FAILED " + dp.error}`); }
          say(`INTEGRATOR-STARTING ${sp.pane_id} screen: ${rd.ok ? rd.text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-14).join(" | ").slice(0, 1800) : rd.error}`);
        }
        const ip = panes.find((p) => p.role === "integrator" && p.alive);
        // handoffs waiting for the integrator, plus those a failed restart took over but never delivered
        const awaits = [...Object.values(state.changes).map((c) => c.awaiting).filter((a) => a?.role === "integrator"), ...(state.integratorPending ?? []).filter((a) => !state.changes[a.change]?.awaiting)];
        let lastActivity = null;
        for (const d of readdirSync(join(repoRoot, ".pi-session")).filter((d) => d.startsWith("integrator-"))) {
          const f = newestSessionLog(join(repoRoot, ".pi-session", d));
          if (f) { const m = statSync(f).mtimeMs; if (!lastActivity || m > lastActivity) lastActivity = m; }
        }
        // no live integrator pane at all counts as unresponsive too (its handoffs were already "delivered")
        // a pane we launched is still starting (image build) -> do not launch another
        const pending = panes.some((p) => p.role === "integrator" && p.starting) || (state.integratorRestartAt && Date.now() - state.integratorRestartAt < 20 * 60e3);
        const un = pending ? null : integratorUnresponsive({ awaits, lastActivity, paneIdle: ip ? READY.has(ip.agent_status) : true, minutes: wd.integrator_unresponsive_minutes ?? 10, lastRestart: state.integratorRestartAt ?? 0 });
        // every agent runs in Docker: when Docker does not answer, a launch hangs silently - wait instead
        const dockerOk = true; // (probe removed: it timed out from the watcher while OrbStack works fine)
        if (un && !dockerOk) {
          let which = ""; try { which = execFileSync("/bin/sh", ["-c", "command -v docker; ls -l \"$(command -v docker)\" 2>&1; echo DOCKER_HOST=$DOCKER_HOST DOCKER_CONTEXT=$DOCKER_CONTEXT; ls -l /var/run/docker.sock ~/.orbstack/run/docker.sock 2>&1; cat ~/.docker/config.json 2>/dev/null | head -c 400"], { encoding: "utf8", timeout: 5000 }).replace(/\s+/g, " "); } catch (e) { which = e.message; }
          say(`DOCKER-DOWN integrator restart postponed: docker does not answer. PATH=${process.env.PATH} :: ${which}`);
          if (Date.now() - (state.dockerDownNotified ?? 0) > 60 * 60e3) { state.dockerDownNotified = Date.now(); outbox.push({ msg: "Docker on the Mac does not answer (commands time out) - no agent can start. Restart Docker Desktop; the integrator relaunches by itself after that." }); }
        }
        if (un && dockerOk) {
          state.integratorRestartAt = Date.now();
          const backend = ip?.backend ?? backendOfAgent(ip?.agent) ?? "codex";
          const limited = loadLimits(repoRoot).some((l) => l.backend === backend && !l.model);
          const next = limited ? (pickFallbackBackend(backend, { allowed: pipeline.auto_backends ?? null, limits: loadLimits(repoRoot), order: pipeline.limits?.fallback_order }) ?? backend) : backend;
          // (no forgetPane here: we hold the handoff lock; the next pass drops the closed pane as PANE-GONE)
          const r = ip ? herdr(["pane", "close", ip.pane_id], { timeoutMs: 5000 }) : { ok: false };
          state.integratorPending = un.changes.map((c) => state.changes[c]?.awaiting ?? (state.integratorPending ?? []).find((a) => a.change === c)).filter(Boolean);
          for (const c of un.changes) { if (state.changes[c]?.awaiting) state.changes[c].awaiting = null; }
          const pend = un.changes.map((c) => { const es = byChange.get(c) ?? []; const l = es[es.length - 1]; return `${c}: ${l ? `${l.role} ${l.verdict}${l.file ? " (read /repo/" + l.file + ")" : ""}${l.note ? " - " + l.note.slice(0, 160) : ""}` : "?"}`; });
          const approved = [...byChange].filter(([, es]) => { const i = es.map((e) => e.verdict).lastIndexOf("merge-approved"); return i >= 0 && !es.slice(i).some((e) => e.verdict === "merged" || e.role === "worker"); }).map(([c]) => c);
          const text = `You replace an integrator that stopped responding (${un.why}). Read /repo/.pi-session/STATUS.md first. Handle these pending handoffs one by one, each ending with exactly one verdict as usual: ${pend.join(" | ")}.${approved.length ? ` The owner has approved merging ${approved.join(", ")} (merge-approved in the ledger) - your merge gate accepts it now: merge per the last review.` : ""} Act yourself; use needs-human only for what only the owner can decide.`.replace(/[^\x20-\x7E]/g, " ");
          // a background pass has no "current" pane: split next to a live pane (as normal launches do)
          const splitTarget = (panes.find((p) => p.alive && p.pane_id !== ip?.pane_id && p.role) ?? panes.find((p) => p.alive && p.pane_id !== ip?.pane_id))?.pane_id ?? "";
          const args = launchRole(repoRoot, { role: "integrator", change: un.changes[0], text, backend: next, plannerName: null, splitTarget, layout: "tab" });
          say(`INTEGRATOR-RESTART ${ip?.pane_id ?? "(no pane)"} (${backend}) closed=${r.ok} -> scripts/herdr-launch.sh ${args.join(" ")}: ${un.why}`);
          outbox.push({ msg: `The integrator stopped responding (${un.why}) - a new one on ${next} took over ${un.changes.join(", ")}` });
        }
      } catch (e) { say(`INTEGRATOR-CHECK-ERROR ${e.message}`); }
    }
    // A planner that changed a change's plan after its last handoff but never reported (e.g. after the
    // owner talked to it directly): remind it once per edit (2026-10-20, CHANGE-0026)
    if (live) {
      try {
        state.unreported ??= {};
        for (const wt of readdirSync(join(repoRoot, ".worktrees")).filter((x) => /-planner-/.test(x))) {
          const base = join(repoRoot, ".worktrees", wt, "docs", "changes");
          let ds = []; try { ds = readdirSync(base).filter((x) => /^CHANGE-\d+-/.test(x)); } catch { continue; }
          for (const dname of ds) {
            const change = dname.match(/^CHANGE-\d+/)[0];
            const es = byChange.get(change) ?? [];
            const last = es[es.length - 1];
            if (!last || last.verdict === "merged") continue;
            let newest = 0, nf = "";
            for (const f of readdirSync(join(base, dname))) { const m = statSync(join(base, dname, f)).mtimeMs; if (m > newest) { newest = m; nf = f; } }
            if (newest <= Date.parse(last.at) + 120e3 || Date.now() - newest < 5 * 60e3) continue;   // reported since, or still editing
            const key = `${change}@${Math.round(newest)}`;
            if (state.unreported[change] === key) continue;
            const pn = wt.replace(/^.*-planner-/, "");
            const pp = panes.find((p) => p.role === "planner" && p.alive && READY.has(p.agent_status) && (p.label ?? "").includes(pn)) ?? panes.find((p) => p.role === "planner" && p.alive && READY.has(p.agent_status));
            if (!pp) continue;
            state.unreported[change] = key;
            const txt = `[handoff] ${change}: you changed the plan (${nf}) after the last handoff (${last.role} ${last.verdict}) but did not report it, so nobody was told. Finish with exactly one report now: node /repo/scripts/handoff.mjs report --change ${change} --role planner --verdict plan-ready --file <your planner handoff> --note '<what changed>' (or --verdict question / blocked).`;
            const res = herdr(["agent", "prompt", pp.pane_id, txt]);
            say(`UNREPORTED ${change}: planner edited ${nf} after ${last.verdict} -> reminded ${pp.pane_id} ${res.ok ? "" : "FAILED " + res.error}`);
          }
        }
      } catch (e) { say(`UNREPORTED-CHECK-ERROR ${e.message}`); }
    }
    if (live && watchNow) state.watchdogAt = Date.now();
    // .pi-session/STATUS.md on every pass; a digest at pipeline.digest.hours and after a merge
    try {
      const st = buildStatus({ byChange, state, yamlOf, panes });
      // agent capacity (5h / weekly windows) + resets since the last pass
      const caps = capacity(loadUsage(repoRoot), loadLimits(repoRoot));
      const projections = loadUsage(repoRoot).projections ?? {};
      writeStatus(repoRoot, st, capacityMarkdown(caps, Date.now(), projections));
      if (live) {
        // pace warnings: one message when an agent's level rises to high or critical
        state.pace ??= {};
        const rank = { none: 0, warning: 1, high: 2, critical: 3 };
        for (const c of caps) {
          const pl = paceLevel(c, projections);
          const was = state.pace[c.agent] ?? "none";
          if (rank[pl.level] > rank[was] && rank[pl.level] >= 2) { say(`PACE ${c.agent} ${pl.level}: ${pl.why}`); outbox.push({ msg: `${c.name} ${pl.level}: ${pl.why} - the router is moving new work elsewhere` }); }
          state.pace[c.agent] = pl.level;
        }
        const wr = windowResets(state.windows ?? {}, caps);
        state.windows = wr.next;
        for (const ev of wr.events) {
          say(`WINDOW-RESET ${ev.agent}${ev.assumed ? " (assumed - reset time passed)" : ""}`);
          outbox.push({ msg: `${ev.name} has capacity again - paused work resumes and new work can go there` });
        }
        // work that waited for a reset (resumeQueue, from migrateOnLimit): resume it
        const due = (state.resumeQueue ?? []).filter((r) => r.at <= Date.now() || wr.events.some((e) => e.agent === r.agent));
        state.resumeQueue = (state.resumeQueue ?? []).filter((r) => !due.includes(r));
        for (const r of due) {
          const cs = state.changes[r.change] ?? {};
          if (typeof cs.waiting === "string" && cs.waiting.startsWith("limit@")) delete cs.waiting;
          const p = panes.find((x) => x.pane_id === r.pane && x.alive);
          if (p && READY.has(p.agent_status)) {
            const res = herdr(["agent", "prompt", r.pane, `Your ${r.agent} usage window has reset. Continue ${r.change} exactly where you stopped (check git status and your last notes first), then report as usual.`]);
            say(`RESUME ${r.change} ${r.pane} (${r.agent} window reset): ${res.ok ? "prompted" : "FAILED " + res.error}`);
            if (res.ok) continue;
          }
          const e = appendEntry(repoRoot, { change: r.change, role: "harness", verdict: "resume", system: true, note: `${r.agent} usage window reset; continuing the paused session's work in a new session. Run git status first` });
          say(`RESUME ${r.change}: new session (${e.id})`);
        }
      }
      if (live && pipeline.digest?.enabled !== false && (mergedThisPass || digestDue(state.digestAt ?? null, pipeline.digest?.hours ?? [8, 20]))) {
        state.digestAt = Date.now();
        outbox.push({ msg: digestText(st), title: "Harness digest" });
      }
    } catch (e) { logEvent(repoRoot, `STATUS-ERROR ${e.message}`); }
    writeJsonAtomic(statePath(repoRoot), state);
  });
  // the project context file (scripts/build-context.mjs) follows main: rebuild it after a merge, or when missing
  if (live && (mergedThisPass || !existsSync(join(repoRoot, ".pi-session", "CONTEXT.md")))) {
    try { const c = spawn(process.execPath, [join(repoRoot, "scripts", "build-context.mjs")], { cwd: repoRoot, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: repoRoot } }); c.unref(); } catch { /* best effort */ }
  }
  flushOutbox(repoRoot, outbox);
}

/** One message for the whole pass (Herdr notifications are short; details stay in the log and STATUS.md). */
function flushOutbox(repoRoot, outbox) {
  if (!outbox.length) return;
  if (outbox.length === 1) { notifyHumanNow(repoRoot, outbox[0].msg, outbox[0].title); return; }
  // with native notifications every item gets its own notification and buttons (at most 6 a pass)
  if (notifyAppInstalled()) {
    const items = outbox.slice(0, 6);
    for (const o of items) notifyHumanNow(repoRoot, o.msg, o.title ?? "Harness");
    if (outbox.length > items.length) notifyHumanNow(repoRoot, `${outbox.length - items.length} more updates - see .pi-session/STATUS.md`, "Harness");
    return;
  }
  const digest = outbox.find((o) => o.title === "Harness digest");
  const rest = outbox.filter((o) => o !== digest);
  const msg = (rest.length > 1 ? `${rest.length} updates: ` : "") + rest.map((o) => o.msg).join(" || ") + (digest ? ` || ${digest.msg}` : "");
  for (const o of outbox) logEvent(repoRoot, `NOTIFY-ITEM ${o.msg}`);
  notifyHumanNow(repoRoot, msg.length > 230 ? msg.slice(0, 200) + "... (see .pi-session/STATUS.md)" : msg, rest.length ? "Harness" : "Harness digest");
}

/**
 * Dependencies, branch sync and the watchdog for one change, before normal routing.
 * Returns "skip" when routing must not happen this pass (parked, or handled).
 * May APPEND a harness ledger entry (resume / stalled / repeated-failure) to entries,
 * which normal routing then delivers in the same pass.
 */
function superviseStep({ repoRoot, change, entries, cstate, panes, byChange, yamlOf, depsOn, wd, watchNow, say, notifyHuman }) {
  // a Jules session is the worker for this change: no pane to watch; jules-worker.mjs poll reports back
  try { if (julesActive(repoRoot, change)) return null; } catch { /* no jules state */ }
  const last = entries[entries.length - 1];
  const pending = depsOn && last.verdict !== "merged" ? pendingDeps(change, { byChange, yamlOf }) : [];
  const busy = (role) => panes.some((p) => p.role === role && (role !== "worker" || p.change === change) && p.agent_status === "working");
  const target = phaseOf(last, cstate, pending).waiting;
  // a "working" worker pane is checked for real activity (hung model requests) - see activity-probe.mjs
  let workerQuiet = null;
  if (busy("worker")) {
    try { const a = lastActivity(repoRoot, change); if (a.quiet_min != null) workerQuiet = { quiet_min: a.quiet_min, progress: a.progress, summary: describeQuiet(a) }; }
    catch (e) { say(`ERROR activity-probe ${change}: ${e.message}`); }
  }
  const sv = superviseChange({ change, entries, cstate, pending, now: Date.now(), cfg: wd, workerBusy: busy("worker"), targetBusy: busy(target), workerQuiet });
  if (sv.action === "none") return null;
  const add = (verdict, note, file = null) => {
    const e = appendEntry(repoRoot, { change, role: "harness", verdict, note, file, system: true });
    const full = { ...e, tree: repoRoot, tree_branch: "main" };
    entries.push(full);
    say(`HARNESS ${change} ${verdict}: ${note}`);
    return full;
  };
  const markRouted = (id) => { cstate.dispatched = [...(cstate.dispatched ?? []), id].slice(-200); };
  if (sv.action === "park") {
    if (cstate.parked?.entry !== last.id) {
      cstate.parked = { entry: last.id, deps: sv.deps, at: new Date().toISOString() };
      say(`PARK ${change} (${last.role} ${last.verdict}): waiting for ${sv.deps.join(", ")} to merge`);
      if (last.verdict === "blocked") notifyHuman(repoRoot, `${change} parked until ${sv.deps.join(", ")} merge - resumes by itself`);
    }
    return "skip";
  }
  if (sv.action === "unpark") { say(`UNPARK ${change}: prerequisites merged (${cstate.parked.deps.join(", ")}) - launching`); delete cstate.parked; return null; }
  if (sv.action === "resume" || sv.action === "sync") {
    if (sv.action === "sync") cstate.syncTried = [...(cstate.syncTried ?? []), last.id].slice(-50);
    const r = syncWorker(repoRoot, change);
    say(`SYNC ${change}: ${r.ok ? "ok" : "FAILED"} - ${r.out}`);
    delete cstate.parked;
    if (!r.ok) return null;   // the blocked entry goes to the integrator as usual (it is told the sync failed)
    markRouted(last.id);
    add("resume", `${sv.why}; branch synced with main${r.head ? " @ " + r.head : ""}, guards regenerated`);
    return null;
  }
  if (sv.action === "triage") {
    if (sv.kind === "stalled" && !watchNow) return null;
    const md = triageMarkdown({ change, kind: sv.kind, why: sv.why, entries, events: eventsFor(repoRoot, change), qualifyTail: sv.kind === "repeated-failure" ? latestQualifyTail(repoRoot, change) : null });
    const file = writeTriage(repoRoot, change, md);
    cstate.triaged = last.id;
    if (sv.kind === "repeated-failure") markRouted(last.id);
    add(sv.kind, sv.why, file);
    return null;
  }
  if (sv.action === "escalate") {
    if (!watchNow) return null;
    cstate.triaged = last.id;
    say(`ESCALATE ${change}: ${sv.why}`);
    notifyHuman(repoRoot, `${change}: ${sv.why} - have a look (triage: ${last.file ?? "-"})`);
    return null;
  }
  return null;
}

function handleIdle(repoRoot, paneId) {
  const pipeline = loadPipeline(repoRoot);
  const lp = listPanes();
  if (!lp.ok) return;
  const pane = annotatePanes(lp.panes, loadRegistry(repoRoot)).find((p) => p.pane_id === paneId);
  if (!pane?.role) return;
  const byChange = readAllEntries(repoRoot);

  // Route exhausted completion gates to the integrator before any auto-continue.
  if (pipeline.mode === "live" && pane.role === "worker" && pane.change) {
    const rd = execHerdrText(["pane", "read", paneId, "--source", "recent", "--lines", "40"]);
    const stop = rd.ok ? completionGateStop(rd.text) : null;
    if (stop) {
      let fresh = false;
      withLock(repoRoot, () => {
        const state = loadState(repoRoot);
        state.completionStops ??= {};
        if (state.completionStops[paneId] !== stop) {
          state.completionStops[paneId] = stop;
          writeJsonAtomic(statePath(repoRoot), state);
          fresh = true;
        }
      });
      if (fresh) {
        const why = `Worker completion gate hard-stopped: ${stop}. Integrator must diagnose the failed obligation before any retry; do not reset counters or treat the work as done.`;
        const file = writeTriage(repoRoot, pane.change, triageMarkdown({ change: pane.change, kind: "stalled", why, entries: byChange.get(pane.change) ?? [], events: eventsFor(repoRoot, pane.change), qualifyTail: latestQualifyTail(repoRoot, pane.change) }) + "\n## Worker terminal hard stop\n\n```text\n" + rd.text + "\n```\n");
        appendEntry(repoRoot, { change: pane.change, role: "harness", verdict: "stalled", system: true, file, note: why });
        logEvent(repoRoot, `COMPLETION-STOP ${pane.change} ${paneId}: integrator diagnosis requested`);
        nudge(repoRoot, "completion-stop", { force: true });
      }
      return;
    }
  }

  // Usage limit / session limit at the bottom of the pane -> move the work to another agent
  // (checked BEFORE auto-continue: typing "continue" into a spent subscription only repeats the error).
  if (pipeline.mode === "live" && pipeline.limits?.migrate !== false) {
    const rdl = execHerdrText(["pane", "read", paneId, "--source", "recent", "--lines", "40"]);
    const lim = rdl.ok ? detectLimit(rdl.text) : null;
    if (lim && migrateOnLimit(repoRoot, pipeline, pane, lim)) return;
    // Server errors (OpenCode "Internal Server Error", 500s): auto-continue retries the first ones;
    // when they keep coming back the provider is treated as down and the work moves.
    const pe = rdl.ok && !lim ? detectProviderError(rdl.text) : null;
    if (pe) {
      let out = null;
      withLock(repoRoot, () => {
        const state = loadState(repoRoot);
        state.providerErrors ??= {};
        out = providerErrorPersists(state.providerErrors[paneId] ?? [], pe.sig, { threshold: pipeline.limits?.provider_error_threshold ?? 3, windowMin: pipeline.limits?.provider_error_window_minutes ?? 30 });
        state.providerErrors[paneId] = out.history;
        writeJsonAtomic(statePath(repoRoot), state);
      });
      logEvent(repoRoot, `PROVIDER-ERROR ${pane.role} ${pane.change ?? ""} ${paneId} (${out.count}x): ${pe.line}`);
      if (out.persists && migrateOnLimit(repoRoot, pipeline, pane, { ...pe, until: Date.now() + (pipeline.limits?.provider_error_cooldown_minutes ?? 45) * 60e3 })) return;
    }
  }

  // Transient model/API error at the bottom of the pane -> type "continue" for the owner.
  const acCfg = pipeline.auto_continue ?? {};
  if (acCfg.enabled !== false) {
    const rd = execHerdrText(["pane", "read", paneId, "--source", "recent", "--lines", "40"]);
    if (rd.ok) {
      let sent = false;
      withLock(repoRoot, () => {
        const state = loadState(repoRoot);
        state.autoContinue ??= {};
        const h = state.autoContinue[paneId] ?? {};
        const ac = planAutoContinue({ tail: rd.text, history: h, cfg: acCfg });
        if (ac.action === "continue") {
          if (pipeline.mode !== "live") logEvent(repoRoot, `DRY-RUN AUTO-CONTINUE ${pane.role} ${paneId}`);
          else {
            const r = herdr(["agent", "prompt", paneId, ac.message]);
            logEvent(repoRoot, `AUTO-CONTINUE ${pane.role} ${pane.change ?? ""} ${paneId}: ${r.ok ? "sent" : "FAILED " + r.error}`);
            if (r.ok) { h.sent = [...(h.sent ?? []).filter((t) => Date.now() - t < 3600e3), Date.now()]; h.lastSig = ac.sig; sent = true; }
          }
        } else if (ac.action === "notify" && pipeline.mode === "live") {
          notifyHuman(repoRoot, `${pane.role} ${pane.change ?? ""} (${paneId}): ${ac.message}`);
          h.notifiedSig = ac.sig;
        }
        state.autoContinue[paneId] = h;
        writeJsonAtomic(statePath(repoRoot), state);
      });
      if (sent) return;   // it is working again - no handoff reminder for this idle
    }
  }

  withLock(repoRoot, () => {
    const state = loadState(repoRoot);
    for (const [change, cstate] of Object.entries(state.changes ?? {})) {
      const r = planReminder({ pane, cstate, entries: byChange.get(change) ?? [] });
      if (r.action === "none") continue;
      if (pipeline.mode !== "live") { logEvent(repoRoot, `DRY-RUN ${change}: ${pane.role} pane ${paneId} idle without a handoff -> would ${r.action}`); continue; }
      if (r.action === "schedule") { scheduleReminder(repoRoot, pipeline, paneId, change); cstate.awaiting.reminderScheduled = true; logEvent(repoRoot, `REMIND-SCHEDULED ${change} ${pane.role} ${paneId} in ${pipeline.remind_after_seconds ?? 180}s`); }
      if (r.action === "notify") {
        // The agent wrote a proposal/decision request but never reported it: report it for the agent
        // (needs-decision -> integrator) instead of only telling the owner (2026-10-20, CHANGE-0022)
        let reported = false;
        try {
          const since = Date.parse(cstate.awaiting.since);
          const dirs = [join(repoRoot, "docs", "changes")];
          for (const wt of readdirSync(join(repoRoot, ".worktrees")).filter((x) => x.toLowerCase().includes(change.toLowerCase()))) dirs.push(join(repoRoot, ".worktrees", wt, "docs", "changes"));
          let found = null;
          for (const base of dirs) {
            let cd = null; try { cd = readdirSync(base).find((x) => x.startsWith(change + "-")); } catch { /* */ }
            if (!cd) continue;
            for (const f of readdirSync(join(base, cd))) {
              if (!/(proposal|decision|question)[^/]*\.md$/i.test(f)) continue;
              const p = join(base, cd, f), m = statSync(p).mtimeMs;
              if (m > since && (!found || m > found.m)) found = { p, m };
            }
          }
          if (found && pane.role === "worker") {
            const rel = found.p.slice(repoRoot.length + 1);
            appendEntry(repoRoot, { change, role: "worker", verdict: "needs-decision", file: rel, note: `(reported by the harness: the worker wrote ${rel.split("/").pop()} but did not report it)` });
            logEvent(repoRoot, `AUTO-REPORT ${change}: worker needs-decision with ${rel}`);
            reported = true;
          }
        } catch (e) { logEvent(repoRoot, `AUTO-REPORT-ERROR ${change}: ${e.message}`); }
        if (!reported) notifyHuman(repoRoot, r.message);
        cstate.awaiting.escalated = true;
      }
    }
    writeJsonAtomic(statePath(repoRoot), state);
  });
}

/**
 * An agent stopped on its usage limit (or its context/session limit): record the limit so the
 * router skips that agent until it resets, close the pane, and continue the same work in a NEW
 * session - a worker through the router (another agent), the integrator/planner on the next
 * allowed backend. The worktree, commits and uncommitted files stay where they are.
 */
function migrateOnLimit(repoRoot, pipeline, pane, lim) {
  let fresh = false;
  withLock(repoRoot, () => {
    const state = loadState(repoRoot);
    state.migrations ??= {};
    if (state.migrations[pane.pane_id] === lim.sig) return;
    state.migrations[pane.pane_id] = lim.sig;
    writeJsonAtomic(statePath(repoRoot), state);
    fresh = true;
  });
  if (!fresh) return true;                     // handled already - and never auto-continue a limit
  const backend = pane.backend ?? backendOfAgent(pane.agent) ?? "pi";
  let model = null;                            // pi/opencode run many providers: limit only the model that hit it
  if (backend === "pi" || backend === "opencode") {
    try {
      const ds = readFileSync(join(repoRoot, ".pi-session", "routing", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d?.change === pane.change && d.pick);
      model = ds.length ? ds[ds.length - 1].pick.id : null;
    } catch { /* unknown */ }
  }
  if (lim.kind === "usage limit" || lim.kind === "provider error") recordLimit(repoRoot, { backend, model, kind: lim.kind, until: lim.until, why: lim.line });
  const untilTxt = lim.until ? ` until ${new Date(lim.until).toTimeString().slice(0, 5)}` : "";
  logEvent(repoRoot, `LIMIT ${pane.role} ${pane.change ?? ""} ${pane.pane_id} (${backend}${model ? " " + model : ""}): ${lim.kind}${untilTxt} - ${lim.line}`);
  if (pane.role === "worker" && pane.change && lim.kind === "usage limit") {
    // move now, or wait for the reset? (harness-supervisor.mjs waitOrMove: depends on how demanding the change is)
    let rd = null, routedTier = null;
    try { rd = decideForChange(repoRoot, pane.change); } catch { /* move */ }
    try {
      const ds = readFileSync(join(repoRoot, ".pi-session", "routing", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d?.change === pane.change && d.pick);
      routedTier = ds.length ? ds[ds.length - 1].pick.tier ?? null : null;
    } catch { /* unknown */ }
    const alt = rd && !rd.escalateToHuman && !rd.wait && rd.pick ? rd.pick : null;
    const wm = waitOrMove({ facts: { risk: rd?.risk, size: rd?.size, visual: rd?.visual?.visual }, until: lim.until, alternative: alt, routedTier, waitMinutes: pipeline.limits?.wait_minutes ?? 90 });
    logEvent(repoRoot, `LIMIT-DECISION ${pane.change}: ${wm.action} - ${wm.why}${alt ? ` (best other: ${alt.id} t${alt.tier ?? "?"})` : ""}`);
    if (wm.action === "wait") {
      withLock(repoRoot, () => {
        const state = loadState(repoRoot);
        state.resumeQueue = [...(state.resumeQueue ?? []).filter((r) => r.change !== pane.change), { change: pane.change, pane: pane.pane_id, agent: backend, at: lim.until ?? Date.now() + 5 * 3600e3 }];
        state.changes ??= {}; state.changes[pane.change] = { ...(state.changes[pane.change] ?? {}), waiting: `limit@${lim.until ?? ""}` };
        writeJsonAtomic(statePath(repoRoot), state);
      });
      if (lim.until) scheduleNudgeAt(repoRoot, lim.until + 15e3, `window-reset ${pane.change}`);
      notifyHuman(repoRoot, `${pane.change}: ${backend} hit its usage limit${untilTxt} - the session waits and continues after the reset (${wm.why})`);
      return true;
    }
  }
  if (pane.role === "worker" && pane.change) {
    // a brief from the stopped session's own log, BEFORE its pane goes away
    let brief = null;
    try {
      const lc = pane.change.toLowerCase();
      const wt = readdirSync(join(repoRoot, ".worktrees")).filter((d) => d === `harness-${lc}` || d.startsWith(`harness-${lc}-`)).map((d) => join(repoRoot, ".worktrees", d))[0] ?? null;
      brief = writeHandoffBrief(repoRoot, { change: pane.change, agent: backend, why: `${lim.kind}${untilTxt}`, worktree: wt });
      logEvent(repoRoot, `BRIEF ${pane.change}: ${brief.file} (${brief.events} events from ${brief.log ?? "no session log"})`);
    } catch (e) { logEvent(repoRoot, `BRIEF-FAILED ${pane.change}: ${e.message}`); }
    logEvent(repoRoot, `MIGRATE ${pane.change}: ${retireWorker(repoRoot, pane.change, [pane.pane_id])}`);
    appendEntry(repoRoot, { change: pane.change, role: "harness", verdict: "resume", system: true, file: brief?.file ?? null,
      note: `the previous ${backend} session stopped on its ${lim.kind}${untilTxt}; continuing in a new session${lim.kind !== "session limit" ? " on another agent" : ""}. Run git status first - uncommitted work from that session is still in the worktree` });
    notifyHuman(repoRoot, `${pane.change}: ${backend} hit its ${lim.kind}${untilTxt} - the work moves to a new session${lim.kind !== "session limit" ? " on another agent" : ""}`);
    nudge(repoRoot, "migrate", { force: true });
    return true;
  }
  if (pane.role === "integrator" || pane.role === "planner") {
    const next = lim.kind !== "session limit" ? pickFallbackBackend(backend, { allowed: pipeline.auto_backends ?? null, limits: loadLimits(repoRoot), order: pipeline.limits?.fallback_order }) : backend;
    if (!next) { notifyHuman(repoRoot, `the ${pane.role} (${backend}) hit its ${lim.kind}${untilTxt} and no other agent is allowed to take over - it resumes when the limit resets`); return true; }
    const st = loadState(repoRoot);
    const mine = Object.entries(st.changes ?? {}).filter(([, c]) => c.awaiting?.role === pane.role).map(([c]) => c);
    const change = pane.change ?? mine[0] ?? null;
    const r = herdr(["pane", "close", pane.pane_id], { timeoutMs: 5000 });
    if (r.ok) forgetPane(repoRoot, pane.pane_id);
    const text = `The previous ${pane.role} session (${backend}) stopped on its ${lim.kind}${untilTxt}. You take over its work now. Read .pi-session/STATUS.md and the newest ledger entries and reports${mine.length ? ` for ${mine.join(", ")}` : ""}, finish what it was doing (check git status and the integrator lock first), and report as usual.`;
    const args = launchRole(repoRoot, { role: pane.role, change, text, backend: next, plannerName: pane.role === "planner" ? next : null });
    logEvent(repoRoot, `MIGRATE ${pane.role} ${backend} -> ${next}: scripts/herdr-launch.sh ${args.join(" ")}`);
    notifyHuman(repoRoot, `the ${pane.role} (${backend}) hit its ${lim.kind}${untilTxt} - a new ${pane.role} on ${next} took over`);
    return true;
  }
  notifyHuman(repoRoot, `${pane.role ?? "a pane"} ${pane.pane_id} (${backend}) hit its ${lim.kind}${untilTxt}`);
  return true;
}

function remind(repoRoot, paneId, change) {
  const pipeline = loadPipeline(repoRoot);
  const lp = listPanes();
  if (!lp.ok) return;
  const pane = annotatePanes(lp.panes, loadRegistry(repoRoot)).find((p) => p.pane_id === paneId);
  withLock(repoRoot, () => {
    const state = loadState(repoRoot);
    const cstate = state.changes?.[change];
    const aw = cstate?.awaiting;
    const skip = (why) => { if (aw) aw.reminderScheduled = false; writeJsonAtomic(statePath(repoRoot), state); logEvent(repoRoot, `REMIND-SKIPPED ${change} ${paneId}: ${why}`); };
    if (!aw) return skip("no longer awaiting anyone");
    if (aw.reminded) return skip("already reminded once");
    if (!pane || !READY.has(pane.agent_status)) return skip(`pane is ${pane ? pane.agent_status : "gone"}`);
    const entries = readAllEntries(repoRoot).get(change) ?? [];
    if (entries.some((e) => e.role === aw.role && e.at > aw.since)) return skip(`${aw.role} reported in the meantime`);
    const text = fillTemplate(pipeline.reminder_prompt, { change, role: aw.role, allowed: VERDICTS_BY_ROLE[aw.role].join(" | "), report: `${pipeline.report_cmd ?? "node /repo/scripts/handoff.mjs report"} --change ${change}`, new: `${pipeline.new_cmd ?? "node /repo/scripts/handoff.mjs new"} --change ${change}` });
    const r = herdr(["agent", "prompt", paneId, text]);
    aw.reminded = true; aw.reminderScheduled = false;
    logEvent(repoRoot, r.ok ? `REMIND ${change} -> ${aw.role} pane ${paneId}` : `REMIND-FAILED ${change} -> ${paneId}: ${r.error}`);
    writeJsonAtomic(statePath(repoRoot), state);
  });
}

function repoRootFromEnv() {
  if (process.env.HARNESS_REPO_ROOT) return process.env.HARNESS_REPO_ROOT;
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return dirname(HERE); }
}

/** Throttled reconcile for startup / focus / new-agent events and the "deliver now" action. */
const NUDGE_MIN_INTERVAL_MS = 15000;
// --- heartbeat: the watcher wakes up on its own (deferred handoffs, quota waits, watchdog, STATUS.md) ---
const heartbeatFile = (repoRoot) => join(repoRoot, ".pi-session", "herdr-lifecycle", "heartbeat.pid");
export function ensureHeartbeat(repoRoot) {
  let pipeline; try { pipeline = loadPipeline(repoRoot); } catch { return; }
  if (pipeline.mode !== "live" || pipeline.watchdog?.enabled === false) return;
  try {
    const [pid, t] = readFileSync(heartbeatFile(repoRoot), "utf8").trim().split(/\s+/).map(Number);
    if (pid && Date.now() - t < 10 * 60e3) { process.kill(pid, 0); return; }
  } catch { /* none or dead */ }
  try {
    const child = spawn(process.execPath, [join(HERE, "lifecycle-watcher.mjs"), "--heartbeat"], { cwd: HERE, detached: true, stdio: "ignore", env: { ...process.env, HARNESS_REPO_ROOT: repoRoot } });
    child.unref();
    mkdirSync(dirname(heartbeatFile(repoRoot)), { recursive: true });
    writeFileSync(heartbeatFile(repoRoot), `${child.pid} ${Date.now()}\n`);
    logEvent(repoRoot, `HEARTBEAT started (pid ${child.pid})`);
  } catch (e) { logEvent(repoRoot, `HEARTBEAT-FAILED ${e.message}`); }
}
function heartbeatLoop(repoRoot) {
  let misses = 0;
  // exit when the harness code changes; the next Herdr event starts a heartbeat with the new code
  const code = [join(HERE, "lifecycle-watcher.mjs"), join(repoRoot, "scripts", "harness-supervisor.mjs"), join(repoRoot, "scripts", "route-worker.mjs"), join(repoRoot, "scripts", "handoff.mjs"), join(repoRoot, "scripts", "notify.mjs"), join(repoRoot, "scripts", "jules-worker.mjs")];
  const stamp = () => code.map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join(",");
  const born = stamp();
  const tick = () => {
    if (stamp() !== born) { logEvent(repoRoot, "HEARTBEAT restarting: harness code changed"); try { writeFileSync(heartbeatFile(repoRoot), ""); } catch { /* */ } process.exit(0); }
    let mine = false;
    try { mine = Number(readFileSync(heartbeatFile(repoRoot), "utf8").trim().split(/\s+/)[0]) === process.pid; } catch { /* gone */ }
    if (!mine) process.exit(0);   // another heartbeat took over, or it was stopped
    try { writeFileSync(heartbeatFile(repoRoot), `${process.pid} ${Date.now()}\n`); } catch { /* best effort */ }
    if (!listPanes().ok) { if (++misses >= 3) { logEvent(repoRoot, "HEARTBEAT stopped: Herdr not reachable"); process.exit(0); } return; }
    misses = 0;
    nudge(repoRoot, "heartbeat");
  };
  let secs = 120; try { secs = Math.max(30, Number(loadPipeline(repoRoot).watchdog?.heartbeat_seconds ?? 120)); } catch { /* default */ }
  setInterval(tick, secs * 1000);
}

/** Follow active Jules sessions every poll_minutes (detached; it records handoffs itself). */
function maybePollJules(repoRoot) {
  if (!Object.values(julesSessions(repoRoot)).some((r) => !r.handled)) return;
  const last = join(repoRoot, ".pi-session", "jules", "last-poll");
  let age = Infinity; try { age = Date.now() - statSync(last).mtimeMs; } catch { /* never */ }
  if (age < (julesConfig(repoRoot).poll_minutes ?? 3) * 60e3) return;
  try { writeFileSync(last, new Date().toISOString()); } catch { /* */ }
  const log = join(repoRoot, ".pi-session", "jules", "poll.log");
  spawn("/bin/sh", ["-c", `"${process.execPath}" scripts/jules-worker.mjs poll >> "${log}" 2>&1`], { cwd: repoRoot, detached: true, stdio: "ignore" }).unref();
}

export function nudge(repoRoot, why, { force = false } = {}) {
  const f = join(repoRoot, ".pi-session", "herdr-lifecycle", "last-nudge");
  try { if (!force && Date.now() - statSync(f).mtimeMs < NUDGE_MIN_INTERVAL_MS) return false; } catch { /* first nudge */ }
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${new Date().toISOString()} ${why}\n`); } catch { /* best effort */ }
  if (force || why === "startup") logEvent(repoRoot, `NUDGE ${why} -> reconcile`);
  try { reconcile(repoRoot); } catch (e) { logEvent(repoRoot, `ERROR nudge ${why}: ${e.message}`); }
  try { maybePollJules(repoRoot); } catch (e) { logEvent(repoRoot, `ERROR jules poll: ${e.message}`); }
  return true;
}

async function main() {
  const repoRoot = repoRootFromEnv();
  const argv = process.argv.slice(2);
  if (argv[0] === "--reconcile") return reconcile(repoRoot, { echo: true });
  if (argv[0] === "--heartbeat") return heartbeatLoop(repoRoot);
  if (argv[0] === "--nudge") { if (argv[1] !== "heartbeat") ensureHeartbeat(repoRoot); return nudge(repoRoot, argv[1] ?? "manual", { force: argv[1] === "action" }); }
  if (argv[0] === "--remind") return remind(repoRoot, argv[1], argv[2]);
  if (argv[0] === "--check-launch") return checkLaunch(repoRoot, argv[1], argv[2], argv[3], argv[4]);
  if (argv[0] === "--retry") {
    // Owner escape hatch after a failed launch: forget that the newest entry was routed.
    const change = normChange(argv[1]);
    withLock(repoRoot, () => {
      const state = loadState(repoRoot);
      const cstate = state.changes?.[change];
      const last = (readAllEntries(repoRoot).get(change) ?? []).at(-1);
      if (cstate && last) { cstate.dispatched = (cstate.dispatched ?? []).filter((id) => id !== last.id); cstate.awaiting = null; if (cstate.capped) { const loop = last.verdict.startsWith("plan") ? "plan" : "impl"; cstate.rounds = { ...(cstate.rounds ?? {}), [loop]: Math.max(0, (cstate.rounds?.[loop] ?? 1) - 3) }; delete cstate.capped; } if (cstate.launchFailures) delete cstate.launchFailures[last.id]; writeJsonAtomic(statePath(repoRoot), state); }
      logEvent(repoRoot, `RETRY ${change} - newest entry will be routed again`);
    });
    return reconcile(repoRoot, { echo: true });
  }
  if (argv[0] === "--sidebar") {
    const lp = listPanes();
    if (!lp.ok) { console.error(`cannot list panes: ${lp.error}`); return; }
    const panes = annotatePanes(lp.panes, loadRegistry(repoRoot));
    const trees = discoverTrees(repoRoot);
    const byChange = readAllEntries(repoRoot, trees);
    withLock(repoRoot, () => {
      const state = loadState(repoRoot);
      state.sidebar = {}; // force a full re-send
      const sb = reportSidebar(repoRoot, { panes, trees, byChange, state, pipeline: loadPipeline(repoRoot) });
      writeJsonAtomic(statePath(repoRoot), state);
      for (const [id, t] of Object.entries(sb.panes)) console.log(`pane ${id}: ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join("  ")}`);
      for (const [id, t] of Object.entries(sb.workspaces)) console.log(`space ${id}: ${Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    });
    return;
  }
  if (argv[0] === "--panes") {
    const lp = listPanes();
    if (!lp.ok) { console.error(`cannot list panes: ${lp.error}`); return; }
    for (const p of annotatePanes(lp.panes, loadRegistry(repoRoot))) console.log(`${p.pane_id.padEnd(7)} ${String(p.agent_status).padEnd(8)} ${(p.role ?? "-").padEnd(10)} ${(p.change ?? "").padEnd(12)} ${p.source ?? ""}  ${p.label ?? ""}`);
    return;
  }

  let envelope;
  try { envelope = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}"); } catch { logEvent(repoRoot, "HOOK unparseable HERDR_PLUGIN_EVENT_JSON - ignored"); return; }
  const { event, paneId, agentStatus } = readHookEvent(envelope, process.env.HERDR_PLUGIN_EVENT);
  try {
    // 2026-10-13 REAL INCIDENT: Herdr 0.9.3 subscribes with "pane.agent_status_changed"
    // (plugin.toml / docs) but delivers HERDR_PLUGIN_EVENT_JSON.event as
    // "pane_agent_status_changed". Compare a normalised form so both spellings work.
    const ev = eventKey(event);
    if (ev === "pane_exited" || ev === "pane_closed") {
      if (paneId && forgetPane(repoRoot, paneId)) logEvent(repoRoot, `PANE-GONE ${paneId} (${event}) - unregistered`);
      return;
    }
    // Focus / a newly detected agent: a cheap, throttled reconcile, so a handoff recorded
    // while every pane sat idle (by a background job, a runner, a human) is delivered
    // the moment anything happens in Herdr.
    if (ev === "pane_focused" || ev === "pane_agent_detected") { nudge(repoRoot, ev); return; }
    if (ev && ev !== "pane_agent_status_changed") return;
    if (!READY.has(agentStatus)) return; // working/blocked/unknown: not a settle point (silent - very frequent)
    logEvent(repoRoot, `IDLE ${paneId ?? "?"} (${agentStatus}) -> reconcile`);
    ensureHeartbeat(repoRoot);
    reconcile(repoRoot);
    if (paneId) handleIdle(repoRoot, paneId);
  } catch (e) {
    logEvent(repoRoot, `ERROR ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
  const hardStop = "[contract_completion_gate]\nCONTRACT GATE (obligation.tests_pass_before_done) - STOPPED after 10 attempts: tests are still not green. This run did NOT complete; a human must review it. Do not treat it as done.";
  ok(completionGateStop(hardStop) !== null, "completion hard stop routes to diagnosis");
  ok(completionGateStop(hardStop.replace("after 10 attempts", "after\n10 attempts")) !== null, "completion hard stop handles terminal wrapping");
  ok(completionGateStop("tests failed; try again") === null, "ordinary test failure is not a hard stop");
  ok(completionGateStop(hardStop + "\nmore work".repeat(20)) === null, "old scrolled hard stop is ignored");
  const mr = { id: "owner-1", owner_authorized: true, change: "CHANGE-0012", pane_id: "old", source: "claude", target: "opencode" };
  const mp = { role: "worker", change: "CHANGE-0012", pane_id: "old", agent: "claude", alive: true, starting: false, agent_status: "idle" };
  ok(requestedWorkerMigrations([mr], [mp]).length === 1, "owner migration accepts exact idle Claude worker");
  for (const patch of [{ agent_status: "working" }, { pane_id: "replacement" }, { agent: "opencode" }, { role: "integrator" }, { alive: false }, { starting: true }]) {
    ok(requestedWorkerMigrations([mr], [{ ...mp, ...patch }]).length === 0, "owner migration refuses active/replaced/wrong-role/dead/startup pane " + JSON.stringify(patch));
  }
  ok(requestedWorkerMigrations([{ ...mr, owner_authorized: false }], [mp]).length === 0, "owner migration requires explicit authorization");
  ok(requestedWorkerMigrations([{ ...mr, target: "shell" }], [mp]).length === 0, "owner migration refuses arbitrary target");
  ok(requestedWorkerMigrations([mr], [{ ...mp, agent: null, label: "claude-worker-CHANGE-0012" }]).length === 1, "owner migration matches exact idle Claude label when agent detection is absent");
  ok(requestedWorkerMigrations([{ ...mr, source: "opencode", target: "antigravity" }], [{ ...mp, agent: "opencode" }]).length === 1, "owner migration accepts idle OpenCode to Antigravity");
  ok(requestedWorkerMigrations([{ ...mr, source: "opencode", target: "opencode" }], [{ ...mp, agent: "opencode" }]).length === 0, "owner migration refuses same backend");
  ok(requestedWorkerMigrations([{ ...mr, source: "shell", target: "antigravity" }], [mp]).length === 0, "owner migration refuses arbitrary source");
  ok(migrationRoutingReady("routing:\n  backend: opencode\n", "opencode"), "owner migration accepts committed target routing");
  ok(!migrationRoutingReady("routing:\n  backend: claude\n", "opencode"), "owner migration refuses old routing");
  const pipeline = JSON.parse(readFileSync(join(HERE, "pipeline.json"), "utf8"));
  const E = (role, verdict, at, extra = {}) => ({ id: `${role}-${verdict}-${at}`, at: `2026-10-13T${at}:00.000Z`, change: "CHANGE-0001", role, verdict, note: "", file: null, sha: "abc123", tree_branch: role === "planner" ? "planning/pi" : "main", ...extra });
  const P = (pane_id, label, agent_status = "idle") => ({ pane_id, label, agent: "pi", agent_status });
  const reg = {};
  const livePanes = annotatePanes([P("w1:p6", "pi-planner-pi"), P("w2:p5", "pi-integrator-integrator-pi"), { pane_id: "w1:p1", agent_status: "unknown" }], reg);

  // pane roles
  ok(livePanes[0].role === "planner" && livePanes[1].role === "integrator" && livePanes[2].role === null, "REGRESSION: the real Johannas_verden labels map to planner/integrator; a plain shell maps to nothing");
  ok(roleOfPane({ pane_id: "x", label: "pi-integrator-auto-change-0050" }).change === "CHANGE-0050", "REGRESSION (v1 bug): lowercased change id in a label is recognised");
  ok(roleOfPane({ pane_id: "w9:p1", label: "random" }, { "w9:p1": { role: "worker", change: "CHANGE-0002" } }).role === "worker", "registry beats label");

  // planner -> integrator
  let d = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00", { note: "fixed validator" })], panes: livePanes, pipeline, now: "2026-10-13T10:01:00.000Z" });
  ok(d.action === "prompt" && d.pane === "w2:p5" && d.role === "integrator", "plan-ready -> prompt the live integrator pane");
  ok(/planning\/pi @ abc123/.test(d.text) && /--verdict plan-approved\|plan-changes-requested/.test(d.text) && /fixed validator/.test(d.text), "prompt names the branch/sha, the allowed verdicts and the planner's note");
  ok(d.stateUpdate.awaiting.role === "integrator" && d.stateUpdate.dispatched.length === 1, "awaiting integrator; entry marked routed");

  // already routed -> nothing
  ok(planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00")], cstate: d.stateUpdate, panes: livePanes, pipeline, now: "x" }).action === "none", "same entry never routed twice");

  // integrator rejects -> planner, round counted
  const entries2 = [E("planner", "plan-ready", "10:00"), E("integrator", "plan-changes-requested", "10:30", { file: "docs/changes/CHANGE-0001-x/integrator-review-4.md" })];
  d = planDispatch({ change: "CHANGE-0001", entries: entries2, cstate: { dispatched: [entries2[0].id] }, panes: livePanes, pipeline, now: "n" });
  ok(d.action === "prompt" && d.pane === "w1:p6" && /integrator-review-4\.md/.test(d.text) && d.stateUpdate.rounds.plan === 1, "plan-changes-requested -> prompt planner with the review file; plan round 1");

  // report path + round from the numbered report files
  d = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00", { file: ".worktrees/p/docs/changes/CHANGE-0001-x/planner-handoff-5.md" })], panes: livePanes, pipeline, now: "n", reportCounts: { reviews: 4, worker: 0 } });
  ok(/plan round 5/.test(d.text) && d.text.includes("Read their report first: /repo/.worktrees/p/docs/changes/CHANGE-0001-x/planner-handoff-5.md"), "REGRESSION: prompt says plan round 5 (4 reviews done) and points at the report under /repo");
  ok(/handoff\.mjs new --change CHANGE-0001 --role integrator/.test(d.text), "prompt tells the integrator to start its review from the template");

  // round cap
  d = planDispatch({ change: "CHANGE-0001", entries: entries2, cstate: { rounds: { plan: 5 } }, panes: livePanes, pipeline: { ...pipeline, max_rounds: { plan: 5, impl: 5 } }, now: "n" });
  ok(d.action === "notify" && /5 plan rounds/.test(d.message), "REGRESSION: 5 rejected plan rounds -> owner, not a 6th round");

  // source still working -> defer
  const busyPlanner = annotatePanes([P("w1:p6", "pi-planner-pi", "working"), P("w2:p5", "pi-integrator-x")], reg);
  ok(planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00")], panes: busyPlanner, pipeline, now: "n" }).action === "defer", "reporter still working -> wait for it to settle");

  // target working -> defer; target blocked -> notify once
  const busyInt = annotatePanes([P("w1:p6", "pi-planner-pi"), P("w2:p5", "pi-integrator-x", "working")], reg);
  ok(planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00")], panes: busyInt, pipeline, now: "n" }).action === "defer", "integrator busy -> deliver on its next idle, not now");
  const blockedInt = annotatePanes([P("w1:p6", "pi-planner-pi"), P("w2:p5", "pi-integrator-x", "blocked")], reg);
  d = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00")], panes: blockedInt, pipeline, now: "n" });
  ok(d.action === "notify" && d.once && d.stateUpdate === null, "integrator blocked on a question -> tell the owner, keep the entry pending");

  // no integrator pane -> launch one
  d = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00")], panes: annotatePanes([P("w1:p6", "pi-planner-pi")], reg), pipeline, now: "n" });
  ok(d.action === "launch" && d.role === "integrator", "no integrator pane -> launch one with the prompt as TASK");

  // approved -> worker launch (no worker pane for this change)
  d = planDispatch({ change: "CHANGE-0001", entries: [E("integrator", "plan-approved", "11:00")], panes: livePanes, pipeline, now: "n" });
  ok(d.action === "launch" && d.role === "worker" && /--verdict impl-ready/.test(d.text), "plan-approved -> launch a worker whose TASK tells it how to report");
  const withWorkers = annotatePanes([...livePanes, P("w3:p1", "pi-worker-CHANGE-0002"), P("w3:p2", "pi-worker-CHANGE-0001")], reg);
  d = planDispatch({ change: "CHANGE-0001", entries: [E("integrator", "impl-changes-requested", "12:00")], panes: withWorkers, pipeline, now: "n" });
  ok(d.action === "prompt" && d.pane === "w3:p2" && d.stateUpdate.rounds.impl === 1, "impl-changes-requested -> THIS change's worker pane, never another change's");

  // liveness: a dead worker pane is never a target; a starting one is waited for
  {
    const now = Date.parse("2026-10-15T10:00:00Z");
    const reg2 = { "w2:p6": { role: "worker", change: "CHANGE-0001", at: "2026-10-13T22:31:08Z" }, "w3:p1": { role: "worker", change: "CHANGE-0002", at: "2026-10-15T09:59:30Z" } };
    const raw = [P("w1:p6", "pi-planner-pi"), P("w2:p5", "pi-integrator-x"), { pane_id: "w2:p6", label: "pi-worker-CHANGE-0001", agent_status: "unknown" }, { pane_id: "w3:p1", label: "pi-worker-CHANGE-0002", agent_status: "unknown" }];
    const ann = annotatePanes(raw, reg2, now);
    const dead = ann.find((p) => p.pane_id === "w2:p6"), starting = ann.find((p) => p.pane_id === "w3:p1");
    ok(dead.alive === false && dead.starting === false && starting.starting === true, "REGRESSION (2026-10-13): an old worker pane with no agent is dead; a just-launched one is still starting");
    d = planDispatch({ change: "CHANGE-0001", entries: [E("integrator", "plan-approved", "11:00")], panes: ann, pipeline, now: "n" });
    ok(d.action === "launch" && d.role === "worker", "plan-approved with only a DEAD worker pane -> launch a fresh worker, do not wait on the dead one");
    d = planDispatch({ change: "CHANGE-0002", entries: [E("integrator", "plan-approved", "11:00", { change: "CHANGE-0002" })], panes: ann, pipeline, now: "n" });
    ok(d.action === "defer", "a worker pane that is still starting -> wait, never a second launch");
    ok(annotatePanes(raw, reg2, now, true).find((p) => p.pane_id === "w2:p6").starting === true, "while an image build is running, a registered pane without an agent counts as starting, not dead");
    const liveW = annotatePanes([...raw.slice(0, 2), P("w4:p1", "pi-worker-CHANGE-0001")], {}, now);
    d = planDispatch({ change: "CHANGE-0001", entries: [E("integrator", "plan-approved", "11:00")], panes: liveW, pipeline, now: "n" });
    ok(d.action === "prompt" && d.pane === "w4:p1", "plan-approved again while a LIVE worker exists -> prompt that worker, never a duplicate launch");
  }

  // human routes
  ok(planDispatch({ change: "CHANGE-0001", entries: [E("planner", "question", "10:00", { note: "which grade levels?" })], panes: livePanes, pipeline, now: "n" }).message.includes("which grade levels?"), "question -> owner, with the question text");
  ok(planDispatch({ change: "CHANGE-0001", entries: [E("integrator", "frobnicate", "10:00")], panes: livePanes, pipeline, now: "n" }).action === "notify", "unknown verdict -> owner, not guessed");

  // reminders
  const aw = { role: "integrator", change: "CHANGE-0001", since: "2026-10-13T10:01:00.000Z", pane: "w2:p5", reminded: false, reminderScheduled: false };
  const intPane = livePanes[1];
  ok(planReminder({ pane: intPane, cstate: { awaiting: aw }, entries: [] }).action === "schedule", "integrator idle without reporting -> schedule one reminder");
  ok(planReminder({ pane: intPane, cstate: { awaiting: { ...aw, reminderScheduled: true } }, entries: [] }).action === "none", "reminder already scheduled -> nothing");
  ok(planReminder({ pane: intPane, cstate: { awaiting: { ...aw, reminded: true } }, entries: [] }).action === "notify", "idle again after the reminder -> owner");
  ok(planReminder({ pane: intPane, cstate: { awaiting: aw }, entries: [E("integrator", "plan-approved", "10:30")] }).action === "none", "reported since -> no reminder");
  ok(planReminder({ pane: livePanes[0], cstate: { awaiting: aw }, entries: [] }).action === "none", "a different role idling -> no reminder");

  // worker backend choice
  ok(chooseWorkerBackend({ riskTier: "high", pipeline: { ...pipeline, worker_backend_by_risk: { high: "pi" } } }).backend === "pi", "pinned backend honoured");
  // (fixed test pipeline - independent of what this project's pipeline.json pins)
  const autoP = { worker_backend_by_risk: { low: "auto", medium: "auto", high: "auto", critical: "human" }, auto_backends: ["pi", "claude", "codex"] };
  ok(chooseWorkerBackend({ riskTier: "critical", pipeline: autoP }).escalate, "critical -> human");
  ok(chooseWorkerBackend({ riskTier: "low", pipeline: autoP }).backend === "pi", "auto + low risk never picks antigravity (seed needs manual paste) when it isn't in auto_backends");
  ok(chooseWorkerBackend({ riskTier: "high", pipeline: { ...autoP, auto_backends: ["pi"] } }).escalate, "high risk with only pi allowed -> escalate, not silently cheap");

  // sidebar
  ok(shortModel("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free") === "nemotron-3-ultra-550b-a55b (free)", "model id shortened, free tier kept visible");
  ok(shortModel("gpt-6.1-sol") === "gpt-6.1-sol", "plain model id unchanged");
  {
    const panesWs = annotatePanes([{ ...P("w1:p6", "pi-planner-pi"), workspace_id: "w1" }, { ...P("w2:p5", "pi-integrator-integrator-pi"), workspace_id: "w2" }], reg);
    const byChange = new Map([["CHANGE-0001", [E("integrator", "plan-changes-requested", "19:53")]]]);
    const sessions = [
      { name: "johannas-verden-planner-pi", branch: "planning/pi", model: "nvidia/nemotron-3-ultra-550b-a55b:free", mtimeMs: 2 },
      { name: "integrator-integrator-pi", branch: "main", model: "gpt-6.1-sol", mtimeMs: 1 },
    ];
    const sb = computeSidebar({ panes: panesWs, byChange, pipeline, sessions, reviewCounts: { "CHANGE-0001": 4 } });
    const pl = sb.panes["w1:p6"], it = sb.panes["w2:p5"];
    ok(pl.role === "planner" && pl.change === "CHANGE-0001" && pl.round === "plan r5" && pl.branch === "planning/pi", "REGRESSION (the real situation): planner row = planner / CHANGE-0001 / plan r5 / planning/pi");
    ok(pl.handoff === "> your turn: revise plan" && it.handoff === "waiting on planner", "whose turn it is, from the ledger");
    ok(pl.model === "nemotron-3-ultra-550b-a55b (free)" && it.model === "gpt-6.1-sol", "model from each pane's own pi session");
    ok(sb.workspaces.w1.pipeline === "CHANGE-0001 plan r5: planner" && sb.workspaces.w2, "space summary on every harness workspace");
    const sbW = computeSidebar({ panes: annotatePanes([{ ...P("w3:p1", "pi-worker-CHANGE-0002"), workspace_id: "w3" }], reg), byChange: new Map([["CHANGE-0002", [E("integrator", "plan-approved", "12:00", { change: "CHANGE-0002" })]]]), pipeline,
      sessions: [{ name: "harness-change-0002-x", branch: "feature/CHANGE-0002-x", model: "local/qwen3-coder-30b-6bit", mtimeMs: 1 }] });
    ok(sbW.panes["w3:p1"].branch === "feature/CHANGE-0002-x" && sbW.panes["w3:p1"].round === "impl r1" && sbW.panes["w3:p1"].handoff === "> your turn: implement", "worker row: feature branch, impl round, its turn");
    // usage meters + account block (2026-10-16)
    const now = Date.UTC(2026, 9, 16, 9);
    const catalog = { models: [{ id: "openai-codex/gpt-6.1-sol", backend: "pi", tier: 3, cost: "sub", quotas: ["codex_5h", "codex_weekly"], context_window: 272000 }] };
    const usage = { at: now - 60e3, quotas: { codex_5h: { usedPct: 10 }, codex_weekly: { usedPct: 40 }, claude_5h: { usedPct: 30 } } };
    const sessM = [{ ...sessions[1], dir: "/x/integrator-integrator-pi" }];
    const sbM = computeSidebar({ panes: panesWs, byChange, pipeline, sessions: sessM, meters: { "/x/integrator-integrator-pi": { contextTokens: 54000, contextPct: 20, cacheHitPct: 93.3, provider: "openai-codex", model: "gpt-6.1-sol" } }, usage, catalog, now });
    ok(sbM.panes["w2:p5"].ctx === "ctx 20% (54k)" && sbM.panes["w2:p5"].cache === "cache 93%" && sbM.panes["w2:p5"].limit === "wk 60%", `pane meters: ctx / cache / tightest limit (got ${JSON.stringify(sbM.panes["w2:p5"])})`);
    ok(/Codex +5h 90% +wk 60%/.test(sbM.workspaces.w2.usage_2 ?? "") && /Claude/.test(sbM.workspaces.w2.usage_1) && !sbM.workspaces.w1.usage_1, "usage block only on the integrator's workspace");
  }

  // text is ASCII-only (herdr's CLI rejected non-UTF-8 argv before; keep it plain)
  d = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "plan-ready", "10:00", { note: "æøå fixed" })], panes: livePanes, pipeline, now: "n" });
  ok(/^[\x20-\x7E]*$/.test(d.text), "prompt text is plain ASCII");

  ok(unwrapEventPayload({ event: "x", data: { pane_id: "p1" } }).pane_id === "p1", "event envelope .data unwrapped");
  {
    const nested = { event: "pane.agent_status_changed", data: { pane: { pane_id: "w2:p5", agent_status: "idle" } } };
    const r = readHookEvent(nested, undefined);
    ok(r.paneId === "w2:p5" && r.agentStatus === "idle" && r.event === "pane.agent_status_changed", "REGRESSION (2026-10-13): pane_id/agent_status nested below .data are still found");
    const flat = readHookEvent({ event: "pane.agent_status_changed", data: { pane_id: "w1:p6", agent_status: "done" } }, undefined);
    ok(flat.paneId === "w1:p6" && flat.agentStatus === "done", "the documented flat .data shape still works");
    ok(readHookEvent({ type: "pane.exited", payload: { pane_id: "w9:p1" } }, undefined).event === "pane.exited", "event name from .type when .event is absent");
    ok(readHookEvent({ data: { pane_id: "w1:p1", agent_status: "idle" } }, "pane.agent_status_changed").event === "pane.agent_status_changed", "event name falls back to HERDR_PLUGIN_EVENT");
    const real = readHookEvent({ event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w2:p5", workspace_id: "w2", agent_status: "idle", agent: "pi" } }, "pane.agent_status_changed");
    ok(eventKey(real.event) === eventKey("pane.agent_status_changed") && real.paneId === "w2:p5" && real.agentStatus === "idle", "REGRESSION (2026-10-13): the REAL Herdr 0.9.3 payload (underscored event name) is recognised");
    ok(eventKey("pane.exited") === "pane_exited" && eventKey("pane_closed") === "pane_closed", "exit/close events normalised the same way");
  }

  {
    const M = [{ id: "a", role: "worker", verdict: "impl-ready" }, { id: "b", role: "integrator", verdict: "merged" }];
    const wp = (st, ch = "CHANGE-0002") => ({ pane_id: "w2:pD", role: "worker", change: ch, alive: true, agent_status: st });
    const r = planRetire({ change: "CHANGE-0002", entries: M, panes: [wp("idle"), wp("idle", "CHANGE-0004")], pipeline: {} });
    ok(r.action === "retire" && r.panes.length === 1, "merged -> retire ONLY this change's worker pane");
    ok(planRetire({ change: "CHANGE-0002", entries: M.slice(0, 1), panes: [wp("idle")] }).action === "none", "impl-ready alone never retires (integrator may send it back)");
    ok(planRetire({ change: "CHANGE-0002", entries: M, panes: [wp("working")] }).action === "defer", "worker still working -> defer, not killed mid-turn");
    ok(planRetire({ change: "CHANGE-0002", entries: M, cstate: { retired: "b" }, panes: [wp("idle")] }).action === "none", "retired once per merged entry");
    ok(planRetire({ change: "CHANGE-0002", entries: M, panes: [wp("idle")], pipeline: { close_worker_on_merge: false } }).action === "none", "close_worker_on_merge:false disables it");
    const re = workerContainerPattern("CHANGE-0002");
    ok(re.test("harness-change-0002") && re.test("harness-change-0002-02") && !re.test("harness-change-00021") && !re.test("harness-planner-pi"), "container pattern matches only this change's worker");
  }

  {
    const T = "doing work...\n\n Error: Retry failed after 3 attempts: A Timeout Occurred\n\n> ";
    ok(planAutoContinue({ tail: T }).action === "continue", "REGRESSION (2026-10-16): 'Retry failed after 3 attempts: A Timeout Occurred' -> continue");
    ok(planAutoContinue({ tail: "Error: 503 Service Unavailable\n>" }).action === "continue", "503 at the bottom -> continue");
    ok(planAutoContinue({ tail: "A Timeout Occurred\n" + "more output\n".repeat(10) }).action === "none", "error scrolled up (not at the bottom) -> nothing");
    ok(planAutoContinue({ tail: "All done. Handoff recorded.\n>" }).action === "none", "normal idle -> nothing");
    const sig = planAutoContinue({ tail: T }).sig;
    ok(planAutoContinue({ tail: T, history: { lastSig: sig } }).action === "none", "same screen as our last continue -> no repeat");
    const now = Date.now();
    ok(planAutoContinue({ tail: T, history: { sent: [now - 1e3, now - 2e3, now - 3e3] }, now }).action === "notify", "4th error within an hour -> owner, not a 4th continue");
    ok(planAutoContinue({ tail: T, cfg: { enabled: false } }).action === "none", "auto_continue.enabled:false disables it");
  }

  // by_role routes (owner 2026-10-18): a worker's block goes to the integrator, a planner's to the owner
  {
    const wb = planDispatch({ change: "CHANGE-0001", entries: [E("worker", "blocked", "10:00", { note: "branch lacks main" })], panes: livePanes, pipeline, now: "n" });
    ok(wb.action === "prompt" && wb.role === "integrator" && /You own unblocking it/.test(wb.text), `worker blocked -> integrator prompt (got ${wb.action} ${wb.role ?? ""})`);
    const pb = planDispatch({ change: "CHANGE-0001", entries: [E("planner", "blocked", "10:00", { note: "x" })], panes: livePanes, pipeline, now: "n" });
    ok(pb.action === "notify", "planner blocked -> owner");
    const hr = planDispatch({ change: "CHANGE-0001", entries: [E("harness", "stalled", "10:00", { file: ".pi-session/triage/CHANGE-0001-x.md" })], panes: livePanes, pipeline, now: "n" });
    ok(hr.action === "prompt" && hr.role === "integrator" && /triage/.test(hr.text), "harness stalled -> integrator triage prompt");
    const ma = planDispatch({ change: "CHANGE-0001", entries: [E("human", "merge-approved", "10:00")], panes: livePanes, pipeline, now: "n" });
    ok(ma.action === "prompt" && ma.role === "integrator" && /OWNER approved/.test(ma.text), "owner merge approval -> integrator");
  }
  if (fails) { console.error(`\n${fails} self-test(s) FAILED`); process.exit(1); }
  console.log("lifecycle-watcher self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("lifecycle-watcher.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main().catch((e) => { try { logEvent(repoRootFromEnv(), `ERROR ${e.message}`); } catch { /* nothing */ } });
}
