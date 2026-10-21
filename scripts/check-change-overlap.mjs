#!/usr/bin/env node
//
// check-change-overlap - cross-change sanity for parallel work: detect two ACTIVE
// changes claiming the same path, AND dependency cycles between active changes.
//
// Two changes whose owned_paths intersect is a conflict before it is ever a merge
// conflict: run them in parallel and two workers write the same file. Because
// owned_paths is machine-readable, it is catchable up front - which is the whole
// point of declaring a boundary.
//
// Bug-fixed port of project/ check-path-ownership.mjs: that version skipped changes
// with status "merged" - a value NOT in our lifecycle enum - so terminal changes
// were never excluded and produced false overlaps against history. We skip the real
// terminal states: complete and rejected.
//
//   node scripts/check-change-overlap.mjs      # scan docs/changes, report overlaps
//   node scripts/check-change-overlap.mjs --selftest
//
// Exit: 0 no overlap, 1 overlap found, 2 nothing to check (<2 active changes).
//
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);
const TERMINAL = new Set(["complete", "rejected"]);

export function readChangeMeta(text) {
  const out = { id: null, status: null, owned_paths: [], depends_on: [] };
  let list = null;
  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (list) {
      const it = raw.match(/^\s+-\s+(.*)$/);
      if (it) { const v = scalar(it[1]); if (v) out[list].push(v); continue; }
      list = null;
    }
    const kv = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
    if (kv) {
      const k = kv[1], rest = kv[2];
      if (k === "id") out.id = scalar(rest);
      else if (k === "status") out.status = scalar(rest);
      else if (k === "owned_paths") { if (scalar(rest) !== "[]") list = "owned_paths"; }
      else if (k === "depends_on") { if (scalar(rest) !== "[]") list = "depends_on"; }
    }
  }
  return out;
}

// Detect dependency CYCLES among active changes. A cycle means two (or more)
// changes each wait on the other — nothing can be merged first. The fix is never a
// state file; it is to extract the shared piece into its own change that both depend
// on (COORDINATION.md). Dependencies on terminal/unknown changes are satisfied and
// ignored. Returns an array of cycles, each a list of ids ending where it began.
export function findCycles(changes) {
  const active = changes.filter((c) => !TERMINAL.has(c.status));
  const byId = new Map(active.map((c) => [c.id, c]));
  const color = new Map(active.map((c) => [c.id, 0])); // 0 white, 1 grey, 2 black
  const stack = [];
  const cycles = [];
  const dfs = (id) => {
    color.set(id, 1); stack.push(id);
    for (const dep of byId.get(id)?.depends_on || []) {
      if (!byId.has(dep)) continue;            // dep is complete/unknown -> satisfied
      if (color.get(dep) === 1) cycles.push(stack.slice(stack.indexOf(dep)).concat(dep));
      else if (color.get(dep) === 0) dfs(dep);
    }
    stack.pop(); color.set(id, 2);
  };
  for (const c of active) if (color.get(c.id) === 0) dfs(c.id);
  return cycles;
}

export function globToRe(g) {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, SP)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(SP, "g"), ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + re + "$");
}
// Materialise a glob into a concrete sample path, then cross-test: two globs
// overlap if a path drawn from one would be matched by the other.
const sample = (g) => g.replace(/\*\*/g, "x/x").replace(/\*/g, "x").replace(/\?/g, "x");
export function overlaps(a, b) {
  return globToRe(a).test(sample(b)) || globToRe(b).test(sample(a));
}

function collect(root) {
  const base = join(root, "docs", "changes");
  const out = [];
  if (!existsSync(base)) return out;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^CHANGE-/.test(e.name)) continue;
    const f = join(base, e.name, "change.yaml");
    if (!existsSync(f)) continue;
    const m = readChangeMeta(readFileSync(f, "utf8"));
    m.dir = e.name;
    out.push(m);
  }
  return out;
}

export function findOverlaps(changes) {
  const active = changes.filter((c) => !TERMINAL.has(c.status));
  const hits = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      for (const pa of a.owned_paths) {
        for (const pb of b.owned_paths) {
          if (overlaps(pa, pb)) hits.push({ a: a.id, pa, b: b.id, pb });
        }
      }
    }
  }
  return { active, hits };
}

