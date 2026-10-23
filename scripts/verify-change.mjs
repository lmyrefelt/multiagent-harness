#!/usr/bin/env node
/**
 * verify-change — prove a change was developed test-first, from git history.
 *
 * WHY THIS EXISTS
 * A model that writes the implementation and THEN writes passing tests produces
 * an identical final tree to one that did it properly. The only durable evidence
 * is the order of commits. And a commit MESSAGE claiming "tests RED" is worthless
 * on its own — it is a string the model types. So this checks two things that a
 * model cannot fake by asserting them:
 *
 *   1. tests.command is set in change.yaml. An author-asserted RED with no runnable
 *      command is not evidence. (Measured in the PI research: "run the tests before
 *      claiming done" failed 5/5 on prose alone — it has to be mechanical.)
 *   2. The earliest commit that touches a TEST file is not AFTER the earliest commit
 *      that touches an IMPLEMENTATION file (a file in owned_paths that is not a test).
 *      Tests first, or it is not test-first.
 *
 * It is the harness-independent half of the evidence gate — the net for non-PI
 * agents, run from a git pre-push hook. PI agents are additionally held at
 * agent_before_settle by the runtime `evidence_captured` guard (which proves the
 * tests actually ran and passed in that session); see docs/changes/HOW-TO-ADD-A-FEATURE.md.
 *
 *   node scripts/verify-change.mjs [CHANGE-NNNN | --branch <b>] [--run]
 *   node scripts/verify-change.mjs --selftest
 *
 * --run additionally executes tests.command and requires it to pass now (GREEN).
 * Exit: 0 = verified (or not applicable), 1 = not verified / error.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);
const US = String.fromCharCode(31); // unit separator, used as a field marker in git format

// ---------------------------------------------------------------------------
// Pure core — no git, no fs for the parts that matter, so --selftest exercises
// the real logic rather than a copy.
// ---------------------------------------------------------------------------

// A file is a TEST file if it looks like one, regardless of owned_paths.
const TEST_GLOBS = [
  "**/test_*.py", "**/*_test.py", "**/tests/**",
  "**/*.test.ts", "**/*.test.tsx", "**/*.test.js", "**/*.test.jsx", "**/*.test.mjs",
  "**/*.spec.ts", "**/*.spec.tsx", "**/*.spec.js", "**/*.spec.jsx", "**/*.spec.mjs",
  "**/*.feature", "**/features/**",
];

export function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, US)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(US, "g"), ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + re + "$");
}
const anyMatch = (path, globs) => globs.some((g) => globToRe(g).test(path));

export function isTestFile(path) { return anyMatch(path, TEST_GLOBS); }
// A change's own docs folder (change.yaml, discovery, spec, evidence) is always in
// owned_paths but is never implementation: a claim commit that only edits change.yaml
// must not count as "implementation before tests" (CHANGE-0058, LOG.md 2026-10).
// .feature files there are still tests — isTestFile is checked first.
const CHANGE_DOCS = "docs/changes/**";
export function isImplFile(path, ownedPaths) {
  return !isTestFile(path) && !anyMatch(path, [CHANGE_DOCS]) && anyMatch(path, ownedPaths);
}

/**
 * commits: oldest-first array of { sha, subject, files: string[] }.
 * Returns { verdict: "pass"|"fail"|"na", reason, redCommit }.
 */
export function evaluateTestFirst(commits, ownedPaths) {
  const firstTest = commits.findIndex((c) => c.files.some(isTestFile));
  const firstImpl = commits.findIndex((c) => c.files.some((f) => isImplFile(f, ownedPaths)));

  if (firstImpl === -1) {
    return { verdict: "na", reason: "no implementation commits yet — nothing to verify", redCommit: null };
  }
  if (firstTest === -1) {
    return { verdict: "fail", reason: "implementation was committed but no test file was ever added", redCommit: null };
  }
  if (firstTest <= firstImpl) {
    return { verdict: "pass", reason: `tests first (test commit ${firstTest + 1} <= impl commit ${firstImpl + 1})`, redCommit: commits[firstTest] };
  }
  return { verdict: "fail", reason: `implementation (commit ${firstImpl + 1}) landed before any test (commit ${firstTest + 1}) — tests were retrofitted`, redCommit: null };
}

/**
 * Strengthens evaluateTestFirst's commit-ORDER check with real RED evidence,
 * when it exists. evaluateTestFirst can only ever prove a test file was
 * committed before an implementation file — it cannot tell "the test was
 * actually run and failed" from "an empty test file was committed first,
 * then written to pass on the first try." A pi worker's contract-guard
 * extension now logs every test invocation it sees (pass or fail, not just
 * the final passing one — see contract-guard.ts's agent_settled handler) to
 * `.pi-session/<name>/evidence.jsonl` inside the worktree, which survives the
 * container. Reading that log here closes the gap FOR SESSIONS THAT HAVE ONE
 * — a non-pi harness, or a pi session whose evidence file was never created,
 * leaves nothing to check, which is "na", not "fail": this is corroborating
 * evidence where available, not a new hard requirement every change must
 * satisfy (the expensive alternative — replaying history and re-running
 * tests.command at each commit — stays out of scope; see WORKER-GUARDRAILS.md).
 *
 * @param records array of parsed evidence.jsonl objects, OLDEST FIRST.
 * @returns { verdict: "pass"|"fail"|"na", reason }
 */
