#!/usr/bin/env node
//
// compile-integrator-guards - tool_call guards for the INTEGRATOR role.
//
// WHY THIS EXISTS
// The integrator is trusted with repo-wide writes (not path-fenced the way a
// worker is) and does the one thing a worker/planner never does: merge a
// feature branch into main. That is the highest-blast-radius action this
// whole system can take, so it is the one thing this guard restricts - not
// by instruction, mechanically, at the moment of the `git merge` call:
//
//   - integrator_merge_gate (checks.mjs): a merge only proceeds if (a) the
//     integrator lock is held by THIS agent and (b) the target CHANGE's own
//     risk.tier is low/medium AND reviewer_required is false. Anything
//     high/critical, reviewer-required, or whose risk could not even be
//     confirmed is refused - the agent is told to escalate to the human/
//     Claude integrator, never to merge unverified.
//   - command_forbidden blocks the genuinely destructive/bypass git ops
//     (force-ish operations, worktree/gc/prune admin, history rewrite,
//     hook-skipping flags) - the same operations a human integrator is
//     told never to run without asking first (see CLAUDE.md's own "Git
//     Safety Protocol"), now enforced instead of merely stated.
//
// Deliberately NO file_boundary: the integrator's job requires touching any
// path in the repo (merging code, flipping change.yaml status, docs). The
// fence here is WHAT git operations it may run and WHICH merges it may land
// on its own, not WHERE it may write.
//
//   node scripts/compile-integrator-guards.mjs --holder <name> [--out guards.json]
//   node scripts/compile-integrator-guards.mjs --selftest
//
import { writeFileSync } from "node:fs";

const NL = String.fromCharCode(10);

// Keep in lockstep with the engine's IMPLEMENTED_CHECKS (checks.mjs).
const IMPLEMENTED = new Set([
  "file_boundary", "path_protected", "command_forbidden",
  "evidence_captured", "test_integrity", "file_exists", "tool_call_limit",
  "integrator_merge_gate", "lock_required_for_write",
]);

// Needs `merge`, `checkout`, `branch` (to delete a merged feature branch),
// `commit`/`add`. Blocks: history rewrite and anything that bypasses review
// (reset, rebase, cherry-pick), force-ish network ops (push - no remote is
// part of this workflow today), and the repo-GLOBAL admin ops that have
// actually caused damage THIS project: `git worktree prune` destroyed a live
// agent's worktree registration in-session because it judged a worktree
// "stale" from the wrong container's view of absolute paths (see
// docs/changes/COORDINATION.md). An autonomous agent gets the same rule a
// human was given afterward: escalate instead of running gc/prune.
//
// `worktree` itself is DELIBERATELY NOT in this list (2026-10-09) - see the
// pattern-based carve-out below instead. git_subcommands can only block the
// WHOLE subcommand, not distinguish `worktree remove` from `worktree prune`,
// so a blanket block was the only option until now. `worktree remove`/
// `worktree unlock` for one explicitly-named worktree is a different risk
// shape than `prune`: prune is a BULK, heuristic operation that judges every
// worktree at once from whatever environment runs it (that's exactly what
// caused the incident above); remove/unlock name one specific path and
// cannot collaterally affect any other worktree, and git itself already
// refuses to remove one with uncommitted changes unless --force is passed.
const INTEGRATOR_BLOCKED_GIT = [
  "push", "reset", "rebase", "cherry-pick", "stash", "clean",
  "gc", "prune", "filter-branch", "filter-repo",
];

