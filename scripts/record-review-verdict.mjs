#!/usr/bin/env node
//
// record-review-verdict - fold a /change-review panel's findings into change.yaml.
//
// WHY THIS EXISTS
// The integrator can spawn a light/medium/heavy reviewer panel (pi-subagents,
// FOREGROUND/blocking mode - see .pi/agents/review-{light,medium,heavy}.md and
// docs/changes/CHANGE-REVIEW.md for why foreground, not background) against a
// change's diff before merging. This script is the mechanical, narrow half: it
// parses each reviewer's structured REVIEW_FINDING lines, computes the panel's
// max severity, and folds that into the change's own risk.tier/reviewer_required -
// the SAME fields integrator_merge_gate already reads. It only ever TIGHTENS
// those fields (max of current vs panel verdict), never loosens one a planner
// already set - a panel finding something is a reason to escalate, never a
// reason to downgrade an existing risk assessment.
//
// Deliberately a narrow line-scanner/writer, not a YAML library - same house
// convention as readChange()/readChangeRiskMeta() elsewhere in this repo.
//
//   node scripts/record-review-verdict.mjs CHANGE-0050 light.txt medium.txt heavy.txt
//   node scripts/record-review-verdict.mjs --selftest
//
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const NL = String.fromCharCode(10);
const SEVERITY_ORDER = ["none", "low", "medium", "high", "critical"];
const TIER_ORDER = ["low", "medium", "high", "critical"];
const FINDING_RE = /^REVIEW_FINDING\s+severity=(none|low|medium|high|critical)\s*::\s*(.*)$/;

// --- parsing ---------------------------------------------------------------

/** All REVIEW_FINDING lines in one reviewer's raw output, in order. */
export function parseFindings(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(FINDING_RE);
    if (m) out.push({ severity: m[1], description: m[2].trim() });
  }
  return out;
}

/** Tally by severity, e.g. { critical: 0, high: 1, medium: 0, low: 1, none: 0 }. */
export function tally(findings) {
  const t = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  for (const f of findings) t[f.severity] = (t[f.severity] ?? 0) + 1;
  return t;
}

/** Highest severity across a set of findings; "none" if empty or all-none. */
export function maxSeverity(findings) {
  let best = "none";
  for (const f of findings) {
    if (SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(best)) best = f.severity;
  }
  return best;
}

/** Fold a panel severity into an existing risk.tier - NEVER downgrades. */
export function escalateTier(currentTier, panelSeverity) {
  const cur = TIER_ORDER.includes(currentTier) ? currentTier : "low";
  if (panelSeverity === "none" || panelSeverity === "low") return cur;
  // panelSeverity is medium/high/critical - all valid tier values too.
  return TIER_ORDER.indexOf(panelSeverity) > TIER_ORDER.indexOf(cur) ? panelSeverity : cur;
}

/** high/critical findings force reviewer_required=true; never flips it false. */
export function escalateReviewerRequired(current, panelSeverity) {
  return current === true || panelSeverity === "high" || panelSeverity === "critical";
}

// --- change.yaml narrow read/write -----------------------------------------

function findChangeDir(root, num) {
  const base = join(root, "docs", "changes");
  const hit = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && new RegExp(`^CHANGE-0*${num}(\\D|$)`).test(e.name))
    .map((e) => e.name)
    .find((n) => existsSync(join(base, n, "change.yaml")));
  return hit ? join(base, hit) : null;
}

/** { tier, reviewerRequired, tierLineIdx, reviewerRequiredLineIdx } - line indexes into `lines`. */
function readRiskBlock(lines) {
  let inRisk = false, tier = null, reviewerRequired = null, tierLineIdx = -1, reviewerRequiredLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^risk:\s*$/.test(raw)) { inRisk = true; continue; }
    if (!inRisk) continue;
    if (/^\S/.test(raw)) break; // dedented past the risk: block
    const t = raw.match(/^(\s+)tier:\s*([a-zA-Z_]+)/);
    if (t) { tier = t[2].toLowerCase(); tierLineIdx = i; }
    const r = raw.match(/^(\s+)reviewer_required:\s*(true|false)/);
    if (r) { reviewerRequired = r[2] === "true"; reviewerRequiredLineIdx = i; }
  }
  return { tier, reviewerRequired, tierLineIdx, reviewerRequiredLineIdx };
}

