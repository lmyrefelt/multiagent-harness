// Loader + validator for project.yaml. Kept separate so it is testable without
// a project and without a model.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/yaml");

export function globToRe(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; } }
      else out += "[^/]*";
    } else if ("\\^$+.()|{}[]?".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
}

/** Load project.yaml, or return null when absent. */
export function loadManifest(path) {
  if (!path || !existsSync(path)) return null;
  const raw = YAML.parse(readFileSync(path, "utf8"));
  if (!raw?.project) throw new Error(`${path}: missing required 'project:' key`);
  return raw;
}

/**
 * Validate every declared path against the seeded copy. This is the whole point:
 * a project says where its structure lives, and a mismatch is a one-second error
 * rather than a five-run mystery.
 */
export function validateManifest(manifest, root) {
  const problems = [];
  const seen = [];
  const check = (label, rel) => {
    if (!rel) return;
    if (existsSync(join(root, rel))) { seen.push(`${label}: ${rel}`); return; }
    // allow a directory
    if (existsSync(join(root, rel)) ) { seen.push(`${label}: ${rel}`); return; }
    problems.push(`${label}: "${rel}" is declared but not present in the copy`);
  };
  check("contract", manifest.contract);
  check("onboarding", manifest.onboarding);
  check("task_state", manifest.task_state);
  // P2. Previously these were accepted WITHOUT being resolved, so a typo'd spec
  // glob validated cleanly. A check that cannot fail is not a check.
  for (const g of manifest.specs ?? []) {
    if (globHasWildcard(g)) {
      const n = countMatches(root, g);
      if (n === 0) problems.push(`specs: "${g}" matches no file in the copy`);
      else seen.push(`specs: ${g} -> ${n} file(s)`);
    } else if (existsSync(join(root, g))) {
      seen.push(`specs: ${g}`);
    } else {
      problems.push(`specs: "${g}" is declared but not present in the copy`);
    }
  }
  return { problems, seen };
}

/** Derive the boundary. A task_state outside `allow` is a design error. */
export function deriveBoundary(manifest) {
  const allow = manifest?.boundary?.allow ?? [];
  const deny = manifest?.boundary?.deny ?? [];
  const warnings = [];
  const ts = manifest?.task_state;
  if (ts && allow.length) {
    const inside = allow.some((a) => ts.startsWith(a.replace(/\/\*\*.*$/, "").replace(/\/$/, "")));
    if (!inside) {
      warnings.push(
        `task_state "${ts}" is OUTSIDE boundary.allow — the worker cannot write its own task\n` +
        `         state, so it can never claim a task. This is a contract design error,\n` +
        `         not a harness one. Add its directory to boundary.allow.`
      );
    }
  }
  return { allow, deny, warnings };
}

/** The test command + evidence patterns, or null if the project declares none. */
export function deriveTests(manifest) {
  const t = manifest?.tests;
  if (!t?.command) return null;
  return { command: t.command, ran: t.ran ?? [], passed: t.passed ?? [], failed: t.failed ?? [] };
}

/** Completion is machine-assertable only when the project says how. */
export function completionIsAssertable(manifest) {
  return manifest?.done_when === "machine" || typeof manifest?.done_when === "object";
}

const WILDCARD = /[*?]/;
export function globHasWildcard(g) { return WILDCARD.test(g); }
export function countMatches(root, glob) {
  let n = 0;
  const walk = (d, prefix) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (globToRe(glob).test(rel)) n++;
    }
  };
  walk(root, "");
  return n;
}
export { resolve };
