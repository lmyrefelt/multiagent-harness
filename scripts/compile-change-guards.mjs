#!/usr/bin/env node
//
// compile-change-guards - turn a change's boundary into PI tool_call guards.
//
// WHY THIS EXISTS
// Our git hooks only fire on a feature branch at commit/push. A local worker that
// edits the working tree without committing (as happened to CHANGE-0003) dodges
// them entirely. The real fix is to enforce the boundary at the moment of the
// write - inside PI, at tool_call - regardless of branch or commit. That is what
// the pi-contracts "contract-guard" extension does; it reads a guards.json. This
// script compiles that guards.json from a change.yaml, so the SAME owned_paths the
// git hook uses also drive the live, un-dodgeable tool_call guard.
//
// Output is the pi-contracts guards.json shape (file_boundary + path_protected +
// command_forbidden). The worker then runs inside contract-guard pointed at it.
//
//   node scripts/compile-change-guards.mjs CHANGE-0003 [--out guards.json]
//   node scripts/compile-change-guards.mjs --selftest
//
// Exit: 0 ok, 1 error. Regenerate before every worker launch - change.yaml is the
// single source of truth; this output is a build artifact, not committed.
//
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { findChangeDir } from "./verify-change.mjs";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);

// Keep in lockstep with the guard engine's IMPLEMENTED_CHECKS (pi-contracts
// extensions/checks.mjs). Emitting a check the engine does not implement would
// silently not enforce - so refuse to emit one.
const IMPLEMENTED = new Set([
  "file_boundary", "path_protected", "command_forbidden",
  "evidence_captured", "test_integrity", "file_exists", "tool_call_limit",
  "structured_file_validity", "no_progress_loop", "redundant_test_rerun",
  "read_budget",
]);

// Standard noise never owned by any change, PLUS the agent's own run-state. A
// worker legitimately writes its task/session state (pi writes agent/task-state.json,
// the session + evidence under .pi-session/) — these are not repo content and must
// not trip the file boundary, which otherwise blocks the agent from recording its
// own progress. Guard/worktree artifacts are excluded for the same reason.
const EXCLUDE = [
  "node_modules/**", ".git/**", "**/__pycache__/**", "**/*.egg-info/**",
  "agent/**", ".pi-session/**", ".pi/**", ".worktrees/**",
  // 2026-10-16: the agent's OWN memory/transcripts in the container's home - never
  // repo content, so never a boundary question. Claude Code saves auto-memory
  // under ~/.claude/projects/<project>/memory/; the planner guard blocked it
  // ("outside docs/changes"). Absolute container path only: nothing in the repo
  // matches it, and the rest of ~/.claude (credentials, settings) stays guarded.
  "/home/node/.claude/projects/**",
  ".contract-guards.json", ".contract-evidence*",
];

// A tool/model may express a repo path as "apps/x" or repo-rooted as "/apps/x".
// The engine anchors its globs and only strips the full repo root in normalize(),
// so a leading-slash path would MISS a repo-relative glob — false-flagging a
// legitimate in-boundary write, and (worse) letting a forbidden "/apps/..." write
// slip the path_protected check. Emit both forms so matching is slash-tolerant.
const slashVariants = (globs) => globs.flatMap((g) => (g.startsWith("/") ? [g] : [g, "/" + g]));

// A worker commits (RED->GREEN) on its branch, so git commit/add are NOT blocked.
// These are blocked: branch wandering, history rewrite, pushing (a gated step),
// and the bash routes that bypass the file boundary or the dependency process.
const BLOCKED_GIT = ["push", "reset", "rebase", "merge", "clean", "checkout", "switch", "stash", "cherry-pick"];
// Loop/OOM guard: a hard ceiling on TOTAL tool calls per run (counts across the
// whole session, including completion-gate continuations). The block-based
// hard-stop only catches a worker flailing against *blocks*; a worker looping on
// un-blocked actions (edit -> run tests -> edit ...) has nothing to stop it until
// the local model's context/memory is exhausted. Tune down if a run still OOMs.
// This is a backstop against OOM, not a loop detector - invariant.no_progress_loop
// below is what actually catches a stuck edit/test/edit cycle, so this ceiling no
// longer has to double as the loop guard and can afford room for a genuinely long,
// productive run.
// 2026-10-10: raised 250 -> 400 (integrator observation: CHANGE-0075 and
// CHANGE-0077 were both cut off at 250 mid-implementation with real, non-looping
// progress committed - same "cutting off genuine improvement" failure mode as the
// MAX_COMPLETION_ATTEMPTS bump below, same fix).
const MAX_TOOL_CALLS = 400;
// 2026-10-10: raised from 4 - owner observation, across real runs, is that
// the model genuinely makes progress on each correction (this is a steering
// mechanism, not just a backstop), so 4 attempts was cutting runs off while
// they were still improving. tool_call_budget (MAX_TOOL_CALLS above) is the
// real backstop against a run that's actually stuck looping, not this - this
// only bounds how many times the completion gate specifically sends the
// model back to make tests green.
const MAX_COMPLETION_ATTEMPTS = 10;

