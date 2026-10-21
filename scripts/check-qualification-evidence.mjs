#!/usr/bin/env node
/**
 * check-qualification-evidence — one command instead of a review round to
 * answer "is this run-qualification.sh output actually good enough yet?"
 *
 * WHY THIS EXISTS
 * Every real change's run-qualification.sh (CHANGE-0077, CHANGE-0084, ...)
 * writes `revision.txt` (the git sha it qualified) and, ONLY on full success
 * (both runs, zero failures/errors/skips, confirmed by `host-qualification.py
 * validate` against the JUnit XML), `PASSED.txt`. MEASURED: CHANGE-0063's
 * rounds 9-11 and CHANGE-0073's rounds 5-8 are a slow "is it ready yet?" loop
 * re-litigating this same question in prose each time, instead of reading
 * two files. This collapses that into one command: does PASSED.txt exist,
 * and does revision.txt match the revision actually being merged.
 *
 * This does NOT replace run-qualification.sh and does NOT run anything
 * itself - it only reads what that script already wrote. "na"/fail results
 * here mean "go run it (again)," never "this script couldn't tell so assume
 * it's fine."
 *
 *   node scripts/check-qualification-evidence.mjs <evidence-dir> [revision]
 *   node scripts/check-qualification-evidence.mjs --selftest
 *
 * revision defaults to `git rev-parse HEAD` if omitted.
 * Exit: 0 = qualified at that revision. 1 = not (stale, incomplete, or missing).
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * @param revisionText contents of revision.txt, or null if the file is absent.
 * @param passedExists whether PASSED.txt exists in the same evidence dir.
 * @param currentRevision the sha this evidence is being checked AGAINST (the
 *   branch's actual current tip, or whatever revision the integrator is
 *   about to merge) - required, since "qualified at SOME revision" is not
 *   the same claim as "qualified at THIS one."
 * @returns { verdict: "pass"|"fail", reason }
 */
export function evaluateQualificationEvidence(revisionText, passedExists, currentRevision) {
  if (revisionText == null) {
    return { verdict: "fail", reason: "revision.txt not found in the evidence directory - this was never a real run-qualification.sh output, or the path given is wrong" };
  }
  if (!currentRevision) {
    return { verdict: "fail", reason: "no current revision to compare against was given" };
  }
  const qualified = revisionText.trim();
  const matches = qualified === currentRevision || qualified.startsWith(currentRevision) || currentRevision.startsWith(qualified);
  if (!matches) {
    return {
      verdict: "fail",
      reason: `evidence qualifies revision ${qualified.slice(0, 8)}, but the revision being checked is ${currentRevision.slice(0, 8)} - ` +
        `stale evidence, a new commit landed after this qualification run and it must be re-run`,
    };
  }
  if (!passedExists) {
    return {
      verdict: "fail",
      reason: "revision matches, but PASSED.txt is absent - the qualification run did not complete both passes with zero " +
        "failures/errors/skips (run-qualification.sh only writes PASSED.txt on full success; a partial or failed run leaves it missing)",
    };
  }
  return { verdict: "pass", reason: `revision ${qualified.slice(0, 8)} is qualified — both runs passed with zero failures/errors/skips` };
}

// ---------------------------------------------------------------------------
function main() {
  const evidenceDir = process.argv[2];
  if (!evidenceDir) {
    console.error("usage: node scripts/check-qualification-evidence.mjs <evidence-dir> [revision]");
    process.exit(1);
  }
  let revisionText = null;
  try { revisionText = readFileSync(join(evidenceDir, "revision.txt"), "utf8"); } catch { /* absent */ }
  const passedExists = existsSync(join(evidenceDir, "PASSED.txt"));

  let currentRevision = process.argv[3];
  if (!currentRevision) {
    try { currentRevision = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); }
    catch { currentRevision = null; }
  }

  const r = evaluateQualificationEvidence(revisionText, passedExists, currentRevision);
  console.log(`QUALIFICATION_EVIDENCE: ${r.verdict} — ${r.reason}`);
  process.exit(r.verdict === "pass" ? 0 : 1);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  ok(evaluateQualificationEvidence(null, true, "abc123").verdict === "fail",
    "no revision.txt at all -> fail, regardless of PASSED.txt");
  ok(evaluateQualificationEvidence("abc123\n", false, "abc123").verdict === "fail",
    "revision matches but PASSED.txt absent -> fail (run never fully succeeded)");
  ok(evaluateQualificationEvidence("abc123\n", true, "abc123").verdict === "pass",
    "exact revision match + PASSED.txt present -> pass");
  ok(evaluateQualificationEvidence("abc123\n", true, "abc123def456").verdict === "pass",
    "a short-sha revision.txt matching the current full sha's prefix still passes");
  ok(evaluateQualificationEvidence("abc123def456\n", true, "abc123").verdict === "pass",
    "the reverse prefix direction also passes (current revision given short, evidence has the full sha)");
  ok(evaluateQualificationEvidence("deadbee\n", true, "abc123def456").verdict === "fail",
    "REGRESSION (CHANGE-0063 rounds 9-11, CHANGE-0073 rounds 5-8): a revision mismatch is stale evidence, not reusable");
  ok(evaluateQualificationEvidence("abc123\n", true, null).verdict === "fail",
    "no current revision given at all -> fail closed, never assume a match");
  ok(/zero failures\/errors\/skips/.test(evaluateQualificationEvidence("abc123\n", true, "abc123").reason),
    "a passing verdict's reason names what was actually confirmed, not just 'ok'");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("check-qualification-evidence self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("check-qualification-evidence.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
