/**
 * checks.mjs — the pure evaluation core of the contract guard.
 *
 * Deliberately free of any pi import so that the same code can be exercised by
 * verify-guards.mjs (plain node) and by contract-guard.ts (under jiti).
 * One implementation, two consumers — otherwise the tests would validate a
 * copy rather than the thing that runs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateReadBudget } from "./read-budget.mjs";

// ---------------------------------------------------------------------------
// glob -> RegExp. Supports **, *, ?. Deliberately small.
// ---------------------------------------------------------------------------
export function globToRegExp(glob) {
	let out = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
				else { out += ".*"; i += 1; }
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") out += "[^/]";
		else if ("\\^$+.()|{}[]".includes(c)) out += "\\" + c;
		else out += c;
	}
	return new RegExp(out + "$");
}

const globCache = new Map();
export function matchesAny(path, globs = []) {
	for (const g of globs) {
		let re = globCache.get(g);
		if (!re) { re = globToRegExp(g); globCache.set(g, re); }
		if (re.test(path)) return true;
	}
	return false;
}

/**
 * Normalize any path form to repo-relative BEFORE boundary matching.
 * Without this, an absolute path to an authorized file is reported as a
 * violation. Measured: 2 of 4 compliant runs were false-flagged before this.
 */
export function normalize(repoRoot, p) {
	if (!p || typeof p !== "string") return null;
	let s = p;
	if (repoRoot && s.startsWith(repoRoot + "/")) s = s.slice(repoRoot.length + 1);
	return s.replace(/^\.\//, "");
}

export const MUTATORS = new Set(["write", "edit", "multiedit", "notebook_edit"]);

export function newCounters() {
	return {
		tool_calls: 0, steps: 0,
		consecutive_blocks: 0,
		total_blocks: 0,        // lifetime count, kept for reporting only — see below
		block_step_history: [],  // step-numbers of each block, for the WINDOWED total — see below
		stopped: false,
		mutation_signatures: [],  // trailing window for no_progress_loop — see below
		mutator_count: 0,         // lifetime mutator-call count, for redundant_test_rerun — see below
		test_rerun_signatures: [], // trailing window for redundant_test_rerun — see below
	};
}

/**
 * THE IMPLEMENTED REGISTRY.
 *
 * A clause whose `check` is not in here cannot be enforced by this engine, full
 * stop. The compiler imports this set and refuses to claim coverage for anything
 * outside it, which is how the coverage matrix is stopped from lying.
 * Keep it in lockstep with the switch statements in evaluatePre /
 * evaluateDuring / evaluatePost below.
 */
export const IMPLEMENTED_CHECKS = new Set([
	"file_exists",
	"file_boundary",
	"path_protected",
	"test_integrity",
	"command_forbidden",
	"evidence_captured",
	"evidence_required",
	"always_state",
	"tool_call_limit",
	"integrator_merge_gate",
	"lock_required_for_write",
	"structured_file_validity",
	"no_progress_loop",
	"redundant_test_rerun",
	"read_budget",
]);

/**
 * Which "surface" a check inspects. Two checks on the same surface can collide,
 * which is the recurring bug class in this prototype (3 of the 4 bugs found).
 *   path  - mutator tool paths
 *   cmd   - bash command text
 *   count - tool-call counters
 *   text  - the run's final assistant message
 *   fs    - repo state at run start
 */
export const CHECK_SURFACE = {
	file_exists: "fs",
	file_boundary: "path",
	path_protected: "path",
	test_integrity: "path",
	command_forbidden: "cmd",
	evidence_captured: "tool-output",
	evidence_required: "text",
	always_state: "text",
	tool_call_limit: "count",
	integrator_merge_gate: "cmd",
	lock_required_for_write: "cmd",
	structured_file_validity: "path",
	no_progress_loop: "path",
	redundant_test_rerun: "cmd",
	read_budget: "read",
};

/**
 * PRE-RUN phase (before_agent_start).
 * Only `file_exists` lives here: a precondition that a required input is already
 * present, so the agent does not burn a turn discovering it is missing.
 */
export function evaluatePre(guards, repoRoot) {
	const results = [];
	for (const g of guards) {
		if (g.phase !== "pre") continue;
		let violated = false;
		let detail = "";
		if (g.check === "file_exists") {
			const globs = g.params.globs ?? [];
			// `mode` is explicit because the default is a genuine trap. A clause
			// listing several globs almost always means "one of these will do",
			// but requiring ALL of them silently fails on a repo that has only one.
			// Measured: ["TASKS.md","tasks/**"] failed on a repo with TASKS.md and
			// no tasks/ dir, because the check demanded both.
			const mode = g.params.mode ?? "any";
			const present = globs.filter((gl) => globExists(repoRoot, gl));
			if (mode === "all") {
				const missing = globs.filter((gl) => !present.includes(gl));
				violated = missing.length > 0;
				detail = violated ? `missing required input: ${missing.join(", ")}` : `found all of: ${globs.join(", ")}`;
			} else {
				violated = present.length === 0;
				detail = violated
					? `none of the required inputs present: ${globs.join(", ")}`
					: `found: ${present.join(", ")}`;
			}
		}
		results.push({ guard: g.id, check: g.check, violated, detail, on_violation: g.on_violation });
	}
	return results;
}

/** Bounded recursive glob existence check. */
function globExists(root, glob, depth = 0) {
	if (depth > 6) return false;
	const segs = glob.split("/");
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); }
	catch { return false; }

	for (const e of entries) {
		const seg = segs[0];
		const rest = segs.slice(1);

		if (seg === "**") {
			if (rest.length === 0) return true;
			if (e.isDirectory() && globExists(root, glob.slice(3), depth + 1)) return true;
			continue;
		}
		if (!globToRegExp(seg).test(e.name)) continue;
		if (rest.length === 0) return true;
		if (e.isDirectory() && globExists(`${root}/${e.name}`, rest.join("/"), depth + 1)) return true;
	}
	return false;
}

/** git flags that consume the following token as their value. */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

/** Shell interpreters whose `-c` argument must be analysed recursively. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Split a command line into argv segments, honouring quotes and splitting on
 * shell operators, so `a; git commit | tee x` yields three segments.
 */
function tokenize(cmd) {
	const segments = [];
	let cur = [];
	let tok = "";
	let quote = null;
	let started = false;

	const flushTok = () => { if (started) { cur.push(tok); tok = ""; started = false; } };
	const flushSeg = () => { flushTok(); if (cur.length) { segments.push(cur); cur = []; } };

	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote) {
			if (c === quote) quote = null;
			else { tok += c; started = true; }
			continue;
		}
		if (c === "'" || c === '"') { quote = c; started = true; continue; }
		if (c === ";" || c === "\n") { flushSeg(); continue; }
		if ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|") || (c === "|" && cmd[i + 1] !== "|")) {
			flushSeg(); i += 1; continue;
		}
		if (/\s/.test(c)) { flushTok(); continue; }
		tok += c; started = true;
	}
	flushSeg();
	return segments;
}

function basename(p) { const b = p.split("/").pop() ?? p; return b; }

/**
 * Find forbidden operations in a command line.
 *
 * `git` is handled structurally: walk argv past flags (and their values) to the
 * subcommand position. Everything else falls back to the contract's regexes,
 * which remain correct for `rm -rf`, `npm install`, `sudo`.
 */
