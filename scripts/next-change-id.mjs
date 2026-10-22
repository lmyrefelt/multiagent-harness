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
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

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

  const lines = branches.split(/\r?\n/);
  // Concurrency limit chunking to avoid spawning too many processes at once
  const CONCURRENCY_LIMIT = 50;
  for (let i = 0; i < lines.length; i += CONCURRENCY_LIMIT) {
    const chunk = lines.slice(i, i + CONCURRENCY_LIMIT);
    await Promise.all(chunk.map(async (line) => {
      const branchName = line.trim();
      if (!branchName) return;
      const m = branchName.match(/^feature\/CHANGE-0*(\d+)\b/i);
      if (m) used.add(Number(m[1]));
      // Also scan docs/changes inside each branch (e.g. planning/* branches)
      try {
        const { stdout: tree } = await execAsync(`git ls-tree -d --name-only "${branchName}":docs/changes`);
        for (const entry of tree.split(/\r?\n/)) {
          const em = entry.match(/^CHANGE-0*(\d+)\b/i);
          if (em) used.add(Number(em[1]));
        }
      } catch { /* branch may not have docs/changes yet */ }
    }));
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
  const root = repoRoot();
  const args = process.argv.slice(2);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
