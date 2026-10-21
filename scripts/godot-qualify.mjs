#!/usr/bin/env node
/**
 * godot-qualify — host-side Godot qualification for one change, run by the
 * Herdr lifecycle watcher when an agent reports `needs-qualification`.
 *
 * Agents never reach the render host. The watcher (on the Mac) starts this
 * script; it ships the exact commit to the Linux render host via
 * scripts/godot-remote.sh, collects evidence, and records ONE verdict in the
 * handoff ledger as role `runner`:
 *   qualified             -> integrator (pipeline.json)
 *   qualification-failed  -> worker, with the evidence (counts as an impl round)
 *   blocked               -> you (host unreachable, wrong Godot version, ...)
 *
 * Jobs: check + export always; render too when change.yaml routing.visual: true
 * (or --render). Evidence: .pi-session/qualify/<CHANGE>/<sha12>/{check,export,render}/
 * plus summary.md - visible to every container as /repo/.pi-session/qualify/...
 *
 *   node scripts/godot-qualify.mjs --change CHANGE-0003 [--sha <rev>] [--tree <path>] [--render] [--no-report]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, openSync, closeSync, writeSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { normChange, discoverTrees, findChangeDir, readAllEntries, appendEntry, ledgerDir, ledgerPath } from "./handoff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function readVisual(yamlText) {
  let inRouting = false;
  for (const raw of yamlText.split(/\r?\n/)) {
    if (/^routing:\s*(?:#.*)?$/.test(raw)) { inRouting = true; continue; }
    if (inRouting && /^\S/.test(raw)) inRouting = false;
    const m = inRouting && raw.match(/^\s+visual:\s*(true|false)/);
    if (m) return m[1] === "true";
  }
  return false;
}

/** Turn job results into a verdict. Pure. */
export function decide(results) {
  if (results.some((r) => r.rc === 3)) return "blocked";
  if (results.every((r) => r.rc === 0)) return "qualified";
  return "qualification-failed";
}

function tail(file, n = 40) {
  try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n"); } catch { return "(no log)"; }
}

