// opencode-guard-adapter.mjs — an OpenCode PLUGIN, not a stdin/stdout adapter.
//
// WHY THIS IS SHAPED DIFFERENTLY FROM THE OTHER THREE ADAPTERS
// antigravity-guard-adapter.mjs / claude-guard-adapter.mjs / codex-guard-
// adapter.mjs are all external-process protocols: the host CLI spawns a
// fresh `node adapter.mjs` per tool call, feeds it a JSON envelope on
// stdin, and reads a JSON decision off stdout. OpenCode's hook system is
// architecturally different (opencode.ai/docs/build/plugins, fetched
// directly, 2026-10-10): a plugin is a JS/TS module loaded IN-PROCESS by
// the opencode binary itself at startup, auto-discovered from
// `.opencode/plugins/` (project) - no subprocess, no JSON protocol. A
// `tool.execute.before` hook fires before a tool runs and can block it by
// THROWING an Error - no decision-object schema to get wrong, which sidesteps
// the exact class of bug that hit the codex backend (an explicit
// "permissionDecision:allow" Codex rejected outright). This file is still
// the SAME thin translation layer in spirit: OpenCode's hook envelope in,
// checks.mjs's event shape through, a thrown Error (or nothing) out.
//
// VERIFIED vs ASSUMED - read before trusting this in production:
//   VERIFIED (opencode.ai/docs/build/plugins + opencode.ai/docs/tools/,
//   fetched directly 2026-10-10, cross-checked against real GitHub issue
//   titles referencing the actual field names in anomalyco/opencode - not
//   training memory):
//     - Plugin export shape: `export const Name = async (ctx) => ({ hooks })`.
//     - Discovery: `.opencode/plugins/*.{js,mjs,ts}` (project-level),
//       auto-loaded at startup - no bind mount needed at all, the file just
//       needs to exist in the already-mounted worktree.
//     - `tool.execute.before(input, output)` - throwing blocks the call.
//     - Real field names, confirmed via actual bug-report titles ("oldString
//       not found", "empty oldString", filePath in the real EditTool source
//       at packages/opencode/src/tool/edit.ts): edit uses `filePath`,
//       `oldString`, `newString` - CAMELCASE, which checks.mjs's existing
//       `input.path ?? input.file_path ?? input.filePath` fallback already
//       covers for the path, but NOT for oldString/newString (checks.mjs
//       only recognises `oldText`/`old_string`, neither of which is
//       `oldString`) - this adapter explicitly renames those two.
//   ASSUMED / genuinely uncertain, flag on first real launch:
//     - WHICH parameter carries `.args` - two independently fetched sources
//       disagreed (one said `output.args`, mutable; a community gist said
//       `input.args.command`). This reads BOTH defensively
//       (`output?.args ?? input?.args ?? {}`) rather than picking one and
//       risking a silent no-op if the wrong one was chosen.
//     - `write`/`read`/`bash`'s exact field names (`content`, `command`) -
//       high-confidence ecosystem convention, not individually confirmed
//       against a real schema dump the way edit's fields were.
//     - Whether `tool.execute.before` fires regardless of the `--auto` flag
//       or a static `opencode.json` "allow" rule - inferred from the SAME
//       hook-vs-permission-layer separation already confirmed for Claude
//       Code and inferred for Codex, not independently confirmed for
//       OpenCode specifically.
//     - Whether Bun (OpenCode's own runtime - its docs reference `$` as
//       "Bun's shell API" and cache plugin deps via `bun install") can
//       dynamically `import()` a plain Node ESM file (checks.mjs) with no
//       Bun-specific syntax - high confidence (Bun's Node-API compatibility
//       is extensive and well established) but not run here.
//
// FAIL CLOSED, not open: any unexpected error (checks.mjs not found,
// CONTRACT_GUARDS missing/unreadable) THROWS too - a broken adapter must not
// become an open gate. Mirrors the other three adapters' own fail-closed
// design, just expressed as "throw" instead of "return deny".
//
// Counters (tool_call_limit) persist in a MODULE-LEVEL variable, not a state
// file like the other three adapters need - because this plugin genuinely
// stays loaded in the SAME process for the whole opencode session (no
// subprocess-per-call to lose state between), this is simpler, not a
// workaround.
//
//   Generated fresh per launch into <worktree>/.opencode/plugins/harness-guard.mjs
//   by scripts/launch-worker.sh - CONTRACT_GUARDS/CONTRACT_EVIDENCE/REPO_ROOT
//   are baked into the file's own top as plain consts at generation time
//   (NOT read from env - unlike the other three adapters, there is no
//   external-process invocation to pass env vars TO; the plugin runs inside
//   opencode's own process, which does inherit the container's env, but
//   baking the paths in directly avoids depending on that inheritance at
//   all, since it was already an open, unconfirmed question for every
//   other backend's adapter).
//
//   node scripts/opencode-guard-adapter.mjs --selftest   (tests the pure
//   mapping/evaluation logic below in isolation, not the real plugin export -
//   there is no opencode binary in this sandbox to load a real plugin into)