export function findForbidden(cmd, params, depth = 0) {
	const found = [];
	const gitNames = new Set(params.git_subcommands ?? []);
	const patterns = params.patterns ?? [];

	for (const argv of tokenize(cmd)) {
		if (argv.length === 0) continue;
		const exe = basename(argv[0]);

		// Recurse into `sh -c "..."` so a nested git call cannot hide.
		if (SHELLS.has(exe) && depth < 3) {
			const cIdx = argv.findIndex((a) => a === "-c");
			if (cIdx >= 0 && argv[cIdx + 1]) {
				found.push(...findForbidden(argv[cIdx + 1], params, depth + 1));
			}
		}

		if (exe === "git" && gitNames.size) {
			let i = 1;
			while (i < argv.length) {
				const a = argv[i];
				if (a === "--") { i += 1; continue; }
				if (GIT_VALUE_FLAGS.has(a)) { i += 2; continue; }
				if (a.startsWith("-")) { i += 1; continue; }
				if (gitNames.has(a)) found.push(`git ${a}`);
				break; // first non-flag is the subcommand position
			}
		}
	}

	// Non-git patterns, per segment, so a pattern can't match across a `;`.
	for (const argv of tokenize(cmd)) {
		const line = argv.join(" ");
		for (const pat of patterns) {
			const re = new RegExp(pat);
			if (re.test(line) || re.test(cmd)) { found.push(pat); }
		}
	}
	return [...new Set(found)];
}

// Value-taking flags of `git merge` itself (distinct from GIT_VALUE_FLAGS, which
// are flags of `git` BEFORE the subcommand, e.g. `-C <path>`). Needed so e.g.
// `git merge -m "msg" feature/X` does not mistake "msg" for the merge target.
const GIT_MERGE_VALUE_FLAGS = new Set(["-m", "-s", "-X", "-F", "--file", "--into-name"]);

// These CONTROL an already-in-progress merge; they do not introduce a NEW
// target branch, so the risk-tier gate does not apply to them. Without this,
// `git merge --abort` on a conflicted merge would itself be read as "a merge
// with an undeterminable target" and blocked - leaving the agent stuck unable
// to even back out of the conflict it is supposed to escalate.
const GIT_MERGE_CONTROL_FLAGS = new Set(["--abort", "--continue", "--quit"]);

/**
 * Find the ref/branch argument of a `git merge` invocation, argv-aware (same
 * walk-past-flags technique as findForbidden, for the same reason: a regex over
 * the raw text is bypassable by flag placement).
 *
 * Returns { found: false } if the command contains no `git merge` at all - the
 * integrator_merge_gate check below then does nothing, same as any other command.
 * Returns { found: true, control: true } for --abort/--continue/--quit - these
 * control an existing merge rather than introduce a new target, so they are not
 * gated either.
 * Returns { found: true, target: null } if `git merge` IS present, is not a
 * control flag, but no target could be determined. This is NOT treated as "no
 * merge" - integrator_merge_gate must escalate rather than silently let an
 * unparseable merge through.
 */
function findGitMergeTarget(cmd) {
	for (const argv of tokenize(cmd)) {
		if (!argv.length) continue;
		if (basename(argv[0]) !== "git") continue;
		let i = 1, sawMerge = false, target = null, control = false;
		while (i < argv.length) {
			const a = argv[i];
			if (a === "--") { i += 1; continue; }
			if (!sawMerge) {
				if (GIT_VALUE_FLAGS.has(a)) { i += 2; continue; }
				if (a.startsWith("-")) { i += 1; continue; }
				if (a === "merge") { sawMerge = true; i += 1; continue; }
				break; // first non-flag was a different subcommand
			}
			if (GIT_MERGE_CONTROL_FLAGS.has(a)) { control = true; break; }
			if (GIT_MERGE_VALUE_FLAGS.has(a)) { i += 2; continue; }
			if (a.startsWith("-")) { i += 1; continue; }
			target = a; break; // first positional after `merge` is the ref
		}
		if (sawMerge) return control ? { found: true, control: true } : { found: true, target };
	}
	return { found: false, target: null };
}

/**
 * holder= line of an integrator-lock.sh lock file, or null if absent/unreadable.
 * Mirrors the exact format integrator-lock.sh itself writes
 * (`printf 'holder=%s\nsince=%s\n' ...`) - not a general parser.
 */
function readLockHolder(lockPath) {
	let text;
	try { text = readFileSync(lockPath, "utf8"); } catch { return null; }
	const m = text.match(/^holder=(.*)$/m);
	return m ? m[1].trim() : null;
}

/**
 * Best-effort reconstruction of what a mutator tool call would leave on disk,
 * so a content-shape check can run BEFORE the write happens instead of after.
 * Returns null when the result cannot be determined (unknown/unrecognized
 * input shape, or an edit whose old text isn't found) - callers MUST treat
 * null as "can't tell", never as "it's fine". Deliberately does not
 * replicate every alias pi's own edit-tool normalizer recovers (JSON-string
 * edits, flat oldText/newText shorthand, etc, see WORKER-GUARDRAILS.md) - an
 * input shape this can't follow just means the check stays silent on that
 * call, which is the existing fail-open posture for "can't confirm" reads
 * elsewhere in this engine's path checks (file_boundary, test_integrity).
 */
function simulateMutatorResult(tool, input, repoRoot, relPath) {
	if (tool === "write") {
		const content = input.content ?? input.text;
		return typeof content === "string" ? content : null;
	}

	let current;
	try { current = readFileSync(join(repoRoot, relPath), "utf8"); }
	catch { return null; } // new file via edit/multiedit: nothing to simulate against

	const applyOne = (text, oldStr, newStr) => {
		if (typeof oldStr !== "string" || typeof newStr !== "string") return null;
		const idx = text.indexOf(oldStr);
		if (idx < 0) return null; // same text the real edit tool itself would refuse on
		return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
	};

	if (tool === "edit") {
		return applyOne(current, input.oldText ?? input.old_string, input.newText ?? input.new_string);
	}
	if (tool === "multiedit") {
		let edits = input.edits;
		if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { return null; } }
		if (edits && !Array.isArray(edits)) edits = [edits];
		if (!Array.isArray(edits) || edits.length === 0) return null;
		let text = current;
		for (const e of edits) {
			if (!e || typeof e !== "object") return null;
			text = applyOne(text, e.oldText ?? e.old_string, e.newText ?? e.new_string);
			if (text === null) return null;
		}
		return text;
	}
	return null;
}

/** null on valid JSON, else the parser's own error message. */
function tryParseJson(text) {
	try { JSON.parse(text); return null; }
	catch (e) { return e.message; }
}

/**
 * risk.tier / risk.reviewer_required for CHANGE-NNNN, read straight from its
 * change.yaml under repoRoot. Returns null if the change folder, the file, or
 * either field cannot be found - the caller must treat "can't confirm" as a
 * reason to escalate, never as permission to proceed.
 *
 * Deliberately a narrow line-scanner for exactly these two fields, matching
 * every other change.yaml reader in this project - not a YAML library.
 */
