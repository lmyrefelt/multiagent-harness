#!/usr/bin/env node
// harvest-antigravity-permissions.mjs — report, don't merge.
//
// WHY A REPORT, NOT AN AUTO-MERGE
// A real worker session's settings.json accumulates "always allow" entries
// Antigravity itself appends whenever the agent approves a prompt - some are
// durable, cross-change patterns worth baking into the shared baseline
// (scripts/antigravity-permissions-baseline.json), some are one-off noise
// specific to that single run (an exact test file path, a hardcoded DB
// connection string, a literal CHANGE-NNNN argument). Telling those apart is
// a judgment call, not a mechanical one - auto-merging everything would let
// a stale connection string or an unrelated change's file path silently
// become a standing "always allow" for every future worker. This script
// only ever PRINTS what's new since the last baseline update, for a human
// to read and fold in by hand.
//
//   node scripts/harvest-antigravity-permissions.mjs
//
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.argv[2] ? process.argv[2] : process.cwd();
const BASELINE_PATH = join(REPO, "scripts/antigravity-permissions-baseline.json");
const WORKTREES_DIR = join(REPO, ".worktrees");

function loadBaselineAllow() {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return new Set(baseline.permissions?.allow ?? []);
}

function findSettingsFiles() {
  const found = [];
  if (!existsSync(WORKTREES_DIR)) return found;
  for (const wt of readdirSync(WORKTREES_DIR)) {
    const sessionDir = join(WORKTREES_DIR, wt, ".pi-session");
    if (!existsSync(sessionDir)) continue;
    for (const session of readdirSync(sessionDir)) {
      const settingsPath = join(sessionDir, session, "gemini-antigravity-cli", "settings.json");
      if (existsSync(settingsPath)) found.push({ worktree: wt, settingsPath });
    }
  }
  return found;
}

function main() {
  const baseline = loadBaselineAllow();
  const files = findSettingsFiles();
  if (files.length === 0) {
    console.log("No real antigravity settings.json files found under .worktrees/*/.pi-session/*/gemini-antigravity-cli/ - nothing to harvest yet.");
    return;
  }

  const seen = new Map(); // entry -> [worktree names that had it]
  for (const { worktree, settingsPath } of files) {
    let data;
    try { data = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { continue; }
    for (const entry of data.permissions?.allow ?? []) {
      if (baseline.has(entry)) continue;
      if (!seen.has(entry)) seen.set(entry, []);
      seen.get(entry).push(worktree);
    }
  }

  if (seen.size === 0) {
    console.log(`Scanned ${files.length} real session(s). Nothing new - every allow[] entry found is already in the baseline.`);
    return;
  }

  console.log(`Scanned ${files.length} real session(s). ${seen.size} allow[] entries NOT yet in the baseline:\n`);
  console.log("(Review each - fold in only the durable, cross-change-reusable ones. Drop exact test");
  console.log(" file paths, hardcoded connection strings/ports, and anything naming a specific");
  console.log(" CHANGE-NNNN - those are one-off noise, not patterns worth trusting by default.)\n");
  for (const [entry, worktrees] of seen) {
    console.log(`  ${entry}`);
    console.log(`    seen in: ${worktrees.join(", ")}`);
  }
}

main();
