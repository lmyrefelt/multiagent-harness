#!/usr/bin/env node
//
// board — one-line-per-change status dashboard, read FRESH from docs/changes/*
// every time, instead of a hand-maintained markdown file that goes stale. This
// project had exactly that file (READINESS-0010-0045.md) and corrected it twice
// in one session because status drifted and nobody noticed until it mattered.
// A generated board cannot go stale between runs - it just reads the real files.
//
//   node scripts/board.mjs             print the board
//   node scripts/board.mjs --active    only non-terminal changes
//   node scripts/board.mjs --selftest
//
// For overlap/cycle detection across active changes, see check-change-overlap.mjs -
// deliberately a separate tool: this one's job is "what is everything, at a glance."
//
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);
const TERMINAL = new Set(["complete", "rejected"]);

export function readBoardMeta(text) {
  const out = { id: null, title: null, status: null, tier: null, reviewer_required: null, depends_on: [], progress: {} };
  let list = null, inProgress = false, inRisk = false;
  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    if (list === "depends_on") {
      const it = raw.match(/^\s+-\s+(.*)$/);
      if (it) { const v = scalar(it[1]); if (v) out.depends_on.push(v); continue; }
      list = null;
    }
    if (inProgress) {
      const m = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(\w+)/);
      if (m) { out.progress[m[1]] = m[2]; continue; }
      if (/^\S/.test(raw)) inProgress = false;
    }
    if (inRisk) {
      const t = raw.match(/^\s+tier:\s*([a-zA-Z_]+)/);
      if (t) out.tier = t[1].toLowerCase();
      const r = raw.match(/^\s+reviewer_required:\s*(true|false)/);
      if (r) out.reviewer_required = r[1] === "true";
      if (/^\S/.test(raw)) inRisk = false;
      else continue;
    }

    const kv = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
    if (kv) {
      const k = kv[1], rest = kv[2];
      if (k === "id") out.id = scalar(rest);
      else if (k === "title") out.title = scalar(rest);
      else if (k === "status") out.status = scalar(rest);
      else if (k === "depends_on") { list = scalar(rest) === "[]" ? null : "depends_on"; }
      else if (k === "progress") inProgress = true;
      else if (k === "risk") inRisk = true;
    }
  }
  return out;
}

export function progressSummary(progress) {
  const vals = Object.values(progress);
  if (!vals.length) return "—";
  const green = vals.filter((v) => v === "green").length;
  return `${green}/${vals.length}`;
}

// A column is reserved width PLUS at least one separating space - truncating
// only when the value is strictly LONGER than the reserved width (not equal
// to it) is what guarantees that gap; an off-by-one here ran every exact-width
// id straight into the next column with zero separation.
export function pad(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + SP : s + SP.repeat(n - s.length + 1); }

function collect(root) {
  const base = join(root, "docs", "changes");
  const out = [];
  if (!existsSync(base)) return out;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^CHANGE-/.test(e.name)) continue;
    const f = join(base, e.name, "change.yaml");
    if (!existsSync(f)) continue;
    const m = readBoardMeta(readFileSync(f, "utf8"));
    m.dir = e.name;
    out.push(m);
  }
  return out;
}

function main() {
  const activeOnly = process.argv.includes("--active");
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  let changes = collect(root);
  changes.sort((a, b) => (parseInt((a.id ?? "").replace(/\D/g, ""), 10) || 0) - (parseInt((b.id ?? "").replace(/\D/g, ""), 10) || 0));
  if (activeOnly) changes = changes.filter((c) => !TERMINAL.has(c.status));

  console.log(pad("ID", 11) + pad("STATUS", 12) + pad("TIER", 9) + pad("REVIEW", 7) + pad("PROGRESS", 9) + "DEPENDS_ON");
  console.log("-".repeat(70));
  for (const c of changes) {
    console.log(
      pad(c.id ?? c.dir, 11) +
      pad(c.status ?? "?", 12) +
      pad(c.tier ?? "—", 9) +
      pad(c.reviewer_required === true ? "yes" : c.reviewer_required === false ? "no" : "—", 7) +
      pad(progressSummary(c.progress), 9) +
      (c.depends_on.length ? c.depends_on.join(",") : "—")
    );
  }
  const active = changes.filter((c) => !TERMINAL.has(c.status)).length;
  console.log("-".repeat(70));
  console.log(`${changes.length} total, ${active} active, ${changes.length - active} terminal`);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  const m = readBoardMeta([
    "id: CHANGE-0010", "title: Case narrative", "status: complete",
    "depends_on:", "  - CHANGE-0011", "  - CHANGE-0012",
    "risk:", "  tier: high", "  touches_authorization: true", "  reviewer_required: true",
    "progress:", "  REQ-0010-001: green", "  REQ-0010-002: red",
    "spec_refs:", "  - docs/x.md",
  ].join(NL));
  ok(m.id === "CHANGE-0010" && m.status === "complete", "reads id/status");
  ok(m.depends_on.length === 2 && m.depends_on[0] === "CHANGE-0011", "reads depends_on, stops correctly");
  ok(m.tier === "high" && m.reviewer_required === true, "reads nested risk.tier/reviewer_required, skips touches_authorization");
  ok(Object.keys(m.progress).length === 2 && m.progress["REQ-0010-001"] === "green", "reads progress dict, stops at dedent");

  ok(progressSummary({ "R1": "green", "R2": "green", "R3": "red" }) === "2/3", "progressSummary counts green/total");
  ok(progressSummary({}) === "—", "progressSummary handles empty");

  ok(pad("x", 5) === "x     ", "pad right-pads to n+1 (always at least one separating space)");
  ok(pad("toolong", 3) === "too ", "pad truncates but still separates with one space");
  ok(pad("CHANGE-0010", 11) === "CHANGE-0010 ", "REGRESSION: an exact-width value still gets a separating space (the column-run-together bug)");

  // depends_on: [] must not be read as a list
  const m2 = readBoardMeta(["id: CHANGE-0046", "depends_on: []", "status: draft"].join(NL));
  ok(m2.depends_on.length === 0, "depends_on: [] parses as empty, not a dangling list");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("board self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("board.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