/** Remove an existing `review:` top-level block (idempotent re-run), if present. */
function stripExistingReviewBlock(lines) {
  const start = lines.findIndex((l) => /^review:\s*$/.test(l));
  if (start < 0) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

function renderReviewBlock({ at, panel, panelMaxSeverity, escalatedTier, escalatedReviewerRequired, findings }) {
  const out = [];
  out.push("review:");
  out.push(`  at: ${at}`);
  out.push("  panel:");
  for (const [name, t] of Object.entries(panel)) {
    out.push(`    ${name}: {critical: ${t.critical}, high: ${t.high}, medium: ${t.medium}, low: ${t.low}, none: ${t.none}}`);
  }
  out.push(`  panel_max_severity: ${panelMaxSeverity}`);
  out.push(`  escalated_tier: ${escalatedTier}`);
  out.push(`  escalated_reviewer_required: ${escalatedReviewerRequired}`);
  out.push("  findings:");
  if (findings.length === 0) out.push('    - "none"');
  for (const f of findings) out.push(`    - "${f.reviewer}: ${f.severity} :: ${f.description.replace(/"/g, "'")}"`);
  return out;
}

export function applyVerdict(changeYamlText, reviewerOutputs) {
  let lines = changeYamlText.split(/\r?\n/);
  const { tier: currentTier, reviewerRequired: currentReviewerRequired, tierLineIdx, reviewerRequiredLineIdx } = readRiskBlock(lines);
  if (tierLineIdx < 0 || reviewerRequiredLineIdx < 0) {
    throw new Error("could not find risk.tier / risk.reviewer_required in change.yaml - refusing to guess");
  }

  const panel = {};
  const allFindings = [];
  for (const [name, text] of Object.entries(reviewerOutputs)) {
    const findings = parseFindings(text);
    panel[name] = tally(findings);
    for (const f of findings) if (f.severity !== "none") allFindings.push({ reviewer: name, ...f });
  }
  const panelMaxSeverity = maxSeverity(allFindings);
  const newTier = escalateTier(currentTier, panelMaxSeverity);
  const newReviewerRequired = escalateReviewerRequired(currentReviewerRequired, panelMaxSeverity);

  lines[tierLineIdx] = lines[tierLineIdx].replace(/tier:\s*[a-zA-Z_]+/, `tier: ${newTier}`);
  lines[reviewerRequiredLineIdx] = lines[reviewerRequiredLineIdx].replace(/reviewer_required:\s*(true|false)/, `reviewer_required: ${newReviewerRequired}`);

  lines = stripExistingReviewBlock(lines);
  const reviewBlock = renderReviewBlock({
    at: new Date().toISOString(),
    panel,
    panelMaxSeverity,
    escalatedTier: newTier !== currentTier,
    escalatedReviewerRequired: newReviewerRequired !== currentReviewerRequired,
    findings: allFindings,
  });
  if (lines[lines.length - 1] !== "") lines.push("");
  lines.push(...reviewBlock);

  return { text: lines.join(NL), currentTier, newTier, currentReviewerRequired, newReviewerRequired, panelMaxSeverity };
}

// --- CLI ---------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const idArg = args.find((a) => /^CHANGE-\d+$/i.test(a));
  const num = (idArg || "").replace(/\D+/g, "");
  const files = args.filter((a) => a !== idArg && !a.startsWith("--"));
  if (!num || files.length === 0) {
    console.error("usage: record-review-verdict.mjs CHANGE-NNNN <light-output> <medium-output> <heavy-output> [--dry-run]");
    process.exit(1);
  }
  const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const dir = findChangeDir(root, num);
  if (!dir) { console.error(`no docs/changes/CHANGE-${num}-*/change.yaml found`); process.exit(1); }
  const changePath = join(dir, "change.yaml");
  const changeText = readFileSync(changePath, "utf8");

  const reviewerOutputs = {};
  const names = ["light", "medium", "heavy"];
  files.forEach((f, i) => { reviewerOutputs[names[i] ?? `reviewer${i}`] = readFileSync(f, "utf8"); });

  const result = applyVerdict(changeText, reviewerOutputs);
  console.error(
    `panel_max_severity=${result.panelMaxSeverity}  ` +
    `tier: ${result.currentTier} -> ${result.newTier}  ` +
    `reviewer_required: ${result.currentReviewerRequired} -> ${result.newReviewerRequired}`
  );
  if (args.includes("--dry-run")) { console.log(result.text); process.exit(0); }
  writeFileSync(changePath, result.text);
  console.error(`wrote ${changePath}`);
  process.exit(0);
}

