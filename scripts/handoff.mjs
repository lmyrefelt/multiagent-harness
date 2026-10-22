#!/usr/bin/env node
//
// handoff.mjs - the handoff ledger between planner, integrator and worker.
//
// ONE RULE, borrowed from herdr-virtualboard / spoolway / pi-herd: an agent
// REPORTS the outcome of its turn; it never decides who goes next. The Herdr
// plugin (herdr-plugin/lifecycle-watcher.mjs) reads this ledger and routes the
// next turn according to herdr-plugin/pipeline.json - a deterministic table,
// not an LLM.
//
// The ledger is append-only JSONL at <tree>/.pi-session/handoff/<CHANGE>.jsonl,
// where <tree> is whichever checkout the reporting agent works in (main, a
// planner worktree, a worker worktree). It lives in .pi-session/ - not
// docs/changes/ - on purpose: it never shows up in a diff, never blocks a
// merge, and every role's container can already write there. The watcher
// runs on the host and merges the ledgers of ALL trees, so it does not matter
// which tree an entry was written in.
//
// Agents (inside their containers):
//   node /repo/scripts/handoff.mjs new --change CHANGE-0001 --role planner
//        -> docs/changes/CHANGE-0001-*/planner-handoff-5.md from the template; fill it in
//   node /repo/scripts/handoff.mjs report --change CHANGE-0001 --role planner \
//        --verdict plan-ready --file docs/changes/CHANGE-0001-*/planner-handoff-5.md \
//        [--note "one line"]
//
// Owner / host:
//   node scripts/handoff.mjs status                 what the watcher sees, per change
//   node scripts/handoff.mjs panes                  Herdr panes and the role each maps to
//   node scripts/handoff.mjs register-pane --pane w1:p6 --role planner [--change CHANGE-0001]
//   node scripts/handoff.mjs reconcile [--live]     run the watcher once by hand (dry-run unless --live)
//   node scripts/handoff.mjs sidebar                push role/change/branch/model tokens to the Herdr sidebar
//   node scripts/handoff.mjs --selftest
//
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findChangeDir as sharedFindChangeDir } from "./verify-change.mjs";

export const ROLES = ["planner", "integrator", "worker", "runner"];
// runner = host-side job runner (scripts/godot-qualify.mjs), started by the watcher - never an agent pane.

// Which verdicts each role may report. Kept here (not only in pipeline.json)
// so a typo is refused at write time, inside the agent's own turn, where the
// agent can still fix it - rather than silently ignored by the watcher later.
export const VERDICTS_BY_ROLE = {
  planner: ["plan-ready", "needs-decision", "question", "blocked"],
  integrator: ["plan-requested", "plan-approved", "plan-changes-requested", "impl-changes-requested", "merged", "needs-human", "needs-qualification", "question", "blocked"],
  worker: ["impl-ready", "needs-qualification", "needs-decision", "question", "blocked"],
  runner: ["qualified", "qualification-failed", "blocked"],
};
// Entries agents can NOT write with `report`: the harness itself (scripts/harness-supervisor.mjs)
// and the owner (`approve-merge`, refused inside a container).
export const SYSTEM_VERDICTS = {
  harness: ["resume", "stalled", "repeated-failure"],
  human: ["merge-approved", "answered"],
};

const CHANGE_RE = /CHANGE-\d+/i;
export const normChange = (s) => {
  const m = CHANGE_RE.exec(String(s ?? ""));
  if (!m) return null;
  const num = m[0].replace(/\D+/g, "");
  return `CHANGE-${num.padStart(4, "0")}`;
};

// ---------------------------------------------------------------------------
// Tree discovery
// ---------------------------------------------------------------------------

/** Root of the checkout the caller is in. Containers may not have a working
 *  git (worktree .git files point at host paths), so fall back to walking up
 *  for AGENTS.md / docs/changes. */
export function findTreeRoot(start = process.cwd()) {
  if (process.env.HANDOFF_ROOT) return resolve(process.env.HANDOFF_ROOT);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return top;
  } catch { /* fall through */ }
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, "AGENTS.md")) || existsSync(join(d, "docs", "changes"))) return d;
    const up = dirname(d);
    if (up === d) return resolve(start);
    d = up;
  }
}

