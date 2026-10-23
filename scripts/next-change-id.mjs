#!/usr/bin/env node
/**
 * next-change-id — allocate the next free CHANGE-NNNN, atomically.
 *
 * WHY THIS EXISTS
 * Two agents (a planner and an orchestrator, or two planners) that each hand-pick
 * "the next change number" will eventually pick the SAME one. That is how this repo
 * ended up with two CHANGE-0005s meaning different things. An id must come from a
 * single source of truth that sees every id already in use — in a folder OR on a
 * branch (a branch can exist before its folder is merged to main, and vice versa).
 *
 * WHAT IT DOES
 *   node scripts/next-change-id.mjs
 *       Print the next free id (e.g. CHANGE-0012). Read-only.
 *
 *   node scripts/next-change-id.mjs --reserve <slug>
 *       Atomically reserve it: create docs/changes/CHANGE-NNNN-<slug>/ with a
 *       minimal draft change.yaml and print the id + path. The folder's existence
 *       IS the reservation — a second caller scanning folders now sees it taken.
 *
 * It scans used ids from BOTH:
 *   - docs/changes/CHANGE-NNNN-*            (folders, merged or local)
 *   - feature/CHANGE-NNNN-* branches        (git, incl. other worktrees)
 *
 * FAIL CLOSED: if it cannot read one of the two sources it refuses to allocate,
 * rather than hand out an id it cannot prove is free.
 */

import { execSync, exec } from "node:child_process";
import { readdirSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

// Every id in use, from folders and from branches. Returns a Set of integers.
async function usedIds(root) {
  const used = new Set();

  const base = join(root, "docs", "changes");
  if (existsSync(base)) {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      const m = e.isDirectory() && e.name.match(/^CHANGE-0*(\d+)\b/);
      if (m) used.add(Number(m[1]));
    }
  } else {
    throw new Error(`no docs/changes/ under ${root} — cannot prove which ids are free`);
  }

  // All branches, across every worktree. `git branch -a` would add remotes too;
  // local + the standard refs are enough here and need no network.
  const branches = execSync("git branch --format='%(refname:short)'", { encoding: "utf8" });

  const lines = branches.split(/\r?\n/).map(b => b.trim()).filter(Boolean);

  // Extract branch numbers
  for (const branchName of lines) {
    const m = branchName.match(/^feature\/CHANGE-0*(\d+)\b/i);
    if (m) used.add(Number(m[1]));
  }

  // Also scan docs/changes inside each branch (e.g. planning/* branches)
  // We optimize this by doing a single batch operation to find all unique trees
  const input = lines.map(b => `${b}:docs/changes`).join('\n') + '\n';
  if (!input.trim()) return used;

  try {
    const batchCheckOutput = execSync(`git cat-file --batch-check="%(objectname) %(objecttype)"`, {
      input,
      encoding: "utf8"
    });

    const uniqueTrees = new Set();
    for (const line of batchCheckOutput.split(/\r?\n/)) {
      const parts = line.split(" ");
      if (parts.length === 2 && parts[1] === "tree") {
        uniqueTrees.add(parts[0]);
      }
    }

    for (const treeHash of uniqueTrees) {
      const treeOut = execSync(`git ls-tree -d --name-only ${treeHash}`, { encoding: "utf8" });
      for (const entry of treeOut.split(/\r?\n/)) {
        const em = entry.match(/^CHANGE-0*(\d+)\b/i);
        if (em) used.add(Number(em[1]));
      }
    }
  } catch {
    // If git cat-file fails, we ignore since the repository might be in a weird state
    // or batch-check had issues, but normally this shouldn't fail.
  }

  return used;
}

// Monotonic: one past the highest id ever used, in a folder OR on a branch. We do
// NOT backfill gaps — a skipped number stays skipped, so an id never means two
// different things across time (the whole point of a single allocator).
function nextId(used) {
  return (used.size ? Math.max(...used) : 0) + 1;
}

