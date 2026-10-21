#!/usr/bin/env node
// preaccept-startup.mjs - record the one-time "do you trust this folder?" style
// answers BEFORE an agent CLI starts, so an unattended container never stops at
// a startup question nobody is there to answer (2026-10-18).
//
//   node scripts/preaccept-startup.mjs claude <host claude.json>   <container workdir>
//   node scripts/preaccept-startup.mjs codex  <host config.toml>   <container workdir>
//   node scripts/preaccept-startup.mjs agy    <antigravity settings.json> <container workdir>
//   node scripts/preaccept-startup.mjs --selftest
//
// Only STARTUP prompts are pre-answered. Nothing here widens what an agent may
// DO: tool permissions stay with each launcher's flags, and the contract guard
// hooks keep enforcing boundaries. Each file is edited in place, keeping every
// existing key; a write is atomic (temp file + rename) because these files are
// shared by every launch.
//   claude: ~/.claude.json projects[<dir>].hasTrustDialogAccepted (+ project
//           onboarding), top-level hasCompletedOnboarding and the one-time
//           --dangerously-skip-permissions warning (bypassPermissionsModeAccepted).
//   codex:  config.toml [projects."<dir>"] trust_level = "trusted".
//   agy:    settings.json trustedWorkspaces[] (antigravity-cli folder trust).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson(path) {
  if (!existsSync(path)) return {};
  const t = readFileSync(path, "utf8").trim();
  return t ? JSON.parse(t) : {};
}

export function acceptClaude(file, dir) {
  const j = readJson(file);
  j.hasCompletedOnboarding = true;
  j.bypassPermissionsModeAccepted = true;
  j.projects ??= {};
  // the workdir AND its repo root (/repo): Claude Code treats a trusted parent as trusting its subfolders;
  // the hooks/external-include flags cover the extra trust questions newer versions ask when the
  // harness passes hooks via --settings or CLAUDE.md includes files outside the folder
  const trust = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, hasTrustDialogHooksAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true, projectOnboardingSeenCount: 1 };
  for (const d of new Set([dir, dir.split("/").slice(0, 2).join("/") || dir])) j.projects[d] = { ...(j.projects[d] ?? {}), ...trust };
  atomicWrite(file, JSON.stringify(j, null, 2));
}

export function acceptCodex(file, dir) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const header = `[projects."${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  if (text.split("\n").some((l) => l.trim() === header)) return; // already recorded (never rewrite a user's own entry)
  atomicWrite(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${header}\ntrust_level = "trusted"\n`);
}

export function acceptAgy(file, dir) {
  const j = readJson(file);
  const list = Array.isArray(j.trustedWorkspaces) ? j.trustedWorkspaces : [];
  if (!list.includes(dir)) list.push(dir);
  j.trustedWorkspaces = list;
  atomicWrite(file, JSON.stringify(j, null, 2));
}

function selftest() {
  let fails = 0;
  const ok = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
  const d = mkdtempSync(join(tmpdir(), "preaccept-"));
  try {
    const cj = join(d, "claude.json");
    writeFileSync(cj, JSON.stringify({ oauthAccount: { x: 1 }, projects: { "/repo/a": { allowedTools: ["Bash"] } } }));
    acceptClaude(cj, "/repo/a"); acceptClaude(cj, "/repo/b");
    const c = JSON.parse(readFileSync(cj, "utf8"));
    ok(c.oauthAccount?.x === 1, "claude: existing account data kept");
    ok(c.projects["/repo/a"].hasTrustDialogAccepted && c.projects["/repo/a"].allowedTools?.[0] === "Bash", "claude: trust added, project's own keys kept");
    ok(c.projects["/repo/b"].hasTrustDialogAccepted && c.hasCompletedOnboarding && c.bypassPermissionsModeAccepted, "claude: new project + onboarding + bypass warning accepted");
    ok(c.projects["/repo"]?.hasTrustDialogAccepted && c.projects["/repo/b"].hasTrustDialogHooksAccepted, "claude: repo root trusted too, hooks trust accepted");
    const empty = join(d, "empty.json"); writeFileSync(empty, "{}"); acceptClaude(empty, "/repo"); ok(readJson(empty).projects["/repo"].hasTrustDialogAccepted, "claude: works on the {} placeholder");
    const tc = join(d, "config.toml");
    writeFileSync(tc, 'model = "gpt-5"\n');
    acceptCodex(tc, "/repo/.worktrees/x"); acceptCodex(tc, "/repo/.worktrees/x");
    const t = readFileSync(tc, "utf8");
    ok(t.startsWith('model = "gpt-5"'), "codex: user's own settings kept");
    ok(t.split('[projects."/repo/.worktrees/x"]').length === 2 && t.includes('trust_level = "trusted"'), "codex: trust entry written once (idempotent)");
    const missing = join(d, "sub", "config.toml"); acceptCodex(missing, "/repo"); ok(readFileSync(missing, "utf8").includes('[projects."/repo"]'), "codex: creates config.toml if missing");
    const ag = join(d, "settings.json");
    writeFileSync(ag, JSON.stringify({ permissions: { allow: ["git status"] } }));
    acceptAgy(ag, "/repo/w"); acceptAgy(ag, "/repo/w");
    const a = readJson(ag);
    ok(a.permissions.allow[0] === "git status" && a.trustedWorkspaces.length === 1 && a.trustedWorkspaces[0] === "/repo/w", "agy: baseline kept, workspace trusted once");
  } finally { rmSync(d, { recursive: true, force: true }); }
  if (fails) { console.error(`${fails} FAILED`); process.exit(1); }
  console.log("preaccept-startup self-test: all passed");
}

const [kind, file, dir] = process.argv.slice(2);
if (kind === "--selftest") selftest();
else if (kind && file && dir) {
  try {
    // (was: fn?.(file, dir) ?? exit(2) - every accept function returns undefined, so the
    // "unknown kind" branch fired AFTER a successful write and failed every launch, 2026-10-18)
    const fn = { claude: acceptClaude, codex: acceptCodex, agy: acceptAgy, antigravity: acceptAgy }[kind];
    if (!fn) { console.error(`preaccept-startup: unknown kind '${kind}'`); process.exit(2); }
    fn(file, dir);
  } catch (e) {
    // Never block a launch over this: worst case the CLI asks its question once.
    console.error(`WARN: could not pre-accept ${kind} startup prompts in ${file}: ${e.message}`);
  }
} else { console.error("usage: preaccept-startup.mjs <claude|codex|agy> <file> <container-workdir> | --selftest"); process.exit(2); }