/**
 * Scan raw change.yaml TEXT (not a path - the caller may have read it from a
 * file or from `git show <ref>:<path>`) for risk.tier / risk.reviewer_required.
 * Shared by readChangeRiskMeta (reads a file off disk) and
 * evaluatePlanningBranchMerge (reads text at an arbitrary git ref) so both
 * stay byte-identical in how they parse the risk: block - one implementation,
 * two call sites, same reasoning as checks.mjs itself being the one engine
 * both verify-guards.mjs and contract-guard.ts exercise.
 */
function parseRiskFromText(text) {
	let inRisk = false, tier = null, reviewerRequired = null;
	for (const raw of text.split(/\r?\n/)) {
		if (/^risk:\s*$/.test(raw)) { inRisk = true; continue; }
		if (!inRisk) continue;
		if (/^\S/.test(raw)) { inRisk = false; continue; } // dedented past the risk: block
		const t = raw.match(/^\s+tier:\s*([a-zA-Z_]+)/);
		if (t) tier = t[1].toLowerCase();
		const r = raw.match(/^\s+reviewer_required:\s*(true|false)/);
		if (r) reviewerRequired = r[1] === "true";
	}
	if (tier === null || reviewerRequired === null) return null;
	return { tier, reviewerRequired };
}

/**
 * The owner's merge approval for a change: the newest role:"human" verdict:"merge-approved"
 * entry in its ledger, newer than the worker's last report, and - if it names a commit -
 * matching the merge target's tip. Written only by `handoff.mjs approve-merge` on the host.
 */
