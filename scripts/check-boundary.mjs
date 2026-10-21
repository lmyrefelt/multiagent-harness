#!/usr/bin/env node
/**
 * check-boundary — stop an agent editing outside the files its change is allowed to touch.
 *
 * WHY THIS EXISTS
 * A change declares `owned_paths` in its change.yaml. That is the boundary. Inside
 * PI, the boundary is enforced at tool_call automatically. Outside PI (Copilot,
 * Antigravity, a plain editor) nothing enforces it — and that is how a repository
 * fills up with files nobody meant to touch. This script is the harness-independent
 * net: it runs from a git pre-commit hook, on your own machine, no CI required.
 *
 * WHAT IT DOES
 *   - Works out which change you are on from the branch name: feature/CHANGE-NNNN-...
 *   - Reads that change's owned_paths from its docs/changes/CHANGE-NNNN-<slug> folder
 *   - Blocks the commit if any staged file is outside owned_paths (the change may
 *     always edit its own change folder).
 *
 * It deliberately does NOTHING (exit 0) when you are not on a feature/CHANGE branch,
 * so ordinary work is never in its way.
 *
 * FAIL CLOSED: any error it cannot understand blocks the commit rather than waving
 * it through. A net that fails open is not a net.
 *
 *   node scripts/check-boundary.mjs              # check staged files on current branch
 *   node scripts/check-boundary.mjs --selftest   # run built-in tests, exit 0/1
 *
 * Exit: 0 = allowed (or not applicable), 1 = blocked / error.
 */

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const NUL = String.fromCharCode(0);
const SP = String.fromCharCode(32);

// The planner (docs-only spec/research role) may write ONLY the spec surface.
// This is a fixed boundary, not read from a change.yaml, because a planner works
// across many changes at once rather than inside one. See docs/changes/COORDINATION.md.
const PLANNER_OWNED = ["docs/changes/**", "docs/decisions/**"];

// ---------------------------------------------------------------------------
// Tiny, deliberately narrow reader for the one shape change.yaml uses:
//   key: scalar
//   key:
//     - item        # inline comments allowed
//     - "quoted/item/**"
// It is not a general YAML parser. It understands exactly the fields this script
// needs (status, owned_paths, forbidden_paths) and nothing else. Anything it
// cannot read is an error, and errors block.
// ---------------------------------------------------------------------------
function readChangeFields(text) {
  const lines = text.split(/\r?\n/);
  const out = { status: null, owned_paths: [], forbidden_paths: [] };
  let listKey = null; // which list we are currently collecting into

  // Parse one scalar: a quoted string keeps its exact content and any trailing
  // inline comment is ignored; an unquoted value drops a trailing " #..." comment.
  const parseScalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, 1);
      return end > 0 ? s.slice(1, end) : s.slice(1);
    }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    // a list item under the current list key
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      const v = parseScalar(item[1]);
      if (v !== "") out[listKey].push(v);
      continue;
    }

    // a top-level key
    const kv = raw.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rest = kv[2].trim();
      listKey = null;
      if (key === "status") out.status = parseScalar(rest) || null;
      else if (key === "owned_paths" || key === "forbidden_paths") {
        if (rest === "[]") { /* empty inline list */ }
        else if (rest === "") listKey = key; // block list follows
        // (inline non-empty lists are not used by our changes; ignore)
      }
      continue;
    }
    // any other indented content we simply skip; it is not a field we read
  }
  return out;
}

// glob -> anchored RegExp.  ** = any run incl. '/', * = run with no '/', ? = one char.
function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, SP)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(SP, "g"), ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + re + "$");
}

function findChangeDir(root, num) {
  const base = join(root, "docs", "changes");
  if (!existsSync(base)) return null;
  const hit = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && new RegExp(`^CHANGE-0*${num}(\\D|$)`).test(e.name))
    .map((e) => join(base, e.name))
    .find((d) => existsSync(join(d, "change.yaml")));
  return hit ?? null;
}