export function evaluateRedVerified(records) {
  const hits = records.filter((r) => r && r.ev === "test_run");
  if (hits.length === 0) {
    return { verdict: "na", reason: "no test_run evidence found — non-pi harness, or no evidence.jsonl for this session" };
  }
  const firstFail = hits.findIndex((h) => h.passed === false);
  const firstPass = hits.findIndex((h) => h.passed === true);
  if (firstPass === -1) {
    return { verdict: "fail", reason: `test_run evidence exists (${hits.length} run(s)) but none ever recorded a pass` };
  }
  if (firstFail === -1) {
    return { verdict: "fail", reason: "test_run evidence shows the tests only ever passed — no recorded RED, so a real fail-before-fix was never demonstrated" };
  }
  if (firstFail < firstPass) {
    return { verdict: "pass", reason: `real RED observed (run ${firstFail + 1}/${hits.length}) before real GREEN (run ${firstPass + 1}/${hits.length})` };
  }
  return { verdict: "fail", reason: "a pass was recorded before any fail — tests never demonstrated RED first" };
}

/**
 * Sum of every "<N> skipped" count found anywhere in a test run's output.
 * Matches pytest's own summary line and this project's own custom-formatted
 * ones alike (both end in a bare "N skipped" - "41 passed / 27 skipped",
 * "645 passed, 14 skipped, 66 fixture errors", "763 passed, 0 skipped").
 * Summing every match (rather than just the first) is deliberate: a
 * "run twice" qualification's output contains two summaries concatenated,
 * and ANY skip in EITHER run must fail a zero-skip gate, not just the first.
 */
export function extractSkipCount(output) {
  const matches = String(output ?? "").match(/\d+\s*skipped\b/gi) ?? [];
  return matches.reduce((sum, m) => sum + parseInt(m, 10), 0);
}

/** Parse `git log --reverse --name-only --format=<US>%H<US>%s` output. */
export function parseGitLog(raw) {
  const commits = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(US)) {
      const [, sha, subject] = line.split(US);
      cur = { sha, subject: subject ?? "", files: [] };
      commits.push(cur);
    } else if (line.trim() !== "" && cur) {
      cur.files.push(line.trim());
    }
  }
  return commits;
}

/** Narrow reader for the fields we need, including nested tests.command. */
export function readChangeConfig(text) {
  const out = { status: null, base_branch: "main", branch: null, owned_paths: [], tests_command: undefined, zero_skip_required: false, risk_tier: null };
  const lines = text.split(/\r?\n/);
  let inTests = false, inOwned = false, inRisk = false;

  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  const asNull = (v) => (v === "null" || v === "" ? null : v);

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    if (inOwned) {
      const it = raw.match(/^\s+-\s+(.*)$/);
      if (it) { const v = scalar(it[1]); if (v) out.owned_paths.push(v); continue; }
      inOwned = false;
    }
    // nested: command: under tests:
    if (inTests) {
      const sub = raw.match(/^(\s+)([a-zA-Z_]\w*):\s*(.*)$/);
      if (sub && sub[1].length >= 2) {
        if (sub[2] === "command") out.tests_command = asNull(scalar(sub[3]));
        else if (sub[2] === "zero_skip_required") out.zero_skip_required = scalar(sub[3]) === "true";
        continue;
      }
      if (/^\S/.test(raw)) inTests = false; // dedented back to top level
    }
    // nested: tier: under risk: - same pattern as tests: above
    if (inRisk) {
      const sub = raw.match(/^(\s+)([a-zA-Z_]\w*):\s*(.*)$/);
      if (sub && sub[1].length >= 2) {
        if (sub[2] === "tier") out.risk_tier = asNull(scalar(sub[3]));
        continue;
      }
      if (/^\S/.test(raw)) inRisk = false; // dedented back to top level
    }

    const kv = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
    if (kv) {
      const key = kv[1], rest = kv[2];
      if (key === "status") out.status = asNull(scalar(rest));
      else if (key === "base_branch") out.base_branch = scalar(rest) || "main";
      else if (key === "branch") out.branch = asNull(scalar(rest));
      else if (key === "tests") inTests = true;
      else if (key === "risk") inRisk = true;
      else if (key === "owned_paths") { if (scalar(rest) !== "[]") inOwned = true; }
    }
  }
  return out;
}

/**
 * progress: REQ-NNNN-seq -> pending|red|green. Same narrow line-scan pattern
 * as readChangeConfig's owned_paths reader - stop at the first dedent.
 */
