#!/usr/bin/env node
//
// change-diff — "what changed since the last handover", for one CHANGE.
//
// Reviewing a change a SECOND time (CHANGE-0014, this session) meant
// re-reading its full discovery.md/impact-analysis.md every pass, even when
// only a few lines had actually changed since the last review. handover.at
// records the commit the LAST handover described - this diffs from there to
// HEAD, scoped to the change's own folder. No handover yet -> falls back to
// diffing the whole branch against base_branch ("nothing handed over, show me
// everything").
//
// Reuses readHandover/readChangeConfig from verify-change.mjs rather than a
// third copy of the same parsing logic - that file already owns getting this
// right; duplicating it risks the two drifting apart as the schema evolves.
//
//   node scripts/change-diff.mjs CHANGE-NNNN [--stat]
//   node scripts/change-diff.mjs --selftest
//
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readHandover, readChangeConfig, findChangeDir, sh } from "./verify-change.mjs";

/** Which ref to diff FROM, and why - the only logic this script adds on top of verify-change.mjs's readers. */
export function pickFromRef(handover, baseBranch) {
  const base = baseBranch || "main";
  if (handover && handover.at) {
    return { from: handover.at, why: `since the last handover (${handover.from} -> ${handover.to}, at ${handover.at})` };
  }
  return { from: base, why: `no handover yet - since branched from ${base}` };
}



function main() {
  const args = process.argv.slice(2);
  const stat = args.includes("--stat");
  const m = (args.find((a) => /^CHANGE-\d+$/i.test(a)) || "").match(/\d+/);
  if (!m) { console.error("usage: change-diff.mjs CHANGE-NNNN [--stat]"); process.exit(1); }
  const num = m[0];

  const root = sh("git rev-parse --show-toplevel").trim();
  const dir = findChangeDir(root, num);
  if (!dir) { console.error(`no docs/changes/CHANGE-${num}-*/change.yaml found.`); process.exit(1); }

  const yamlText = readFileSync(join(dir, "change.yaml"), "utf8");
  const cfg = readChangeConfig(yamlText);
  const handover = readHandover(yamlText);
  const branch = cfg.branch || sh("git rev-parse --abbrev-ref HEAD").trim();
  const { from, why } = pickFromRef(handover, cfg.base_branch);

  const relDir = dir.replace(root + "/", "");
  console.log(`CHANGE-${num}: changes ${why}`);
  console.log("");
  let out;
  try {
    out = sh(`git diff ${stat ? "--stat" : ""} ${from}..${branch} -- "${relDir}"`);
  } catch (e) {
    console.error(`could not diff ${from}..${branch}: ${((e.stderr || e.message || "").toString().split("\n")[0])}`);
    process.exit(1);
  }
  if (!out.trim()) { console.log("(no changes to this change's own docs since then)"); process.exit(0); }
  process.stdout.write(out);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  let r = pickFromRef({ from: "worker", to: "integrator", at: "8461ae33" }, "main");
  ok(r.from === "8461ae33" && /last handover/.test(r.why), "prefers handover.at when present");

  r = pickFromRef(null, "main");
  ok(r.from === "main" && /no handover yet/.test(r.why), "falls back to base_branch with no handover block");

  r = pickFromRef({ from: "worker", to: "integrator", at: null }, "develop");
  ok(r.from === "develop", "falls back when a handover exists but at is empty");

  r = pickFromRef(null, null);
  ok(r.from === "main", "defaults to main when base_branch itself is also missing");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("change-diff self-test: all passed");
  process.exit(0);
}

if (process.argv.includes("--selftest")) selftest();
else main();
