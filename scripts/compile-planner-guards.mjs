#!/usr/bin/env node
//
// compile-planner-guards - tool_call guards for the PLANNER (docs-only) role.
//
// WHY THIS EXISTS
// The planner writes specs, never code, and must never do the repo-global git
// operations that trip the other agents (worktree prune/remove, branch -D/-m, gc,
// merge, ...). The host-side pre-commit (check-boundary.mjs planning/* lane) already
// fences WHAT it may commit. This adds the live, un-dodgeable tool_call layer for a
// planner that runs INSIDE the pi container: a write outside docs/, or a repo-global
// git command, is blocked at the moment of the call - not caught later at commit.
//
// Same guards.json shape the worker uses (file_boundary + command_forbidden +
// tool_call_limit), so the pi contract-guard engine reads it identically. No
// evidence gate: a planner has no tests to pass.
//
//   node scripts/compile-planner-guards.mjs [--out guards.json]
//   node scripts/compile-planner-guards.mjs --selftest
//
import { writeFileSync } from "node:fs";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);

// Keep in lockstep with the engine's IMPLEMENTED_CHECKS (checks.mjs).
const IMPLEMENTED = new Set([
  "file_boundary", "path_protected", "command_forbidden",
  "evidence_captured", "test_integrity", "file_exists", "tool_call_limit",
]);

// The planner's whole world: the spec surface. Nothing else.
const PLANNER_OWNED = ["docs/changes/**", "docs/decisions/**"];
// Standard noise + the agent's own run-state (pi writes agent/task-state.json and
// its session/evidence) — not repo content, must not trip the boundary.
const EXCLUDE = [
  "node_modules/**", ".git/**", "**/__pycache__/**", "**/*.egg-info/**",
  "agent/**", ".pi-session/**", ".pi/**", ".worktrees/**",
  ".contract-guards.json", ".contract-evidence*",
  // 2026-10-16: the agent's OWN memory/transcripts in the container's home - never
  // repo content, so never a boundary question. Claude Code saves auto-memory
  // under ~/.claude/projects/<project>/memory/; the planner guard blocked it
  // ("outside docs/changes"). Absolute container path only: nothing in the repo
  // matches it, and the rest of ~/.claude (credentials, settings) stays guarded.
  "/home/node/.claude/projects/**",
];

// Slash-tolerant matching: a path may arrive as "docs/x" or "/docs/x".
const slashVariants = (globs) => globs.flatMap((g) => (g.startsWith("/") ? [g] : [g, "/" + g]));

// The planner commits specs on its planning/* branch, so commit/add stay allowed.
// Everything that moves branches, rewrites history, reaches the network, or is
// repo-GLOBAL (affects other agents' worktrees/branches) is blocked. This is the
// mechanical form of COORDINATION.md rules 3-4.
const PLANNER_BLOCKED_GIT = [
  "push", "pull", "fetch", "reset", "rebase", "merge", "clean", "checkout",
  "switch", "stash", "cherry-pick", "worktree", "branch", "gc", "prune", "remote", "tag",
];

// A planner has no reason to write source via bash or run destructive ops. Blocking
// the bash write-bypass routes means spec text goes through the edit/write tools
// (which the file_boundary guard sees), never around them.
const PLANNER_BLOCKED_CMD = [
  "rm\\s+-rf", "FLUSHALL", "FLUSHDB", "docker\\s+compose\\s+down\\s+.*-v",
  "sed\\s+-i", "perl\\s+-\\w*i", "\\btee\\b", "\\bdd\\b",
  "python3?\\s+-c", "node\\s+-e", "ruby\\s+-e",
  ">>?\\s*\\S*\\.(py|ts|tsx|js|mjs|yaml|yml|toml|json|sh)\\b", // redirect INTO source
];

// Planning can span several specs in one run (discovery + impact-analysis + spec +
// Gherkin per change, sometimes for 3-4 changes back to back), so the loop ceiling
// is higher than the worker's 250 - still a hard stop against a runaway edit/read loop.
const MAX_TOOL_CALLS = 400;

export function buildPlannerGuards() {
  const guards = [
    {
      id: "invariant.planner_docs_only", clause: "planner_docs_only", bucket: "invariant",
      description: "Planner may only write the spec surface (docs/changes, docs/decisions). Code, compose, scripts and hooks belong to a worker.",
      check: "file_boundary", hook: "tool_call", phase: "during", implemented: true, surface: "path",
      params: { include: slashVariants(PLANNER_OWNED), exclude: slashVariants(EXCLUDE), normalize: "repo_relative" },
      on_violation: "block",
    },
    {
      id: "invariant.planner_no_repo_global_git", clause: "planner_no_repo_global_git", bucket: "invariant",
      description: "bash must not move branches, rewrite history, reach the network, or run repo-global ops (worktree/branch/gc/prune/merge) that trip other agents. Commit/add on the planning branch stay allowed.",
      check: "command_forbidden", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
      params: { git_subcommands: PLANNER_BLOCKED_GIT, patterns: PLANNER_BLOCKED_CMD }, on_violation: "block",
    },
    {
      id: "invariant.tool_call_budget", clause: "tool_call_budget", bucket: "invariant",
      description: `Hard ceiling of ${MAX_TOOL_CALLS} tool calls per planning run: stops a runaway loop before it exhausts the model's context.`,
      check: "tool_call_limit", hook: "tool_call", phase: "during", implemented: true, surface: "count",
      params: { max: MAX_TOOL_CALLS, distinct: false }, on_violation: "block",
    },
  ];
  for (const g of guards) if (!IMPLEMENTED.has(g.check)) throw new Error(`unimplemented check: ${g.check}`);
  return guards;
}

function main() {
  const args = process.argv.slice(2);
  const doc = { agent: "planner", version: "0.1.0", guards: buildPlannerGuards() };
  const json = JSON.stringify(doc, null, 2);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    writeFileSync(args[outIdx + 1], json + NL);
    console.error(`wrote ${args[outIdx + 1]} (${doc.guards.length} guards)`);
  } else console.log(json);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
  const g = buildPlannerGuards();

  const fb = g.find((x) => x.check === "file_boundary");
  ok(!!fb && fb.on_violation === "block", "file_boundary present, blocks");
  ok(fb.params.include.includes("docs/changes/**"), "boundary allows docs/changes");
  ok(fb.params.include.includes("docs/decisions/**"), "boundary allows docs/decisions");
  ok(!fb.params.include.some((p) => /apps\//.test(p)), "boundary does NOT allow code");

  const cf = g.find((x) => x.check === "command_forbidden");
  ok(cf.params.git_subcommands.includes("worktree"), "blocks git worktree (the prune that wiped the planner)");
  ok(cf.params.git_subcommands.includes("merge"), "blocks git merge (integrator-only)");
  ok(cf.params.git_subcommands.includes("branch"), "blocks git branch -D/-m");
  ok(!cf.params.git_subcommands.includes("commit"), "allows git commit on the planning branch");
  ok(cf.params.patterns.some((p) => /sed/.test(p)), "blocks bash source-write bypass");

  const tcl = g.find((x) => x.check === "tool_call_limit");
  ok(!!tcl && tcl.params.max > 0 && tcl.on_violation === "block", "emits a tool_call_limit loop guard");
  ok(g.find((x) => x.check === "evidence_captured") === undefined, "no evidence gate (planner has no tests)");
  ok(g.every((x) => IMPLEMENTED.has(x.check)), "every emitted check is implemented");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("compile-planner-guards self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("compile-planner-guards.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
