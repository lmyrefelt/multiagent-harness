/**
 * contract-guard — a GENERIC mechanical enforcement engine (thin pi adapter).
 *
 * All evaluation logic lives in ./checks.mjs so that verify-guards.mjs tests the
 * exact code that runs in a live session. A test against a copy proves nothing.
 *
 * It knows nothing about the worker, the repository, or the specific rules. It
 * reads guards.json (compiled from the contract) and applies it to the event
 * stream.
 *
 * Design constraints:
 *  - FAIL SAFE. A guard that throws blocks the tool (VERIFIED: docs/extensions.md,
 *    "A tool_call handler failure blocks the tool as a fail-safe"). Do not add a
 *    catch that swallows errors.
 *  - NO FALSE POSITIVES. Paths normalized to repo-relative before matching.
 *  - FAIL LOUD when the config is missing. A silent no-op is the worst possible
 *    failure for a load-bearing layer.
 *  - EVERY verdict is logged, pass and fail, so adherence is auditable after the
 *    fact rather than self-reported by the model.
 *
 * Env:
 *   CONTRACT_GUARDS   path to guards.json (default ./generated/guards.json)
 *   CONTRACT_EVIDENCE path to JSONL log   (default ./.contract-evidence.jsonl)
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { evaluateDuring, evaluatePost, evaluatePre, newCounters, MUTATORS, shouldGateCompletion, claimsCompletion, testsRanAndPassed, shouldRecoverFromDisconnect, isTestInvocation } from "./checks.mjs";
import { normalize } from "./checks.mjs";
import { loopConfig, newLoopState, observe, shapeOutput, parseExitCode, isTestCommand, sha as loopSha } from "./loop-checks.mjs";

const GUARDS_PATH = process.env.CONTRACT_GUARDS ?? "./generated/guards.json";
const EVIDENCE_PATH = process.env.CONTRACT_EVIDENCE ?? "./.contract-evidence.jsonl";

function log(rec) {
	try { appendFileSync(EVIDENCE_PATH, JSON.stringify({ t: Date.now(), ...rec }) + "\n"); }
	catch { /* logging must never block a run */ }
}

function readGuards(cwd) {
	const p = resolve(cwd, GUARDS_PATH);
	if (!existsSync(p)) return null;
	try { return JSON.parse(readFileSync(p, "utf8")).guards ?? []; }
	catch (e) { log({ ev: "guard_load_failed", path: p, err: String(e) }); return null; }
}

