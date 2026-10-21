#!/usr/bin/env node
/**
 * secrets.mjs - API keys for every harness and project, from ONE place: the macOS Keychain
 * (owner, 2026-10-21). Store a key once:
 *
 *   security add-generic-password -U -s harness.openai -a "$USER" -w
 *
 * Names in use: openai, openai_metrics (admin key, usage/costs API), aistudio, vertex, opencode,
 * openrouter. Lookup order, first hit wins:
 *   1. environment: HARNESS_SECRET_<NAME> or the usual variable (OPENAI_API_KEY, ...)
 *   2. macOS Keychain service "harness.<name>" (any account)
 *   3. ~/.config/harness/secrets.env  (NAME=value; for Linux hosts; chmod 600)
 * Keys are never written anywhere by this script and never printed except by `get`, which
 * exists so shell launchers can export a key into ONE container that needs it.
 *
 *   node scripts/secrets.mjs list            which keys are found (never their values)
 *   node scripts/secrets.mjs get <name>      print one key (for launch scripts)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const NAMES = ["openai", "openai_metrics", "aistudio", "vertex", "opencode", "openrouter", "jules"];
const ENV_ALIASES = { openai: ["OPENAI_API_KEY"], openai_metrics: ["OPENAI_ADMIN_KEY"], aistudio: ["GEMINI_FREE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"], vertex: ["VERTEX_API_KEY"], opencode: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], jules: ["JULES_API_KEY"] };
const cache = new Map();

function fromFile(name) {
	try {
		for (const l of readFileSync(join(homedir(), ".config", "harness", "secrets.env"), "utf8").split("\n")) {
			const m = l.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
			if (m && (m[1] === name || m[1] === `harness.${name}` || m[1] === name.toUpperCase())) return m[2].replace(/^["']|["']$/g, "");
		}
	} catch { /* none */ }
	return null;
}

/** The key for <name>, or null. */
export function getSecret(name, env = process.env) {
	if (cache.has(name)) return cache.get(name);
	let v = env[`HARNESS_SECRET_${name.toUpperCase()}`] || (ENV_ALIASES[name] ?? []).map((k) => env[k]).find(Boolean) || null;
	if (!v && process.platform === "darwin") {
		try { v = execFileSync("security", ["find-generic-password", "-s", `harness.${name}`, "-w"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* not stored */ }
	}
	if (!v) v = fromFile(name);
	cache.set(name, v);
	return v;
}

function main() {
	const [cmd, name] = process.argv.slice(2);
	if (cmd === "list") { for (const n of NAMES) console.log(`${n.padEnd(16)} ${getSecret(n) ? "found" : "-"}`); return 0; }
	if (cmd === "get" && name) { const v = getSecret(name); if (!v) return 1; process.stdout.write(v); return 0; }
	console.error("usage: secrets.mjs list | get <name>");
	return 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
