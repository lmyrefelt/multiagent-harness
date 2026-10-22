#!/usr/bin/env node
//
// preflight-change - refuse to start a worker unless HEAD is the change's feature branch.
//
// Hardening #8. The first CHANGE-0003 worker ran with the working tree on `main` and
// edited it uncommitted - which dodged every git hook (they only fire on a feature
// branch at commit/push). Run this BEFORE launching the worker: if HEAD is not the
// change's declared branch, it exits non-zero so the launch aborts. Combined with the
// command_forbidden git-checkout/switch block (#1), the worker then cannot leave that
// branch mid-run either.
//
//   node scripts/preflight-change.mjs CHANGE-0003 && <launch the worker>
//   node scripts/preflight-change.mjs --selftest
//
// Exit: 0 ok to launch, 1 refuse.
//
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { findChangeDir } from "./verify-change.mjs";

const SP = String.fromCharCode(32);
const NL = String.fromCharCode(10);

export function readBranch(text) {
  const scalar = (s) => {
    s = s.trim();
    const q = s[0];
    if (q === '"' || q === "'") { const e = s.indexOf(q, 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
    const i = s.indexOf(SP + "#");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  for (const raw of text.split(/\r?\n/)) {
    const kv = raw.match(/^([a-zA-Z_]\w*):\s*(.*)$/);
    if (kv && kv[1] === "branch") { const v = scalar(kv[2]); return v === "" || v === "null" ? null : v; }
  }
  return null;
}

export function verdict(expected, current) {
  if (!expected) return { ok: false, why: "change.yaml has no branch set - assign feature/CHANGE-NNNN-<slug> and approve the boundary first" };
  if (current !== expected) return { ok: false, why: `HEAD is "${current}", but this change must be worked on "${expected}"` };
  return { ok: true, why: `on ${expected}` };
}

function main() {
  const idArg = process.argv.slice(2).find((a) => /^CHANGE-\d+$/i.test(a));
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const current = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  let num = (idArg || "").replace(/\D+/g, "");
  if (!num) { const m = current.match(/CHANGE-0*(\d+)/i); num = m ? m[1] : ""; }
  if (!num) { console.error("usage: preflight-change.mjs CHANGE-NNNN"); process.exit(1); }
  const dir = findChangeDir(root, num);
  if (!dir) { console.error(`no docs/changes/CHANGE-${num}-*/change.yaml found`); process.exit(1); }
  const expected = readBranch(readFileSync(join(dir, "change.yaml"), "utf8"));
  const v = verdict(expected, current);
  if (!v.ok) {
    console.error(NL + `  WORKER PRE-FLIGHT FAILED: ${v.why}.` + NL +
      `  Do:  git checkout ${expected || "feature/CHANGE-" + num + "-<slug>"}   (create from main if needed)` + NL +
      `  then relaunch. Working on main lets a worker edit the tree and dodge the hooks -` + NL +
      `  that is the exact failure this prevents.` + NL);
    process.exit(1);
  }
  console.log(`preflight ok: ${v.why}`);
  process.exit(0);
}

function selftest() {
  let f = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); f++; } };
  ok(readBranch(["id: CHANGE-0003", "branch: feature/CHANGE-0003-x", "status: approved"].join(NL)) === "feature/CHANGE-0003-x", "reads branch");
  ok(readBranch(["branch: null"].join(NL)) === null, "null branch -> null");
  ok(verdict("feature/CHANGE-0003-x", "feature/CHANGE-0003-x").ok, "match -> ok");
  ok(!verdict("feature/CHANGE-0003-x", "main").ok, "on main -> refuse");
  ok(!verdict(null, "main").ok, "no branch set -> refuse");
  if (f) { console.error(NL + f + " self-test(s) FAILED"); process.exit(1); }
  console.log("preflight-change self-test: all passed");
  process.exit(0);
}

const direct = process.argv[1] && process.argv[1].endsWith("preflight-change.mjs");
if (direct) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