// Mirrors CLAUDE.md's own "Git Safety Protocol" (never force-push, never skip
// hooks) as a MECHANICAL check instead of an instruction a model can forget
// under pressure. `branch -D` (capital D, force-delete an unmerged branch) is
// caught by pattern since command_forbidden's git_subcommands list can only
// block a whole subcommand, not one flag of it - `branch -d` (safe, refuses
// on an unmerged branch) must stay allowed to clean up after a real merge.
//
// worktree carve-out (2026-10-09): `worktree add`/`prune`/`move`/`repair`
// stay blocked by pattern now that `worktree` itself is allowed through
// git_subcommands above - `add` is not the integrator's job (workers/
// planners create their own via their own launch scripts), `prune` is the
// exact bulk operation that caused the real incident, `move` is unneeded
// for retiring a worktree, `repair` does not do what it looks like it does
// (confirmed hands-on: it updates a STALE admin path, it cannot recreate
// one `prune` already deleted outright - a false sense of safety is worse
// than no safety). `worktree remove` is allowed UNLESS it also carries
// --force/-f anywhere in the command (lookaheads, not a fixed arg order,
// since a flag can be written before or after the path) - forcing past
// git's own uncommitted-changes refusal is exactly the case this guard
// exists to stop. `worktree unlock` and `worktree list` are left
// unblocked entirely: unlock only removes a protection (the lock itself
// was added in launch-worker.sh/launch-planner.sh specifically to survive
// a stray prune, not to resist a deliberate, scoped unlock), and list is
// read-only.
const INTEGRATOR_BLOCKED_CMD = [
  "push\\s+.*--force", "push\\s+.*-f\\b", "push\\s+.*--delete",
  "reset\\s+--hard", "--no-verify", "--no-gpg-sign", "-c\\s+commit\\.gpgsign=false",
  "branch\\s+.*-D\\b", "branch\\s+.*--delete\\s+--force",
  "rm\\s+-rf", "FLUSHALL", "FLUSHDB", "docker\\s+compose\\s+down\\s+.*-v",
  "sed\\s+-i", "perl\\s+-\\w*i", "\\btee\\b", "\\bdd\\b",
  "python3?\\s+-c", "node\\s+-e", "ruby\\s+-e",
  "worktree\\s+add", "worktree\\s+prune", "worktree\\s+move", "worktree\\s+repair",
  "(?=.*\\bworktree\\b)(?=.*\\bremove\\b)(?=.*(?:--force\\b|-f\\b))",
];

// May process several changes (review + merge, in sequence) in one run, more
// than a worker's one-task scope. Still a hard stop, not an unbounded loop.
// Raised from 600 after a real session legitimately carried three unrelated
// changes (0012, 0043, 0014) past that ceiling on cumulative, not per-change,
// tool calls - the fix is headroom, not removing the runaway-loop backstop.
const MAX_TOOL_CALLS = 1500;