export default function (pi) {
	let repoRoot = process.cwd();
	let guards = readGuards(repoRoot) ?? [];
	// max_total_blocks_window (2026-10-11): 10 refusals is a stuck run if they
	// happen within a tight span; 10 refusals spread thinly across an otherwise
	// long, healthy session (now up to 400 tool calls - see the host project's
	// MAX_TOOL_CALLS) is not the same signal and was tripping the SAME cap,
	// ending a run that was not actually stuck. 100 is chosen to match
	// no_progress_loop's own order-of-magnitude window (20 calls for an exact-
	// repeat detector; 100 here since this cap counts ANY block, a strictly
	// rarer event than one repeated edit).
	const ctx = { repoRoot, counters: newCounters(), max_consecutive_blocks: 5, max_total_blocks: 10, max_total_blocks_window: 100 };
	let lastViolation = null;
	let latchedPrecondition = null;
	let completionAttempts = 0;
	// Every bash command the model has issued, for the completion gate to scan.
	const testCommands = [];
	// Consecutive upstream-disconnect count - see shouldRecoverFromDisconnect's
	// own header (checks.mjs) for why this is consecutive, not cumulative.
	let disconnectAttempts = 0;
	const MAX_DISCONNECT_RETRIES = 5;
	// Consecutive transient-overload errors (see TRANSIENT_OVERLOAD_RE in
	// checks.mjs). pi retries those itself, so the recovery follow-up is only
	// sent on the OVERLOAD_THRESHOLD-th one in a row - or by the stall timer
	// below if pi stops retrying and nothing else happens.
	let overloadStreak = 0;
	const OVERLOAD_THRESHOLD = Math.max(1, Number(process.env.CONTRACT_OVERLOAD_THRESHOLD ?? 3) || 3);
	// How long the session must sit IDLE (pi's own retries given up, nothing queued)
	// before a recovery for a below-threshold overload is sent anyway.
	const OVERLOAD_STALL_MS = Math.max(5000, Number(process.env.CONTRACT_OVERLOAD_STALL_MS ?? 30000) || 30000);
	// ...and after the threshold: idle this long once pi's last retry failed.
	const RECOVERY_IDLE_MS = Math.max(2000, Number(process.env.CONTRACT_RECOVERY_IDLE_MS ?? 5000) || 5000);
	let turnSeq = 0;
	// Never stack recovery messages (owner-reported 2026-10-13: 7 identical
	// "Follow-up: [CONTRACT] ..." lines queued while pi was still retrying).
	// A recovery is only queued if nothing is already waiting in pi's queue
	// (ctx.hasPendingMessages()) AND our own last one has been delivered
	// (cleared when a [CONTRACT] user message starts). Belt and braces: the
	// ctx helper is the authoritative check, the flag covers pi versions
	// without it.
	let recoveryQueued = false;
	let lastCtx: any = null;
	// After giving up (exhausted / permanent / model-config), say so ONCE until
	// a turn succeeds again - re-posting it on every later failure is what
	// turned a broken model into an endless flood.
	let gaveUp = false;
	const queueBusy = (ctx: any) => {
		try { if (typeof ctx?.hasPendingMessages === "function" && ctx.hasPendingMessages()) return "pending_messages"; } catch { /* older pi */ }
		return recoveryQueued ? "own_recovery_queued" : null;
	};
	const sendRecovery = (content: string, ctx: any, meta: Record<string, unknown>) => {
		const busy = queueBusy(ctx);
		if (busy) { log({ ev: "disconnect_recovery_skipped_queued", why: busy, ...meta }); return false; }
		pi.sendUserMessage(content, { deliverAs: "followUp" });
		recoveryQueued = true;
		return true;
	};
	pi.on("message_start", (event: any) => {
		const m = event?.message;
		if (m?.role !== "user") return;
		const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join(" ") : "";
		if (text.includes("[CONTRACT]")) recoveryQueued = false;
	});
	let stallTimer: ReturnType<typeof setTimeout> | null = null;

	// WAIT FOR PI'S OWN RETRY (owner-reported 2026-10-15): after an overload pi
	// shows "retrying in Ns" and usually gets through - a follow-up sent at that
	// moment just lands in the queue and piles up. pi does not tell extensions
	// about its retries, but it does say whether it is idle (ctx.isIdle()) and a
	// retry that gets through starts a new assistant message. So a recovery is
	// only ever sent once the session has been IDLE for a while with no new
	// activity - i.e. pi gave up and the session would otherwise sit there.
	let activitySeq = 0;
	let idleWatch: ReturnType<typeof setInterval> | null = null;
	let idleMeta: Record<string, any> | null = null;
	const isIdleNow = () => { try { return typeof lastCtx?.isIdle === "function" ? !!lastCtx.isIdle() : true; } catch { return true; } };
	// Stop waiting. A recovery that was never sent gives its attempt back.
	const cancelIdleWatch = (why: string | null, sent = false) => {
		if (!idleWatch) return;
		clearInterval(idleWatch); idleWatch = null;
		if (!sent && idleMeta?.counted) disconnectAttempts = Math.max(0, disconnectAttempts - 1);
		idleMeta = null;
		if (why) log({ ev: "disconnect_recovery_not_needed", why });
	};
	const sendWhenIdle = (content: string, meta: Record<string, any>, idleMs: number) => {
		cancelIdleWatch(null); // at most ONE pending recovery, ever
		idleMeta = meta;
		const seq0 = activitySeq;
		const started = Date.now();
		let idleSince = 0;
		idleWatch = setInterval(() => {
			if (activitySeq !== seq0) { cancelIdleWatch("pi resumed on its own (its retry got through)"); return; }
			if (!isIdleNow()) { idleSince = 0; return; }
			if (!idleSince) idleSince = Date.now();
			if (Date.now() - idleSince < idleMs) return;
			let ok = false;
			try { ok = sendRecovery(content, lastCtx, meta); } catch (e) { log({ ev: "disconnect_recovery_send_failed", err: String(e), via: meta.via }); }
			cancelIdleWatch(null, ok);
			if (ok) log({ ev: "disconnect_recovery_sent", attempt: meta.attempt, via: meta.via, waitedMs: Date.now() - started });
		}, 1000);
		(idleWatch as any)?.unref?.();
	};
	pi.on("turn_start", () => { activitySeq += 1; });

	// ---- CODEX SUBSCRIPTION USAGE (owner request 2026-10-15) ----------------
	// pi's openai-codex provider signs in with the ChatGPT account (Codex Plus).
	// The same login reads the 5h / weekly windows Codex itself shows, from
	// GET chatgpt.com/backend-api/wham/usage. The token comes from pi's model
	// registry (which refreshes it) - never from parsing auth.json here. Only the
	// percentages are logged, as codex_quota_snapshot, for the worker router
	// (scripts/route-worker.mjs) and the dashboard. At most every 10 minutes;
	// any failure is logged once and otherwise ignored.
	const CODEX_USAGE_EVERY_MS = 10 * 60 * 1000;
	let codexPolledAt = 0;
	const pollCodexUsage = async (ctx: any) => {
		if (Date.now() - codexPolledAt < CODEX_USAGE_EVERY_MS) return;
		codexPolledAt = Date.now();
		try {
			const token = await ctx?.modelRegistry?.getApiKeyForProvider?.("openai-codex");
			if (!token) return; // no Codex login configured in this pi
			const claims = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
			const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
			if (!accountId) return;
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), 8000);
			let r: any;
			try {
				r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
					headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": accountId, Accept: "application/json", originator: "pi" },
					signal: ctl.signal,
				});
			} finally { clearTimeout(timer); }
			if (!r.ok) { log({ ev: "codex_usage_unavailable", status: r.status }); return; }
			const j: any = await r.json();
			const w = (x: any) => (x && typeof x.used_percent === "number") ? { used_percent: x.used_percent, window_seconds: x.limit_window_seconds ?? null, reset_at: x.reset_at ?? null } : null;
			log({ ev: "codex_quota_snapshot", plan_type: j?.plan_type ?? null, primary: w(j?.rate_limit?.primary_window), secondary: w(j?.rate_limit?.secondary_window) });
		} catch (e) {
			log({ ev: "codex_usage_unavailable", err: String(e).slice(0, 200) });
		}
	};
	pi.on("session_start", (_e: any, ctx: any) => { void pollCodexUsage(ctx); });
	pi.on("message_start", (event: any) => { if (event?.message?.role === "assistant") activitySeq += 1; });

	if (guards.length === 0) {
		log({ ev: "no_guards_loaded", path: GUARDS_PATH, cwd: repoRoot });
		// MEASURED (2026-10-08): a session ran to completion with guards.length
		// === 0 - every tool_call vacuously passed (nothing to violate), so the
		// session was fully unguarded while LOOKING identical to a normal run
		// except for this one easily-missed log line. "FAIL LOUD when the
		// config is missing" (this file's own header) was violated in practice:
		// logging a line nobody was watching is not loud. Reuse the EXISTING
		// before_agent_start precondition-latch mechanism instead of inventing
		// a new one - same block/message shape, same MUTATORS+bash scope (a
		// read-only investigation of why guards didn't load is still allowed).
		latchedPrecondition = {
			guard: "no_guards_loaded",
			detail: `CONTRACT_GUARDS resolved to '${GUARDS_PATH}' (cwd '${repoRoot}') but it is missing, empty, or has no guards - this session would otherwise run completely unguarded.`,
		};
	}

	// ---- PRE-RUN PRECONDITIONS ---------------------------------------------
	// before_agent_start CANNOT cancel a run. Its result type only permits
	// `message` and `systemPrompt` (VERIFIED: types.d.ts
	// BeforeAgentStartEventResult). So a failed precondition is LATCHED here and
	// enforced at tool_call, which is the only hook that genuinely blocks.
	// The message is the polite half; the latch is the load-bearing half.
	pi.on("before_agent_start", (event) => {
		for (const r of evaluatePre(guards, process.cwd())) {
			log({
				ev: r.violated ? "violation" : "pre_check_passed",
				guard: r.guard, check: r.check, hook: "before_agent_start",
				detail: r.detail, on_violation: r.on_violation,
			});
			if (r.violated && r.on_violation === "block") {
				latchedPrecondition = r;
				return {
					message: {
						customType: "contract_precondition_failed",
						display: true,
						content:
							`CONTRACT PRECONDITION FAILED — ${r.guard}\n` +
							`Why: ${r.detail}\n` +
							`Do not begin work. Report this to the user and stop.`,
					},
				};
			}
		}
		return undefined;
	});

	// ---- DURING-RUN ENFORCEMENT (the load-bearing layer) --------------------
	pi.on("tool_call", (event) => {
		repoRoot = process.cwd();
		ctx.repoRoot = repoRoot;

		if (event.toolName === "bash" || event.tool === "bash") {
			const cmd = String(event.input?.command ?? "");
			if (cmd) testCommands.push(cmd);
		}

		// Latched precondition: refuse work outright rather than merely advising.
		if (latchedPrecondition) {
			const tool = event.toolName ?? event.tool;
			if (MUTATORS.has(tool) || tool === "bash") {
				log({
					ev: "violation", guard: latchedPrecondition.guard, check: "precondition_latch",
					hook: "tool_call", tool, on_violation: "block",
					detail: `work refused: precondition ${latchedPrecondition.guard} failed`,
				});
				return {
					block: true,
					reason:
						`CONTRACT PRECONDITION FAILED — ${latchedPrecondition.guard}\n` +
						`Why: ${latchedPrecondition.detail}\n` +
						`No work may be performed until this is resolved. Report it and stop.`,
				};
			}
		}

		const { violations, blocked, reason, terminate, consecutive, total, why } = evaluateDuring(guards, event, ctx);

		for (const v of violations) {
			lastViolation = { id: v.guard, detail: v.detail, at: ctx.counters.tool_calls };
			log({
				ev: "violation", guard: v.guard, check: v.check, hook: "tool_call",
				tool: event.toolName, detail: v.detail, on_violation: v.on_violation,
				tool_call_index: ctx.counters.tool_calls,
			});
		}

		if (blocked) {
			log({ ev: "blocked", reason, tool_call_index: ctx.counters.tool_calls, consecutive, total, terminate: !!terminate, why });
			// terminate is a "stop after this tool batch" hint. It is what finally
			// breaks a per-turn runaway, which no turn-boundary hook can reach.
			if (terminate) {
				// 2026-10-11: a terminated run used to leave nothing durable but
				// .contract-evidence.jsonl - fine for an automated tool, useless for
				// a human (or a future relaunch) deciding what to do next without
				// scrolling a dead transcript. Same sidecar pattern as the
				// completion-gate's own capturedEvidence write below - a durable
				// record lives in a FILE, not in the model's prose, same reasoning.
				// Written HERE, at the moment of termination inside tool_call,
				// rather than deferred to agent_settled - that hook's firing after a
				// tool_call-level terminate is not independently confirmed (see
				// pi-agentic-setup-research/04-mechanical-guards OPEN-QUESTIONS),
				// so this must not depend on it to exist at all.
				try {
					const path = resolve(process.cwd(), EVIDENCE_PATH.replace(/\.jsonl$/, ".evidence.md"));
					appendFileSync(path,
						`\n## BLOCKED (run stopped) @ ${new Date().toISOString()}\n\n` +
						`**guard** ${lastViolation?.id ?? "?"}\n` +
						`**why** ${why}\n` +
						`**refusals** ${total} total, ${consecutive} in a row\n` +
						`**tool_call_index** ${ctx.counters.tool_calls}\n\n` +
						`**reason given to the model**\n\`\`\`\n${reason}\n\`\`\`\n\n` +
						`**next steps for whoever resumes this session:**\n` +
						`- This was stopped automatically because the SAME thing kept getting refused -\n` +
						`  relaunching and letting it retry the identical action will hit the same guard again.\n` +
						`- Read "why" above for the exact file/command involved, then decide: a different\n` +
						`  approach, a boundary update (if the path genuinely belongs in scope), or escalate\n` +
						`  to a human - do not just relaunch blind.\n`);
					log({ ev: "blocker_artifact_written", path });
				} catch (e) {
					log({ ev: "blocker_artifact_write_failed", err: String(e) });
				}
				return { block: true, reason, terminate: true };
			}
			return { block: true, reason };
		}
		return undefined;
	});

	// ---- COMPLETION GATE ---------------------------------------------------
	// The one ACTIONABLE boundary. agent_settled is notification-only, so a
	// post-run check can observe a violation but never prevent one. Measured
	// cost of that: the model claimed completion without running the test suite
	// in 3/5 compliant runs, in two independent batches. Detected every time,
	// prevented never.
	//
	// agent_before_settle "can append entries and request one continuation"
	// (VERIFIED, docs/extensions.md). So instead of recording the violation and
	// letting the run end, we send the model back with the specific instruction
	// and let it finish the job. Once per run — a gate that loops is a bug.
	// ---- LOOP GUARD: result side (2026-10-20, see claude/loop-guard-proposal.md)
	// tool_call above can only see what the model INTENDS; stuck-fix loops,
	// A->B->A oscillation and spinning are only visible in RESULTS. All
	// detection is in ./loop-checks.mjs (pure, shared with the Codex/Claude
	// hook adapter and verify-loop-guard.mjs). VERIFIED against pi 1.3.0
	// types.d.ts: a tool_result handler may return {content, details,
	// structuredContent, isError}; replacing content without structuredContent
	// drops it, so it is passed through. Advisory only: never blocks, never
	// throws (errors are logged and the result is left untouched).
	// LOOP_GUARD=shadow (default) logs findings without changing anything the
	// model sees; LOOP_GUARD=on appends the message and shapes long output.
	const loopCfg = loopConfig(process.env);
	const loopState = newLoopState();
	pi.on("tool_result", (event: any) => {
		try {
			if (loopCfg.mode === "off") return undefined;
			const tool = event.toolName ?? event.tool;
			const root = process.cwd();
			const parts: any[] = Array.isArray(event.content) ? event.content : [];
			const text = parts.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
			const evs: any[] = [];
			if (tool === "bash") {
				const command = String(event.input?.command ?? "");
				evs.push({ kind: "shell", command, output: text, exitCode: parseExitCode(text),
					failed: event.isError === true ? true : undefined, isTest: isTestCommand(command), repoRoot: root });
			} else if (MUTATORS.has(tool) && !event.isError) {
				const p = event.input?.path ?? event.input?.file_path ?? event.input?.filePath;
				let contentHash: string | null | undefined = undefined;
				if (p) { try { contentHash = loopSha(readFileSync(resolve(root, String(p)))); } catch { contentHash = null; } }
				evs.push({ kind: "edit", path: p ? normalize(root, String(p)) : undefined, contentHash });
			}
			let best: any = null;
			for (const ev of evs) {
				const r = observe(loopState, ev, loopCfg);
				if (!r.finding) continue;
				log({ ev: "loop_guard", backend: "pi", mode: loopCfg.mode, signal: r.finding.signal, level: r.level,
					subject: r.finding.subject, detail: r.finding.detail, tool, tool_call_id: event.toolCallId });
				if (!best || ["none", "nudge", "restrict", "handoff"].indexOf(r.level) > ["none", "nudge", "restrict", "handoff"].indexOf(best.level)) best = r;
			}
			let newText = text;
			if (tool === "bash") {
				const shaped = shapeOutput(text, loopCfg, event.details?.fullOutputPath ?? "");
				if (shaped.shaped) {
					log({ ev: "loop_guard_output_shaped", mode: loopCfg.mode, omitted: shaped.omitted, tool_call_id: event.toolCallId });
					if (loopCfg.mode === "on") newText = shaped.text;
				}
			}
			if (best && loopCfg.mode === "on") newText = `${newText}\n\n${best.message}`;
			if (newText === text) return undefined;
			return {
				content: [...parts.filter((c) => c?.type !== "text"), { type: "text", text: newText }],
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
			};
		} catch (e) {
			log({ ev: "loop_guard_error", backend: "pi", err: String((e as any)?.message ?? e) });
			return undefined;
		}
	});

	pi.on("agent_before_settle", (_event, piCtx) => {
		const gate = guards.find((g) => g.check === "evidence_captured" && g.params.enforce_before_settle);
		if (!gate) return undefined;

		let lastText = "";
		try {
			const entries = piCtx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const m = entries[i]?.message;
				if (m?.role === "assistant") {
					for (const b of m.content ?? []) if (b.type === "text") lastText += b.text + "\n";
					break;
				}
			}
		} catch { return undefined; }

		// Only gate a run that CLAIMS completion; a worker still working is left alone.
		if (!claimsCompletion(lastText, gate.params.claim_patterns)) {
			log({ ev: "completion_gate_passed", guard: gate.id, why: "no completion claim" });
			return undefined;
		}

		// Strong condition: the declared tests must have RUN and PASSED - not merely
		// "a test command appeared" (the hole in the old one-shot gate). Gather the
		// transcript's tool results the same way the agent_settled audit does.
		const toolResults = [];
		try {
			for (const e of piCtx.sessionManager.getEntries()) {
				const m = e?.message;
				if (!m) continue;
				if (m.role === "toolResult") {
					const text = (m.content ?? []).map((c) => c.text ?? "").join("\n");
					toolResults.push({ tool: m.toolName ?? m.name ?? null, output: text, isError: !!m.isError });
				} else if (m.role === "toolCall" || m.role === "assistant") {
					for (const p of m.content ?? []) if (p.type === "toolCall" && p.name === "bash") toolResults.push({ command: String(p.arguments?.command ?? ""), output: "", isError: false });
				}
			}
		} catch { return undefined; }

		const tp = testsRanAndPassed(pairCommandsWithResults(toolResults), gate.params);
		if (tp.passed) {
			log({ ev: "completion_gate_passed", guard: gate.id, why: tp.reason });
			return undefined;
		}

		const MAX = gate.params.max_completion_attempts ?? 4;
		completionAttempts += 1;
		if (completionAttempts > MAX) {
			// Bounded: never loop forever on a task the model cannot finish. Stop,
			// and record a hard FAILURE so the run is never mistaken for complete.
			log({ ev: "completion_gate_exhausted", guard: gate.id, attempts: completionAttempts, why: tp.reason });
			return {
				entries: [{ type: "custom_message", customType: "contract_completion_gate", display: true,
					content: `CONTRACT GATE (${gate.id}) - STOPPED after ${MAX} attempts: tests are still not green (${tp.reason}). This run did NOT complete; a human must review it. Do not treat it as done.` }],
				continue: false,
			};
		}
		log({ ev: "completion_gate_fired", guard: gate.id, attempt: completionAttempts, max: MAX, why: tp.reason });
		const cmd = gate.params.tests_command || (testCommands.find((c) => isTestInvocation(c)) ?? "the project's test command");
		return {
			entries: [{ type: "custom_message", customType: "contract_completion_gate", display: true,
				content: `CONTRACT GATE (${gate.id}) attempt ${completionAttempts}/${MAX}: you claimed completion, but the tests are not green (${tp.reason}). Run:  ${cmd}  and make it PASS. Do not claim completion until that command actually runs and passes.` }],
			continue: true,
		};
	});

	// ---- DISCONNECT RECOVERY ------------------------------------------------
	// Owner-reported (2026-10-10): free OpenRouter models sometimes drop the
	// stream mid-turn ("Upstream idle timeout exceeded" and similar) - the
	// process does NOT die, pi.dev does not auto-retry this itself, and the
	// session just sits idle until a human manually types something. turn_end
	// fires after EVERY turn (not just at the end of a whole run, unlike
	// agent_before_settle above) and can inject a message + continue:true the
	// same way the completion gate does - reused here for a different
	// trigger. See shouldRecoverFromDisconnect's own header (checks.mjs) for
	// what's VERIFIED (stopReason's real values, turn_end's real event shape,
	// both confirmed against pi.dev's own source/docs, not training memory)
	// vs the one real tradeoff: this cannot tell "a disconnect" apart from
	// any OTHER cause of stopReason "error" - it recovers from all of them
	// the same way, bounded by MAX_DISCONNECT_RETRIES so a genuinely broken
	// provider still fails loud instead of looping forever.
	pi.on("turn_end", (event, piCtx) => {
		turnSeq += 1;
		lastCtx = piCtx;
		if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
		cancelIdleWatch(null); // a newer turn_end supersedes any pending recovery
		void pollCodexUsage(piCtx);
		const { recover, exhausted, reset, deferred, errorMessage, cause, overloadStreak: nextStreak, overloadCount } = shouldRecoverFromDisconnect(
			event.message, disconnectAttempts, MAX_DISCONNECT_RETRIES, { overloadStreak, overloadThreshold: OVERLOAD_THRESHOLD },
		);
		overloadStreak = nextStreak ?? 0;
		if (reset) { cancelIdleWatch(null); disconnectAttempts = 0; gaveUp = false; return undefined; }
		if (deferred) {
			// Transient overload, below the threshold: leave it to pi's own retry.
			log({ ev: "disconnect_recovery_deferred", cause, streak: overloadStreak, threshold: OVERLOAD_THRESHOLD, errorMessage });
			// Safety net: if NO further turn ends within OVERLOAD_STALL_MS (pi did
			// not retry - retries disabled or already exhausted), the session would
			// sit idle forever; send the same recovery then.
			if (disconnectAttempts >= MAX_DISCONNECT_RETRIES) return undefined;
			disconnectAttempts += 1;
			sendWhenIdle(
				`[CONTRACT] (attempt ${disconnectAttempts}/${MAX_DISCONNECT_RETRIES}) Your previous response failed because the provider was overloaded ("${errorMessage ?? "unknown"}") and the session has been idle since. Verify the actual current state first (re-read the file you were editing, re-check the last command's real output) before deciding what to do next, then continue the actual task - do not restart completed work, and do not just acknowledge this message.`,
				{ attempt: disconnectAttempts, cause, counted: true, via: "idle_after_overload" },
				OVERLOAD_STALL_MS,
			);
			return undefined;
		}
		if (exhausted) {
			// "permanent_error" skips the retry loop entirely (attempts stays 0) -
			// a 402/credits/quota/bad-key error will not change on retry, so
			// treating it like a flaky connection just burns the whole retry
			// budget producing 5 identical queued messages before finally saying
			// what a human needed to know on attempt 1: this needs a config/
			// billing fix, not a retry.
			if (gaveUp) { log({ ev: "disconnect_recovery_suppressed", cause, errorMessage }); return undefined; }
			gaveUp = true;
			const isModelConfig = cause === "model_config_error";
			const isPermanent = cause === "permanent_error" || isModelConfig;
			log({ ev: "disconnect_recovery_exhausted", attempts: disconnectAttempts, cause });
			// 2026-10-11: this used to silently `return undefined` here - "give up,
			// let the real error surface" sounds fine until you check what pi's own
			// handling of stopReason:"error" actually is: nothing visible. A run
			// that exhausts retries reproduces, EXACTLY, the original bug this whole
			// mechanism exists to fix ("the session just sits idle until a human
			// manually types something") - just after 5 silent attempts instead of
			// immediately. A human watching the terminal has no way to tell "still
			// recovering" from "gave up" from "never had a problem" without this.
			try {
				const path = resolve(process.cwd(), EVIDENCE_PATH.replace(/\.jsonl$/, ".evidence.md"));
				appendFileSync(path,
					`\n## DISCONNECT RECOVERY ${isPermanent ? "SKIPPED (permanent error)" : "EXHAUSTED"} @ ${new Date().toISOString()}\n\n` +
					`**attempts** ${disconnectAttempts} (cap ${MAX_DISCONNECT_RETRIES})\n` +
					`**last error** ${errorMessage ?? "(none captured)"}\n\n` +
					`**next steps for whoever resumes this session:**\n` +
					(isPermanent
						? `- This is a billing/quota/credentials error, not a dropped connection - it\n` +
						  `  will not go away on retry, so no retry was attempted.\n` +
						  `- Fix the underlying problem (add credits, raise max_tokens, fix the API key,\n` +
						  `  switch models) before relaunching - relaunching as-is reproduces this\n` +
						  `  immediately.\n`
						: `- The connection/provider failed ${disconnectAttempts} times in a row and this\n` +
						  `  gave up auto-recovering - this is NOT the same as a stuck/looping worker\n` +
						  `  (see the no_progress_loop / refusal-budget BLOCKED entries, if any, above or below).\n` +
						  `- Check the provider/connection before relaunching - if it's still flaky, the\n` +
						  `  SAME exhaustion will happen again immediately on relaunch.\n`));
				log({ ev: "disconnect_recovery_exhausted_artifact_written", path });
			} catch (e) {
				log({ ev: "disconnect_recovery_exhausted_artifact_write_failed", err: String(e) });
			}
			// 2026-10-11: sendUserMessage, not the {entries,...} return - see the
			// recover branch below for the full rationale (same bug, same fix). Here
			// it buys something extra: it gives the model ONE more turn specifically
			// to acknowledge the failure and report it, rather than the model's last
			// attempted response (which ended in error) being the last thing that
			// ever happened in the transcript.
			if (isModelConfig) {
				// The model itself is unusable (none configured / wrong id / no key):
				// asking it to "report this" would just fail again. Show it once,
				// display-only - this return shape does NOT start a model turn.
				return { entries: [{ type: "custom_message", customType: "contract_model_config_error", display: true,
					content: `[CONTRACT] The model can't be used: ${errorMessage ?? "unknown error"}. This is a setup problem, not a dropped connection - nothing will be retried. Fix it, then send your message again: pick a model with /model, or check the model id / API key (e.g. WORKER_MODEL / INTEGRATOR_MODEL / PLANNER_MODEL, models.json, the OpenRouter model name).` }] };
			}
			if (queueBusy(piCtx)) { log({ ev: "disconnect_recovery_skipped_queued", why: queueBusy(piCtx), via: "exhausted" }); return undefined; }
			try {
				recoveryQueued = true;
				pi.sendUserMessage(
					isPermanent
						? `[CONTRACT] Upstream rejected this request with a permanent error (${errorMessage ?? "unknown"}) - this is a billing/quota/credentials/request-size problem, not a dropped connection, so no retry was attempted. Report this to the user now as something that needs a config/billing fix (e.g. add credits, lower max_tokens, switch models, or fix the API key) - do not repeat the same request as-is, it will fail again identically.`
						: `[CONTRACT] Disconnect recovery gave up after ${disconnectAttempts} consecutive upstream errors (last: ${errorMessage ?? "unknown"}). This is NOT something you can fix by retrying - report this to the user as a connection/provider problem now, then stop. Do not attempt the same action again.`,
					{ deliverAs: "followUp" },
				);
			} catch (e) {
				log({ ev: "disconnect_recovery_exhausted_send_failed", err: String(e) });
			}
			return undefined;
		}
		if (recover) {
			disconnectAttempts += 1;
			log({ ev: "disconnect_recovery_fired", attempt: disconnectAttempts, max: MAX_DISCONNECT_RETRIES, errorMessage, cause, ...(cause === "overload" ? { overloadCount } : {}) });
			// Two causes land on the SAME stopReason "error" but need DIFFERENT
			// recovery text - see shouldRecoverFromDisconnect's own header
			// (checks.mjs) for why "unrecoverable_tool_call" is a hypothesis, not
			// independently confirmed the way the plain disconnect case is.
			//
			// 2026-10-11: strengthened both messages after a REAL run recovered
			// (this message WAS shown, confirmed from the transcript) but then did
			// not actually resume substantive work - "continue where you left off"
			// assumes the model's own memory of its last action is complete and
			// correct, which is exactly the assumption that may not hold if the
			// interruption happened mid tool-call. Now explicitly tells the model
			// to VERIFY state with a real tool call before assuming anything, and
			// states plainly that silence/acknowledgment-only is not an acceptable
			// response to this message - unverified whether this alone fixes the
			// behavioral gap (no live session available to confirm the fix), but it
			// costs nothing and directly targets the most likely failure mode.
			// Owner-reported (2026-10-13): with no attempt count visible in this
			// text, several consecutive upstream failures looked like an
			// unbounded pile of identical queued messages - no way to tell from
			// the transcript alone that this is bounded (MAX_DISCONNECT_RETRIES)
			// and already converging toward the exhausted branch above. Every
			// instance of this message now says exactly where it stands.
			const attemptTag = `attempt ${disconnectAttempts}/${MAX_DISCONNECT_RETRIES}`;
			const content = cause === "unrecoverable_tool_call"
				? `[CONTRACT] (${attemptTag}) Your previous turn ended because a tool call could not be safely retried (${errorMessage}) - this happens when your own chat-template markers (role/turn tokens, or tool-call tags like tool_call/function=/parameter=) get written into plain text output, which corrupts the parser. See AGENTS.md's "Start here" section for the full rule. Continue your actual task now, in plain prose - do not repeat the tool call that triggered this, and do not write out any template/tool-call syntax as text, including when describing what just happened. Do not just acknowledge this message - your next action must be a real tool call or a substantive response that moves the task forward.`
				: cause === "overload"
				? `[CONTRACT] (${attemptTag}) The provider has been overloaded ${overloadCount} times in a row ("${errorMessage ?? "unknown"}") and its own retries did not get through. Do NOT assume you know what was or was not completed - the interruption may have happened mid-action. Verify the actual current state first (re-read the file you were editing, re-check the last command's real output, re-read the change's checkpoints/progress fields) before deciding what to do next. Then continue the actual task - do not restart completed work, and do not just acknowledge this message without taking a real next action.`
				: `[CONTRACT] (${attemptTag}) Your previous response was interrupted by an upstream connection error (stopReason: "error"${errorMessage ? `, "${errorMessage}"` : ""}), not by anything you did. Do NOT assume you know what was or was not completed - the interruption may have happened mid-action. Verify the actual current state first (re-read the file you were editing, re-check the last command's real output, re-read the change's checkpoints/progress fields) before deciding what to do next. Then continue the actual task - do not restart completed work, and do not just acknowledge this message without taking a real next action.`;
			// 2026-10-11 REAL INCIDENT: the {entries:[...], continue:true} return
			// shape used to live here. It displayed the message (confirmed from a
			// real transcript) but did NOT actually drive a new model turn - the
			// user had to manually copy the text and press enter themselves.
			//
			// ROOT CAUSE, now precisely identified (not just empirically patched):
			// this is NOT the same situation as the completion gate below, even
			// though both return the same {entries, continue:true} shape. The
			// completion gate fires from agent_before_settle during a NORMAL
			// settle - no error, so continue:true is honoured, which is exactly
			// why that mechanism already works correctly. THIS handler fires from
			// turn_end specifically because stopReason is "error", and pi's own
			// run loop treats an error (same as an abort) as a HARD EXIT -
			// confirmed from pi's own issue tracker: "Error and aborted responses
			// remain hard exits" and "the only continuation hooks (turn_end/
			// agent_before_settle returning continue:true) are skipped after an
			// abort." continue:true is not a bug here that sometimes doesn't fire;
			// it is documented to be skipped on exactly this path, by design.
			// pi.sendUserMessage() sidesteps this entirely because it does not ask
			// the already-hard-exited run to continue - it sends a genuinely NEW
			// message, which pi's own example (examples/extensions/send-user-
			// message.ts) and docs confirm "always triggers a turn" when idle.
			// deliverAs:"followUp" (not "steer") queues it rather than
			// interrupting, since nothing here needs to interrupt anything.
			try {
				if (cause === "unrecoverable_tool_call") {
					// pi does not retry this one - send now.
					if (!sendRecovery(content, piCtx, { attempt: disconnectAttempts, cause })) { disconnectAttempts -= 1; return undefined; }
					log({ ev: "disconnect_recovery_sent", attempt: disconnectAttempts });
				} else {
					// Overload / dropped connection: pi is probably counting down to its own
					// retry right now. Send only if that does not get through.
					log({ ev: "disconnect_recovery_waiting_for_idle", attempt: disconnectAttempts, cause, idleMs: RECOVERY_IDLE_MS });
					sendWhenIdle(content, { attempt: disconnectAttempts, cause, counted: true, via: "after_pi_retries" }, RECOVERY_IDLE_MS);
				}
			} catch (e) {
				log({ ev: "disconnect_recovery_send_failed", err: String(e) });
				// Fall back to the old (unreliable but harmless) display-only path
				// rather than losing the signal entirely if sendUserMessage itself
				// is unavailable in some mode/version.
				return { entries: [{ type: "custom_message", customType: "contract_disconnect_recovery", display: true, content }] };
			}
			return undefined;
		}
		return undefined;
	});

	// ---- POST-RUN CHECKS (audit only) --------------------------------------
	// agent_settled is final and notification-only (VERIFIED), which is exactly
	// right for an audit: it cannot change the outcome, only record it.
	pi.on("agent_settled", (_event, piCtx) => {
		let finalText = "";
		const toolResults = [];
		try {
			const entries = piCtx.sessionManager.getEntries();
			for (const e of entries) {
				const m = e?.message;
				if (!m) continue;
				if (m.role === "toolResult") {
					// Record what each tool actually produced. This is the source
					// of truth for evidence_captured: the model does not have to
					// re-quote anything, we read it from the transcript.
					const text = (m.content ?? []).map((c) => c.text ?? "").join("\n");
					toolResults.push({
						tool: m.toolName ?? m.name ?? null,
						output: text,
						isError: !!m.isError,
					});
				} else if (m.role === "toolCall" || m?.role === "assistant") {
					for (const p of m.content ?? []) {
						if (p.type === "toolCall" && p.name === "bash") {
							toolResults.push({ command: String(p.arguments?.command ?? ""), output: "", isError: false });
						}
					}
				}
			}
			for (let i = entries.length - 1; i >= 0; i--) {
				const m = entries[i]?.message;
				if (m?.role === "assistant") {
					for (const b of m.content ?? []) if (b.type === "text") finalText += b.text + "\n";
					break;
				}
			}
		} catch (e) {
			log({ ev: "post_check_error", err: String(e) });
			return;
		}

		// Pair each bash command with the tool result that followed it, so a
		// check can ask "did the test command they ran actually pass?".
		const paired = pairCommandsWithResults(toolResults);

		// Log EVERY test invocation this session saw, not just the last one -
		// evidence_captured below only ever records the final (necessarily
		// passing, or the run wouldn't claim completion) run. Without this, a
		// cross-session check like verify-change.mjs's red-commit verification
		// has no durable evidence that a test actually FAILED before the fix,
		// only that a test file was committed before an implementation file
		// (commit order, not a real RED). This makes every test run in the
		// transcript - pass or fail - visible to that later, offline check.
		const evGuard = guards.find((g) => g.check === "evidence_captured");
		const testHits = paired.filter((r) => r.command && isTestInvocation(r.command));
		for (const hit of testHits) {
			const out = String(hit.output ?? "");
			const ranPatterns = evGuard?.params?.ran_patterns ?? [];
			const passedPatterns = evGuard?.params?.passed_patterns ?? [];
			const failedPatterns = evGuard?.params?.failed_patterns ?? [];
			const ranOk = ranPatterns.some((p) => new RegExp(p).test(out));
			const passed = ranOk && passedPatterns.some((p) => new RegExp(p).test(out)) && !failedPatterns.some((p) => new RegExp(p).test(out)) && !hit.isError;
			log({ ev: "test_run", command: hit.command, passed, exited_nonzero: !!hit.isError, ran_recognised: ranOk });
		}

		let capturedEvidence = null;
		for (const r of evaluatePost(guards, { finalText, toolResults: paired })) {
			log({
				ev: r.violated ? "violation" : "post_check_passed",
				guard: r.guard, check: r.check, hook: "agent_settled", detail: r.detail,
				on_violation: r.on_violation, final_text_len: finalText.length,
			});
			if (r.captured) capturedEvidence = { guard: r.guard, ...r.captured };
		}

		// Durable record. The evidence lives HERE, in a file, rather than in the
		// model's prose — which is the whole point of the change.
		if (capturedEvidence) {
			try {
				// EVIDENCE_PATH may be ABSOLUTE (the harness passes one). path.join() does
			// not replace on an absolute second argument, it concatenates — which buried
			// the capture under the sandbox instead of the results dir. resolve() is
			// the correct tool and handles both absolute and relative.
			const path = resolve(process.cwd(), EVIDENCE_PATH.replace(/\.jsonl$/, ".evidence.md"));
				appendFileSync(path,
					`\n## run @ ${new Date().toISOString()}\n\n` +
					`**command**\n\`\`\`\n${capturedEvidence.command}\n\`\`\`\n\n` +
					`**passed** ${capturedEvidence.passed} · **failed** ${capturedEvidence.failed} · **exit nonzero** ${capturedEvidence.exited_nonzero}\n\n` +
					`**output**\n\`\`\`\n${capturedEvidence.output}\n\`\`\`\n`);
				log({ ev: "evidence_captured", command: capturedEvidence.command, passed: capturedEvidence.passed, bytes: capturedEvidence.output.length, path });
			} catch (e) {
				log({ ev: "evidence_write_failed", err: String(e) });
			}
		}

		if (ctx.counters.stopped) log({ ev: "hard_stop_engaged", blocks: ctx.counters.total_blocks, streak: ctx.counters.consecutive_blocks, tool_calls: ctx.counters.tool_calls });
		log({
			ev: "run_summary",
			tool_calls: ctx.counters.tool_calls,
			steps: ctx.counters.steps,
			guards_evaluated: guards.length,
			hard_stop_engaged: ctx.counters.stopped,
			consecutive_blocks_at_end: ctx.counters.consecutive_blocks,
			total_blocks_at_end: ctx.counters.total_blocks,
			evidence_captured: !!capturedEvidence,
			last_violation: lastViolation,
		});
	});
}

/**
 * Merge the bash commands the model issued with the tool results that came back.
 * The transcript interleaves them, so we walk it in order and attach each
 * non-empty result to the most recent command awaiting one.
 */
function pairCommandsWithResults(rows) {
	const paired = [];
	let pending = null;
	for (const r of rows) {
		if (r.command !== undefined) { pending = r; paired.push(r); }
		else if (pending) { pending.output = r.output; pending.isError = r.isError; pending = null; }
	}
	return paired.filter((r) => r.command !== undefined && r.output !== "");
}
