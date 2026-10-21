#!/usr/bin/env node
//
// repo-health — a doctor pass over exactly the failure classes that cost real
// time THIS session, checked proactively instead of discovered by forensics:
//
//   - orphaned .worktrees/* directories (a dead gitdir registration, found by
//     hand, repeatedly, via hash-comparing directories against branch tips -
//     this now takes one command)
//   - feature/CHANGE-* branches fully merged into main but never deleted
//   - a stale or long-held integrator lock
//   - any change whose status is review/complete but whose handover: block
//     is missing, incomplete, or stale (the repo-wide sweep version of the
//     single-change check verify-change.mjs already does at push time)
//
// Reports only - never deletes or resets anything. Every fix this session
// for these classes was a judgment call (what's safe to remove, what's
// genuinely unique work); this tool's job is to make that judgment call
// CHEAP to start, not to make it automatically.
//
//   node scripts/repo-health.mjs
//   node scripts/repo-health.mjs --selftest
//
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { readChangeConfig, readHandover, checkHandover } from "./verify-change.mjs";

const NL = String.fromCharCode(10);
const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Resolve a worktree's `.git` pointer file to the gitdir it claims, relative
 * to the worktree's own directory (the same relative-gitdir convention
 * launch-worker.sh/launch-planner.sh write). Returns null if there's no .git
 * file at all (not a worktree - plain leftover directory).
 */
export function resolveGitdir(worktreeDir, gitFileContent) {
  const m = gitFileContent.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const target = m[1].trim();
  return target.startsWith("/") ? target : resolve(worktreeDir, target);
}

/** Pure check: given a worktree dir's .git content (or null if absent) and whether the resolved gitdir exists, classify it. */
export function classifyWorktree(gitFileContent, gitdirExists) {
  if (gitFileContent === null) return "not-a-worktree";
  if (gitdirExists === null) return "no-gitdir-line"; // .git exists but doesn't look like a worktree pointer
  return gitdirExists ? "live" : "orphaned";
}

function findOrphanedWorktrees(root) {
  const base = join(root, ".worktrees");
  const findings = [];
  if (!existsSync(base)) return findings;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(base, e.name);
    const gitFile = join(dir, ".git");
    const content = existsSync(gitFile) ? readFileSync(gitFile, "utf8") : null;
    if (content === null) { findings.push({ dir, status: "not-a-worktree" }); continue; }
    const resolved = resolveGitdir(dir, content);
    if (resolved === null) { findings.push({ dir, status: "no-gitdir-line" }); continue; }
    const exists = existsSync(resolved);
    if (!exists) findings.push({ dir, status: "orphaned", resolved });
  }
  return findings;
}

function findMergedUndeletedBranches(root) {
  let merged;
  try { merged = sh(`git -C "${root}" branch --merged main --format='%(refname:short)'`).split(/\r?\n/).filter(Boolean); }
  catch { return []; }
  return merged.filter((b) => /^feature\/CHANGE-\d+/.test(b) && b !== "main");
}

function checkLock(root) {
  try { return sh(`"${join(root, "scripts", "integrator-lock.sh")}" status`).trim(); }
  catch (e) { return `(could not check: ${(e.stderr || e.message || "").toString().split(NL)[0]})`; }
}

function findStaleHandovers(root) {
  const base = join(root, "docs", "changes");
  const findings = [];
  if (!existsSync(base)) return findings;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^CHANGE-/.test(e.name)) continue;
    const f = join(base, e.name, "change.yaml");
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const cfg = readChangeConfig(text);
    if (!["review", "complete"].includes(cfg.status)) continue;
    let headSha = null;
    if (cfg.branch) { try { headSha = sh(`git -C "${root}" rev-parse "${cfg.branch}"`).trim(); } catch { /* branch gone - already landed or deleted */ } }
    const problems = checkHandover(readHandover(text), headSha);
    if (problems.length) findings.push({ dir: e.name, status: cfg.status, problems });
  }
  return findings;
}

function main() {
  const root = sh("git rev-parse --show-toplevel").trim();
  let bad = false;

  console.log("repo-health");
  console.log("===========" + NL);

  console.log("orphaned worktrees");
  const orphans = findOrphanedWorktrees(root);
  if (!orphans.length) console.log("  none");
  else { bad = true; for (const o of orphans) console.log(`  ${o.status.toUpperCase().padEnd(16)} ${o.dir}${o.resolved ? ` -> ${o.resolved} (missing)` : ""}`); }

  console.log(NL + "merged-but-undeleted feature branches");
  const merged = findMergedUndeletedBranches(root);
  if (!merged.length) console.log("  none");
  else for (const b of merged) console.log(`  ${b}  (fully merged into main - safe to 'git branch -d' once confirmed)`);

  console.log(NL + "integrator lock");
  console.log("  " + checkLock(root));

  console.log(NL + "changes with a missing/incomplete/stale handover (status: review or complete)");
  const stale = findStaleHandovers(root);
  if (!stale.length) console.log("  none");
  else { bad = true; for (const s of stale) { console.log(`  ${s.dir} (${s.status}):`); for (const p of s.problems) console.log(`    - ${p}`); } }

  console.log(NL + (bad ? "ISSUES FOUND - see above. This tool reports only; nothing was changed." : "clean."));
  process.exit(bad ? 1 : 0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(resolveGitdir("/repo/.worktrees/harness-change-0010", "gitdir: ../../.git/worktrees/harness-change-0010") === "/repo/.git/worktrees/harness-change-0010",
    "resolves a relative gitdir against the worktree's own dir");
  ok(resolveGitdir("/repo/.worktrees/x", "gitdir: /absolute/path") === "/absolute/path", "passes through an absolute gitdir unchanged");
  ok(resolveGitdir("/repo/.worktrees/x", "not a gitdir line") === null, "no gitdir: line -> null");

  ok(classifyWorktree(null, null) === "not-a-worktree", "no .git file at all");
  ok(classifyWorktree("garbage", null) === "no-gitdir-line", ".git exists but has no gitdir: line");
  ok(classifyWorktree("gitdir: x", true) === "live", "gitdir resolves and exists -> live");
  ok(classifyWorktree("gitdir: x", false) === "orphaned", "REGRESSION: gitdir resolves to a path that does not exist -> orphaned (the exact bug class hunted by hand this session)");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("repo-health self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("repo-health.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