/** The main checkout plus every worktree: `git worktree list` (host paths)
 *  AND a plain scan of <repo>/.worktrees/* (works even when git metadata is
 *  unreadable, e.g. in a sandbox). Deduped by real path. */
export function discoverTrees(repoRoot) {
  const out = new Map();
  const add = (p, branch = null) => {
    try {
      if (!existsSync(p) || !statSync(p).isDirectory()) return;
      const rp = realpathSync(p);
      if (!out.has(rp)) out.set(rp, { path: rp, branch });
      else if (branch && !out.get(rp).branch) out.get(rp).branch = branch;
    } catch { /* unreadable - skip */ }
  };
  add(repoRoot);
  try {
    const txt = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let cur = null;
    for (const line of txt.split("\n")) {
      if (line.startsWith("worktree ")) { if (cur) add(cur.path, cur.branch); cur = { path: line.slice(9), branch: null }; }
      else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    if (cur) add(cur.path, cur.branch);
  } catch { /* not a git repo here - scan only */ }
  const wt = join(repoRoot, ".worktrees");
  if (existsSync(wt)) for (const e of readdirSync(wt, { withFileTypes: true })) if (e.isDirectory()) add(join(wt, e.name));
  for (const t of out.values()) {
    if (!t.branch) {
      try { t.branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: t.path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* unknown */ }
    }
  }
  return [...out.values()];
}

/** docs/changes/CHANGE-NNNN-* folder for a change in one tree, or null. */
// tests.command from a change.yaml (the nested `tests:` -> `command:` key).
export function readTestsCommand(yamlPath) {
  let text; try { text = readFileSync(yamlPath, "utf8"); } catch { return null; }
  let inTests = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^tests:\s*$/.test(raw)) { inTests = true; continue; }
    if (inTests && /^\S/.test(raw)) inTests = false;
    const m = inTests && raw.match(/^\s+command:\s*(.+?)\s*$/);
    if (m) {
      let v = m[1].replace(/\s+#.*$/, "");
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
      return v && v !== "null" && v !== "~" ? v : null;
    }
  }
  return null;
}

export function findChangeDir(treeRoot, change) {
  const num = change.replace(/\D+/g, "");
  return sharedFindChangeDir(treeRoot, num);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const ledgerDir = (treeRoot) => join(treeRoot, ".pi-session", "handoff");
export const ledgerPath = (treeRoot, change) => join(ledgerDir(treeRoot), `${change}.jsonl`);

export function validateEntry({ change, role, verdict }, { system = false } = {}) {
  const errs = [];
  if (!normChange(change)) errs.push(`--change must name a CHANGE-NNNN (got '${change ?? ""}')`);
  if (system && SYSTEM_VERDICTS[role]) { if (!SYSTEM_VERDICTS[role].includes(verdict)) errs.push(`${role} verdict must be one of ${SYSTEM_VERDICTS[role].join("|")}`); return errs; }
  if (!ROLES.includes(role)) errs.push(`--role must be one of ${ROLES.join("|")} (got '${role ?? ""}')`);
  else if (!VERDICTS_BY_ROLE[role].includes(verdict)) errs.push(`--verdict for ${role} must be one of ${VERDICTS_BY_ROLE[role].join("|")} (got '${verdict ?? ""}')`);
  return errs;
}

export function appendEntry(treeRoot, { change, role, verdict, note = "", file = null, now = new Date(), system = false, extra = null }) {
  const errs = validateEntry({ change, role, verdict }, { system });
  if (errs.length) throw new Error(errs.join("\n"));
  change = normChange(change);
  let sha = null;
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: treeRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* no git in container */ }
  const entry = {
    id: `${now.toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(3).toString("hex")}`,
    at: now.toISOString(), change, role, verdict,
    note: String(note).replace(/\s+/g, " ").trim().slice(0, 500),
    file: file || null, sha,
    ...(extra ?? {}),
  };
  mkdirSync(ledgerDir(treeRoot), { recursive: true });
  appendFileSync(ledgerPath(treeRoot, change), JSON.stringify(entry) + "\n");
  return entry;
}

function parseLedger(text, tree) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.id && e.at && e.change && e.role && e.verdict) out.push({ ...e, change: normChange(e.change), tree: tree.path, tree_branch: tree.branch ?? null });
    } catch { /* a torn line is skipped, never guessed at */ }
  }
  return out;
}