// Object id of a rev/blob spec (e.g. "MERGE_HEAD", ":path", "<sha>:path"), or null if absent.
function gitRef(spec) {
  try {
    return execFileSync("git", ["rev-parse", "-q", "--verify", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function isAncestor(commit, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A staged path was taken verbatim from the merged-in base when its staged blob equals
// the base's blob, or when it is absent from both (a deletion taken from the base).
function takenVerbatim(stagedBlob, baseBlob) {
  return stagedBlob === baseBlob;
}

function fail(msg) {
  console.error("\n  BOUNDARY CHECK BLOCKED THIS COMMIT\n");
  console.error(msg.replace(/^/gm, "  "));
  console.error("");
  process.exit(1);
}

// ---------------------------------------------------------------------------
function main() {
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  // symbolic-ref reads the ref name without needing a commit to exist yet, so
  // it still works on a brand-new repo's first commit (unborn HEAD) - unlike
  // `rev-parse --abbrev-ref HEAD`, which throws in that state. Fall back to
  // rev-parse for the one case symbolic-ref can't handle: detached HEAD.
  let branch;
  try {
    branch = execSync("git symbolic-ref --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    } catch {
      branch = "HEAD";
    }
  }

  const stagedFiles = () => execSync("git diff --cached --name-only -z", { encoding: "utf8" })
    .split(NUL).filter(Boolean);

  // Planner lane: a docs-only spec/research agent works on a planning/* branch
  // (planning/... or plan/...). It may only touch the spec surface — never code,
  // compose, scripts or hooks. Enforced here so it holds for ANY agent or editor
  // (Gemini, Astra, Copilot, pi), not only the pi worker.
  if (/^plan(?:ning)?\//i.test(branch)) {
    let files = stagedFiles();
    // Catching a planner branch up with main can stage application files that
    // the planner did not author. Exempt only entries byte-identical to the
    // merged-in base; conflicts the planner resolved remain subject to the
    // docs-only boundary. This preserves the same guard semantics as a normal
    // planner diff while allowing the merge commit itself to carry main's tree.
    const mergeHead = gitRef("MERGE_HEAD");
    if (mergeHead && isAncestor(mergeHead, "main")) {
      files = files.filter((f) => !takenVerbatim(gitRef(":" + f), gitRef(mergeHead + ":" + f)));
    }
    if (files.length === 0) process.exit(0);
    const allow = PLANNER_OWNED.map(globToRe);
    const outside = files.filter((f) => !allow.some((re) => re.test(f)));
    if (outside.length) {
      fail(
        `Branch "${branch}" is a PLANNER (docs-only) branch. These staged files are\n` +
        `outside the spec lane:\n` +
        outside.map((f) => `  - ${f}`).join("\n") + "\n\n" +
        `A planner may only write specs:\n` +
        PLANNER_OWNED.map((p) => `  - ${p}`).join("\n") + "\n\n" +
        `Code, compose, scripts and hooks belong to a WORKER on a feature/CHANGE-NNNN\n` +
        `branch, not to planning. See docs/changes/COORDINATION.md.`
      );
    }
    process.exit(0);
  }

  const m = branch.match(/^feature\/CHANGE-0*(\d+)/i);
  if (!m) process.exit(0); // not a change branch — not our business

  const num = m[1];
  const dir = findChangeDir(root, num);
  if (!dir) {
    fail(
      `Branch is "${branch}" but no docs/changes/CHANGE-${num}-*/change.yaml was found.\n` +
      `Every feature/CHANGE-NNNN branch must have a matching change folder that declares\n` +
      `what it is allowed to touch. Create it, or rename the branch.`
    );
  }

  let fields;
  try {
    fields = readChangeFields(readFileSync(join(dir, "change.yaml"), "utf8"));
  } catch (e) {
    fail(`Could not read ${join(dir, "change.yaml")}: ${e.message}`);
  }

  const owned = fields.owned_paths;

  if (owned.some((p) => /<[^>]+>/.test(p))) {
    fail(
      `${dir}/change.yaml still has placeholder paths (e.g. "<backend>/...").\n` +
      `A boundary you cannot name is not a boundary. Fill owned_paths with the real\n` +
      `repository paths (from Phase 0 discovery) before committing implementation.`
    );
  }

  if (owned.length === 0) {
    console.error(
      `  check-boundary: ${dir} declares no owned_paths yet — not enforcing.\n` +
      `  (Fill owned_paths before implementation so this net can protect you.)`
    );
    process.exit(0);
  }

  let staged = execSync("git diff --cached --name-only -z", { encoding: "utf8" })
    .split(NUL).filter(Boolean);

  // Conflicted merge of the base branch into this feature branch (the launcher's
  // catch-up merge, resolved by hand). Files staged byte-identical to MERGE_HEAD's
  // version came from the base verbatim and were not authored here, so drop them.
  // Every file this branch resolved or changed is still checked. Only applies when
  // MERGE_HEAD is already contained in the base branch, not to merging another feature.
  const mergeHead = gitRef("MERGE_HEAD");
  if (mergeHead) {
    const yaml = readFileSync(join(dir, "change.yaml"), "utf8");
    const base = (yaml.match(/^base_branch:\s*([^\s#]+)/m) || [])[1] || "main";
    if (isAncestor(mergeHead, base)) {
      staged = staged.filter((f) => !takenVerbatim(gitRef(":" + f), gitRef(mergeHead + ":" + f)));
    }
  }
  if (staged.length === 0) process.exit(0);

  // The change may always edit its own folder.
  const selfDir = dir.slice(root.length + 1).replace(/\\/g, "/") + "/**";
  const allow = [...owned, selfDir].map(globToRe);

  const outside = staged.filter((f) => !allow.some((re) => re.test(f)));
  if (outside.length) {
    fail(
      `These staged files are OUTSIDE change CHANGE-${num}'s declared boundary:\n` +
      outside.map((f) => `  - ${f}`).join("\n") + "\n\n" +
      `Allowed (owned_paths):\n` +
      owned.map((p) => `  - ${p}`).join("\n") + "\n\n" +
      `Either: (a) this file genuinely belongs to this change — add its path to\n` +
      `owned_paths in change.yaml and get the boundary re-approved; or (b) it belongs\n` +
      `to different work — that is a SEPARATE change, not this one. Do not widen the\n` +
      `boundary silently.`
    );
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Built-in tests. Negative cases are permanent tests, not comments:
// a boundary checker is only as trustworthy as the violations it has been shown.
// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (cond, name) => { if (!cond) { console.error("FAIL: " + name); fails++; } };
  const nl = String.fromCharCode(10);

  // reader
  const f = readChangeFields(
    [
      "id: CHANGE-0007",
      "status: in_progress   # active",
      "owned_paths:",
      '  - "apps/api/src/harness/war_room/**"   # the module',
      "  - apps/api/tests/war_room/**",
      "forbidden_paths: []",
    ].join(nl)
  );
  ok(f.status === "in_progress", "reads scalar with inline comment");
  ok(f.owned_paths.length === 2, "reads two owned_paths");
  ok(f.owned_paths[0] === "apps/api/src/harness/war_room/**", "unquotes + strips comment");
  ok(f.forbidden_paths.length === 0, "inline empty list stays empty");

  const g = readChangeFields(["owned_paths: []", "status: draft"].join(nl));
  ok(g.owned_paths.length === 0 && g.status === "draft", "inline [] owned_paths");

  // glob matching — positive AND negative
  const re = globToRe("apps/api/src/harness/war_room/**");
  ok(re.test("apps/api/src/harness/war_room/service.py"), "** matches nested");
  ok(re.test("apps/api/src/harness/war_room/sub/deep.py"), "** matches deep");
  ok(!re.test("apps/api/src/harness/triage_v2/store.py"), "** does NOT match sibling module");
  ok(!re.test("apps/web/src/app/page.tsx"), "** does NOT match other app");

  const star = globToRe("docs/changes/*.md");
  ok(star.test("docs/changes/README.md"), "* matches one segment");
  ok(!star.test("docs/changes/CHANGE-1/spec.md"), "* does not cross '/'");

  ok(/<[^>]+>/.test("<backend>/domain/**"), "placeholder detected");

  // planner lane — docs only, positive AND negative
  const pc = globToRe("docs/changes/**");
  const pd = globToRe("docs/decisions/**");
  ok(pc.test("docs/changes/CHANGE-0012-foo/change.yaml"), "planner may write a change folder");
  ok(pd.test("docs/decisions/ADR-010-x.md"), "planner may write an ADR");
  ok(!pc.test("apps/api/src/harness/x.py") && !pd.test("apps/api/src/harness/x.py"), "planner may NOT write code");
  ok(!pc.test("compose.yaml") && !pd.test("scripts/launch-worker.sh"), "planner may NOT write compose/scripts");

  // merge-from-base filter: only verbatim base content is exempt
  ok(takenVerbatim("abc123", "abc123"), "file identical to the merged-in base is exempt");
  ok(takenVerbatim(null, null), "deletion taken from the base is exempt");
  ok(!takenVerbatim("abc123", "def456"), "a hand-resolved file (differs from base) is still checked");
  ok(!takenVerbatim("abc123", null), "a file the base does not have is still checked");
  ok(!takenVerbatim(null, "def456"), "deleting a file the base keeps is still checked");

  if (fails) { console.error(nl + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("check-boundary self-test: all passed");
  process.exit(0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