function main() {
  const change = normChange(arg("change"));
  if (!change) { console.error("usage: godot-qualify.mjs --change CHANGE-NNNN [--sha rev] [--tree path] [--render] [--no-report]"); process.exit(2); }

  // Which tree/commit: the latest needs-qualification entry, unless told.
  const trees = discoverTrees(REPO);
  const entries = readAllEntries(REPO, trees).get(change) ?? [];
  const req = [...entries].reverse().find((e) => e.verdict === "needs-qualification");
  let tree = arg("tree") || req?.tree || trees.find((t) => (t.branch ?? "").includes(change))?.path || REPO;
  let rev = arg("sha") || req?.sha || null;
  let sha;
  try { sha = git(tree, "rev-parse", "--verify", `${rev ?? "HEAD"}^{commit}`); }
  catch { try { sha = git(tree, "rev-parse", "HEAD"); } catch { console.error(`cannot resolve a commit in ${tree}`); process.exit(2); } }

  const changeDir = findChangeDir(tree, change);
  const visual = arg("render") === true || (changeDir && existsSync(join(changeDir, "change.yaml")) && readVisual(readFileSync(join(changeDir, "change.yaml"), "utf8")));
  // browser = Web export + Playwright, whenever the commit has tests/browser_runner (it replaces plain export).
  let hasBrowser = false;
  try { execFileSync("git", ["cat-file", "-e", `${sha}:godot-project/tests/browser_runner/package.json`], { cwd: tree, stdio: "ignore" }); hasBrowser = true; } catch { /* none */ }
  const jobs = ["check", hasBrowser ? "browser" : "export", ...(visual ? ["render"] : [])];

  const base = join(REPO, ".pi-session", "qualify", change, sha.slice(0, 12));
  mkdirSync(base, { recursive: true });

  // One run at a time per host.
  const lockFile = join(REPO, ".pi-session", "qualify", ".lock");
  // The lock holds "<pid> <epoch ms> <change>". A lock whose process is gone, or older than
  // QUALIFY_LOCK_MAX_MIN, is stale and taken over; a live one is WAITED for (queued), not
  // reported as blocked (owner, 2026-10-18).
  const maxMin = Number(process.env.QUALIFY_LOCK_MAX_MIN ?? 180);
  const waitMin = Number(process.env.QUALIFY_QUEUE_MAX_MIN ?? 240);
  const lockInfo = () => { try { const [pid, t, who] = readFileSync(lockFile, "utf8").trim().split(/\s+/); return { pid: Number(pid) || null, t: Number(t) || null, who: who ?? "?" }; } catch { return null; } };
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  let lock = null;
  const started = Date.now();
  let announced = false;
  while (!lock) {
    try { lock = openSync(lockFile, "wx"); writeSync(lock, `${process.pid} ${Date.now()} ${change}\n`); break; } catch { /* held */ }
    const li = lockInfo();
    let ageMin = li?.t ? (Date.now() - li.t) / 60000 : null;
    if (ageMin == null) { try { ageMin = (Date.now() - statSync(lockFile).mtimeMs) / 60000; } catch { continue; } }
    if (!(li?.pid && alive(li.pid)) || ageMin > maxMin) {
      console.error(`stale qualification lock (${li?.pid ? "pid " + li.pid + " gone" : "no pid"}, ${Math.round(ageMin)} min old) - taking it over`);
      rmSync(lockFile, { force: true });
      continue;
    }
    if ((Date.now() - started) / 60000 > waitMin) {
      console.error(`still queued behind ${li.who} after ${waitMin} min - giving up`);
      if (!arg("no-report")) appendEntry(tree, { change, role: "runner", verdict: "blocked", note: `Godot qualification for ${sha.slice(0, 12)} waited ${waitMin} min behind ${li.who} (pid ${li.pid}) - the render host may be stuck` });
      process.exit(3);
    }
    if (!announced) { console.error(`queued behind the qualification of ${li.who} (pid ${li.pid}) - waiting`); announced = true; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);   // sync sleep (main() is synchronous)
  }
  const results = [];
  try {
    for (const job of jobs) {
      const out = join(base, job);
      rmSync(out, { recursive: true, force: true });
      console.log(`=== ${change} ${sha.slice(0, 12)} ${job} ===`);
      // F21: prefer the wrapper from the TREE under qualification, so the reviewed runner
      // fix in that branch is the code that actually executes (fall back to this file's own
      // copy for trees that ship no wrapper). Lock, revision, evidence dirs and ledger
      // routing below are all unchanged - only which wrapper runs differs.
      const treeWrapper = join(tree, "scripts", "godot-remote.sh");
      const wrapper = existsSync(treeWrapper) ? treeWrapper : join(HERE, "godot-remote.sh");
      console.log(`wrapper: ${wrapper}`);
      const r = spawnSync("bash", [wrapper, sha, job, out], { cwd: tree, stdio: "inherit" });
      const rc = r.status ?? 3;
      results.push({ job, rc, out });
      if (rc === 3) break; // host problem: stop, it is not the change's fault
    }
  } finally { closeSync(lock); rmSync(lockFile, { force: true }); }

  const verdict = decide(results);
  const rel = (p) => relative(REPO, p);
  const md = [
    `# Godot qualification — ${change} @ ${sha.slice(0, 12)}`, "",
    `- verdict: **${verdict}**`, `- commit: ${sha}`, `- tree: ${rel(tree) || "."}`, `- at: ${new Date().toISOString()}`,
    `- host: ${(() => { try { return readFileSync(join(results[0].out, "host.txt"), "utf8").trim(); } catch { return "?"; } })()}`, "",
    "| job | result | evidence |", "|---|---|---|",
    ...results.map((r) => `| ${r.job} | ${r.rc === 0 ? "PASS" : r.rc === 3 ? "HOST PROBLEM" : "FAIL"} | /repo/${rel(r.out)}/ |`), "",
  ];
  const render = results.find((r) => r.job === "render");
  if (render && existsSync(render.out)) {
    const pngs = readdirSync(render.out).filter((f) => f.endsWith(".png"));
    md.push("## Screenshots", "", ...pngs.map((p) => `- /repo/${rel(join(render.out, p))}`), "",
      "Open each PNG with your image/read tool and compare it with the style guide and the change's spec.", "");
  }
  for (const r of results.filter((x) => x.rc === 3)) {
    const hp = join(r.out, "HOST_PROBLEM.txt");
    if (existsSync(hp)) md.push(`## ${r.job}: host problem (not the change's fault)`, "", "```", readFileSync(hp, "utf8").trim(), "```", "");
  }
  for (const r of results.filter((x) => x.rc !== 0)) md.push(`## ${r.job} log (last 40 lines)`, "", "```", tail(join(r.out, "log.txt")), "```", "");
  const summary = join(base, "summary.md");
  writeFileSync(summary, md.join("\n"));
  console.log(md.join("\n"));

  if (!arg("no-report")) {
    const failed = results.filter((r) => r.rc !== 0).map((r) => r.job).join(", ");
    const note = verdict === "qualified" ? `Godot ${jobs.join("+")} passed on the render host @ ${sha.slice(0, 12)}`
      : verdict === "blocked" ? `render host problem during ${failed} @ ${sha.slice(0, 12)} - see summary`
      : `Godot ${failed} failed @ ${sha.slice(0, 12)}`;
    // Ledger in the tree that asked, so the watcher sees branch + sha of that tree.
    // Like appendEntry, plus requested_by so pipeline.json can route the result back to the asker.
    const e = { id: `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(16).slice(2, 8)}`, at: new Date().toISOString(),
      change, role: "runner", verdict, note, file: rel(summary), sha: sha.slice(0, 7), requested_by: req?.role ?? "integrator" };
    mkdirSync(ledgerDir(tree), { recursive: true });
    appendFileSync(ledgerPath(tree, change), JSON.stringify(e) + "\n");
    console.log(`recorded ${e.verdict} for ${change} (${e.id})`);
  }
  process.exit(verdict === "qualified" ? 0 : verdict === "blocked" ? 3 : 1);
}

if (process.argv.includes("--selftest")) {
  const assert = (c, m) => { if (!c) { console.error("FAIL " + m); process.exit(1); } console.log("ok   " + m); };
  assert(readVisual("id: X\nrouting:\n  complexity: M\n  visual: true\n") === true, "routing.visual true");
  assert(readVisual("routing:\n  visual: false\nvisual: true\n") === false, "only routing.visual counts");
  assert(readVisual("routing: # visual contract\n  visual: true\n") === true, "commented routing schedules visual job");
  assert(decide([{ rc: 0 }, { rc: 0 }]) === "qualified", "all pass -> qualified");
  assert(decide([{ rc: 0 }, { rc: 1 }]) === "qualification-failed", "a job fails -> failed");
  assert(decide([{ rc: 3 }]) === "blocked", "host problem -> blocked (owner), not the worker");
} else main();