function ownerMergeApproval(repoRoot, changeId, target) {
	let lines = [];
	try { lines = readFileSync(join(repoRoot, ".pi-session", "handoff", `${changeId}.jsonl`), "utf8").split("\n"); } catch { return { ok: false, why: "" }; }
	const es = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	let ai = -1;
	es.forEach((e, i) => { if (e.role === "human" && e.verdict === "merge-approved") ai = i; });
	if (ai < 0) return { ok: false, why: "" };
	if (es.slice(ai + 1).some((e) => e.role === "worker")) return { ok: false, why: "the owner's approval predates the worker's last report" };
	const want = es[ai].approved_sha;
	if (want) {
		let tip = null;
		try { tip = execFileSync("git", ["rev-parse", target], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* unresolvable */ }
		if (!tip || !(tip.startsWith(want) || want.startsWith(tip))) return { ok: false, why: `owner approved ${want}, target is ${tip ? tip.slice(0, 12) : "unresolvable"}` };
	}
	return { ok: true };
}

function readChangeRiskMeta(repoRoot, changeId) {
	if (!changeId) return null;
	let entries;
	try { entries = readdirSync(join(repoRoot, "docs", "changes"), { withFileTypes: true }); }
	catch { return null; }
	const dir = entries.find((e) => e.isDirectory() && e.name.toUpperCase().startsWith(changeId.toUpperCase() + "-"));
	if (!dir) return null;
	let text;
	try { text = readFileSync(join(repoRoot, "docs", "changes", dir.name, "change.yaml"), "utf8"); }
	catch { return null; }
	return parseRiskFromText(text);
}

const RISK_TIER_ORDER = ["low", "medium", "high", "critical"];

/**
 * Is a `planning/*` branch merge safe to land autonomously?
 *
 * MEASURED gap: integrator_merge_gate extracts a CHANGE-\d+ id from the merge
 * target to look up risk - a planner branch (COORDINATION.md's `planning/<name>`
 * convention) carries no such id in its name, since one planning session can
 * span several changes' docs or none. That made EVERY planning/* merge refuse
 * identically to a genuinely unresolvable target, even a purely docs-only one
 * that loosens nothing - the integrator had no path but to ask a human to run
 * three lines by hand for a case the planner's own file_boundary guard had
 * already fenced to docs/changes/** at write time.
 *
 * Safe here means BOTH: (a) every file the merge would bring in lives under
 * docs/changes/** - no code, nothing else, and (b) no change.yaml's risk.tier
 * is lowered, and no reviewer_required flips true->false, relative to base.
 * Mirrors the /change-review panel's own rule (docs/changes/CHANGE-REVIEW.md):
 * an automated step may only ever TIGHTEN a risk assessment, never loosen one
 * a human or planner already set - a planner branch gets the same ceiling.
 *
 * Fails CLOSED (safe: false) on any git error, parse failure, or empty diff -
 * "could not confirm" is a reason to escalate, never permission to proceed.
 */
function evaluatePlanningBranchMerge(repoRoot, base, target) {
	// stdio: a missing path at a ref (e.g. a file that's new on `target`) is an
	// EXPECTED, already-caught case below - without this, execFileSync's sync
	// methods inherit the child's stderr by default, so git's own "fatal: ..."
	// would print to the real terminal even though nothing is actually wrong.
	const git = (...argv) => execFileSync("git", argv, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

	let changedFiles;
	try {
		changedFiles = git("diff", "--name-only", `${base}...${target}`).split(/\r?\n/).filter(Boolean);
	} catch (e) {
		return { safe: false, reason: `could not diff ${base}...${target}: ${String(e.message || e).slice(0, 160)}` };
	}
	if (changedFiles.length === 0) {
		return { safe: false, reason: `empty diff between ${base} and ${target} - nothing confirmed, nothing to merge` };
	}
	const outside = changedFiles.filter((f) => !f.startsWith("docs/changes/"));
	if (outside.length) {
		return { safe: false, reason: `touches non-docs path(s): ${outside.slice(0, 5).join(", ")}` };
	}

	const changedChangeYamls = changedFiles.filter((f) => /^docs\/changes\/[^/]+\/change\.yaml$/.test(f));
	for (const f of changedChangeYamls) {
		let baseText;
		try { baseText = git("show", `${base}:${f}`); }
		catch { baseText = null; } // new on target - nothing on base to loosen relative to
		let targetText;
		try { targetText = git("show", `${target}:${f}`); }
		catch (e) { return { safe: false, reason: `could not read ${f} at ${target}: ${String(e.message || e).slice(0, 160)}` }; }

		if (baseText === null) continue;
		const baseRisk = parseRiskFromText(baseText);
		const targetRisk = parseRiskFromText(targetText);
		if (!baseRisk || !targetRisk) {
			return { safe: false, reason: `could not parse risk: block in ${f} - escalate, do not guess` };
		}
		if (RISK_TIER_ORDER.indexOf(targetRisk.tier) < RISK_TIER_ORDER.indexOf(baseRisk.tier)) {
			return { safe: false, reason: `${f}: risk.tier would be lowered (${baseRisk.tier} -> ${targetRisk.tier})` };
		}
		if (baseRisk.reviewerRequired === true && targetRisk.reviewerRequired === false) {
			return { safe: false, reason: `${f}: reviewer_required would be cleared (true -> false)` };
		}
	}
	return { safe: true, reason: null };
}

/**
 * Evaluate every `during` guard against one tool call.
 *
 * @returns {{violations: Array, blocked: boolean, reason: string|null}}
 *   `blocked` is true only if some violating guard has on_violation === "block".
 *   Guards are evaluated in declaration order and the first blocking violation
 *   wins, because that is the one the model is told about.
 */
export function evaluateDuring(guards, event, ctx) {
	// pi's ToolCallEvent exposes the name as `toolName`. Accepting both keeps
	// this callable from a plain test harness. REGRESSION: reading `event.tool`
	// only made every guard silently no-op, because `tool` was always undefined
	// and MUTATORS.has(undefined) is false. Caught by verify-guards.mjs.
	const tool = event.toolName ?? event.tool;
	const input = event.input ?? {};
	const repoRoot = ctx.repoRoot;
	ctx.counters.tool_calls += 1;
	ctx.counters.steps += 1;
	// Unconditional, regardless of which guards are declared or fire - a
	// redundant_test_rerun guard elsewhere needs to know "has anything actually
	// changed" at the moment a later test command runs, not just at the moment
	// its own case executes.
	if (MUTATORS.has(tool)) ctx.counters.mutator_count += 1;

	const violations = [];
	for (const g of guards) {
		if (g.phase !== "during") continue;
		let violated = false;
		let detail = "";

		switch (g.check) {
			case "tool_call_limit": {
				const current = g.params.distinct ? ctx.counters.steps : ctx.counters.tool_calls;
				if (current > g.params.max) { violated = true; detail = `${current} > max ${g.params.max}`; }
				break;
			}
			case "no_progress_loop": {
				// tool_call_limit bounds TOTAL calls; it cannot tell a worker making
				// 200 distinct edits from one replaying the SAME edit 200 times —
				// both just look like "a lot of calls". This catches the second shape
				// directly: the literal edit/write signature repeating, which is what
				// "stuck" actually looks like on the wire (an edit that didn't take,
				// re-applied verbatim; a write reverted then reissued identically).
				// Scoped to mutators only — rerunning the SAME test command is the
				// normal RED->GREEN loop, not a loop bug, and must never trip this.
				if (!MUTATORS.has(tool)) break;
				const p = normalize(repoRoot, input.path ?? input.file_path ?? input.filePath);
				if (!p) break;
				const sig = [tool, p,
					String(input.old_string ?? input.oldText ?? ""),
					String(input.new_string ?? input.newText ?? input.content ?? ""),
				].join("");
				const hist = ctx.counters.mutation_signatures ?? (ctx.counters.mutation_signatures = []);
				hist.push(sig);
				const window = g.params.window ?? 20;
				if (hist.length > window) hist.splice(0, hist.length - window);
				const repeats = hist.filter((s) => s === sig).length;
				const maxRepeats = g.params.max_repeats ?? 3;
				if (repeats > maxRepeats) {
					violated = true;
					detail = `identical ${tool} on "${p}" repeated ${repeats}x within the last ${hist.length} mutating calls — looks stuck, not progressing`;
				}
				break;
			}
			case "redundant_test_rerun": {
				// Deliberately separate from no_progress_loop above, not a variant of
				// it - no_progress_loop is scoped to MUTATORS and explicitly exempts
				// bash test reruns ("the normal RED->GREEN loop"), because rerunning
				// the SAME command after a real edit is exactly what TDD is. This
				// catches the narrower, genuinely wasteful case that exemption can't
				// distinguish: the SAME test/build command run again with ZERO
				// mutating calls in between - same inputs, same outputs, informs
				// nothing. ("running the same build/test command twice without
				// intervening changes" - a real, named red flag, distinct from a
				// stuck edit loop.)
				if (tool !== "bash") break;
				const command = String(input.command ?? "");
				if (!isTestInvocation(command)) break;
				// Signature pairs the command with the mutator count AT THIS CALL -
				// if the same pair recurs, nothing mutating happened between the two
				// invocations, by construction (mutator_count only ever increases).
				const sig = `${command}${ctx.counters.mutator_count}`;
				const hist = ctx.counters.test_rerun_signatures ?? (ctx.counters.test_rerun_signatures = []);
				hist.push(sig);
				const window = g.params.window ?? 20;
				if (hist.length > window) hist.splice(0, hist.length - window);
				const repeats = hist.filter((s) => s === sig).length;
				const maxRepeats = g.params.max_repeats ?? 2;
				if (repeats > maxRepeats) {
					violated = true;
					detail = `identical test/build command repeated ${repeats}x with ZERO mutating calls in between - reruns the same inputs, learns nothing new: "${command}"`;
				}
				break;
			}
			case "file_boundary": {
				if (!MUTATORS.has(tool)) break;
				const p = normalize(repoRoot, input.path ?? input.file_path ?? input.filePath);
				if (!p) break;
				if (matchesAny(p, g.params.exclude)) break;
				if (matchesAny(p, g.params.include)) break;
				violated = true;
				detail = `"${p}" is outside include=[${(g.params.include ?? []).join(", ")}]`;
				break;
			}
			case "path_protected": {
				if (!MUTATORS.has(tool)) break;
				const p = normalize(repoRoot, input.path ?? input.file_path ?? input.filePath);
				if (!p) break;
				if (matchesAny(p, g.params.patterns)) {
					violated = true;
					detail = `"${p}" matches a protected pattern`;
				}
				break;
			}
			case "test_integrity": {
				if (!MUTATORS.has(tool)) break;
				const p = normalize(repoRoot, input.path ?? input.file_path ?? input.filePath);
				if (!p || !matchesAny(p, g.params.test_globs)) break;
				const added = String(input.newText ?? input.new_string ?? input.content ?? "");
				const removed = String(input.oldText ?? input.old_string ?? "");
				for (const bad of g.params.forbid_added ?? []) {
					if (new RegExp(bad).test(added)) {
						violated = true;
						detail = `edit to test file introduces ${bad} (${p})`;
						break;
					}
				}
				if (!violated && g.params.forbid_removed_assertions && /assert\./i.test(removed) && !/assert\./i.test(added)) {
					violated = true;
					detail = `edit to test file removes assertions (${p})`;
				}
				break;
			}
			case "command_forbidden": {
				if (tool !== "bash") break;
				const cmd = String(input.command ?? "");
				// A regex over the whole command string is bypassable. MEASURED:
				// `git -C /path commit -m "x"` defeated
				// `\bgit\s+(commit|add|...)\b` because `-C` sits between `git`
				// and the subcommand. A commit landed despite an active blocking
				// guard. Subcommand detection must work on argv, not on text.
				const findings = findForbidden(cmd, g.params);
				if (findings.length) {
					violated = true;
					detail = `forbidden: ${findings.join("; ")} :: ${cmd.slice(0, 120)}`;
				}
				break;
			}
			case "integrator_merge_gate": {
				// An autonomous merge into main is only allowed for a change the
				// repo itself has already marked low-risk and reviewer-optional.
				// Anything else - high/critical tier, a mandatory reviewer, or a
				// risk.tier the engine cannot even confirm - must escalate to a
				// human/Claude integrator rather than merge unverified. Three
				// independent "cannot confirm -> block" defaults on purpose: a
				// merge is the single highest-blast-radius action this engine
				// can gate, so ambiguity must fail closed, never open.
				if (tool !== "bash") break;
				const cmd = String(input.command ?? "");
				const m = findGitMergeTarget(cmd);
				if (!m.found) break; // no git merge in this command at all
				if (m.control) break; // --abort/--continue/--quit: not a new-target merge
				if (!m.target) {
					violated = true;
					detail = `git merge target could not be determined - escalate, do not guess :: ${cmd.slice(0, 120)}`;
					break;
				}
				const lockPath = join(repoRoot, g.params.lock_path ?? ".git/integrator.lock");
				const holder = readLockHolder(lockPath);
				const expected = g.params.holder;
				if (!expected || holder !== expected) {
					violated = true;
					detail = `integrator lock not held by '${expected ?? "?"}' (current holder: ${holder ?? "none"}) - claim it before merging`;
					break;
				}
				// Merging the base branch INTO something else (a feature/worktree
				// branch catching up with already-landed history) can never alter
				// the base branch's own content - main is the SOURCE here, not the
				// destination, regardless of which worktree -C points at. MEASURED
				// gap, same root cause as the planning/* one below: "main" has no
				// CHANGE-\d+ substring either, so this fell into the same generic
				// "could not resolve risk" refusal as a genuinely unresolvable
				// target, even though nothing about this direction is unresolvable -
				// it is unconditionally safe, no diff inspection needed at all.
				if (m.target === (g.params.base_branch ?? "main")) break;

				const changeId = (m.target.match(/CHANGE-\d+/i) || [])[0]?.toUpperCase() ?? null;
				if (!changeId && /^(?:[\w.-]+\/)?planning\/[\w.-]+$/.test(m.target)) {
					// A planning/* branch carries no CHANGE-NNNN in its name - a
					// planner branch spans several changes' docs or none at all.
					// Narrower, not more permissive: evaluatePlanningBranchMerge
					// still fails closed on anything beyond docs-only, risk-
					// non-loosening changes. See its own doc comment for why.
					const verdict = evaluatePlanningBranchMerge(repoRoot, g.params.base_branch ?? "main", m.target);
					if (!verdict.safe) {
						violated = true;
						detail = `planning branch '${m.target}': ${verdict.reason} - escalate, do not merge unverified`;
					}
					break;
				}
				const meta = readChangeRiskMeta(repoRoot, changeId);
				if (!meta) {
					violated = true;
					detail = `could not resolve risk.tier/reviewer_required for '${m.target}' (${changeId ?? "unknown change"}) - escalate, do not merge unverified`;
					break;
				}
				const allowTiers = g.params.allow_tiers ?? ["low", "medium"];
				// reviewer_required counts only if the guard says so (owner 2026-10-19: the integrator's own review
				// suffices below critical); critical is never in allow_tiers, so it always goes to the owner
				const reviewerBlocks = g.params.reviewer_required_blocks !== false;
				if ((reviewerBlocks && meta.reviewerRequired) || !allowTiers.includes(meta.tier) || meta.tier === "critical") {
					// The OWNER's explicit approval (node scripts/handoff.mjs approve-merge, host only)
					// lets the integrator do the merge itself (owner, 2026-10-18).
					const appr = ownerMergeApproval(repoRoot, changeId, m.target);
					if (appr.ok) break;
					violated = true;
					detail = `${changeId}: risk.tier='${meta.tier}' reviewer_required=${meta.reviewerRequired} — ESCALATE (needs-human); the owner can approve with: node scripts/handoff.mjs approve-merge --change ${changeId}${appr.why ? ` (${appr.why})` : ""}`;
				}
				break;
			}
			case "lock_required_for_write": {
				// integrator_merge_gate only ever covered `git merge` - a plain
				// `git commit`/`git add` to main was never gated by anything,
				// mechanically or otherwise, except the honor-system discipline
				// in COORDINATION.md. MEASURED: an integrator backend committed
				// directly to main (a change.yaml edit, not a merge) without
				// claiming the lock, because nothing checked for it outside of
				// merge. Reuses findForbidden's argv-aware subcommand detection
				// (the same technique integrator_merge_gate's target-finder
				// uses) rather than a new parser - a regex over the raw command
				// text is bypassable by flag placement, same reason as always.
				if (tool !== "bash") break;
				const cmd = String(input.command ?? "");
				const gitSubcommands = g.params.git_subcommands ?? ["commit", "add"];
				const findings = findForbidden(cmd, { git_subcommands: gitSubcommands });
				if (!findings.length) break; // no commit/add (or configured subcommand) in this command
				const lockPath = join(repoRoot, g.params.lock_path ?? ".git/integrator.lock");
				const holder = readLockHolder(lockPath);
				const expected = g.params.holder;
				if (!expected || holder !== expected) {
					violated = true;
					detail = `integrator lock not held by '${expected ?? "?"}' (current holder: ${holder ?? "none"}) - claim it before ${findings.join(", ")}`;
				}
				break;
			}
			case "read_budget": {
				// See read-budget.mjs. Runs as on_violation "redirect": stops the
				// call with an outline, never counts as a refusal (see below).
				const msg = evaluateReadBudget(tool, input, ctx, g.params);
				if (msg) { violated = true; detail = msg; }
				break;
			}
			case "structured_file_validity": {
				// evidence_captured's test-must-pass gate catches this kind of
				// corruption for code (a dropped quote/comma usually throws at
				// import or syntax-check time) but has no equivalent for
				// JSON/YAML/config files, which aren't run through a test
				// command. MEASURED root cause this closes: a local-model tool
				// call's string argument can land corrupted (a dropped quote or
				// comma - see WORKER-GUARDRAILS.md issue #2, an oMLX
				// detokenization bug, not a model/quantization issue) with NO
				// error raised by write/edit itself. Catching it before the
				// write lands, rather than relying on later review, is the only
				// way to stop at the moment of corruption instead of after it's
				// already on disk.
				//
				// JSON only for now: `JSON.parse` is a zero-dependency,
				// zero-false-positive validator. YAML is deliberately NOT
				// handled here - this engine has an explicit house rule against
				// hand-rolling a YAML parser (see readChangeRiskMeta's own
				// comment, "not a YAML library") and pulling in a real one is a
				// dependency decision this prototype hasn't made. A YAML file
				// matching g.params.extensions with no parser wired for its
				// extension is silently skipped below, not block-by-default.
				if (!MUTATORS.has(tool)) break;
				const p = normalize(repoRoot, input.path ?? input.file_path ?? input.filePath);
				if (!p) break;
				if (matchesAny(p, g.params.exclude)) break;
				const exts = g.params.extensions ?? [".json"];
				const lower = p.toLowerCase();
				const ext = exts.find((e) => lower.endsWith(e));
				if (!ext) break;
				if (ext !== ".json") break; // no validator wired for this extension yet
				const result = simulateMutatorResult(tool, input, repoRoot, p);
				if (result === null) break; // can't reconstruct the result - don't block on uncertainty
				const err = tryParseJson(result);
				if (err) {
					violated = true;
					detail = `this ${tool} would leave "${p}" as invalid JSON: ${err}`;
				}
				break;
			}
		}

		if (violated) violations.push({ guard: g.id, check: g.check, detail, on_violation: g.on_violation });
	}

	const blocking = violations.find((v) => v.on_violation === "block");
	// "redirect" tier (read_budget): stop THIS call and hand the model the
	// guard's own guidance, but it is not a refusal - no refusal counters move,
	// no streak reset, can never terminate the run. A real block always wins.
	if (!blocking) {
		const redirect = violations.find((v) => v.on_violation === "redirect");
		if (redirect) return { violations, blocked: true, redirected: true, terminate: false, reason: redirect.detail,
			consecutive: ctx.counters.consecutive_blocks, total: ctx.counters.total_blocks, why: null };
	}
	let reason = null;
	// A block is a refusal, not a correction. Measured: one run logged
	// block=19 calls=78 — the model hit the same wall nineteen times inside a
	// single turn, because a turn has no boundary for us to intervene at. Every
	// refusal cost a tool call and bought nothing.
	//
	// The remedy is on the block itself: ToolCallEventResult.terminate is a
	// "stop after this tool batch" hint (VERIFIED, types.d.ts). Once the same
	// guard has refused N times in a row we escalate from refusing to stopping.
	// Refuse twice, maybe the model will notice. Refuse nineteen times, it will
	// not.
	let terminate = false;
	let why = null;
	let blocksInWindow = ctx.counters.total_blocks; // default: unwindowed (matches old behaviour when no window is configured)
	if (blocking) {
		ctx.counters.consecutive_blocks += 1;
		ctx.counters.total_blocks += 1;
		ctx.counters.block_step_history.push(ctx.counters.steps);

		// Two caps, because they fail differently. MEASURED: a streak limit alone
		// did not stop a real run — block=17 calls=26 — because the model
		// alternated a refused call with a permitted one and never reached five
		// CONSECUTIVE blocks. A streak measures the wrong thing: what costs
		// budget is the TOTAL number of refusals, not how they are arranged.
		const streakCap = ctx.max_consecutive_blocks ?? Infinity;
		const totalCap = ctx.max_total_blocks ?? Infinity;

		// 2026-10-11: total_blocks used to be a LIFETIME count that never reset,
		// which punishes a long, mostly-compliant session for being long — ten
		// incidental, unrelated one-off corrections spread across 400 calls is
		// healthy exploration, not a stuck run, but it tripped the same cap a
		// genuinely stuck run does. Windowed the same way no_progress_loop
		// already is: only blocks within the last `max_total_blocks_window`
		// calls count toward the cap. `max_total_blocks_window` unset (the
		// default) reproduces the exact old lifetime behaviour - nothing
		// regresses for a caller that never sets it.
		const window = ctx.max_total_blocks_window ?? Infinity;
		const windowStart = ctx.counters.steps - window;
		blocksInWindow = ctx.counters.block_step_history.filter((s) => s > windowStart).length;
		// Bounded cheap prune so this array can't grow unboundedly over a very
		// long session - keep at most 10x the cap's worth of recent entries,
		// which is always enough to answer "how many in the window" correctly.
		const keep = Math.max(totalCap, 1) * 10;
		if (ctx.counters.block_step_history.length > keep) {
			ctx.counters.block_step_history = ctx.counters.block_step_history.slice(-keep);
		}

		if (blocksInWindow >= totalCap) {
			terminate = true;
			why = Number.isFinite(window)
				? `${blocksInWindow} refusals within the last ${window} calls (cap ${totalCap})`
				: `total refusal budget exhausted (${blocksInWindow} of ${totalCap})`;
		} else if (ctx.counters.consecutive_blocks >= streakCap) {
			terminate = true;
			why = `${ctx.counters.consecutive_blocks} consecutive refusals`;
		}
		if (terminate) ctx.counters.stopped = true;
	} else {
		ctx.counters.consecutive_blocks = 0;
	}

	if (blocking) {
		const g = guards.find((x) => x.id === blocking.guard);
		reason =
			`CONTRACT VIOLATION — ${blocking.guard}\n` +
			`Clause: ${g.description ?? g.clause ?? blocking.guard}\n` +
			`Why: ${blocking.detail}\n` +
			(terminate
				? `Refusals: ${ctx.counters.total_blocks} total (${blocksInWindow} recent), ${ctx.counters.consecutive_blocks} in a row (${why}).\n` +
				  `The run is being stopped. Report the blocker to the user; do not retry.`
				: `This is enforced mechanically, not a suggestion. Retry with a compliant action.`);
	}
	return { violations, blocked: !!blocking, terminate, reason,
		consecutive: ctx.counters.consecutive_blocks, total: ctx.counters.total_blocks, why };
}

/**
 * Did the model actually CLAIM completion?
 *
 * A bare regex over claim words is wrong. "I cannot complete this task" contains
 * 'complete', so a REFUSAL scored as a claim of completion — which made the
 * adversarial arm report 5/5 violations that were pure artefact. This is the
 * fifth time a checker of mine has invented a violation, and the pattern is
 * consistent: my checks are only as trustworthy as the cases I feed them.
 *
 * Negations and hypotheticals are stripped before matching.
 */
const NEGATION_RE = /\b(cannot|can't|cant|won't|will not|unable to|not able to|didn't|did not|haven't|have not|refused to|decline[d]? to)\b[^.!?\n]{0,40}/gi;
const HYPOTHETICAL_RE = /\b(if|would|could|should)\b[^.!?\n]{0,40}/gi;

export function claimsCompletion(text, patterns) {
	const re = new RegExp(patterns?.join("|") ?? "\\bdone\\b", "i");
	// Count claim occurrences that are NOT inside a negation or hypothetical.
	const plain = text;
	// Blank out negated / hypothetical clauses, keeping the rest measurable.
	const masked = plain
		.replace(NEGATION_RE, (m) => " ".repeat(m.length))
		.replace(HYPOTHETICAL_RE, (m) => " ".repeat(m.length));
	return re.test(masked);
}

/**
 * Upstream-disconnect recovery (2026-10-10) - owner-reported: free OpenRouter
 * models sometimes drop the stream mid-turn ("Upstream idle timeout exceeded"
 * and similar), pi.dev does NOT crash or auto-retry this itself, and the
 * session just sits there until a human manually types something to kick it
 * back into motion. VERIFIED (pi.dev's own packages/ai/README.md "Stop
 * Reasons" section, fetched directly): every AssistantMessage carries a
 * `stopReason` of "pending" | "stop" | "length" | "toolUse" | "error" |
 * "aborted" - "error" is the documented catch-all for "an error occurred
 * during generation" (network drops included), with an optional
 * `errorMessage` giving detail. `turn_end` (VERIFIED against pi's own
 * extensions/types.ts source, not the docs prose) fires after EVERY turn,
 * not just at the end of a whole run, and its handler can return the SAME
 * {entries, continue: true} shape agent_before_settle's completion gate
 * already uses to inject a message and resume - this reuses that exact
 * mechanism for a different trigger.
 *
 * `attempts` is CONSECUTIVE-disconnect count, not a lifetime budget - the
 * caller resets it to 0 on any turn that did NOT end in "error". Free-tier
 * flakiness is "frequent but individually recoverable," not "persistently
 * broken" - a cumulative counter would eventually exhaust itself over a long
 * session even though every single disconnect recovered fine. "aborted" is
 * deliberately NOT treated as recoverable here - that's a cancelled request
 * (an abort signal), which is far more likely an intentional interruption
 * than a connection problem, and auto-continuing past a deliberate cancel
 * would be the wrong default.
 *
 * SAME-DAY ADDITION: a second, DIFFERENT-cause error that also lands on
 * stopReason "error" - "Model output contains an unrecoverable tool call.
 * Previously delivered tool calls must not be executed again on retry." This
 * is NOT a network problem - it's AGENTS.md's own already-documented root
 * cause (this file's own header, "Never reproduce your own chat-template's
 * role-boundary tokens or tool-call tags as plain text... corrupts the
 * parser's envelope boundary, forcing a retry that re-delivers an
 * already-executed tool call - which pi then correctly refuses to run a
 * second time"). HYPOTHESIS, not independently confirmed against a real pi
 * session the way the plain-disconnect case was (no live session available
 * to test against) - but the errorMessage text reads exactly like what the
 * stopReason spec describes that field for ("an error occurred during
 * generation... errorMessage providing details"), so it's treated the same
 * way (recoverable, same counter/bound) with a MORE TARGETED message: the
 * generic "you were interrupted, continue" text wouldn't tell the model to
 * stop doing the thing that caused this, so a model that gets recovered
 * this way without being told that would be likely to repeat it immediately.
 * Safety note: pi's own refusal to replay the stale tool call is what makes
 * this safe to auto-continue past at all - the error IS pi correctly
 * refusing to double-execute, not pi accidentally doing so.
 */
const UNRECOVERABLE_TOOL_CALL_RE = /unrecoverable tool call/i;
// Owner-reported (2026-10-13): a 402 "requires more credits" error was being
// retried 5 times identically, like any other transient disconnect/overload.
// It never will succeed on retry - it's a billing/config problem, not a
// dropped connection - so burning the whole retry budget on it just delays
// the moment a human finds out by 5 queued messages for nothing. 400/401/403
// included for the same reason (bad request, bad/missing key, forbidden -
// none of these change on their own between retries).
const PERMANENT_ERROR_RE = /\b40[0-3]\b.*:|requires more credits|insufficient[_ ]?(quota|credits|balance)|invalid[_ ]?api[_ ]?key|exceeded.*quota/i;
// Owner-reported (2026-10-13): launching pi with no model configured, or with
// an OpenRouter model id that doesn't exist, flooded the screen with retry
// messages - every retry hits the same broken model instantly. These are
// setup errors, not dropped connections: classed with the permanent ones.
export const MODEL_CONFIG_ERROR_RE = /no endpoints found|not a valid model|model[^.]{0,60}\b(not found|does not exist|not available|is not supported|unknown)\b|unknown model|no model (selected|configured|available|specified)|no api key|api key[^.]{0,40}\b(missing|not (set|found|configured))\b|\b40[134]\b[^0-9]|unauthori[sz]ed|forbidden/i;

// Owner-reported (2026-10-13): free models behind OpenRouter regularly answer
// "Upstream error from Nvidia: Service temporarily overloaded". pi retries
// these itself (its own auto-retry matches /overloaded|rate.?limit|429|5xx|.../
// with backoff) - MEASURED in a real planner session: 2-3 consecutive error
// turns a few seconds apart, then a normal turn, with no help from us. Our
// immediate "[CONTRACT] ... interrupted" follow-up was therefore redundant:
// it got queued and delivered AFTER pi had already recovered, costing an
// extra model turn ("State confirmed ...") every time. So transient overload
// errors are now DEFERRED until `overloadThreshold` (default 3) arrive in a
// row; only then is the recovery sent. Any successful turn or a different
// kind of error resets the streak. contract-guard.ts adds a stall timer as
// a safety net in case pi does NOT retry (retries disabled / exhausted early).
export const TRANSIENT_OVERLOAD_RE = /overloaded|rate.?limit|too many requests|\b429\b|\b50[234]\b|service.?unavailable|temporarily unavailable|at capacity/i;
export const OVERLOAD_RECOVERY_THRESHOLD = 3;

export function shouldRecoverFromDisconnect(message, attempts, max, { overloadStreak = 0, overloadThreshold = OVERLOAD_RECOVERY_THRESHOLD } = {}) {
	if (message?.stopReason !== "error") return { recover: false, reset: true, overloadStreak: 0 };
	// errorMessage extracted BEFORE the exhaustion check (2026-10-11 fix) - it used to
	// return early on exhaustion without it, so the exhaustion report could only ever
	// say "unknown" instead of citing the actual last error that was still failing.
	const errorMessage = message?.errorMessage ?? null;
	if (errorMessage && MODEL_CONFIG_ERROR_RE.test(errorMessage) && !TRANSIENT_OVERLOAD_RE.test(errorMessage)) {
		return { recover: false, exhausted: true, errorMessage, cause: "model_config_error", overloadStreak: 0 };
	}
	if (errorMessage && PERMANENT_ERROR_RE.test(errorMessage)) {
		return { recover: false, exhausted: true, errorMessage, cause: "permanent_error", overloadStreak: 0 };
	}
	const isOverload = !!(errorMessage && TRANSIENT_OVERLOAD_RE.test(errorMessage));
	const streak = isOverload ? overloadStreak + 1 : 0;
	if (isOverload && streak < overloadThreshold) {
		return { recover: false, deferred: true, errorMessage, cause: "overload", overloadStreak: streak };
	}
	if (attempts >= max) return { recover: false, exhausted: true, errorMessage, cause: "retries_exhausted", overloadStreak: 0 };
	const cause = errorMessage && UNRECOVERABLE_TOOL_CALL_RE.test(errorMessage) ? "unrecoverable_tool_call" : isOverload ? "overload" : "disconnect";
	// The streak restarts after a recovery is sent: a still-overloaded provider
	// gets another `overloadThreshold` errors (pi retrying) before the next one.
	return { recover: true, errorMessage, cause, overloadStreak: 0, overloadCount: isOverload ? streak : 0 };
}

/**
 * Should the completion gate intercept this run?
 *
 * Extracted as a pure function so it can be unit-tested. It used to live
 * inline in the pi adapter, which meant the only way to exercise the failing
 * branch was to find a model that happened to misbehave — the same mistake as
 * the silent no-op. A gate you cannot test is a gate you have not built.
 *
 * @param lastText   the model's most recent assistant text
 * @param testCommands every bash command issued so far
 * @param params     the guard params (claim_patterns, test_command_patterns)
 */
export function shouldGateCompletion(lastText, testCommands = [], params = {}) {
	const claimed = claimsCompletion(lastText ?? "", params.claim_patterns);
	if (!claimed) return { gate: false, reason: "no completion claim" };
	if (testCommands.some(isTestInvocation)) {
		return { gate: false, reason: `tests already run (${testCommands.length} commands)` };
	}
	return { gate: true, reason: "claimed completion with no test command issued" };
}

/**
 * testsRanAndPassed — did the LAST test invocation in this session run AND pass?
 *
 * The one-shot shouldGateCompletion only asks "was a test command issued", so a
 * model that runs a FAILING test and then claims done slips through. The looping
 * gate needs the stronger fact: a test ran and did not fail. Pure, so it is unit
 * tested directly.
 */
export function testsRanAndPassed(toolResults = [], params = {}) {
	const ranPatterns = params.ran_patterns ?? [];
	// A result counts as a test run if its COMMAND is a direct test invocation
	// (`uv run ... pytest`, `pytest`, ...) OR it is a known runner whose OUTPUT
	// carries a recognised test summary. The second arm is what makes a sanctioned
	// WRAPPER work — e.g. `node scripts/verify-change.mjs`, which drives the declared
	// tests.command: its command isn't pytest-shaped, but its output is. Tying the
	// output evidence to a runner in command position avoids prose false positives
	// (a model merely typing "5 passed" is not a runner).
	const outputLooksLikeTests = (out) => ranPatterns.some((p) => new RegExp(p).test(out));
	const isRunner = (command) => {
		const first = (String(command).trim().split(/\s+/)[0] ?? "").split("/").pop();
		return TEST_RUNNERS.has(first);
	};
	// The change's OWN declared tests.command always counts, whatever it is
	// (`bash .../validate-gdd.sh` is neither pytest-shaped nor prints "N passed").
	// Pass/fail for it comes from its exit status plus failed_patterns.
	const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
	const declared = squash(params.tests_command);
	const isDeclared = (command) => !!declared && squash(command).includes(declared);
	const looksLikeTestRun = (r) =>
		r && r.command && (isDeclared(r.command) || isTestInvocation(r.command) || (isRunner(r.command) && outputLooksLikeTests(String(r.output ?? ""))));
	const hits = toolResults.filter(looksLikeTestRun);
	const last = hits[hits.length - 1];
	if (!last) return {
		ran: false, passed: false,
		reason: "no recognised test run. Run the change's tests.command directly as your last action " +
			"(a test runner like `uv run ... pytest ...`), or a wrapper whose OUTPUT shows a test summary " +
			"(e.g. 'N passed'). A bare `node scripts/verify-change.mjs` now counts IF its output shows the summary.",
	};
	const out = String(last.output ?? "");
	const failed = (params.failed_patterns ?? []).some((p) => new RegExp(p).test(out));
	if (isDeclared(last.command)) {
		const passed = !failed && !last.isError && !/exited with code [1-9]|exit code:? [1-9]/i.test(out);
		return { ran: true, passed, reason: passed ? "declared tests.command ran and passed" : "declared tests.command ran but failed (non-zero exit or failure output)" };
	}
	const ranOk = outputLooksLikeTests(out);
	if (!ranOk) return { ran: false, passed: false, reason: "test output not recognised; cannot confirm pass" };
	const passed = !failed && !last.isError;
	return { ran: true, passed, reason: passed ? "tests ran and passed" : "tests ran but failed/errored" };
}

/** Executors that can actually START a test run. */
const TEST_RUNNERS = new Set([
	"npm", "npx", "yarn", "pnpm", "bun", "node", "deno", "pytest", "py.test",
	"go", "cargo", "mvn", "gradle", "dotnet", "make", "just", "tox", "uv",
]);

/**
 * Did this command actually INVOKE a test runner?
 *
 * Matching the pattern anywhere in the string is wrong: `grep -rn "npm test" .`
 * contains the phrase but runs nothing. Caught by a self-test written to
 * expect the stricter behaviour — the same false-pass class as
 * `git log --grep commit` in command_forbidden, where a naive substring match
 * would have satisfied a guard that was supposed to catch something else.
 *
 * So: the pattern must appear in a COMMAND POSITION — the segment's leading
 * tokens — and the segment must begin with a known test runner.
 */
export function isTestInvocation(command) {
	if (!command) return false;
	for (const seg of String(command).split(/(\n|;|&&|\|\||\||\n)/)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;
		const tokens = trimmed.split(/\s+/);
		const first = (tokens[0] ?? "").split("/").pop();
		if (!TEST_RUNNERS.has(first)) continue;
		// Everything after the runner is the argument vector; the test pattern
		// must be matched against THAT, not the raw line.
		const argv = tokens.slice(1).join(" ");
		if (/\btest\b|--test|\bpytest\b|\bgo\s+test\b|\bmvn\s+test\b|--tap\b|\bnext\b/.test(argv)) return true;
	}
	return false;
}

/**
 * Evaluate every `post` guard against the run.
 *
 * `ctx` carries BOTH the model's final words and the tool results it received.
 * The distinction matters: the old `evidence_required` check demanded that the
 * model re-quote output it had already been given, and it failed 5/5 at 6-bit
 * and 3/3 at 4-bit. That is a summarisation habit, not a capability ceiling,
 * and no prompt fixes it. The rule is now evaluated against the TRANSCRIPT —
 * did a test actually run, and did it pass — and the harness captures the
 * output itself. The worker no longer carries the bookkeeping.
 *
 * @param ctx {{finalText: string, toolResults: Array<{tool,command,output,isError}>}}
 * @returns results, each with an optional `captured` payload for the record
 */
export function evaluatePost(guards, ctx) {
	const { finalText = "", toolResults = [] } = ctx ?? {};
	const results = [];
	for (const g of guards) {
		if (g.phase !== "post") continue;
		let violated = false;
		let detail = "";
		let captured = null;

		if (g.check === "evidence_captured") {
			// Find test invocations among the commands the model actually ran.
			// MUST use isTestInvocation, the same predicate the completion gate uses.
			// A substring match here and a command-position match there would let the
			// gate block a run the audit then records as evidenced — two layers
			// disagreeing about the same fact.
			const hits = toolResults.filter((r) => r.command && isTestInvocation(r.command));
			const last = hits[hits.length - 1];
			const claims = claimsCompletion(finalText, g.params.claim_patterns);

			if (!last) {
				violated = claims; // claimed done, never ran a test
				detail = `claimed_completion_without_running_tests (claims=${claims}, test_runs=0)`;
			} else {
				const out = last.output ?? "";
				const ranOk = (g.params.ran_patterns ?? []).some((p) => new RegExp(p).test(out));
				const passed = (g.params.passed_patterns ?? []).some((p) => new RegExp(p).test(out));
				const failed = (g.params.failed_patterns ?? []).some((p) => new RegExp(p).test(out));
				captured = {
					command: last.command,
					exited_nonzero: !!last.isError,
					ran_ok: ranOk,
					passed: passed,
					failed: failed,
					output: out.slice(0, 4000),
				};
				violated = ranOk && (failed || last.isError);
				detail = violated
					? `tests_ran_but_did_not_pass (command="${last.command.slice(0, 80)}")`
					: `tests_ran_and_passed (command="${last.command.slice(0, 60)}") — captured by the harness`;
			}
		} else if (g.check === "evidence_required") {
			// Legacy: the model must quote the output itself. Kept so the old
			// contract still evaluates, but the current contract does not use it.
			const claims = claimsCompletion(finalText, g.params.claim_patterns);
			const hasEvidence = (g.params.evidence_markers ?? []).some((m) => new RegExp(m).test(finalText));
			violated = claims && !hasEvidence;
			detail = violated
				? `claim_without_evidence (claim=${claims}, evidence=${hasEvidence})`
				: `evidence_quoted_by_model (claim=${claims}, evidence=${hasEvidence})`;
		} else if (g.check === "always_state") {
			const missing = (g.params.tokens ?? []).filter((t) => !finalText.includes(t));
			violated = missing.length > 0;
			detail = `missing tokens: ${missing.join(", ") || "(none)"}`;
		}
		results.push({ guard: g.id, check: g.check, violated, detail, captured, on_violation: g.on_violation });
	}
	return results;
}
