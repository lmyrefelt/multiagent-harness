#!/usr/bin/env node
/**
 * check-qualification-env — can THIS container actually run a Gate-D /
 * full-regression PostgreSQL+Redis qualification, right now?
 *
 * WHY THIS EXISTS
 * Measured across real integrator reviews (CHANGE-0063 rounds 8-10, all of
 * CHANGE-0084, CHANGE-0073/integrator-review-2.md): a full review round gets
 * spent discovering, mid-review, that this container has no `docker`, no
 * compose, no reachable daemon - "Required command missing: docker"
 * (CHANGE-0084/integrator-review-3-codex.md), "Neither the worker container
 * nor the integrator container has one (6379 refused; no docker/redis-server)"
 * (CHANGE-0073/integrator-review-2.md, a PI-backed review - NOT codex-specific,
 * contrary to an earlier draft read of this data). Every real qualification in
 * this project's history was actually run on the OWNER'S host via that
 * change's own `run-qualification.sh` (see its header: "Host-only... requires
 * Docker Compose v2"). No integrator container, any backend, has ever
 * self-hosted one.
 *
 * So: this is NOT a request to give any container new capability (a docker
 * socket mount, docker-in-docker) - that would be a real, security-relevant
 * escalation for a guarded container and is deliberately out of scope here.
 * This is a 3-second preflight so an integrator finds out BEFORE spending a
 * review round narrating the same missing-Docker finding again: run this
 * first, and if it fails, go straight to telling the owner to run
 * `run-qualification.sh` on their own host.
 *
 *   node scripts/check-qualification-env.mjs
 *   node scripts/check-qualification-env.mjs --selftest
 *
 * Exit: 0 = this container can run a qualification itself. 1 = it cannot
 * (not an error - the correct next step is "ask the owner", not retry).
 */

import { execSync } from "node:child_process";

/**
 * Pure core: given an `exec(cmd) -> {ok, error}` probe, decide whether this
 * environment can run a Docker-Compose-based qualification. Mirrors
 * run-qualification.sh's own preflight (`command -v docker/uv`,
 * `docker compose version`, `docker info`) exactly - this checks the SAME
 * three things that script already requires, just earlier and without
 * attempting the actual qualification run.
 *
 * @param execFn (cmd: string) => { ok: boolean }
 * @returns { available: boolean, missing: string[] }
 */
export function probeQualificationEnv(execFn) {
  const checks = [
    ["docker", "docker"],
    ["uv", "uv"],
    ["docker compose", "docker compose version"],
    ["docker daemon", "docker info"],
  ];
  const missing = [];
  for (const [label, probeCmd] of checks) {
    const binCmd = probeCmd === label ? `command -v ${label}` : probeCmd;
    let r;
    try { r = execFn(binCmd); } catch { r = { ok: false }; }
    if (!r || !r.ok) missing.push(label);
  }
  return { available: missing.length === 0, missing };
}

function realExec(cmd) {
  try { execSync(cmd, { stdio: ["ignore", "ignore", "ignore"] }); return { ok: true }; }
  catch { return { ok: false }; }
}

function main() {
  const { available, missing } = probeQualificationEnv(realExec);
  if (available) {
    console.log("QUALIFICATION_ENV: available — docker, uv, compose, and the daemon all respond here.");
    process.exit(0);
  }
  console.log(
    `QUALIFICATION_ENV: unavailable — missing: ${missing.join(", ")}.\n` +
    `This container cannot run a Gate-D / full-regression PostgreSQL+Redis qualification.\n` +
    `No integrator container (pi, codex, or otherwise) has ever been able to - this is not\n` +
    `backend-specific and is not something to work around in-container (no docker-socket\n` +
    `mount, no docker-in-docker - that is a real capability escalation, out of scope).\n` +
    `Next step: ask the owner to run this change's own run-qualification.sh on their real\n` +
    `Docker host, and record that evidence instead of attempting it here.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
function selftest() {
  let fails = 0;
  const ok = (c, n) => { if (!c) { console.error("FAIL: " + n); fails++; } };

  const allOk = () => ({ ok: true });
  ok(probeQualificationEnv(allOk).available === true, "all four probes ok -> available");
  ok(probeQualificationEnv(allOk).missing.length === 0, "available case reports no missing items");

  const noDocker = (cmd) => ({ ok: !cmd.includes("docker") });
  const r1 = probeQualificationEnv(noDocker);
  ok(r1.available === false, "docker missing -> unavailable");
  ok(r1.missing.includes("docker") && r1.missing.includes("docker compose") && r1.missing.includes("docker daemon"),
    "a missing docker binary also fails compose and the daemon probe, all three reported");
  ok(!r1.missing.includes("uv"), "uv itself still reports ok when only docker-related probes fail");

  const daemonDown = (cmd) => ({ ok: !/docker info/.test(cmd) });
  const r2 = probeQualificationEnv(daemonDown);
  ok(r2.available === false, "REGRESSION: docker binary present but daemon unreachable must still fail closed, not report available");
  ok(r2.missing.length === 1 && r2.missing[0] === "docker daemon",
    "only the daemon probe is reported missing when docker/uv/compose all succeed");

  const noUv = (cmd) => ({ ok: !cmd.includes("uv") });
  ok(probeQualificationEnv(noUv).missing.includes("uv"), "uv missing is reported independently of docker");

  const throws = () => { throw new Error("boom"); };
  let threw = false;
  try { probeQualificationEnv(throws); } catch { threw = true; }
  ok(!threw, "a throwing execFn must not crash probeQualificationEnv — real callers wrap exec in try/catch themselves, but this core must stay defensive");

  if (fails) { console.error("\n" + fails + " self-test(s) FAILED"); process.exit(1); }
  console.log("check-qualification-env self-test: all passed");
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("check-qualification-env.mjs");
if (invokedDirectly) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