/** Every entry from every tree, grouped by change, each list sorted oldest -> newest, deduped by id. */
export function readAllEntries(repoRoot, trees = discoverTrees(repoRoot)) {
  const byChange = new Map();
  const seen = new Set();
  for (const t of trees) {
    const dir = ledgerDir(t.path);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/^CHANGE-\d+\.jsonl$/i.test(f)) continue;
      let text; try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
      for (const e of parseLedger(text, t)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (!byChange.has(e.change)) byChange.set(e.change, []);
        byChange.get(e.change).push(e);
      }
    }
  }
  for (const list of byChange.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return byChange;
}


// ---------------------------------------------------------------------------
// Handoff reports - one template per role (docs/changes/handoff-template.<role>.md)
// ---------------------------------------------------------------------------
// Every turn that hands work on ends with a report written from the role's
// template, so each round reads the same way: verdict, summary, previous
// findings by ID, changes, what was verified (and what was not), next steps.
// `new` creates the next numbered file pre-filled; `report` refuses a file
// that still has template TODOs, misses a section, or whose Verdict line
// disagrees with the verdict being reported.

// Verdicts that hand work to another role carry a report; question/blocked
// only need --note (they go to the owner).
export const VERDICTS_NEEDING_REPORT = new Set(["plan-ready", "plan-approved", "plan-changes-requested", "impl-ready", "impl-changes-requested", "merged", "needs-human"]);
const REPORT_PREFIX = { planner: "planner-handoff", integrator: "integrator-review", worker: "worker-handoff" };
const DEFAULT_VERDICT = { planner: "plan-ready", worker: "impl-ready" };

export function templatePath(role, scriptDir = dirname(fileURLToPath(import.meta.url))) {
  const name = `handoff-template.${role}.md`;
  const cands = [
    process.env.HANDOFF_TEMPLATES ? join(process.env.HANDOFF_TEMPLATES, name) : null,
    join(scriptDir, "..", "docs", "changes", name), // bootstrapped project
    join(scriptDir, "..", "docs", name),            // export package
  ].filter(Boolean);
  return cands.find(existsSync) ?? null;
}

const highestN = (dir, prefix) => {
  if (!dir || !existsSync(dir)) return 0;
  let max = 0;
  for (const f of readdirSync(dir)) { const m = new RegExp(`^${prefix}-(\\d+)\\.md$`).exec(f); if (m) max = Math.max(max, Number(m[1])); }
  return max;
};

/** Where the next report for this role goes, and what it responds to. Pure apart from reading the folder. */
export function nextReportPath(changeDir, role) {
  const reviews = highestN(changeDir, "integrator-review");
  const planner = highestN(changeDir, "planner-handoff");
  const worker = highestN(changeDir, "worker-handoff");
  const rel = (f) => (f ? f : "n/a - first round");
  if (role === "planner") {
    const n = reviews + 1; // plan round N answers integrator-review-(N-1)
    return { path: join(changeDir, `planner-handoff-${n}.md`), round: n, prev: rel(reviews ? `integrator-review-${reviews}.md` : null) };
  }
  if (role === "worker") {
    const n = worker + 1;
    return { path: join(changeDir, `worker-handoff-${n}.md`), round: n, prev: rel(worker && reviews ? `integrator-review-${reviews}.md` : null) };
  }
  const n = reviews + 1;
  const phase = worker > 0 ? "implementation" : "plan";
  const prevHandoff = phase === "implementation" ? (worker ? `worker-handoff-${worker}.md` : null) : (planner ? `planner-handoff-${planner}.md` : null);
  return { path: join(changeDir, `integrator-review-${n}.md`), round: n, phase, prev: rel(prevHandoff) };
}

/** "/repo/.worktrees/x/docs/a.md" or "<host>/.worktrees/x/docs/a.md" -> ".worktrees/x/docs/a.md"; else relative to the tree. */
export function repoRelative(abs, tree) {
  const i = abs.indexOf("/.worktrees/");
  if (i !== -1) return abs.slice(i + 1);
  if (abs.startsWith("/repo/")) return abs.slice("/repo/".length);
  return abs.startsWith(tree + "/") ? abs.slice(tree.length + 1) : abs;
}

export function fillReportTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ""));
}