// 2026-10-10: carved out global/tool installs from the project-dependency
// block below. A worker hitting a genuinely MISSING system tool (corepack
// not enabled, a CLI the image forgot) was stuck entirely blocked from
// fixing it, even though a global install touches nothing inside
// owned_paths and doesn't modify the project's own dependency manifest -
// categorically different from `npm install <pkg>` silently adding an
// unreviewed dependency to package.json. The line: -g/--global (npm, pnpm,
// yarn) is allowed anywhere in the command; a bare/local install still
// blocks. `uv tool install <cli>` (uv's own equivalent - an isolated venv
// under ~/.local/share/uv/tools, never touching the project's pyproject.toml/
// uv.lock) and `corepack enable`/`corepack prepare` were ALREADY unaffected
// by any pattern below - call that out so it reads as intentional, not an
// oversight. `uv add`/`uv pip install`/`pip install`/`poetry add` stay fully
// blocked - those are real Python PROJECT dependency changes; the worker's
// own `uv tool install` is the right escape hatch for a missing Python CLI
// tool, same as `npm install -g` for a missing Node one. Verified against
// the real findForbidden() matcher, not just read: 11 cases (bare blocked,
// -g/--global/trailing-flag-position all allowed) - see this file's
// --selftest.
//
// 2026-10-10, SAME DAY, REAL BLOCK HIT: `corepack pnpm install
// --frozen-lockfile` (a worker syncing node_modules from an already-
// committed lockfile - touches nothing in package.json, adds no dependency)
// was blocked anyway. Two separate bugs, both fixed below:
//   1. `npm\s+install` had no LEADING word boundary, so it matched the TAIL
//      of "pnpm install" - "pnpm" is literally "p" + "npm", so the string
//      "pnpm install" contains "npm install" as a plain substring. Every
//      \b-bounded pattern here now anchors at the START too, not just after
//      the command name.
//   2. Once that's fixed, `pnpm install` was never blocked in the first
//      place (no `pnpm\s+install` rule exists - only `pnpm\s+add`, pnpm's
//      actual add-a-dependency verb), but bare `npm install` (no package
//      name - npm's OWN lockfile-sync form, since npm has no separate "add"
//      verb) was STILL blocked even with no dangerous flag present. Added:
//      a completely bare `install`/`i` (nothing after but whitespace) is
//      now ALSO safe, same as -g/--global/--frozen-lockfile/--ci - none of
//      these touch the project's dependency manifest, only `npm install
//      <pkg>` (an actual bare word naming a package) does.
const BLOCKED_CMD = [
  "pip\\s+install", "uv\\s+add", "uv\\s+pip\\s+install", "poetry\\s+add",
  "\\bnpm\\s+install\\b(?!.*(-g\\b|--global\\b|--frozen-lockfile\\b|--ci\\b)|\\s*$)",
  "\\bnpm\\s+i\\b(?!.*(-g\\b|--global\\b|--frozen-lockfile\\b|--ci\\b)|\\s*$)",
  "\\bpnpm\\s+add\\b(?!.*(-g\\b|--global\\b))",
  "\\byarn\\s+add\\b(?!.*(-g\\b|--global\\b))",   // project deps go through the change, not ad-hoc; -g/--global tool installs are the carved-out exception above
  "rm\\s+-rf", "FLUSHALL", "FLUSHDB", "docker\\s+compose\\s+down\\s+.*-v",  // destructive
  // #5 - close the bash file-write bypass: file changes go through the edit/write
  // tools (which the boundary guard sees), never through bash. These routes are not
  // path-checked, so a worker could edit an out-of-boundary file with them.
  "sed\\s+-i", "perl\\s+-\\w*i", "\\btee\\b", "\\bdd\\b",
  "python3?\\s+-c", "node\\s+-e", "ruby\\s+-e",                 // arbitrary-code write routes
  // redirect INTO a source file - but NOT into /tmp/, which has no owned_paths meaning
  // at all and is a completely normal place to dump a read-only `git show` for inspection.
  // 2026-10-11 REAL BLOCK HIT: `git show HEAD:apps/.../test_foo.py > /tmp/test_foo.py`
  // (a harmless read, not a write-bypass) was blocked 10 times in a row because the
  // pattern had no path scoping at all - it matched the EXTENSION anywhere, regardless
  // of destination, and exhausted the run's total refusal budget on a non-issue.
  ">>?\\s*(?!/tmp/)\\S*\\.(py|ts|tsx|js|mjs|yaml|yml|toml|json|sh)\\b",
];