function main() {
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  let changes = collect(root);
  const filterIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (filterIds.length > 0) {
    const set = new Set(filterIds.map((x) => x.toUpperCase()));
    changes = changes.filter((c) => c.id && set.has(c.id.toUpperCase()));
  }
  const { active, hits } = findOverlaps(changes);
  if (active.length < 2) { console.log(`check-change-overlap: ${active.length} active change(s) - nothing to check`); process.exit(2); }
  console.log(`active: ${active.map((c) => `${c.id}(${c.status || "?"})`).join(", ")}`);
  const cycles = findCycles(changes);
  let bad = false;
  if (hits.length) {
    console.error(NL + "  OWNED_PATHS OVERLAP between active changes:");
    for (const h of hits) console.error(`    ${h.a}  (${h.pa})   <->   ${h.b}  (${h.pb})`);
    console.error("  Serialise these changes or shrink a boundary - two workers must not own the same path.");
    bad = true;
  }
  if (cycles.length) {
    console.error(NL + "  DEPENDENCY CYCLE between active changes:");
    for (const c of cycles) console.error(`    ${c.join(" -> ")}`);
    console.error("  Break it: extract the shared piece into its OWN change that both depend on,");
    console.error("  and spec that one first (COORDINATION.md 'breaking cycles').");
    bad = true;
  }
  if (bad) process.exit(1);
  console.log(`no overlap or cycle across ${active.length} active change(s).`);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  const m = readChangeMeta(["id: CHANGE-0003", "status: approved", "owned_paths:", '  - "a/b/**"', "  - c/d.py"].join(NL));
  ok(m.id === "CHANGE-0003" && m.status === "approved" && m.owned_paths.length === 2, "reads id/status/owned_paths");

  // overlap detection — positive and negative
  ok(overlaps("a/b.py", "a/b.py"), "exact same path overlaps");
  ok(overlaps("a/**", "a/sub/x.py"), "dir/** contains a nested file");
  ok(overlaps("a/**", "a/b/**"), "dir/** overlaps a deeper dir/**");
  ok(overlaps("a/*.py", "a/foo.py"), "glob overlaps a concrete match");
  ok(overlaps("a/*", "a/**"), "a/* overlaps a/**");
  ok(!overlaps("a/**", "b/**"), "disjoint dirs do NOT overlap");
  ok(!overlaps("a/x.py", "a/y.py"), "different files do NOT overlap");

  // THE bug fix: a terminal change sharing a path must be SKIPPED, not flagged.
  const terminalShared = findOverlaps([
    { id: "C1", status: "complete", owned_paths: ["a/**"] },
    { id: "C2", status: "in_progress", owned_paths: ["a/**"] },
  ]);
  ok(terminalShared.hits.length === 0, "complete change is skipped (the merged-guard bug fix)");

  // two active changes sharing a path -> flagged
  const activeShared = findOverlaps([
    { id: "C2", status: "in_progress", owned_paths: ["a/**"] },
    { id: "C3", status: "approved", owned_paths: ["a/sub/x.py"] },
  ]);
  ok(activeShared.hits.length === 1 && activeShared.active.length === 2, "two active changes sharing a path are flagged");

  // disjoint active changes -> clean
  const disjoint = findOverlaps([
    { id: "C2", status: "approved", owned_paths: ["a/**"] },
    { id: "C4", status: "draft", owned_paths: ["b/**", "compose.yaml"] },
  ]);
  ok(disjoint.hits.length === 0, "disjoint active changes do not overlap");

  // depends_on parsing + cycle detection — positive and negative
  const dm = readChangeMeta(["id: CHANGE-1", "status: approved", "depends_on:", "  - CHANGE-2", "  - CHANGE-3"].join(NL));
  ok(dm.depends_on.length === 2 && dm.depends_on[0] === "CHANGE-2", "reads depends_on list");

  const cyc = findCycles([
    { id: "X", status: "approved", depends_on: ["Y"] },
    { id: "Y", status: "approved", depends_on: ["X"] },
  ]);
  ok(cyc.length >= 1, "mutual dependency X<->Y is flagged as a cycle");

  const acyclic = findCycles([
    { id: "X", status: "approved", depends_on: ["Y"] },
    { id: "Y", status: "approved", depends_on: ["Z"] },
    { id: "Z", status: "approved", depends_on: [] },
  ]);
  ok(acyclic.length === 0, "a linear chain X->Y->Z is NOT a cycle");

  const onTerminal = findCycles([
    { id: "X", status: "approved", depends_on: ["DONE"] },
    { id: "DONE", status: "complete", depends_on: ["X"] },
  ]);
  ok(onTerminal.length === 0, "dependency on a complete change is satisfied, not a cycle");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("check-change-overlap self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("check-change-overlap.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