export function readProgress(text) {
  const out = {};
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (inBlock) {
      const m = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(\w+)/);
      if (m) { out[m[1]] = m[2]; continue; }
      if (/^\S/.test(raw)) inBlock = false;
    }
    if (/^progress:\s*$/.test(raw)) inBlock = true;
  }
  return out;
}

/** checkpoints: key -> pending|in_progress|complete|partial (partial is observed, not in the enum, and that gap is exactly what this file checks for). */
export function readCheckpoints(text) {
  const out = {};
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (inBlock) {
      const m = raw.match(/^\s+([a-z_]+):\s*(\w+)/);
      if (m) { out[m[1]] = m[2]; continue; }
      if (/^\S/.test(raw)) inBlock = false;
    }
    if (/^checkpoints:\s*$/.test(raw)) inBlock = true;
  }
  return out;
}

/**
 * handover: {from,to,at,summary,verified[],must_do_next[],open_risk} or null
 * if the block is absent entirely. Every scalar is deliberately single-line
 * (no folded `>-`) - same lesson as tests.command, paid once already.
 */
export function readHandover(text) {
  let present = false;
  const out = { from: null, to: null, at: null, summary: null, verified: [], must_do_next: [], open_risk: null };
  let inBlock = false, list = null;
  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (inBlock) {
      if (list) {
        const it = raw.match(/^\s+-\s+(.*)$/);
        if (it) { const v = scalar(it[1]); if (v && v !== "null") out[list].push(v); continue; }
        list = null;
      }
      const sub = raw.match(/^(\s+)([a-zA-Z_]+):\s*(.*)$/);
      if (sub && sub[1].length >= 2) {
        const k = sub[2], v = scalar(sub[3]);
        if (k === "verified" || k === "must_do_next") { list = k; continue; }
        if (k in out && v && v !== "null") out[k] = v;
        continue;
      }
      if (/^\S/.test(raw)) inBlock = false;
    }
    if (/^handover:\s*$/.test(raw)) { inBlock = true; present = true; }
  }
  return present ? out : null;
}

/**
 * Cross-reference progress against checkpoints.green - the exact gap that let
 * CHANGE-0010 report every REQ green while its own checkpoints.green said
 * `partial` (web suite never run). Pure text, no test execution: a claim
 * contradicting the SAME file's own checkpoint is catchable for free.
 *
 * @returns {string[]} REQ ids claimed green despite an incomplete green checkpoint.
 */
export function findProgressContradiction(progress, checkpoints) {
  if (!checkpoints.green || checkpoints.green === "complete") return [];
  return Object.entries(progress).filter(([, v]) => v === "green").map(([k]) => k);
}

/**
 * True if every commit strictly after the one matching `atSha` touches ONLY
 * files under `docsPath` (e.g. "docs/changes/CHANGE-0063-ingest-gateway") - a
 * status update or review note committed after handover does not make the
 * handover itself stale. MEASURED: this false positive hit CHANGE-0063 at
 * integrator rounds 7, 8, AND 11, and CHANGE-0079 round 3 - each one a manual
 * "go verify that intervening commit is docs-only" detour that found nothing,
 * because the checker could not tell "the code changed after handover"
 * (genuinely stale) from "only a review doc landed after handover" (not
 * stale at all). `commits` is the same oldest-first array evaluateTestFirst
 * already consumes - no new git call needed.
 */
export function allCommitsAfterAreDocsOnly(commits, atSha, docsPath) {
  if (!atSha || !docsPath) return false;
  const idx = commits.findIndex((c) => c.sha.startsWith(atSha) || atSha.startsWith(c.sha));
  if (idx === -1) return false; // handover.at isn't in this range at all - can't vouch for anything
  const prefix = docsPath.endsWith("/") ? docsPath : docsPath + "/";
  const after = commits.slice(idx + 1);
  return after.length > 0 && after.every((c) => c.files.every((f) => f.startsWith(prefix)));
}

/**
 * handover shape/freshness problems, or [] if clean. `headSha` is the actual
 * current tip of the change's branch - `at` must match it exactly UNLESS
 * every commit after it only touched this change's own docs folder (see
 * allCommitsAfterAreDocsOnly above) - a prefix match (short sha) counts as
 * exact.
 */