export function toCanonicalEvent(toolName, args) {
  const a = args || {};
  switch (toolName) {
    case "bash":
      return { toolName: "bash", input: { command: a.command } };
    case "write":
      return { toolName: "write", input: { path: a.filePath, content: a.content } };
    case "edit":
      return {
        toolName: "edit",
        input: { path: a.filePath, old_string: a.oldString, new_string: a.newString },
      };
    case "read":
      return { toolName: "read", input: { path: a.filePath, offset: a.offset, limit: a.limit } }; // offset/limit: read_budget lets ranged reads through
    default:
      // Unrecognised tool: pass the raw name through unmapped. No guard
      // compiled for the worker role keys on anything but bash/write/edit/
      // multiedit/notebook_edit (MUTATORS, checks.mjs), so this is inert
      // today, not a silent bypass of something that would otherwise have
      // fired.
      return { toolName, input: a };
  }
}

/**
 * Build the real OpenCode plugin export. Takes the already-resolved guards
 * array and repoRoot (the generator script bakes these in as literals, see
 * this file's own header) rather than reading env - no subprocess, no env
 * inheritance to depend on.
 */
export function makeGuardHook({ guards, repoRoot, evaluateDuring, newCounters }) {
  const counters = newCounters();
  return async (input, output) => {
    const toolName = input?.tool;
    const args = output?.args ?? input?.args ?? {};
    const event = toCanonicalEvent(toolName, args);
    const result = evaluateDuring(guards, event, { repoRoot, counters });
    if (result.blocked) {
      throw new Error(result.reason || "blocked by worker guard");
    }
  };
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  // toCanonicalEvent - the field-name renames this adapter adds that no
  // sibling adapter needed (checks.mjs doesn't already recognise camelCase
  // oldString/newString, unlike filePath which IS already a recognised
  // synonym)
  let e = toCanonicalEvent("bash", { command: "git status" });
  ok(e.toolName === "bash" && e.input.command === "git status", "bash -> bash, command passes through");

  e = toCanonicalEvent("write", { filePath: "docs/x.md", content: "hello" });
  ok(e.toolName === "write" && e.input.path === "docs/x.md" && e.input.content === "hello", "write -> write, filePath -> path");

  e = toCanonicalEvent("edit", { filePath: "x.py", oldString: "old", newString: "new" });
  ok(e.toolName === "edit" && e.input.old_string === "old" && e.input.new_string === "new", "edit -> edit, oldString/newString -> old_string/new_string (the real rename this adapter adds)");

  e = toCanonicalEvent("read", { filePath: "x.py" });
  ok(e.toolName === "read" && e.input.path === "x.py", "read -> read");

  e = toCanonicalEvent("some_future_tool", { a: 1 });
  ok(e.toolName === "some_future_tool" && e.input.a === 1, "unrecognised tool passes through unmapped, not dropped");

  // makeGuardHook - exercise against a FAKE evaluateDuring (this sandbox has
  // no opencode binary to load a real plugin into, but the pure logic -
  // which param carries .args, throw-on-block - is fully testable standalone)
  let thrown = null;
  const fakeEvaluateDuring = (guards, event, ctx) => {
    if (event.input.path === "blocked.py") return { blocked: true, reason: "nope: " + event.input.path };
    return { blocked: false };
  };
  const hook = makeGuardHook({ guards: [], repoRoot: "/x", evaluateDuring: fakeEvaluateDuring, newCounters: () => ({}) });

  // args on `output` (the shape one fetched source confirmed via a real
  // apply_patch example: output.args.patchText/filePath)
  (async () => {
    try { await hook({ tool: "edit" }, { args: { filePath: "ok.py", oldString: "a", newString: "b" } }); }
    catch (e) { thrown = e; }
    ok(thrown === null, "output.args shape: not blocked -> no throw");

    thrown = null;
    try { await hook({ tool: "edit" }, { args: { filePath: "blocked.py", oldString: "a", newString: "b" } }); }
    catch (e) { thrown = e; }
    ok(thrown instanceof Error && thrown.message === "nope: blocked.py", "output.args shape: blocked -> throws with the real reason");

    // args on `input` (the gist's claimed shape) - defensive fallback must
    // ALSO work, since the two sources disagreed and this must not silently
    // no-op under either reading
    thrown = null;
    try { await hook({ tool: "edit", args: { filePath: "blocked.py", oldString: "a", newString: "b" } }, {}); }
    catch (e) { thrown = e; }
    ok(thrown instanceof Error && thrown.message === "nope: blocked.py", "input.args fallback shape: blocked -> still throws (defensive dual-read)");

    if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
    console.log("opencode-guard-adapter self-test: all passed");
    process.exit(0);
  })();
}

const direct = process.argv[1] && process.argv[1].endsWith("opencode-guard-adapter.mjs");
if (direct && process.argv.includes("--selftest")) selftest();
