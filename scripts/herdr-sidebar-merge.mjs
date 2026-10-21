#!/usr/bin/env node
/**
 * herdr-sidebar-merge.mjs - put herdr-plugin/sidebar.config.toml into Herdr's config.toml,
 * replacing the harness block from an earlier install. Always writes a backup first.
 *
 * Handles:
 *   - a marked block (# >>> harness sidebar ... # <<< harness sidebar <<<)  -> replaced
 *   - the earlier unmarked install: [ui.sidebar.agents.rows_by_agent] holding only `pi`
 *     with $role tokens, and [ui.sidebar.spaces] with $pipeline                -> replaced
 *   - no sidebar tables at all                                               -> appended
 * Refuses (changes nothing) when those tables hold anything that is not ours.
 *
 *   node scripts/herdr-sidebar-merge.mjs [--config <path>] [--dry-run]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const START = "# >>> harness sidebar";
const END = "# <<< harness sidebar <<<";

export function mergeSidebar(config, snippet) {
	const text = String(config ?? "");
	const block = snippet.trim() + "\n";
	const s = text.indexOf(START), e = text.indexOf(END);
	if (s >= 0 && e > s) {
		const lineEnd = text.indexOf("\n", e);
		return { ok: true, how: "replaced the marked block", text: text.slice(0, s) + block + (lineEnd >= 0 ? text.slice(lineEnd + 1) : "") };
	}
	// split into [header] sections (the preamble has header null)
	const lines = text.split("\n");
	const sections = [];
	let cur = { header: null, lines: [] };
	for (const l of lines) {
		const h = l.match(/^\s*\[{1,2}([^\]]+)\]{1,2}\s*(#.*)?$/);
		if (h) { sections.push(cur); cur = { header: h[1].trim(), lines: [l] }; } else cur.lines.push(l);
	}
	sections.push(cur);
	const ours = { "ui.sidebar.agents.rows_by_agent": /\$role/, "ui.sidebar.spaces": /\$pipeline/ };
	let removed = 0;
	for (const sec of sections) {
		if (!(sec.header in ours)) continue;
		const body = sec.lines.slice(1).join("\n");
		const keys = [...body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
		const mine = ours[sec.header].test(body) && (sec.header !== "ui.sidebar.agents.rows_by_agent" || keys.every((k) => k === "pi"));
		const onlyRows = sec.header !== "ui.sidebar.spaces" || keys.every((k) => ["rows", "row_gap"].includes(k));
		if (!mine || !onlyRows) return { ok: false, why: `[${sec.header}] in your config holds settings that are not the harness's - merge herdr-plugin/sidebar.config.toml by hand` };
		sec.drop = true; removed++;
	}
	const kept = sections.filter((x) => !x.drop).flatMap((x) => x.lines).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
	return { ok: true, how: removed ? `replaced ${removed} harness table(s) from the earlier install` : "appended", text: kept + "\n" + block };
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const i = argv.indexOf("--config");
	const cfg = i >= 0 ? argv[i + 1] : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr", "config.toml");
	const snippet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "herdr-plugin", "sidebar.config.toml"), "utf8");
	const before = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
	const r = mergeSidebar(before, snippet);
	if (!r.ok) { console.error(`not changed: ${r.why}`); return 1; }
	if (argv.includes("--dry-run")) { process.stdout.write(r.text); return 0; }
	mkdirSync(dirname(cfg), { recursive: true });
	if (existsSync(cfg)) copyFileSync(cfg, `${cfg}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`);
	writeFileSync(cfg, r.text);
	console.error(`-> ${cfg}: ${r.how} (backup next to it). Reload: herdr server reload-config`);
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const snip = `${START} >>>\n[ui.sidebar.spaces]\nrows = [["$usage_1"]]\n${END}\n`;
	const old = `[ui]\ntheme = "x"\n\n[ui.sidebar.agents.rows_by_agent]\npi = [\n  ["state_icon", { token = "$role" }],\n]\n\n[ui.sidebar.spaces]\nrows = [\n  [{ token = "$pipeline" }],\n]\n\n[[keys.command]]\nkey = "prefix+u"\n`;
	let r = mergeSidebar(old, snip);
	ok(r.ok && !/\$role/.test(r.text) && /\$usage_1/.test(r.text) && /theme = "x"/.test(r.text) && /prefix\+u/.test(r.text), "replaces the earlier unmarked install, keeps everything else");
	const r2 = mergeSidebar(r.text, snip.replace("$usage_1", "$usage_2"));
	ok(r2.ok && /\$usage_2/.test(r2.text) && !/\$usage_1/.test(r2.text) && (r2.text.match(/>>> harness sidebar/g) || []).length === 1, "replaces the marked block in place");
	ok(!mergeSidebar(`[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]\npi = [["$role"]]\n`, snip).ok, "refuses when rows_by_agent also holds someone else's layout");
	ok(!mergeSidebar(`[ui.sidebar.spaces]\nrows = [["workspace"]]\n`, snip).ok, "refuses a spaces layout that is not ours");
	ok(mergeSidebar(`[ui]\ntheme = "y"\n`, snip).how === "appended", "appends when there is nothing to replace");
	if (fails) { console.error(`${fails} sidebar-merge self-test(s) FAILED`); return 1; }
	console.log("herdr-sidebar-merge self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
