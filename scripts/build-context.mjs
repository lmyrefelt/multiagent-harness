#!/usr/bin/env node
/**
 * build-context.mjs - the project context file every worker reads FIRST, so sub-agents stop
 * re-exploring the repository on every task (owner, 2026-10-20; idea from a Reddit setup:
 * "read this, don't re-read the source for it").
 *
 * Writes .pi-session/CONTEXT.md (generated, not committed; every container sees it at
 * /repo/.pi-session/CONTEXT.md). It is rebuilt by the watcher after every merge and by hand:
 *
 *   node scripts/build-context.mjs            write it
 *   node scripts/build-context.mjs --print    print it
 *   node scripts/build-context.mjs --selftest
 *
 * Generated sections: layout, autoloads in load order with their public API, class_name
 * scripts with their public API, tests and how to run them, decisions (ADRs), harness
 * commands. Hand-written knowledge (session patterns, gotchas, conventions) lives in
 * docs/CONTEXT-notes.md - committed, maintained by the planner/integrator - and is
 * included verbatim at the top.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Public API of a GDScript file: class_name, extends, signals, consts, public funcs (one line each). Pure. */
export function gdApi(text) {
	const out = { className: null, extends: null, signals: [], funcs: [], consts: [] };
	for (const raw of String(text).split("\n")) {
		const l = raw.replace(/\s+#.*$/, "");
		let m;
		if ((m = l.match(/^class_name\s+(\w+)/))) out.className = m[1];
		else if ((m = l.match(/^extends\s+(\S+)/))) out.extends = m[1];
		else if ((m = l.match(/^signal\s+(\w+\s*(\([^)]*\))?)/))) out.signals.push(m[1].replace(/\s+/g, " "));
		else if ((m = l.match(/^const\s+([A-Z][A-Z0-9_]*)\b/))) out.consts.push(m[1]);
		else if ((m = l.match(/^(static\s+)?func\s+([a-zA-Z]\w*)\s*(\([^)]*\))\s*(->\s*[\w\[\]]+)?/))) out.funcs.push(`${m[1] ? "static " : ""}${m[2]}${m[3].replace(/\s+/g, " ")}${m[4] ? " " + m[4].replace(/\s+/g, " ").trim() : ""}`);
	}
	return out;
}

/** [autoload] section of project.godot -> [{ name, path }] in load order. Pure. */
export function autoloads(projectGodot) {
	const sec = String(projectGodot).split(/^\[autoload\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
	return [...sec.matchAll(/^(\w+)="\*?res:\/\/([^"]+)"/gm)].map((m) => ({ name: m[1], path: m[2] }));
}

function walk(dir, test, out = [], depth = 8) {
	let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of es) {
		if (e.name.startsWith(".") || e.name === "addons" || e.name === "node_modules") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (depth > 0) walk(p, test, out, depth - 1); } else if (test(e.name, p)) out.push(p);
	}
	return out;
}