function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(JSON.stringify(parseFindings("REVIEW_FINDING severity=high :: thing broke\nnoise\nREVIEW_FINDING severity=low :: minor"))
    === JSON.stringify([{ severity: "high", description: "thing broke" }, { severity: "low", description: "minor" }]),
    "parses multiple finding lines, ignores noise");
  ok(parseFindings("REVIEW_FINDING severity=none :: no findings").length === 1, "parses a none-finding line too");

  ok(maxSeverity([{ severity: "low" }, { severity: "high" }, { severity: "medium" }]) === "high", "max severity across findings");
  ok(maxSeverity([]) === "none", "no findings -> none");

  ok(escalateTier("low", "none") === "low", "none finding does not escalate");
  ok(escalateTier("low", "low") === "low", "low finding does not escalate a low tier");
  ok(escalateTier("low", "high") === "high", "high finding escalates a low tier");
  ok(escalateTier("critical", "low") === "critical", "never downgrades an existing critical tier");
  ok(escalateTier("medium", "critical") === "critical", "critical finding escalates past medium");

  ok(escalateReviewerRequired(false, "none") === false, "no escalation without a high/critical finding");
  ok(escalateReviewerRequired(false, "medium") === false, "medium alone does not force reviewer_required");
  ok(escalateReviewerRequired(false, "high") === true, "high finding forces reviewer_required");
  ok(escalateReviewerRequired(true, "none") === true, "never un-sets an existing reviewer_required");

  const sample = [
    "id: CHANGE-0099",
    "risk:",
    "  tier: low",
    "  touches_authorization: false",
    "  reviewer_required: false",
    "  rationale: \"\"",
    "",
  ].join(NL);
  const r1 = applyVerdict(sample, {
    light: "REVIEW_FINDING severity=none :: no findings",
    medium: "REVIEW_FINDING severity=low :: minor style nit",
    heavy: "REVIEW_FINDING severity=high :: possible auth bypass",
  });
  ok(r1.newTier === "high", "end-to-end: a heavy high-severity finding escalates tier to high");
  ok(r1.newReviewerRequired === true, "end-to-end: reviewer_required flips true");
  ok(r1.text.includes("tier: high"), "written text reflects the escalated tier");
  ok(r1.text.includes("reviewer_required: true"), "written text reflects escalated reviewer_required");
  ok(r1.text.includes("panel_max_severity: high"), "review block records the panel verdict");
  ok(r1.text.includes("auth bypass"), "review block preserves the finding description");

  // idempotent re-run: applying the SAME verdict again must not double-escalate
  // or accumulate a second review: block.
  const r2 = applyVerdict(r1.text, {
    light: "REVIEW_FINDING severity=none :: no findings",
    medium: "REVIEW_FINDING severity=low :: minor style nit",
    heavy: "REVIEW_FINDING severity=high :: possible auth bypass",
  });
  ok(r2.newTier === "high", "idempotent: re-running does not escalate further");
  ok((r2.text.match(/^review:\s*$/gm) ?? []).length === 1, "idempotent: re-running replaces, does not duplicate, the review: block");

  // an all-clean panel on an already-low-risk change must not touch anything.
  const r3 = applyVerdict(sample, {
    light: "REVIEW_FINDING severity=none :: no findings",
    medium: "REVIEW_FINDING severity=none :: no findings",
    heavy: "REVIEW_FINDING severity=none :: no findings",
  });
  ok(r3.newTier === "low" && r3.newReviewerRequired === false, "an all-clean panel leaves a low-risk change untouched");

  let threw = false;
  try { applyVerdict("id: CHANGE-0099\n", { light: "x" }); } catch { threw = true; }
  ok(threw, "refuses (does not guess) when risk.tier/reviewer_required cannot be found at all");

  if (fails) { console.error(NL + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("record-review-verdict self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("record-review-verdict.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