// --- narrow reader for the two list fields + id --------------------------
export function readChange(text) {
  const out = { id: null, owned_paths: [], forbidden_paths: [], tests_command: null };
  let list = null, inTests = false;
  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  const asNull = (v) => (v === "null" || v === "" ? null : v);
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (list) {
      const it = raw.match(/^\s+-\s+(.*)$/);
      if (it) { const v = scalar(it[1]); if (v) out[list].push(v); continue; }
      list = null;
    }
    if (inTests) {
      const sub = raw.match(/^(\s+)([a-zA-Z_]\w*):\s*(.*)$/);
      if (sub && sub[1].length >= 2) { if (sub[2] === "command") out.tests_command = asNull(scalar(sub[3])); continue; }
      if (/^\S/.test(raw)) inTests = false; // dedented back to a top-level key
    }
    const kv = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
    if (kv) {
      const k = kv[1], rest = kv[2]; list = null;
      if (k === "id") out.id = scalar(rest);
      else if (k === "tests") inTests = true;
      else if (k === "owned_paths" || k === "forbidden_paths") { if (scalar(rest) !== "[]") list = k; }
    }
  }
  return out;
}

export function buildGuards(cfg, changeDirGlob) {
  const guards = [];
  guards.push({
    id: "invariant.no_write_outside_boundary", clause: "no_write_outside_boundary", bucket: "invariant",
    description: `Worker may only modify files inside ${cfg.id} owned_paths (and its own change folder).`,
    check: "file_boundary", hook: "tool_call", phase: "during", implemented: true, surface: "path",
    params: { include: slashVariants([...cfg.owned_paths, changeDirGlob]), exclude: slashVariants(EXCLUDE), normalize: "repo_relative" },
    on_violation: "block",
  });
  if (cfg.forbidden_paths.length) {
    guards.push({
      id: "invariant.no_write_to_protected_paths", clause: "no_write_to_protected_paths", bucket: "invariant",
      description: `Paths this change is explicitly forbidden to touch.`,
      check: "path_protected", hook: "tool_call", phase: "during", implemented: true, surface: "path",
      params: { patterns: slashVariants(cfg.forbidden_paths) }, on_violation: "block",
    });
  }
  // WORKER-GUARDRAILS.md issue #2: a local model's write/edit can land a
  // JSON file corrupted (a dropped quote or comma, confirmed as an oMLX
  // detokenization bug, not a model/quantization issue) with no error raised
  // by the tool itself. The evidence_captured gate below catches this for
  // code via the test run's own syntax/import error; JSON files aren't
  // test-covered the same way, so this closes that specific gap by
  // reconstructing what the write/edit would leave on disk and refusing it
  // before it lands, at the moment of the write rather than at review time.
  // YAML is deliberately not included - no YAML parser is wired into the
  // guard engine (see checks.mjs), and a hand-rolled one risks being wrong
  // in the same way the bug it's meant to catch is.
  guards.push({
    id: "invariant.structured_files_stay_parseable", clause: "structured_files_stay_parseable", bucket: "invariant",
    description: "A write/edit must not leave a .json file as invalid JSON. Catches local-model tool-call content corruption (WORKER-GUARDRAILS.md issue #2) at the moment of the write, since it raises no error of its own and isn't covered by the test-must-pass gate.",
    check: "structured_file_validity", hook: "tool_call", phase: "during", implemented: true, surface: "path",
    params: { extensions: [".json"], exclude: slashVariants(EXCLUDE) },
    on_violation: "block",
  });
  guards.push({
    id: "invariant.no_offboundary_or_destructive_bash", clause: "no_offboundary_or_destructive_bash", bucket: "invariant",
    description: "bash must not wander branches, rewrite history, push, install deps ad-hoc, or run destructive ops. Deps go through the change's owned_paths + a boundary update, not a raw install.",
    check: "command_forbidden", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
    params: { git_subcommands: BLOCKED_GIT, patterns: BLOCKED_CMD }, on_violation: "block",
  });
  guards.push({
    id: "invariant.tool_call_budget", clause: "tool_call_budget", bucket: "invariant",
    description: `Hard ceiling of ${MAX_TOOL_CALLS} tool calls per run: stops a runaway run before it exhausts the local model's context/memory. Counts all calls across the run, including completion-gate continuations. This is an OOM backstop, not a loop detector - see invariant.no_progress_loop for that.`,
    check: "tool_call_limit", hook: "tool_call", phase: "during", implemented: true, surface: "count",
    params: { max: MAX_TOOL_CALLS, distinct: false }, on_violation: "block",
  });
  // 2026-10-10: tool_call_budget alone can't tell a worker making 300 distinct
  // edits from one replaying the SAME edit 300 times - both just look like "a lot
  // of calls" to a raw counter. This catches the second shape directly: the exact
  // same mutating tool call (same tool + path + before/after content) repeating
  // within a short trailing window. Scoped to mutators only (edit/write) -
  // rerunning the SAME test command is the normal RED->GREEN loop and must never
  // trip this; only a file write/edit that keeps landing identically counts as
  // "stuck".
  guards.push({
    id: "invariant.no_progress_loop", clause: "no_progress_loop", bucket: "invariant",
    description: "The same edit/write (identical tool + path + before/after content) repeated more than max_repeats times within the trailing window of mutating calls is a stuck loop, not progress - stop it well before tool_call_budget would.",
    check: "no_progress_loop", hook: "tool_call", phase: "during", implemented: true, surface: "path",
    params: { window: 20, max_repeats: 3 }, on_violation: "block",
  });
  // 2026-10-12: a DIFFERENT waste pattern than no_progress_loop above, not a
  // variant of it - deliberately separate, inspired by a named red flag
  // ("running the same build/test command twice without intervening changes")
  // that no_progress_loop's own bash exemption can't catch, because that
  // exemption exists FOR the normal RED->GREEN rerun and can't distinguish it
  // from a test rerun with nothing changed. This guard can: it keys on the
  // mutator-call COUNT at the moment of each test invocation, so a repeat is
  // only flagged when literally zero edits/writes happened in between.
  guards.push({
    id: "invariant.no_redundant_test_rerun", clause: "redundant_test_rerun", bucket: "invariant",
    description: "The same test/build command run again with ZERO mutating calls (no edit/write) since its last run repeats the same inputs and learns nothing new - distinct from the normal RED->GREEN rerun, which always has an edit in between.",
    check: "redundant_test_rerun", hook: "tool_call", phase: "during", implemented: true, surface: "cmd",
    params: { window: 20, max_repeats: 2 }, on_violation: "block",
  });
  // Token budget - read_budget (pi-contracts extensions/read-budget.mjs, ported
  // from tokenleak). A whole-file read of a big text file is re-sent on every
  // later call; redirect it to an outline instead. on_violation "redirect", NOT
  // "block": never counts toward the refusal caps, never hard-stops, and the
  // same read repeated once goes through. Applies to every role and backend:
  // read/view_file/Read tools, and cat/nl through bash (Codex).
  guards.push({
    id: "efficiency.read_budget", clause: "read_budget", bucket: "invariant",
    description: "Whole-file reads of large text files are redirected to an outline with line numbers; read the part you need with a range.",
    check: "read_budget", hook: "tool_call", phase: "during", implemented: true, surface: "read",
    params: { max_bytes: 24000 }, on_violation: "redirect",
  });
  // Hardening #2 — the completion/evidence gate. The worker may not END a run
  // claiming "done" unless the change's tests actually ran AND passed, captured
  // from the transcript (not asserted by the model). This is what kills the
  // "IMPLEMENTATION_COMPLETE.md over broken code" failure. Only meaningful if the
  // change names a runnable tests.command.
  if (cfg.tests_command) {
    guards.push({
      id: "obligation.tests_pass_before_done", clause: "tests_pass_before_done", bucket: "obligation",
      description: `A run may not settle claiming completion unless ${cfg.id}'s tests ran and passed. Captured from tool output, not from the model's word.`,
      check: "evidence_captured", hook: "agent_settled", phase: "post", implemented: true, surface: "tool-output",
      params: {
        // Detection is isTestInvocation(uv/pytest/vitest/pnpm-aware) in the engine; these are
        // declared for forward-compat and audit.
        test_command_patterns: ["\\bpytest\\b", "\\buv\\s+run\\b", "\\bpnpm\\b", "\\bvitest\\b"],
        // pytest-shaped, NOT node-shaped: a run that "ran" always prints one of these.
        // The change's own tests.command ALWAYS counts as the test run (judged by exit
        // status) - a bash validator need not be pytest-shaped. HARNESS-TESTS: is what
        // `handoff.mjs report` prints after running tests.command itself.
        tests_command: cfg.tests_command,
        ran_patterns: ["collected \\d+ item", "\\d+ passed", "\\d+ failed", "\\d+ error", "no tests ran", "HARNESS-TESTS: (PASSED|FAILED)"],
        passed_patterns: ["\\d+ passed", "HARNESS-TESTS: PASSED"],
        failed_patterns: ["\\d+ failed", "\\d+ error", "no tests ran", "INTERNALERROR", "HARNESS-TESTS: FAILED"],
        claim_patterns: ["\\b(done|complete|completed|implemented|finished|shipped)\\b", "ready for review"],
        enforce_before_settle: true, // gate at the actionable boundary, not just observe at settle
        max_completion_attempts: MAX_COMPLETION_ATTEMPTS,  // loop the model back up to N times until tests are green, then fail the run
      },
      on_violation: "block",
    });
  }
  for (const g of guards) if (!IMPLEMENTED.has(g.check)) throw new Error(`unimplemented check: ${g.check}`);
  return guards;
}

