#!/usr/bin/env node
/**
 * image-setup — configure and VERIFY the pi agent directory inside the image.
 *
 * Run at build time, after `pi install` and before the image is considered
 * good. Two jobs:
 *
 *   1. merge our worker defaults into <agent-dir>/settings.json WITHOUT
 *      clobbering the `packages` array that `pi install` writes.
 *      A plain `COPY settings.json` over that file silently de-registers
 *      every extension: they sit in node_modules and pi never loads them.
 *      That bug shipped in v1 of this Dockerfile.
 *
 *   2. assert the result. Do not trust the merge — check it. A container that
 *      lost its extensions looks perfectly healthy and enforces nothing.
 *
 * This lives in a file rather than `RUN node -e '...'` because the Dockerfile
 * parser does not understand shell quoting across lines: a multi-line
 * single-quoted block is read as additional Dockerfile instructions.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const AGENT_DIR = process.env.AGENT_DIR ?? "/home/node/.pi/agent";
const SETTINGS = `${AGENT_DIR}/settings.json`;
const DEFAULTS = process.env.SETTINGS_DEFAULTS ?? "/tmp/settings.defaults.json";
const MODULES = `${AGENT_DIR}/npm/node_modules`;

const WANT = ["pi-localllm-provider", "pi-web-access", "pi-cache-optimizer"];

function fail(msg) {
	console.error(`image-setup: ${msg}`);
	process.exit(1);
}

// --- 1. merge ---------------------------------------------------------------
const cur = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
if (!existsSync(DEFAULTS)) fail(`defaults file not found: ${DEFAULTS}`);
const def = JSON.parse(readFileSync(DEFAULTS, "utf8"));

const before = (cur.packages ?? []).length;
const merged = { ...cur, ...def, packages: cur.packages ?? [] };
// Keys that only exist in our defaults fragment must not masquerade as config.
for (const k of Object.keys(merged)) if (k.startsWith("_")) delete merged[k];
writeFileSync(SETTINGS, JSON.stringify(merged, null, 2) + "\n");
console.log(`image-setup: merged defaults into ${SETTINGS} (packages preserved: ${before})`);

// --- 2. verify ---------------------------------------------------------------
const s = JSON.parse(readFileSync(SETTINGS, "utf8"));
const have = (s.packages ?? []).map((p) => String(p).replace(/^npm:/, ""));

const unregistered = WANT.filter((w) => !have.includes(w));
if (unregistered.length) {
	fail(`extensions not registered in settings.json: ${unregistered.join(", ")}\n` +
		`  registered: ${JSON.stringify(s.packages)}`);
}

const missing = WANT.filter((w) => !existsSync(`${MODULES}/${w}`));
if (missing.length) {
	fail(`extensions registered but not installed on disk: ${missing.join(", ")}\n` +
		`  looked in: ${MODULES}`);
}

if (!Array.isArray(s.defaultTools) || s.defaultTools.length === 0) {
	fail("defaultTools missing or empty — the worker would start with no built-in tools");
}

console.log(`image-setup: OK — registered and on disk: ${WANT.join(", ")}`);
console.log(`image-setup: OK — defaultTools: ${s.defaultTools.join(", ")}`);