export function buildContext(repo) {
	const gp = join(repo, "godot-project");
	const rel = (p) => relative(repo, p);
	const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
	const L = ["# Project context", "",
		"Read this BEFORE exploring the repository. It is generated from the code (`node scripts/build-context.mjs`, rebuilt after every merge), so it is current for main. Do not re-read source files just to learn what is summarised here; open a file only when you change it or need a body. All paths are relative to the repository root (`/repo` in a container).", ""];
	const notes = read(join(repo, "docs", "CONTEXT-notes.md")).trim();
	if (notes) L.push("## Notes (hand-written, docs/CONTEXT-notes.md)", "", notes.replace(/^#\s.*\n+/, ""), "");

	// layout
	L.push("## Layout", "");
	for (const top of ["godot-project", "docs", "scripts", "contracts", "herdr-plugin"]) {
		const d = join(repo, top);
		if (!existsSync(d)) continue;
		let subs = []; try { subs = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "addons"); } catch { /* */ }
		const counts = subs.map((s) => `${s.name}/ (${walk(join(d, s.name), () => true).length})`);
		L.push(`- \`${top}/\`${counts.length ? ": " + counts.join(", ") : ""}`);
	}
	L.push("");

	// autoloads
	const pg = read(join(gp, "project.godot"));
	const al = autoloads(pg);
	if (al.length) {
		L.push("## Autoloads (singletons, in load order - a later one may rely on an earlier one)", "");
		for (const a of al) {
			const api = gdApi(read(join(gp, a.path)));
			L.push(`### ${a.name} - \`godot-project/${a.path}\``);
			if (api.signals.length) L.push(`- signals: ${api.signals.join("; ")}`);
			if (api.funcs.length) L.push(`- funcs: ${api.funcs.join("; ")}`);
			if (api.consts.length) L.push(`- consts: ${api.consts.slice(0, 20).join(", ")}${api.consts.length > 20 ? " ..." : ""}`);
			L.push("");
		}
	}

	// class_name scripts (outside autoloads)
	const alPaths = new Set(al.map((a) => join(gp, a.path)));
	const classes = walk(gp, (n) => n.endsWith(".gd")).filter((p) => !alPaths.has(p) && !/\/tests?\//.test(p)).map((p) => ({ p, api: gdApi(read(p)) })).filter((x) => x.api.className);
	if (classes.length) {
		L.push("## Classes (class_name)", "");
		for (const { p, api } of classes.sort((a, b) => a.api.className.localeCompare(b.api.className))) {
			L.push(`- **${api.className}**${api.extends ? ` (extends ${api.extends})` : ""} - \`${rel(p)}\`${api.funcs.length ? `: ${api.funcs.slice(0, 14).join("; ")}${api.funcs.length > 14 ? "; ..." : ""}` : ""}`);
		}
		L.push("");
	}

	// other scripts by folder (names only)
	const other = walk(gp, (n) => n.endsWith(".gd")).filter((p) => !alPaths.has(p) && !classes.some((c) => c.p === p) && !/\/tests?\//.test(p));
	if (other.length) {
		const byDir = {};
		for (const p of other) (byDir[rel(dirname(p))] ??= []).push(p.split("/").pop());
		L.push("## Other scripts", "", ...Object.entries(byDir).sort().map(([d, fs]) => `- \`${d}/\`: ${fs.sort().join(", ")}`), "");
	}

	// tests
	const td = join(gp, "tests");
	if (existsSync(td)) {
		L.push("## Tests", "");
		let suites = []; try { suites = readdirSync(td, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* */ }
		L.push(`- suites (\`godot-project/tests/\`): ${suites.join(", ")}`);
		for (const f of ["run_qualification.sh", "export_web.sh"]) if (existsSync(join(td, f))) L.push(`- \`godot-project/tests/${f}\``);
		L.push("- A change's own test command is `tests.command` in its change.yaml - run THAT, it is what the completion gate checks.");
		L.push("- Godot engine/render/browser checks run on the render host, not in your container: report `needs-qualification` (see AGENTS.md).", "");
	}

	// decisions
	const dd = join(repo, "docs", "decisions");
	if (existsSync(dd)) {
		const adrs = readdirSync(dd).filter((f) => f.endsWith(".md")).sort();
		L.push("## Decisions (ADRs) - binding; read the one you touch", "", ...adrs.map((f) => { const t = (read(join(dd, f)).match(/^#\s+(.*)$/m) || [])[1] ?? ""; return `- \`docs/decisions/${f}\`${t ? " - " + t : ""}`; }), "");
	}

	L.push("## Harness commands", "",
		"- report your result (LAST action): `node /repo/scripts/handoff.mjs report --change CHANGE-NNNN --role <role> --verdict <v> --file <report> --note '<one line>'`",
		"- start your report from the template: `node /repo/scripts/handoff.mjs new --change CHANGE-NNNN --role <role>`",
		"- status of every change: `/repo/.pi-session/STATUS.md`", "");
	return L.join("\n");
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--selftest")) return selftest();
	const repo = process.env.HARNESS_REPO_ROOT || resolve(HERE, "..");
	const md = buildContext(repo);
	if (argv.includes("--print")) { process.stdout.write(md); return 0; }
	mkdirSync(join(repo, ".pi-session"), { recursive: true });
	writeFileSync(join(repo, ".pi-session", "CONTEXT.md"), md);
	console.log(`wrote .pi-session/CONTEXT.md (${md.length} chars, ~${Math.round(md.length / 4)} tokens)`);
	return 0;
}

function selftest() {
	let fails = 0;
	const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } };
	const api = gdApi('class_name SaveStore\nextends Node\nsignal saved(slot: int)\nconst MAX_SLOTS := 3\nfunc save(slot: int, data: Dictionary) -> bool:\n\tpass\nfunc _ready():\n\tpass\nstatic func load_slot(slot: int) -> Dictionary:\n\tpass\n');
	ok(api.className === "SaveStore" && api.extends === "Node" && api.signals[0] === "saved(slot: int)" && api.consts[0] === "MAX_SLOTS", "class, extends, signal, const");
	ok(api.funcs.length === 2 && api.funcs[0] === "save(slot: int, data: Dictionary) -> bool" && api.funcs[1].startsWith("static load_slot"), `public funcs only (got ${JSON.stringify(api.funcs)})`);
	const al = autoloads('[application]\nx=1\n[autoload]\n\nGameConfig="*res://autoload/game_config.gd"\nSaveManager="*res://autoload/save_manager.gd"\n\n[display]\n');
	ok(al.length === 2 && al[1].name === "SaveManager" && al[1].path === "autoload/save_manager.gd", "autoload order");
	if (fails) { console.error(`${fails} build-context self-test(s) FAILED`); return 1; }
	console.log("build-context self-test: all passed");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
