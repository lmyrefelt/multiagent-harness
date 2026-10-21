#!/usr/bin/env node
/**
 * check-dockerfile — validate the image build inputs BEFORE you run the build.
 *
 * WHY THIS EXISTS
 * This Dockerfile shipped four bugs in a row, all of the same two species:
 *
 *   1. A COPY source that .dockerignore excludes (or that does not exist), so
 *      the build dies with `"/x": not found`.
 *   2. A RUN whose continuation lines lack a `\`, so the Dockerfile parser
 *      treats them as new instructions (`unknown instruction: const`).
 *
 * Both are invisible to review and cheap to detect. Both are checked here.
 * This is the same discipline as the guard suite, applied to the image.
 *
 * Checks:
 *   - every COPY source exists on disk
 *   - every COPY source survives .dockerignore
 *   - every RUN continuation is backslash-continued
 *   - no bare multi-line `node -e '` block (the quoting trap)
 *   - no suspicious bare filename in .dockerignore (a file the image needs)
 *
 * Usage: node check-dockerfile.mjs [--context DIR] [--dockerfile FILE]
 * Exit 0 = safe to build. Exit 1 = do not waste a build cycle.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CTX = resolve(arg("--context", process.cwd()));
const DOCKERFILE = arg("--dockerfile", join(CTX, "Dockerfile.pi-contracts"));
const IGNORE = join(CTX, ".dockerignore");

// --- .dockerignore semantics (gitignore subset) -----------------------------
function parseIgnore(text) {
	const rules = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		const pat = (negated ? line.slice(1) : line).trim();
		if (!pat) continue;
		rules.push({
			negated,
			dirOnly: pat.endsWith("/"),
			pattern: pat.replace(/^\//, "").replace(/\/$/, ""),
			anchored: pat.includes("/"),
		});
	}
	return rules;
}

/** Compile one rule to a RegExp. `**` spans directories, `*` does not. */
function ruleToRe(r) {
	let re = "";
	const p = r.pattern;
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "*" && p[i + 1] === "*") {
			if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
			else { re += ".*"; i += 1; }
		} else if (p[i] === "*") re += "[^/]*";
		else if ("\\^$+.()|{}[]?".includes(p[i])) re += "\\" + p[i];
		else re += p[i];
	}
	return new RegExp("^" + re + "$");
}

function isIgnored(relPath, rules) {
	let ignored = false;
	for (const r of rules) {
		let re;
		try { re = ruleToRe(r); } catch { continue; }
		// A non-anchored pattern matches at any depth (gitignore behaviour).
		const hit = r.anchored ? re.test(relPath) : re.test(relPath) || re.test(relPath.split("/").pop() ?? "");
		if (hit) ignored = !r.negated;
	}
	return ignored;
}

// --- run --------------------------------------------------------------------
const problems = [];
const notes = [];

if (!existsSync(DOCKERFILE)) {
	console.error(`check-dockerfile: no Dockerfile at ${DOCKERFILE}`);
	process.exit(1);
}
const df = readFileSync(DOCKERFILE, "utf8");
const rules = existsSync(IGNORE) ? parseIgnore(readFileSync(IGNORE, "utf8")) : [];

// 1 + 2: COPY sources
const copies = [];
for (const line of df.split("\n")) {
	if (!/^\s*COPY\s/i.test(line)) continue;
	const parts = line.trim().split(/\s+/).slice(1).filter((a) => !a.startsWith("--"));
	// `COPY src... dest` — everything except the LAST token is a source.
	for (const a of parts.slice(0, -1)) copies.push(a);
}

console.log("check-dockerfile");
console.log("=================");
console.log(`context     ${CTX}`);
console.log(`dockerfile  ${DOCKERFILE.replace(CTX + sep, "")}`);
console.log(`ignore      ${existsSync(IGNORE) ? ".dockerignore (" + rules.length + " rules)" : "(none)"}`);
console.log("");

for (const src of copies) {
	const onDisk = existsSync(join(CTX, src));
	const ignored = isIgnored(src, rules);
	let verdict = "ok";
	if (ignored) { verdict = "IGNORED BY .dockerignore"; problems.push(`COPY source excluded by .dockerignore: ${src}`); }
	else if (!onDisk) { verdict = "MISSING ON DISK"; problems.push(`COPY source does not exist: ${src}`); }
	console.log(`  ${verdict === "ok" ? "ok  " : "FAIL"}  ${src.padEnd(42)} ${verdict === "ok" ? "" : verdict}`);
}

// 3: RUN continuations
console.log("\nRUN continuation check");
const lines = df.split("\n");
let runIssues = 0;
for (let i = 0; i < lines.length; i++) {
	if (!/^RUN\s/.test(lines[i])) continue;
	let j = i;
	while (lines[j].trimEnd().endsWith("\\") && j + 1 < lines.length) j++;
	const next = lines[j + 1];
	if (next === undefined) continue;
	if (/^\s+\S/.test(next) && !lines[j].trimEnd().endsWith("\\")) {
		// a continuation-looking line after a RUN that did not end with \
		problems.push(`line ${j + 2}: RUN at line ${i + 1} has an un-continued line: ${next.trim()}`);
		runIssues++;
	}
}
console.log(`  ${runIssues === 0 ? "ok  " : "FAIL"}  ${lines.filter((l) => /^RUN\s/.test(l)).length} RUN instructions, ${runIssues} broken continuation(s)`);

// 4: the quoting trap
const inlineJs = /^RUN\s+node\s+-e\s+'?$/m.test(df);
if (inlineJs) problems.push("multi-line `RUN node -e '` block: the Dockerfile parser will read the body as new instructions");
console.log(`  ${inlineJs ? "FAIL" : "ok  "}  no multi-line inline node -e blocks`);

// 5: bare filenames in .dockerignore that the image needs
if (rules.length) {
	for (const need of ["models.json", "settings.defaults.json"]) {
		if (isIgnored(need, rules)) {
			problems.push(`.dockerignore excludes ${need}, which the image requires`);
			console.log(`  FAIL  .dockerignore excludes required file: ${need}`);
		}
	}
}

// --- verdict ----------------------------------------------------------------
console.log("");
if (problems.length) {
	console.log(`${problems.length} problem(s) — do not run the build:`);
	for (const p of problems) console.log(`  - ${p}`);
	process.exit(1);
}
console.log("Dockerfile inputs look consistent. Safe to build.");
for (const n of notes) console.log(`  note: ${n}`);