export function checkHandover(handover, headSha, opts = {}) {
  const { commits = [], docsPath = null } = opts;
  const problems = [];
  if (!handover) return ["no handover: block is present"];
  for (const f of ["from", "to", "at", "summary"]) {
    if (!handover[f]) problems.push(`handover.${f} is missing/empty`);
  }
  if (handover.at && headSha && !headSha.startsWith(handover.at)) {
    const tolerated = allCommitsAfterAreDocsOnly(commits, handover.at, docsPath);
    if (!tolerated) {
      problems.push(`handover.at ('${handover.at}') does not match the branch's current tip ('${headSha.slice(0, 8)}') - stale, update it`);
    }
  }
  for (const v of handover.verified) {
    if (!/\s[—-]\s/.test(v)) problems.push(`handover.verified entry has no "claim — how" shape: "${v}"`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function findChangeDir(root, num) {
  const base = join(root, "docs", "changes");
  if (!existsSync(base)) return null;
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && new RegExp(`^CHANGE-0*${num}(\\D|$)`).test(e.name))
    .map((e) => join(base, e.name))
    .find((d) => existsSync(join(d, "change.yaml"))) ?? null;
}
/**
 * Every `.pi-session/<name>/evidence.jsonl` under the worktree root, parsed
 * and merged in actual chronological order — sorted by each record's own `t`
 * (set by contract-guard.ts's log() as Date.now()), NOT by directory name or
 * read order. A relaunched session gets a fresh <name> dir whose name carries
 * no timestamp (it's derived from the launch label, e.g. "harness-change-0044"),
 * so directory iteration order cannot be trusted as chronological — only the
 * records' own timestamps can. Malformed lines are skipped, not fatal — a
 * crashed write mid-line must not take down an otherwise-good check.
 */
export function loadCounters(path, newCounters) {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* fall through to fresh */ }
  }
  return newCounters();
}

export function counterStatePath(prefix, id) {
  const evidence = process.env.CONTRACT_EVIDENCE;
  const dir = evidence ? dirname(evidence) : ".";
  return join(dir, `${prefix}-${id || "default"}.json`);
}