function main() {
  const args = process.argv.slice(2);
  const idArg = args.find((a) => /^CHANGE-\d+$/i.test(a));
  const num = (idArg || "").replace(/\D+/g, "");
  if (!num) { console.error("usage: compile-change-guards.mjs CHANGE-NNNN [--out file]"); process.exit(1); }
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const absoluteDir = findChangeDir(root, num);
  const dir = absoluteDir ? relative(root, absoluteDir).replace(/\\/g, "/") : null;
  if (!dir) { console.error(`no docs/changes/CHANGE-${num}-*/change.yaml found`); process.exit(1); }
  const cfg = readChange(readFileSync(join(root, dir, "change.yaml"), "utf8"));
  if (!cfg.owned_paths.length) { console.error(`${dir}/change.yaml has empty owned_paths - nothing to enforce`); process.exit(1); }
  const doc = { agent: "worker", version: "0.1.0", change: cfg.id, guards: buildGuards(cfg, dir + "/**") };
  const json = JSON.stringify(doc, null, 2);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) { writeFileSync(args[outIdx + 1], json + NL); console.error(`wrote ${args[outIdx + 1]} (${doc.guards.length} guards)`); }
  else console.log(json);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
  const text = [
    "id: CHANGE-0003",
    "owned_paths:",
    '  - "apps/api/src/harness/ports/object_store.py"',
    '  - "apps/api/src/harness/adapters/object_store/**"',
    "forbidden_paths:",
    '  - "apps/api/src/harness/domain/**"',
    "tests:",
    '  command: "uv run --frozen --project apps/api pytest apps/api/tests -q"',
    "  red_commit_required: true",
  ].join(NL);
  const cfg = readChange(text);
  ok(cfg.id === "CHANGE-0003", "reads id");
  ok(cfg.owned_paths.length === 2, "reads owned_paths");
  ok(cfg.forbidden_paths.length === 1, "reads forbidden_paths");
  ok(cfg.tests_command === "uv run --frozen --project apps/api pytest apps/api/tests -q", "reads nested tests.command");

  const guards = buildGuards(cfg, "docs/changes/CHANGE-0003-x/**");
  const fb = guards.find((g) => g.check === "file_boundary");
  ok(!!fb && fb.hook === "tool_call" && fb.on_violation === "block", "file_boundary at tool_call, blocks");
  ok(fb.params.include.includes("apps/api/src/harness/adapters/object_store/**"), "include carries owned_paths");
  ok(fb.params.include.includes("docs/changes/CHANGE-0003-x/**"), "include carries the change folder");
  ok(fb.params.exclude.includes(".git/**"), "excludes .git");
  const pp = guards.find((g) => g.check === "path_protected");
  ok(!!pp && pp.params.patterns[0] === "apps/api/src/harness/domain/**", "path_protected carries forbidden_paths");
  const cf = guards.find((g) => g.check === "command_forbidden");
  ok(!!cf && cf.params.git_subcommands.includes("push") && !cf.params.git_subcommands.includes("commit"), "blocks push, allows commit");
  ok(cf.params.patterns.some((p) => /pip/.test(p)), "blocks ad-hoc pip install");
  ok(cf.params.patterns.some((p) => /sed/.test(p)), "blocks bash sed -i write-bypass (#5)");

  // Global/tool-install carve-out (2026-10-10) - exercise the ACTUAL regex
  // strings against real-shaped commands, not just check a pattern exists.
  // A worker can install a MISSING system tool (-g/--global, or uv tool
  // install, which no pattern here ever touched) without being able to
  // quietly add a real project dependency.
  const isBlocked = (cmd) => cf.params.patterns.some((p) => new RegExp(p).test(cmd));
  ok(isBlocked("npm install lodash"), "still blocks a bare npm install (project dep)");
  ok(!isBlocked("npm install -g corepack@latest"), "allows npm install -g (global tool, not a project dep)");
  ok(!isBlocked("npm install --global corepack"), "allows npm install --global");
  ok(!isBlocked("npm install corepack -g"), "allows -g regardless of position in the command");
  ok(isBlocked("pnpm add react"), "still blocks a bare pnpm add (project dep)");
  ok(!isBlocked("pnpm add -g typescript"), "allows pnpm add -g");
  ok(isBlocked("yarn add lodash"), "still blocks a bare yarn add (project dep)");
  ok(!isBlocked("yarn add -g typescript"), "allows yarn add -g");
  ok(isBlocked("uv add requests"), "uv add (real pyproject.toml/uv.lock change) still fully blocked - no carve-out for it");
  ok(!isBlocked("uv tool install ruff"), "uv tool install was never matched by any pattern here - the intended escape hatch for a missing Python CLI");
  ok(!isBlocked("corepack enable"), "corepack enable was never matched by any pattern here - the intended fix for the real gap this carve-out was written for");

  // Real block hit the same day (2026-10-10): `corepack pnpm install
  // --frozen-lockfile` - two separate bugs, both covered here so neither
  // regresses silently. See this file's own BLOCKED_CMD comment.
  ok(!isBlocked("corepack pnpm install --frozen-lockfile"), "pnpm install (lockfile sync, no new dep) is NOT blocked - npm's pattern must not match inside the word \"pnpm\" (bug #1: missing leading word boundary)");
  ok(!isBlocked("pnpm install"), "bare pnpm install, no corepack prefix, still not blocked");
  ok(!isBlocked("npm install"), "bare npm install (npm's OWN lockfile-sync form - it has no separate add verb) is NOT blocked even with no flag at all (bug #2: a completely bare install/i is now also treated as safe)");
  ok(!isBlocked("npm install --frozen-lockfile"), "npm install --frozen-lockfile allowed (lockfile-respecting, not a dependency add)");
  ok(!isBlocked("npm i"), "bare npm i (the short alias) also not blocked");
  ok(isBlocked("npm install lodash"), "npm install <actual-package-name> (no flag, not bare) still correctly blocks - the real add-a-dependency case");

  // Real block hit 2026-10-11: a read-only `git show ... > /tmp/x.py` exhausted the
  // total refusal budget 10 times in a row before this fix existed.
  ok(!isBlocked("git show HEAD:apps/api/tests/triage_v2/test_access_administration.py > /tmp/test_access_administration.py"), "redirect into /tmp (even with a source-like extension) is NOT a write-bypass - must not block");
  ok(!isBlocked("cat foo.yaml > /tmp/foo.yaml"), "/tmp redirect allowed for every covered extension, not just .py");
  ok(isBlocked("git show HEAD:foo.py > apps/api/src/harness/foo.py"), "the SAME command redirecting into the repo (not /tmp) still correctly blocks - the exclusion is path-scoped, not extension-scoped");
  ok(isBlocked("echo bad >> src/app.py"), "a real write-bypass into a repo source file still blocks (regression check - /tmp carve-out must not weaken this)");
  ok(guards.every((g) => IMPLEMENTED.has(g.check)), "every emitted check is implemented");
  const tcl = guards.find((g) => g.check === "tool_call_limit");
  ok(!!tcl && tcl.params.max > 0 && tcl.on_violation === "block", "emits a tool_call_limit loop guard");
  ok(tcl.params.max === 400, "worker tool_call_budget raised to 400 (2026-10-10, was cutting off genuine progress at 250)");

  const npl = guards.find((g) => g.check === "no_progress_loop");
  ok(!!npl && npl.hook === "tool_call" && npl.on_violation === "block", "emits a no_progress_loop guard, blocks");
  ok(npl.params.window > 0 && npl.params.max_repeats > 0, "no_progress_loop carries a window and a repeat threshold");

  const rtr = guards.find((g) => g.check === "redundant_test_rerun");
  ok(!!rtr && rtr.hook === "tool_call" && rtr.on_violation === "block", "emits a redundant_test_rerun guard, blocks");
  ok(rtr.params.window > 0 && rtr.params.max_repeats > 0, "redundant_test_rerun carries a window and a repeat threshold");
  ok(rtr.id !== npl.id && rtr.check !== npl.check, "redundant_test_rerun is a SEPARATE guard from no_progress_loop, not a duplicate registration");

  const sfv = guards.find((g) => g.check === "structured_file_validity");
  ok(!!sfv && sfv.hook === "tool_call" && sfv.on_violation === "block", "structured_file_validity present, blocks");
  ok(sfv.params.extensions.includes(".json") && !sfv.params.extensions.includes(".yaml"), "JSON only - no YAML parser wired into the engine");
  ok(sfv.params.exclude.includes(".pi-session/**"), "excludes the agent's own run-state, same EXCLUDE list as file_boundary");

  const ev = guards.find((g) => g.check === "evidence_captured");
  ok(!!ev && ev.hook === "agent_settled" && ev.on_violation === "block", "evidence gate present, blocks");
  ok(ev.params.enforce_before_settle === true, "evidence gate enforces before settle (not just observes)");
  ok(ev.params.claim_patterns.join("|").includes("complete"), "claim patterns include a 'complete' claim");
  ok(ev.params.failed_patterns.some((p) => /failed/.test(p)), "failed patterns catch pytest failures");
  ok(ev.params.tests_command === cfg.tests_command, "the gate carries the change's own tests.command (accepted as the test run; named in the gate's hint)");
  ok(ev.params.max_completion_attempts === 10, "completion gate allows 10 correction attempts before failing the run (raised from 4 - owner observation: real progress per correction)");

  // empty forbidden_paths -> no path_protected guard; no tests.command -> no evidence gate
  const cfg2 = readChange(["id: CHANGE-0009", "owned_paths:", "  - a/**", "forbidden_paths: []"].join(NL));
  const g2 = buildGuards(cfg2, "d/**");
  ok(g2.find((g) => g.check === "path_protected") === undefined, "no path_protected when none declared");
  ok(g2.find((g) => g.check === "evidence_captured") === undefined, "no evidence gate without a tests.command");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("compile-change-guards self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("compile-change-guards.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