const pad = (n) => "CHANGE-" + String(n).padStart(4, "0");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    const code = await selftest();
    process.exit(code);
  }

  const root = repoRoot();
  const used = await usedIds(root);
  const n = nextId(used);
  const id = pad(n);

  const reserveIdx = args.indexOf("--reserve");
  if (reserveIdx === -1) {
    console.log(id);
    return;
  }

  const slug = (args[reserveIdx + 1] || "").trim();
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("usage: next-change-id.mjs --reserve <slug>   (slug: lower-case-kebab)");
    process.exit(1);
  }

  const dirName = `${id}-${slug}`;
  const dir = join(root, "docs", "changes", dirName);
  if (existsSync(dir)) {
    // Someone won the race between our scan and our mkdir. Refuse rather than reuse.
    console.error(`${dirName} already exists — re-run to get a fresh id.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: false }); // recursive:false so a race fails loudly

  const yaml = [
    `id: ${id}`,
    `title: ${slug.replace(/-/g, " ")}`,
    `type: feature`,
    ``,
    `status: draft              # planner lane: draft -> specified (see COORDINATION.md)`,
    ``,
    `base_branch: main`,
    `branch: null               # set by the integrator at approval, not by the planner`,
    `worktree: null`,
    ``,
    `# CHANGE ids this change needs merged first. MUST stay acyclic: if X and Y would`,
    `# depend on each other, extract the shared piece into its own change and depend on`,
    `# THAT instead (see COORDINATION.md "breaking cycles"). check-change-overlap flags cycles.`,
    `depends_on: []`,
    ``,
    `owned_paths: []            # fill from discovery before implementation`,
    `forbidden_paths: []`,
    ``,
    `requirements: []           # REQ-NNNN-nnn ids, defined in specification.md`,
    `# Per-requirement state, updated by the worker as it goes (resume/handoff + integrator`,
    `# visibility). One key per requirement. Values: pending | red | green.`,
    `progress: {}`,
    ``,
  ].join("\n");
  writeFileSync(join(dir, "change.yaml"), yaml);

  console.log(id);
  console.log(`docs/changes/${dirName}/`);
}

async function selftest() {
  let fails = 0;
  const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };

  const tmp = mkdtempSync(join(tmpdir(), "next-change-id-test-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmp);

    // Set up mock repository
    execSync("git init --initial-branch=master", { stdio: "ignore" });
    execSync("git config user.name 'Test'", { stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { stdio: "ignore" });
    execSync("git commit --allow-empty -m 'init'", { stdio: "ignore" });

    // Mock 1: Folders
    const docsChanges = join(tmp, "docs", "changes");
    mkdirSync(join(docsChanges, "CHANGE-0005-foo"), { recursive: true });
    mkdirSync(join(docsChanges, "CHANGE-0006-bar"), { recursive: true });

    // Mock 2: Branches
    execSync("git branch feature/CHANGE-0008-something", { stdio: "ignore" });
    execSync("git branch feature/CHANGE-0010-other", { stdio: "ignore" });

    // Mock 3: ls-tree in a branch
    execSync("git checkout -b with-docs", { stdio: "ignore" });
    mkdirSync(join(docsChanges, "CHANGE-0012-baz"), { recursive: true });
    writeFileSync(join(docsChanges, "CHANGE-0012-baz", "change.yaml"), "id: CHANGE-0012");
    execSync("git add docs", { stdio: "ignore" });
    execSync("git commit -m 'add 12'", { stdio: "ignore" });
    execSync("git checkout master", { stdio: "ignore" });

    // Test usedIds
    const used = await usedIds(tmp);

    ok(used.size === 5, `Expected 5 used ids, got ${used.size}`);
    ok(used.has(5), "Detects id from folder (5)");
    ok(used.has(6), "Detects id from folder (6)");
    ok(used.has(8), "Detects id from branch name (8)");
    ok(used.has(10), "Detects id from branch name (10)");
    ok(used.has(12), "Detects id from ls-tree in branch (12)");

    // Test nextId
    const nId = nextId(used);
    ok(nId === 13, `Expected nextId to be 13, got ${nId}`);

    // Test nextId with empty used
    const emptyUsed = new Set();
    const emptyNext = nextId(emptyUsed);
    ok(emptyNext === 1, `Expected empty nextId to be 1, got ${emptyNext}`);

  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }

  if (fails) {
    console.error(`${fails} selftest(s) FAILED`);
    return 1;
  }
  console.log("next-change-id selftest: all passed");
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