/** Check a report against its template. Returns a list of problems (empty = ok). */
export function validateReport(text, templateText, verdict) {
  const problems = [];
  const headings = [...templateText.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const sections = new Map();
  const parts = text.split(/^## /m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const h = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? "" : part.slice(nl + 1);
    sections.set(h, body);
  }
  for (const h of headings) {
    if (!sections.has(h)) { problems.push(`missing section "## ${h}"`); continue; }
    const content = sections.get(h).split("\n").map((l) => l.trim())
      .filter((l) => l && !/^> ?TODO/i.test(l) && !/^\|[\s|:-]*\|$/.test(l) && !/^\|\s*ID\s*\|/i.test(l));
    if (!content.length) problems.push(`section "## ${h}" is empty`);
  }
  const todos = text.split("\n").filter((l) => /> ?TODO/i.test(l)).length;
  if (todos) problems.push(`${todos} template TODO line(s) still in the file - replace them with real content`);
  const vm = /^- Verdict:\s*([a-z-]+)\s*$/m.exec(text);
  if (!vm) problems.push(`no "- Verdict: <verdict>" line`);
  else if (verdict && vm[1] !== verdict) problems.push(`the file says Verdict: ${vm[1]} but you are reporting ${verdict}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Host-side state (main checkout only): pane registry + watcher state
// ---------------------------------------------------------------------------

export const lifecycleDir = (repoRoot) => join(repoRoot, ".pi-session", "herdr-lifecycle");
const registryPath = (repoRoot) => join(lifecycleDir(repoRoot), "panes.json");
export const statePath = (repoRoot) => join(lifecycleDir(repoRoot), "state.json");
export const eventsLogPath = (repoRoot) => join(lifecycleDir(repoRoot), "events.log");

export function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  execFileSync("mv", ["-f", tmp, p]);
}

export const loadRegistry = (repoRoot) => readJson(registryPath(repoRoot), {});
export function registerPane(repoRoot, { pane, role, change = null, label = null, backend = null }) {
  if (!pane) throw new Error("--pane is required");
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join("|")}`);
  return withLock(repoRoot, () => {
    const reg = loadRegistry(repoRoot);
    reg[pane] = { role, change: change ? normChange(change) : null, label, backend, at: new Date().toISOString() };
    writeJsonAtomic(registryPath(repoRoot), reg);
    return reg[pane];
  });
}
export function forgetPane(repoRoot, pane) {
  return withLock(repoRoot, () => {
    const reg = loadRegistry(repoRoot);
    if (!(pane in reg)) return false;
    delete reg[pane];
    writeJsonAtomic(registryPath(repoRoot), reg);
    return true;
  });
}

/** mkdir-based lock: several hook processes can fire at once (one per pane event). */
export function withLock(repoRoot, fn, { timeoutMs = 8000, staleMs = 60000 } = {}) {
  const lock = join(lifecycleDir(repoRoot), ".lock");
  mkdirSync(lifecycleDir(repoRoot), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (Date.now() - t0 > timeoutMs) throw new Error("handoff lock busy");
      execSync("sleep 0.1");
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function logEvent(repoRoot, msg) {
  try {
    mkdirSync(lifecycleDir(repoRoot), { recursive: true });
    appendFileSync(eventsLogPath(repoRoot), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging is best-effort */ }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

function usage() {
  console.error(`usage:
  node scripts/handoff.mjs new    --change CHANGE-NNNN --role planner|integrator|worker   (creates your next report from the template, prints its path)
  node scripts/handoff.mjs check  --file <report> [--role <role>] [--verdict <v>]          (is the report complete?)
  node scripts/handoff.mjs report --change CHANGE-NNNN --role <role> --verdict <v> --file <your report> [--note "<one line>"]
  node scripts/handoff.mjs status [--change CHANGE-NNNN]
  node scripts/handoff.mjs answer --change CHANGE-NNNN --note '<answer>'      (OWNER: answer an agent's question; it is routed back to the asker)
  node scripts/handoff.mjs approve-merge --change CHANGE-NNNN [--sha <commit>]   (OWNER, on the host: let the integrator merge a gated change)
  node scripts/handoff.mjs panes
  node scripts/handoff.mjs register-pane --pane <w1:p2> --role <role> [--change CHANGE-NNNN] [--label <l>] [--backend <b>]
  node scripts/handoff.mjs forget-pane --pane <w1:p2>
  node scripts/handoff.mjs reconcile [--live] [--retry CHANGE-NNNN]   (--retry: route the newest entry again, e.g. after a failed worker launch)
  node scripts/handoff.mjs sidebar                (re)send role/change/branch/model tokens to the Herdr sidebar
verdicts:
${ROLES.map((r) => `  ${r.padEnd(10)} ${VERDICTS_BY_ROLE[r].join(" | ")}`).join("\n")}`);
}

async function cli(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.selftest) return selftest();
  if (!cmd || cmd === "help" || args.help) { usage(); return 0; }

  if (cmd === "new") {
    const tree = findTreeRoot();
    const change = normChange(args.change);
    const role = args.role;
    if (!change || !ROLES.includes(role)) { console.error("REFUSED: new needs --change CHANGE-NNNN and --role planner|integrator|worker"); usage(); return 2; }
    const dir = findChangeDir(tree, change);
    if (!dir) { console.error(`REFUSED: no docs/changes/${change}-*/ folder in ${tree}.`); return 2; }
    const tp = templatePath(role);
    if (!tp) { console.error(`REFUSED: template handoff-template.${role}.md not found (looked in docs/changes/ and docs/ next to this script).`); return 2; }
    const nx = nextReportPath(dir, role);
    if (existsSync(nx.path) && !args.force) {
      console.log(nx.path);
      console.error(`exists already - fill it in (or --force to start it over).`);
      return 0;
    }
    let branch = "unknown", sha = "unknown";
    try { branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: tree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || branch; } catch { /* no git in container */ }
    try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: tree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || sha; } catch { /* idem */ }
    const vars = { change, round: String(nx.round), phase: nx.phase ?? "", branch, sha, date: new Date().toISOString().slice(0, 16).replace("T", " ") + "Z",
      prev_review: nx.prev, prev_handoff: nx.prev, verdict: args.verdict && args.verdict !== true ? args.verdict : (DEFAULT_VERDICT[role] ?? "") };
    let text = fillReportTemplate(readFileSync(tp, "utf8"), vars);
    if (args.verdict && args.verdict !== true) text = text.replace(/^- Verdict:.*$/m, `- Verdict: ${args.verdict}`);
    writeFileSync(nx.path, text);
    console.log(nx.path);
    console.error(`created from ${tp}. Replace every "> TODO" line, then report with --file ${nx.path.slice(tree.length + 1)}`);
    return 0;
  }

  if (cmd === "check") {
    const tree = findTreeRoot();
    const file = args.file && args.file !== true ? resolve(tree, args.file) : null;
    if (!file || !existsSync(file)) { console.error("usage: check --file <report> --role <role> [--verdict <v>]"); return 2; }
    const role = args.role ?? (/integrator-review/.test(file) ? "integrator" : /worker-handoff/.test(file) ? "worker" : "planner");
    const tp = templatePath(role);
    const probs = tp ? validateReport(readFileSync(file, "utf8"), readFileSync(tp, "utf8"), args.verdict === true ? null : args.verdict) : ["template not found"];
    if (probs.length) { console.error("NOT READY:\n  - " + probs.join("\n  - ")); return 1; }
    console.log("ok - report is complete");
    return 0;
  }

  if (cmd === "report") {
    const tree = findTreeRoot();
    const errs = validateEntry({ change: args.change, role: args.role, verdict: args.verdict });
    if (errs.length) { console.error("REFUSED:\n  " + errs.join("\n  ")); usage(); return 2; }
    const change = normChange(args.change);
    const dir = findChangeDir(tree, change);
    if (!dir) console.error(`WARN: no docs/changes/${change}-*/ folder in ${tree} - recorded anyway (the watcher reads every tree).`);
    let file = args.file === true ? null : args.file ?? null;
    // plan-requested starts a NEW change's planning: the planner needs something to go on.
    if ((args.verdict === "plan-requested" || args.verdict === "needs-decision") && !file && !(typeof args.note === "string" && args.note.trim())) {
      console.error(`REFUSED: --verdict ${args.verdict} needs --file <${args.verdict === "needs-decision" ? "the proposal the integrator must decide on" : "brief/research doc the planner must read"}> and/or --note '<${args.verdict === "needs-decision" ? "the decision needed" : "scope"}>'.`); return 2;
    }
    if (VERDICTS_NEEDING_REPORT.has(args.verdict) && !args.force) {
      const how = `create it with: node /repo/scripts/handoff.mjs new --change ${change} --role ${args.role}`;
      if (!file) { console.error(`REFUSED: --verdict ${args.verdict} needs your handoff report (--file). ${how}`); return 2; }
      const abs = resolve(tree, file);
      if (!existsSync(abs)) { console.error(`REFUSED: --file ${file} does not exist in ${tree}. ${how}`); return 2; }
      const tp = templatePath(args.role);
      if (tp) {
        const probs = validateReport(readFileSync(abs, "utf8"), readFileSync(tp, "utf8"), args.verdict);
        if (probs.length) { console.error(`REFUSED: ${file} is not complete yet:\n  - ${probs.join("\n  - ")}\nFix the file and run the same report command again.`); return 2; }
      } else console.error(`WARN: no handoff-template.${args.role}.md found - report not checked.`);
    } else if (file && !existsSync(resolve(tree, file))) console.error(`WARN: --file ${file} does not exist (yet) in ${tree}.`);
    // Store the report path relative to the MAIN checkout (".worktrees/<wt>/docs/..."
    // or "docs/..."), so the watcher can hand it to any role as /repo/<path> -
    // every container mounts the main checkout at /repo.
    // A worker hands over ONLY when the change's tests.command passes - the same
    // condition the in-session contract gate (obligation.tests_pass_before_done)
    // enforces, checked here BEFORE the ledger entry that starts the integrator.
    if (args.role === "worker" && args.verdict === "impl-ready" && !args.force && args["skip-tests"] !== true) {
      const tcmd = dir ? readTestsCommand(join(dir, "change.yaml")) : null;
      if (tcmd) {
        console.log(`running the change's tests.command before handing over:\n  ${tcmd}`);
        let ok = true;
        try { execSync(tcmd, { cwd: tree, stdio: "inherit", shell: "/bin/bash", timeout: 30 * 60 * 1000 }); }
        catch { ok = false; }
        if (!ok) {
          console.log(`HARNESS-TESTS: FAILED (${tcmd})`);
          console.error("REFUSED: tests.command did not pass - fix it, then run the same report command again. Nothing was handed over.");
          return 2;
        }
        console.log(`HARNESS-TESTS: PASSED (${tcmd})`);
      }
    }
    if (file) file = repoRelative(resolve(tree, file), tree);
    const e = appendEntry(tree, { change, role: args.role, verdict: args.verdict, note: args.note === true ? "" : args.note ?? "", file });
    console.log(`recorded: ${e.change} ${e.role} -> ${e.verdict} (${e.id}) in ${ledgerPath(tree, e.change)}`);
    console.log("This was your handoff; end your turn now - the next role is started for you.");
    return 0;
  }

  const repoRoot = process.env.HARNESS_REPO_ROOT || findTreeRoot();

  // The OWNER lets the integrator merge a change its merge gate would refuse
  // (risk high or reviewer_required). Refused inside a container: agents cannot approve.
  if (cmd === "approve-merge") {
    const change = normChange(args.change);
    if (!change) { console.error("usage: node scripts/handoff.mjs approve-merge --change CHANGE-NNNN [--sha <commit>] [--note '<why>']"); return 2; }
    if (existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.HARNESS_IN_CONTAINER) { console.error("REFUSED: approve-merge is for the owner, on the host - not from an agent container."); return 2; }
    const repoRoot = findTreeRoot();
    const sha = typeof args.sha === "string" ? args.sha : null;
    const e = appendEntry(repoRoot, { change, role: "human", verdict: "merge-approved", note: typeof args.note === "string" ? args.note : `owner approves merging ${change}${sha ? " @ " + sha : ""}`, system: true, extra: sha ? { approved_sha: sha } : null });
    console.log(`recorded ${e.id}: ${change} merge-approved${sha ? " @ " + sha : ""} - the integrator is prompted to merge it.`);
    return 0;
  }

  // The OWNER answers a question an agent asked (verdict question): recorded in the ledger and
  // routed back to the agent that asked, so the answer is a real handoff, not a pane chat (2026-10-20).
  if (cmd === "answer") {
    const change = normChange(args.change);
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!change || !note) { console.error("usage: node scripts/handoff.mjs answer --change CHANGE-NNNN --note '<your answer>' [--file <doc>]"); return 2; }
    if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) { console.error("REFUSED: answer is for the owner, on the host."); return 2; }
    const e = appendEntry(findTreeRoot(), { change, role: "human", verdict: "answered", note, file: typeof args.file === "string" ? args.file : null, system: true });
    console.log(`recorded ${e.id}: answer to ${change} - the agent that asked is prompted with it.`);
    return 0;
  }

  if (cmd === "status") {
    const byChange = readAllEntries(repoRoot);
    const state = readJson(statePath(repoRoot), { changes: {} });
    const only = args.change ? normChange(args.change) : null;
    if (!byChange.size) console.log("no handoff entries in any tree yet.");
    for (const [change, list] of byChange) {
      if (only && change !== only) continue;
      const st = state.changes?.[change] ?? {};
      console.log(`${change}`);
      for (const e of list.slice(-8)) {
        const done = (st.dispatched ?? []).includes(e.id) ? "routed " : "PENDING";
        console.log(`  ${e.at}  ${done}  ${e.role.padEnd(10)} ${e.verdict.padEnd(24)} ${e.file ?? ""} ${e.note ? "- " + e.note : ""}`);
      }
      if (st.rounds) console.log(`  rounds: ${JSON.stringify(st.rounds)}`);
      if (st.awaiting) console.log(`  awaiting: ${st.awaiting.role} since ${st.awaiting.since}${st.awaiting.reminded ? " (reminded)" : ""}`);
    }
    return 0;
  }

  if (cmd === "register-pane") {
    const r = registerPane(repoRoot, { pane: args.pane, role: args.role, change: args.change === true ? null : args.change, label: args.label === true ? null : args.label, backend: args.backend === true ? null : args.backend });
    console.log(`registered ${args.pane}: ${JSON.stringify(r)}`);
    return 0;
  }
  if (cmd === "forget-pane") { console.log(forgetPane(repoRoot, args.pane) ? "forgotten" : "not registered"); return 0; }

  if (cmd === "panes" || cmd === "reconcile" || cmd === "sidebar") {
    const here = dirname(fileURLToPath(import.meta.url));
    const watcher = join(here, "..", "herdr-plugin", "lifecycle-watcher.mjs");
    const env = { ...process.env, HARNESS_REPO_ROOT: repoRoot };
    if (cmd === "reconcile" && args.live) env.HANDOFF_FORCE_LIVE = "1";
    const wargs = cmd === "reconcile" && args.retry && args.retry !== true ? ["--retry", args.retry] : [{ panes: "--panes", reconcile: "--reconcile", sidebar: "--sidebar" }[cmd]];
    execFileSync(process.execPath, [watcher, ...wargs], { stdio: "inherit", env });
    return 0;
  }

  usage();
  return 2;
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };
  const root = join(tmpdir(), `handoff-selftest-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "docs", "changes", "CHANGE-0001-foo"), { recursive: true });
  mkdirSync(join(root, ".worktrees", "planner-pi", "docs", "changes", "CHANGE-0001-foo"), { recursive: true });

  ok(normChange("pi-integrator-auto-change-0050") === "CHANGE-0050", "change id match is case-insensitive (the lowercased-label bug)");
  ok(normChange("CHANGE-7") === "CHANGE-0007", "change id normalised to 4 digits");
  ok(normChange("nope") === null, "no change id -> null");

  ok(validateEntry({ change: "CHANGE-0001", role: "planner", verdict: "plan-approved" }).length === 1, "planner cannot approve its own plan");
  ok(validateEntry({ change: "CHANGE-0001", role: "integrator", verdict: "plan-approved" }).length === 0, "integrator may approve");
  ok(validateEntry({ change: "x", role: "boss", verdict: "y" }).length === 2, "bad change + bad role both reported");

  const wt = join(root, ".worktrees", "planner-pi");
  const a = appendEntry(wt, { change: "change-1", role: "planner", verdict: "plan-ready", note: "multi\nline   note", now: new Date("2026-10-13T10:00:00Z") });
  const b = appendEntry(root, { change: "CHANGE-0001", role: "integrator", verdict: "plan-changes-requested", file: "docs/changes/CHANGE-0001-foo/integrator-review-4.md", now: new Date("2026-10-13T11:00:00Z") });
  ok(a.note === "multi line note", "note is flattened to one line");
  appendFileSync(ledgerPath(root, "CHANGE-0001"), "{torn line\n");

  const trees = discoverTrees(root);
  ok(trees.length === 2, "main + .worktrees/* discovered without git");
  const all = readAllEntries(root, trees);
  const list = all.get("CHANGE-0001");
  ok(list && list.length === 2, "entries from BOTH trees merged; torn line skipped");
  ok(list[0].id === a.id && list[1].id === b.id, "sorted oldest -> newest across trees");

  const r = registerPane(root, { pane: "w1:p6", role: "planner" });
  ok(r.role === "planner" && loadRegistry(root)["w1:p6"], "pane registry write/read");
  ok(forgetPane(root, "w1:p6") === true && !loadRegistry(root)["w1:p6"], "pane registry forget");

  // handoff reports
  {
    const tplP = "# P\n\n- Verdict: plan-ready\n\n## Summary\n> TODO: x\n\n## Verified\n> TODO: y\n";
    const tplI = "# I\n\n- Verdict: > TODO: v\n\n## Findings\n| ID | Severity | Finding | Required fix |\n|---|---|---|---|\n> TODO: rows\n";
    ok(validateReport(tplP, tplP, "plan-ready").some((p) => /TODO/.test(p)), "an untouched template is refused (TODOs left)");
    const good = "# P\n\n- Verdict: plan-ready\n\n## Summary\nFixed F1-F3.\n\n## Verified\nbash -n ok\n";
    ok(validateReport(good, tplP, "plan-ready").length === 0, "a filled report passes");
    ok(validateReport(good.replace("## Verified\nbash -n ok\n", ""), tplP, "plan-ready").some((p) => /missing section/.test(p)), "a dropped section is refused");
    ok(validateReport(good.replace("bash -n ok", ""), tplP, "plan-ready").some((p) => /is empty/.test(p)), "an empty section is refused");
    ok(validateReport(good, tplP, "question").some((p) => /says Verdict: plan-ready/.test(p)), "Verdict line must match the reported verdict");
    const appr = "# I\n\n- Verdict: plan-approved\n\n## Findings\n| ID | Severity | Finding | Required fix |\n|---|---|---|---|\nnone\n";
    ok(validateReport(appr, tplI, "plan-approved").length === 0, "an approval with an empty findings table + 'none' passes");
    ok(validateReport(appr.replace("none\n", ""), tplI, "plan-approved").some((p) => /Findings" is empty/.test(p)), "a bare table header alone does not count as content");

    ok(repoRelative("/repo/.worktrees/p/docs/changes/C/planner-handoff-5.md", "/repo/.worktrees/p") === ".worktrees/p/docs/changes/C/planner-handoff-5.md", "worktree report stored repo-relative");
    ok(repoRelative("/repo/docs/changes/C/integrator-review-5.md", "/repo") === "docs/changes/C/integrator-review-5.md", "main-checkout report stored repo-relative");
    const cd = join(root, "docs", "changes", "CHANGE-0001-foo");
    for (const f of ["integrator-review-2.md", "integrator-review-4.md", "planner-handoff-4.md"]) writeFileSync(join(cd, f), "x");
    let nx = nextReportPath(cd, "planner");
    ok(/planner-handoff-5\.md$/.test(nx.path) && nx.round === 5 && nx.prev === "integrator-review-4.md", "planner round = last review + 1, responds to that review");
    nx = nextReportPath(cd, "integrator");
    ok(/integrator-review-5\.md$/.test(nx.path) && nx.phase === "plan" && nx.prev === "planner-handoff-4.md", "integrator review numbering continues; plan phase answers the planner's handoff");
    writeFileSync(join(cd, "worker-handoff-1.md"), "x");
    nx = nextReportPath(cd, "integrator");
    ok(nx.phase === "implementation" && nx.prev === "worker-handoff-1.md", "once a worker has reported, reviews answer the worker's handoff");
    ok(/worker-handoff-2\.md$/.test(nextReportPath(cd, "worker").path), "worker rounds count its own handoffs");
  }

  rmSync(root, { recursive: true, force: true });
  if (fails) { console.error(`\n${fails} self-test(s) FAILED`); return 1; }
  console.log("handoff self-test: all passed");
  return 0;
}

const direct = process.argv[1] && process.argv[1].endsWith("handoff.mjs");
if (direct) cli(process.argv.slice(2)).then((c) => process.exit(c ?? 0), (e) => { console.error(e.message); process.exit(1); });