export function buildIntegratorGuards({ holder, allowTiers = ["low", "medium", "high"], lockPath = ".git/integrator.lock", reviewerRequiredBlocks = false } = {}) {
  if (!holder) throw new Error("buildIntegratorGuards requires a holder name (matches integrator-lock.sh claim <name>)");
  const guards = [
    {
      id: "invariant.integrator_merge_gate", clause: "integrator_merge_gate", bucket: "invariant",
      description: "An autonomous merge into main is only allowed for a change whose risk.tier is low/medium AND reviewer_required is false, AND only while holding the integrator lock. Anything else - high/critical, reviewer-required, or unconfirmable - must escalate to the human/Claude integrator. Two carve-outs for targets that carry no CHANGE-NNNN id at all (2026-10-08): merging the base branch into anything is always safe (main is the source, never the destination); a planning/* branch is safe only if its diff is confined to docs/changes/** and loosens no change's risk.tier/reviewer_required relative to base.",
      check: "integrator_merge_gate", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
      params: { holder, lock_path: lockPath, allow_tiers: allowTiers, reviewer_required_blocks: reviewerRequiredBlocks },
      on_violation: "block",
    },
    {
      id: "invariant.lock_required_for_write", clause: "lock_required_for_write", bucket: "invariant",
      description: "Any git commit or add while on the main checkout requires the integrator lock to be held by this agent first. integrator_merge_gate only ever covered git merge - a plain commit/add (e.g. marking a change.yaml status) was never gated by anything except the honor-system discipline in COORDINATION.md. MEASURED: an integrator backend committed directly to main without claiming the lock, because nothing checked for it outside of merge.",
      check: "lock_required_for_write", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
      params: { holder, lock_path: lockPath },
      on_violation: "block",
    },
    {
      id: "invariant.integrator_no_destructive_git", clause: "integrator_no_destructive_git", bucket: "invariant",
      description: "bash must not force-push, rewrite history, skip hooks, force-delete a branch, or run repo-global gc/prune admin - escalate instead. worktree add/prune/move/repair and forced worktree remove are blocked the same way; worktree remove (no --force) and worktree unlock are deliberately allowed, to retire one specific, already-complete change's worktree (2026-10-09).",
      check: "command_forbidden", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
      params: { git_subcommands: INTEGRATOR_BLOCKED_GIT, patterns: INTEGRATOR_BLOCKED_CMD }, on_violation: "block",
    },
    {
      id: "invariant.tool_call_budget", clause: "tool_call_budget", bucket: "invariant",
      description: `Hard ceiling of ${MAX_TOOL_CALLS} tool calls per integrator run: stops a runaway loop before it exhausts the model's context.`,
      check: "tool_call_limit", hook: "tool_call", phase: "during", implemented: true, surface: "count",
      params: { max: MAX_TOOL_CALLS, distinct: false }, on_violation: "block",
    },
  ];
  for (const g of guards) if (!IMPLEMENTED.has(g.check)) throw new Error(`unimplemented check: ${g.check}`);
  return guards;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const holder = arg("--holder");
  if (!holder) { console.error("usage: compile-integrator-guards.mjs --holder <name> [--allow-tiers low,medium] [--out guards.json]"); process.exit(1); }
  const allowTiersArg = arg("--allow-tiers");
  const allowTiers = allowTiersArg ? allowTiersArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const doc = { agent: "integrator", version: "0.1.0", guards: buildIntegratorGuards({ holder, allowTiers }) };
  const json = JSON.stringify(doc, null, 2);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    writeFileSync(args[outIdx + 1], json + NL);
    console.error(`wrote ${args[outIdx + 1]} (${doc.guards.length} guards, holder=${holder}, allow_tiers=${(allowTiers ?? ["low","medium","high"]).join("/")})`);
  } else console.log(json);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  let threw = false;
  try { buildIntegratorGuards({}); } catch { threw = true; }
  ok(threw, "refuses to build without a holder name");

  const g = buildIntegratorGuards({ holder: "claude-integrator" });

  const mg = g.find((x) => x.check === "integrator_merge_gate");
  ok(!!mg && mg.on_violation === "block", "integrator_merge_gate present, blocks");
  ok(mg.params.holder === "claude-integrator", "holder is baked into the guard, not read from the environment at runtime");
  ok(mg.params.allow_tiers.includes("low") && mg.params.allow_tiers.includes("medium"), "low/medium tiers allowed");
  ok(mg.params.allow_tiers.includes("high") && !mg.params.allow_tiers.includes("critical") && mg.params.reviewer_required_blocks === false, "high allowed, critical never, reviewer_required does not block (owner 2026-10-19)");

  const lw = g.find((x) => x.check === "lock_required_for_write");
  ok(!!lw && lw.on_violation === "block", "lock_required_for_write present, blocks");
  ok(lw.params.holder === "claude-integrator", "holder is baked into the guard, not read from the environment at runtime");
  ok(lw.params.lock_path === mg.params.lock_path, "uses the same lock path as integrator_merge_gate");

  const cf = g.find((x) => x.check === "command_forbidden");
  ok(!cf.params.git_subcommands.includes("worktree"), "does NOT blanket-block git worktree (2026-10-09) - remove/unlock are allowed by pattern below, deliberately");
  ok(cf.params.git_subcommands.includes("gc") && cf.params.git_subcommands.includes("prune"), "blocks gc/prune outright (prune is the exact op that destroyed a live agent's work this project)");
  ok(cf.params.git_subcommands.includes("reset"), "blocks git reset outright (the hard-reset case needs a human, not a mechanical allow)");
  ok(!cf.params.git_subcommands.includes("merge"), "does NOT blanket-block git merge - that is integrator_merge_gate's job, conditionally");
  ok(!cf.params.git_subcommands.includes("checkout"), "allows git checkout (needed to review/land a change)");
  ok(!cf.params.git_subcommands.includes("branch"), "allows git branch (branch -d cleanup after a real merge)");
  ok(!cf.params.git_subcommands.includes("commit"), "allows git commit at the command_forbidden level - lock_required_for_write gates it conditionally");
  ok(cf.params.patterns.some((p) => /--no-verify/.test(p)), "blocks --no-verify (hook skip)");
  ok(cf.params.patterns.some((p) => /force/.test(p)), "blocks force-push");
  ok(cf.params.patterns.some((p) => p.includes("-D")), "blocks branch -D (force-delete)");
  ok(cf.params.patterns.some((p) => p === "worktree\\s+add"), "blocks worktree add - not the integrator's job");
  ok(cf.params.patterns.some((p) => p === "worktree\\s+prune"), "blocks worktree prune by pattern too, belt-and-suspenders with the git_subcommands block above");
  ok(cf.params.patterns.some((p) => p === "worktree\\s+move"), "blocks worktree move");
  ok(cf.params.patterns.some((p) => p === "worktree\\s+repair"), "blocks worktree repair (does not do what it looks like it does - confirmed hands-on)");
  ok(cf.params.patterns.some((p) => p.includes("remove") && p.includes("force")), "blocks a FORCED worktree remove specifically, not remove itself");

  const tcl = g.find((x) => x.check === "tool_call_limit");
  ok(!!tcl && tcl.params.max > 0 && tcl.on_violation === "block", "emits a tool_call_limit loop guard");
  ok(g.find((x) => x.check === "file_boundary") === undefined, "no file_boundary - the integrator is not path-fenced");
  ok(g.every((x) => IMPLEMENTED.has(x.check)), "every emitted check is implemented");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("compile-integrator-guards self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("compile-integrator-guards.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