export function readEvidenceRecords(root, listFn = readdirSync, readFn = readFileSync, existsFn = existsSync) {
  const base = join(root, ".pi-session");
  if (!existsFn(base)) return [];
  let names;
  try { names = listFn(base); } catch { return []; }
  const out = [];
  for (const name of names) {
    const p = join(base, name, "evidence.jsonl");
    if (!existsFn(p)) continue;
    let text;
    try { text = readFn(p, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

export const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function fail(msg) { console.error(NL + "  CHANGE NOT VERIFIED" + NL); console.error(msg.replace(/^/gm, "  ")); console.error(""); process.exit(1); }
function okExit(msg) { console.log("  verify-change: " + msg); process.exit(0); }

function main() {
  const args = process.argv.slice(2);
  const run = args.includes("--run");
  const root = sh("git rev-parse --show-toplevel").trim();
  const branchArg = args.includes("--branch") ? args[args.indexOf("--branch") + 1] : null;
  // symbolic-ref reads the ref name without needing a commit to exist yet, so
  // it still works on a brand-new repo's first commit (unborn HEAD) - unlike
  // `rev-parse --abbrev-ref HEAD`, which throws in that state. Fall back to
  // rev-parse for the one case symbolic-ref can't handle: detached HEAD.
  const currentBranch = () => {
    try { return sh("git symbolic-ref --short HEAD").trim(); }
    catch { try { return sh("git rev-parse --abbrev-ref HEAD").trim(); } catch { return "HEAD"; } }
  };
  const branch = branchArg || currentBranch();

  let num = (args.find((a) => /^CHANGE-\d+$/i.test(a)) || "").replace(/\D+/g, "");
  if (!num) { const m = branch.match(/CHANGE-0*(\d+)/i); num = m ? m[1] : ""; }
  if (!num) okExit(`branch "${branch}" is not a change branch — nothing to verify`);

  const dir = findChangeDir(root, num);
  if (!dir) fail(`no docs/changes/CHANGE-${num}-*/change.yaml found for branch "${branch}".`);

  const yamlText = readFileSync(join(dir, "change.yaml"), "utf8");
  const cfg = readChangeConfig(yamlText);

  if (cfg.tests_command == null) {
    fail(
      `CHANGE-${num}: tests.command is null.` + NL +
      `An author-asserted RED is not evidence. Set tests.command in change.yaml to the` + NL +
      `command that runs this change's tests before any implementation is pushed.`
    );
  }

  // Pure text cross-reference, no test execution: a REQ cannot be claimed
  // green while the change's own green checkpoint says otherwise. This is
  // exactly the gap that let CHANGE-0010 report every REQ green while
  // checkpoints.green said `partial` (the web suite had never actually run),
  // undetected until someone happened to run the tests by hand.
  const progress = readProgress(yamlText);
  const checkpoints = readCheckpoints(yamlText);
  const contradicting = findProgressContradiction(progress, checkpoints);
  if (contradicting.length) {
    fail(
      `CHANGE-${num}: progress claims green for ${contradicting.join(", ")}, but checkpoints.green is ` +
      `'${checkpoints.green}' (not complete).` + NL +
      `A requirement cannot be green while the change's own checkpoint says the green phase is not done.` + NL +
      `Fix whichever one is actually true before this goes further.`
    );
  }

  // Computed early (not just before evaluateTestFirst, as before) so the
  // handover check below can also use it - it needs the same commit/file
  // history to tell "code landed after handover" from "only a review doc did".
  const range = `${cfg.base_branch}..${branch}`;
  let raw;
  try { raw = sh(`git log --reverse --name-only --format=${US}%H${US}%s ${range}`); }
  catch { fail(`cannot read git history for ${range}.`); }
  const commits = parseGitLog(raw);

  // handover: required once the change has reached review/complete - see
  // docs/changes/README.md. Checked here, not just documented, because a
  // convention nobody enforces is not durably different from no convention.
  if (["review", "complete"].includes(cfg.status)) {
    const headSha = sh(`git rev-parse ${branch}`).trim();
    const handover = readHandover(yamlText);
    const docsPath = relative(root, dir).replace(/\\/g, "/");
    const problems = checkHandover(handover, headSha, { commits, docsPath });
    if (problems.length) {
      fail(
        `CHANGE-${num}: status is '${cfg.status}' but its handover: block has problems:` + NL +
        problems.map((p) => `  - ${p}`).join(NL) + NL +
        `See docs/changes/README.md's "handover" section for the required shape.`
      );
    }
  }

  const r = evaluateTestFirst(commits, cfg.owned_paths);
  if (r.verdict === "fail") fail(`CHANGE-${num} is not test-first: ${r.reason}.` + NL + `Never make a failing test green by writing the code first and the test after.`);
  if (r.verdict === "na") { console.log(`  verify-change: CHANGE-${num} — ${r.reason}.`); }
  else console.log(`  verify-change: CHANGE-${num} test-first OK — ${r.reason}` + (r.redCommit ? ` [RED ${r.redCommit.sha.slice(0, 8)}]` : ""));

  // Corroborating evidence, where it exists — see evaluateRedVerified's header.
  // Advisory only: "na" (no evidence file at all) must never block a push —
  // most harnesses, and even most pi sessions, won't have left one.
  try {
    const records = readEvidenceRecords(root);
    const rv = evaluateRedVerified(records);
    if (rv.verdict === "fail") {
      fail(`CHANGE-${num}: a pi session's own evidence log contradicts test-first: ${rv.reason}.` + NL +
        `Commit order alone said "test-first OK" above, but the harness's recorded test runs show otherwise.`);
    } else {
      console.log(`  verify-change: red-verified — ${rv.reason}.`);
    }
  } catch (e) { console.log(`  verify-change: red-verified check skipped (${e.message}).`); }

  if (run) {
    console.log(`  running tests.command to confirm GREEN: ${cfg.tests_command}`);
    let out;
    try { out = sh(cfg.tests_command); }
    catch (e) { fail(`tests.command did not pass at HEAD:` + NL + ((e.stdout || "") + (e.stderr || "")).split(NL).filter(Boolean).slice(-6).join(NL)); }
    console.log("  tests pass at HEAD (GREEN).");

    // MEASURED: the dominant "false completion" round across real reviews was
    // never a wrong command - it was a run reporting skips credited as if it
    // satisfied a zero-skip gate ("41 passed / 27 skipped... it is not
    // resolved", CHANGE-0063/integrator-review-7.md). exited-zero + "tests
    // pass" is not the same claim as "zero failures/errors/skips" - only
    // tests.zero_skip_required opts a change into this stricter bar, since
    // plenty of legitimate runs skip something (a platform-gated test, a
    // service-dependent suite) without that meaning anything is wrong.
    if (cfg.zero_skip_required) {
      const skips = extractSkipCount(out);
      if (skips > 0) {
        fail(
          `CHANGE-${num}: tests.zero_skip_required is true, but this run reported ${skips} skipped test(s).` + NL +
          `A run with skips does not satisfy a zero-skip qualification gate - exit 0 only means` + NL +
          `nothing FAILED, not that nothing was SKIPPED. Re-run in an environment where every` + NL +
          `declared service is actually available, or use run-qualification.sh if one exists` + NL +
          `for this change.`
        );
      }
      console.log("  zero_skip_required satisfied — 0 skipped.");
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
  const owned = ["apps/api/src/harness/war_room/**", "apps/api/tests/war_room/**"];

  ok(isTestFile("apps/api/tests/war_room/test_lifecycle.py"), "test_ file is a test");
  ok(isTestFile("apps/web/src/components/triage/v2/AiSummary.test.tsx"), ".test.tsx file is a test");
  ok(isTestFile("docs/changes/CHANGE-0043-war-room/features/x.feature"), ".feature is a test");
  ok(!isTestFile("apps/api/src/harness/war_room/service.py"), "service.py is not a test");
  ok(isImplFile("apps/api/src/harness/war_room/service.py", owned), "service in owned is impl");
  ok(!isImplFile("apps/api/tests/war_room/test_x.py", owned), "test in owned is NOT impl");
  ok(!isImplFile("apps/web/src/page.tsx", owned), "file outside owned is not impl");
  // a real change always owns its own docs folder; that folder is never implementation
  const ownedWithDocs = [...owned, "docs/changes/CHANGE-0043-war-room/**"];
  ok(!isImplFile("docs/changes/CHANGE-0043-war-room/change.yaml", ownedWithDocs), "own change.yaml is NOT impl");
  ok(isTestFile("docs/changes/CHANGE-0043-war-room/features/x.feature"), "own .feature still a test");
  ok(evaluateTestFirst([
    { sha: "claim", subject: "", files: ["docs/changes/CHANGE-0043-war-room/change.yaml"] },
    { sha: "red", subject: "", files: ["apps/api/tests/war_room/test_x.py"] },
    { sha: "impl", subject: "", files: ["apps/api/src/harness/war_room/service.py"] },
  ], ownedWithDocs).verdict === "pass", "claim-only change.yaml commit before RED passes");
  ok(evaluateTestFirst([
    { sha: "claim", subject: "", files: ["docs/changes/CHANGE-0043-war-room/change.yaml"] },
    { sha: "impl", subject: "", files: ["apps/api/src/harness/war_room/service.py"] },
    { sha: "red", subject: "", files: ["apps/api/tests/war_room/test_x.py"] },
  ], ownedWithDocs).verdict === "fail", "claim, then impl before test, still fails");

  const C = (sha, files) => ({ sha, subject: "", files });
  // tests first -> pass
  let r = evaluateTestFirst([
    C("aaa", ["apps/api/tests/war_room/test_lifecycle.py"]),
    C("bbb", ["apps/api/src/harness/war_room/service.py"]),
  ], owned);
  ok(r.verdict === "pass" && r.redCommit.sha === "aaa", "tests-first passes, red=first test commit");
  // impl first -> fail
  r = evaluateTestFirst([
    C("aaa", ["apps/api/src/harness/war_room/service.py"]),
    C("bbb", ["apps/api/tests/war_room/test_lifecycle.py"]),
  ], owned);
  ok(r.verdict === "fail", "impl-before-test fails");
  // impl, no tests -> fail
  r = evaluateTestFirst([C("aaa", ["apps/api/src/harness/war_room/service.py"])], owned);
  ok(r.verdict === "fail", "impl with no tests fails");
  // nothing implemented yet -> na
  r = evaluateTestFirst([C("aaa", ["docs/changes/CHANGE-0043-war-room/change.yaml"])], owned);
  ok(r.verdict === "na", "no impl yet -> n/a");
  // same commit has both (test + impl together) -> firstTest==firstImpl -> pass
  r = evaluateTestFirst([C("aaa", ["apps/api/tests/war_room/test_x.py", "apps/api/src/harness/war_room/s.py"])], owned);
  ok(r.verdict === "pass", "test+impl same commit passes (test<=impl)");

  // reader: nested tests.command + owned_paths + null
  const cfg = readChangeConfig([
    "status: in_progress",
    "base_branch: main",
    "branch: feature/CHANGE-0043-war-room",
    "owned_paths:",
    '  - "apps/api/src/harness/war_room/**"',
    "tests:",
    '  command: "pytest apps/api/tests/war_room -q"',
    "  red_commit_required: true",
    "non_goals:",
    "  - something",
  ].join(NL));
  ok(cfg.tests_command === "pytest apps/api/tests/war_room -q", "reads nested tests.command");
  ok(cfg.owned_paths.length === 1, "reads owned_paths, stops at dedent");
  ok(cfg.branch === "feature/CHANGE-0043-war-room", "reads branch");
  const cfg2 = readChangeConfig(["tests:", "  command: null", "status: draft"].join(NL));
  ok(cfg2.tests_command === null, "null command -> null");

  // parseGitLog
  const g = parseGitLog([US + "aaa" + US + "add failing tests", "tests/test_x.py", "", US + "bbb" + US + "impl", "src/x.py"].join(NL));
  ok(g.length === 2 && g[0].sha === "aaa" && g[0].files[0] === "tests/test_x.py" && g[1].files[0] === "src/x.py", "parseGitLog splits commits + files");

  // readProgress / readCheckpoints
  const prog = readProgress([
    "progress:", "  REQ-0010-001: green", "  REQ-0010-002: red", "spec_refs:", "  - docs/x.md",
  ].join(NL));
  ok(prog["REQ-0010-001"] === "green" && prog["REQ-0010-002"] === "red" && Object.keys(prog).length === 2,
    "readProgress reads REQ:status pairs, stops at dedent");
  const cp = readCheckpoints([
    "checkpoints:", "  discovery: complete", "  green: partial", "  review: pending",
  ].join(NL));
  ok(cp.green === "partial" && cp.discovery === "complete" && cp.review === "pending", "readCheckpoints reads key:status pairs");

  // readHandover
  ok(readHandover(["status: draft", "branch: null"].join(NL)) === null, "readHandover: absent block -> null");
  const h = readHandover([
    "handover:",
    "  from: worker", "  to: integrator", "  at: 8461ae33",
    '  summary: "backend green, web not run"',
    "  verified:",
    '    - "unit 27/27 green — pytest run, commit 8461ae33"',
    '    - "web suite NOT run — no node_modules in sandbox"',
    "  must_do_next:", '    - "mount the router"',
    '  open_risk: "integration suite unverified"',
    "non_goals:", "  - x",
  ].join(NL));
  ok(h.from === "worker" && h.to === "integrator" && h.at === "8461ae33", "readHandover reads scalars");
  ok(h.verified.length === 2 && h.must_do_next.length === 1, "readHandover reads both lists, stops at dedent");
  ok(h.open_risk === "integration suite unverified", "readHandover reads the field AFTER a list (list-termination works)");

  // findProgressContradiction — the exact CHANGE-0010 shape
  ok(findProgressContradiction({ "REQ-1": "green", "REQ-2": "green" }, { green: "partial" }).length === 2,
    "REGRESSION: all-green progress with checkpoints.green=partial is flagged (the CHANGE-0010 bug)");
  ok(findProgressContradiction({ "REQ-1": "green" }, { green: "complete" }).length === 0,
    "no contradiction once checkpoints.green is actually complete");
  ok(findProgressContradiction({ "REQ-1": "red" }, { green: "pending" }).length === 0,
    "no contradiction when nothing is claimed green yet");

  // checkHandover
  ok(checkHandover(null, "abc12345").length === 1, "missing handover: block is one problem");
  ok(checkHandover({ from: "worker", to: "", at: "x", summary: "s", verified: [] }, "x").length === 1,
    "missing `to` is flagged");
  ok(checkHandover({ from: "w", to: "i", at: "abc123", summary: "s", verified: [] }, "abc123def456").length === 0,
    "short-sha `at` matching the full HEAD sha is NOT stale (prefix match)");
  ok(checkHandover({ from: "w", to: "i", at: "deadbee", summary: "s", verified: [] }, "abc123def456").length === 1,
    "REGRESSION: a non-matching `at` is flagged stale (the CHANGE-0010/0014 staleness bug)");
  ok(checkHandover({ from: "w", to: "i", at: "abc", summary: "s", verified: ["green — ran it"] }, "abc").length === 0,
    "a verified entry with a claim — how shape passes");
  ok(checkHandover({ from: "w", to: "i", at: "abc", summary: "s", verified: ["just green, no evidence"] }, "abc").length === 1,
    "a bare claim with no 'how' is flagged");

  // allCommitsAfterAreDocsOnly / checkHandover's docs-only tolerance
  const docsPath = "docs/changes/CHANGE-0063-ingest-gateway";
  const C2 = (sha, files) => ({ sha, subject: "", files });
  const commitsDocsOnlyAfter = [
    C2("aaa111", ["apps/api/src/harness/store.py"]),
    C2("bbb222", [`${docsPath}/integrator-review-7.md`]),
    C2("ccc333", [`${docsPath}/change.yaml`]),
  ];
  ok(allCommitsAfterAreDocsOnly(commitsDocsOnlyAfter, "aaa111", docsPath) === true,
    "REGRESSION (CHANGE-0063 rounds 7/8/11, CHANGE-0079 round 3): commits after handover.at that only touch this change's own docs folder are tolerated");
  ok(checkHandover({ from: "w", to: "i", at: "aaa111", summary: "s", verified: [] }, "ccc333",
    { commits: commitsDocsOnlyAfter, docsPath }).length === 0,
    "checkHandover itself is no longer stale when only docs-only commits follow handover.at");

  const commitsCodeAfter = [
    C2("aaa111", ["apps/api/src/harness/store.py"]),
    C2("bbb222", [`${docsPath}/integrator-review-7.md`]),
    C2("ccc333", ["apps/api/src/harness/service.py"]), // a REAL code change after handover
  ];
  ok(allCommitsAfterAreDocsOnly(commitsCodeAfter, "aaa111", docsPath) === false,
    "REGRESSION: a genuine code commit after handover.at is NOT tolerated - still flagged stale");
  ok(checkHandover({ from: "w", to: "i", at: "aaa111", summary: "s", verified: [] }, "ccc333",
    { commits: commitsCodeAfter, docsPath }).length === 1,
    "checkHandover still fails closed when real code landed after handover, not just docs");

  ok(allCommitsAfterAreDocsOnly([C2("aaa111", ["x.py"])], "zzz999", docsPath) === false,
    "handover.at not found in the commit range at all -> not tolerated, fails closed rather than guessing");
  ok(allCommitsAfterAreDocsOnly([C2("aaa111", ["x.py"])], "aaa111", docsPath) === false,
    "no commits at all after handover.at -> nothing to tolerate (checkHandover wouldn't even reach this branch, since headSha would already match)");
  ok(checkHandover({ from: "w", to: "i", at: "abc", summary: "s", verified: [] }, "deadbee", {}).length === 1,
    "no commits/docsPath passed at all (old call shape) still fails closed exactly like before - the fix is additive, not a behaviour change by default");

  // extractSkipCount
  ok(extractSkipCount("763 passed, 0 skipped in 44.07s") === 0, "zero skipped is parsed as zero, not a false positive");
  ok(extractSkipCount("41 passed / 27 skipped") === 27, "REGRESSION (CHANGE-0063 review-7): this project's own custom summary format is parsed");
  ok(extractSkipCount("645 passed, 14 skipped, 66 fixture errors") === 14, "a pytest-style summary with extra trailing text is parsed");
  ok(extractSkipCount("run 1: 10 passed, 2 skipped\nrun 2: 10 passed, 0 skipped") === 2,
    "a two-run qualification output sums skips across BOTH runs, not just the first match");
  ok(extractSkipCount("763 passed") === 0, "no 'skipped' mention at all -> zero, not NaN or a crash");
  ok(extractSkipCount(null) === 0, "null output does not crash extractSkipCount");

  // readChangeConfig's new zero_skip_required field
  ok(readChangeConfig("tests:\n  command: pytest\n  zero_skip_required: true\n").zero_skip_required === true,
    "zero_skip_required: true is read from the nested tests: block");
  ok(readChangeConfig("tests:\n  command: pytest\n").zero_skip_required === false,
    "zero_skip_required defaults to false when absent, same as red_commit_required's own opt-in shape");
  ok(readChangeConfig("tests:\n  command: pytest\n  zero_skip_required: false\n").zero_skip_required === false,
    "zero_skip_required: false is read explicitly, not just defaulted");

  // readChangeConfig's new risk_tier field - same nested-block pattern as tests:
  ok(readChangeConfig("risk:\n  tier: high\n  touches_authorization: true\n").risk_tier === "high",
    "risk.tier is read from the nested risk: block");
  ok(readChangeConfig("status: draft\n").risk_tier === null, "risk_tier defaults to null when the risk: block is absent entirely");
  ok(readChangeConfig("risk:\n  tier: low\ntests:\n  command: pytest\n").risk_tier === "low",
    "REGRESSION: the risk: block correctly dedents back to top level before tests: starts, same two-block-in-one-file shape every real change.yaml has");

  // evaluateRedVerified
  ok(evaluateRedVerified([]).verdict === "na", "no evidence records at all -> na, not fail");
  ok(evaluateRedVerified([{ ev: "run_summary" }, { ev: "violation" }]).verdict === "na",
    "evidence file present but no test_run records -> na");
  ok(evaluateRedVerified([
    { ev: "test_run", passed: false }, { ev: "test_run", passed: true },
  ]).verdict === "pass", "fail then pass -> real RED verified");
  ok(evaluateRedVerified([
    { ev: "test_run", passed: true },
  ]).verdict === "fail", "REGRESSION: only-ever-passed test_run evidence must fail, not na — this is exactly the gap (empty test committed first, written to pass immediately) that commit-order alone cannot see");
  ok(evaluateRedVerified([
    { ev: "test_run", passed: true }, { ev: "test_run", passed: false },
  ]).verdict === "fail", "pass before fail -> fail (RED never came first)");
  ok(evaluateRedVerified([
    { ev: "test_run", passed: false }, { ev: "test_run", passed: false },
  ]).verdict === "fail", "never recorded a pass at all -> fail");

  // readEvidenceRecords — fake fs, no real disk I/O
  {
    const fakeExists = (p) => p.endsWith(".pi-session") || p.endsWith("evidence.jsonl");
    const fakeList = () => ["sess-a", "sess-b"];
    const fakeRead = (p) => p.includes("sess-a")
      ? [JSON.stringify({ ev: "test_run", passed: false, t: 200 }), JSON.stringify({ ev: "test_run", passed: true, t: 300 })].join(NL)
      : JSON.stringify({ ev: "test_run", passed: true, t: 100 }) + NL + "{not json" + NL;
    const recs = readEvidenceRecords("/fake/root", fakeList, fakeRead, fakeExists);
    ok(recs.length === 3, "readEvidenceRecords merges across session dirs and skips malformed lines");
    ok(recs[0].t === 100 && recs[1].t === 200 && recs[2].t === 300,
      "readEvidenceRecords sorts by record timestamp, not directory/read order");
  }
  {
    const recs = readEvidenceRecords("/fake/root", () => [], () => "", () => false);
    ok(recs.length === 0, "readEvidenceRecords returns [] when .pi-session doesn't exist");
  }

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("verify-change self-test: all passed");
  process.exit(0);
}

// Guard like every other script in scripts/ (compile-*.mjs, board.mjs,
// check-change-overlap.mjs) - without it, importing this file's exported
// readers (as change-diff.mjs does) ALSO runs main()/selftest() as a side
// effect of the import, process.exit()ing before the importer's own code
// ever runs. MEASURED: change-diff.mjs --selftest silently ran and exited
// on THIS file's selftest output instead of its own.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("verify-change.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
