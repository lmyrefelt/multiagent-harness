# `/change-review` — a tiered reviewer panel before merge

A light/medium/heavy reviewer panel an integrator can run against a change's diff
before merging, inspired by the `pi-pr-review` package's model-tiering pattern
(github.com/10ego/pi-pr-review) — adopted as a pattern, not the package, because
that package hard-requires an actual GitHub PR (`gh` CLI, a PR number) and this
project's integrator merges directly under `scripts/integrator-lock.sh`'s lock,
never through a GitHub PR. The reusable part was the idea (cheap model for a fast
scan, strongest model reserved for the deep pass, host-gated rather than
model-gated approval), not the GitHub-specific plumbing.

## How it works

1. The integrator, after reviewing a change lock-free in its own worktree (per
   COORDINATION.md's "An automated integrator" section) and before deciding
   whether to merge, **first generates the diff itself** (it has bash; the
   reviewers deliberately do not - see below) and saves it to a file, e.g.:

   ```bash
   git diff <base_branch>...<branch> > /tmp/CHANGE-NNNN.diff
   ```

   Then, if the change touches any store/repository file, also runs the
   tenant-scoping lead-generator against that same diff and saves its output
   alongside it:

   ```bash
   node scripts/check-tenant-scoping.mjs /tmp/CHANGE-NNNN.diff > /tmp/CHANGE-NNNN.tenant-scoping.txt
   ```

   This is a heuristic — it flags a hunk as a candidate, not a proof (see the
   script's own header for why and its false-positive/false-negative shape).
   Built because the SAME org-scoping bug independently recurred across five
   real changes and, in CHANGE-0075, survived three separate fix rounds in a
   row — each fix looked locally correct and was reviewed as such; nobody
   re-checked every consumer of the changed storage shape. Give `review-heavy.md`
   this output file's path alongside the diff; it treats each candidate as a
   lead to verify by reading the actual code, not as a finding to repeat
   verbatim — a `severity=none` output means no candidates, not "no bug."

   Then spawns three reviewer subagents (`pi-subagents`, already installed on
   the integrator/planner images), each told the diff file's path in its task:

   - `.pi/agents/review-light.md` — fast scope/risk scan
   - `.pi/agents/review-medium.md` — convention/maintainability
   - `.pi/agents/review-heavy.md` — correctness/security/performance

   **The three reviewer agents have NO shell and NO write access at all**
   (`tools: read, grep, find`; `bash` is explicitly in `disallowed_tools`) -
   changed 2026-10-08 from an earlier version that gave them `bash` for
   read-only git commands. A real integrator run independently converged on
   the same "no shell" design for its own fallback (see below) specifically
   because it removes the question of whether background/detached execution
   escapes `CONTRACT_GUARDS` as a live concern for this role: with no bash and
   no write tool registered at all, there is no write-bypass surface
   regardless of which hook sees the call. This is a stronger guarantee than
   "foreground only," which depended on trusting hook visibility rather than
   removing the capability. **Still prefer FOREGROUND calls when possible** -
   `Dockerfile.pi-integrator` documents the background-inheritance question as
   unverified in general, and "this specific role has no capability to
   misuse" is a narrower claim than "it's fully safe in the general case."

   Pass an explicit `model=` override per reviewer appropriate to its tier -
   `REVIEW_MODEL_LIGHT`/`REVIEW_MODEL_MEDIUM`/`REVIEW_MODEL_HEAVY` if set in the
   environment (wired through by `scripts/launch-integrator.sh`), otherwise use
   whatever reasonable default is actually available in the session. The three
   agent definitions deliberately do not hardcode a `model:` in their own
   frontmatter, since the right model differs per deployment.

2. Each reviewer is instructed to emit ONLY structured finding lines:

   ```
   REVIEW_FINDING severity=<low|medium|high|critical> :: <one-line description>
   ```

   or, if clean, exactly one `REVIEW_FINDING severity=none :: no findings` line.
   This is a deliberately narrow, mechanically-parseable contract (same house
   style as everywhere else in this project - no LLM re-reads another LLM's
   prose to decide severity).

3. Save each reviewer's raw output to a file, then run:

   ```bash
   node scripts/record-review-verdict.mjs CHANGE-NNNN light.txt medium.txt heavy.txt
   ```

   This parses the `REVIEW_FINDING` lines, computes the panel's max severity,
   and folds it into the change's own `risk.tier`/`risk.reviewer_required` -
   the SAME fields `integrator_merge_gate` already reads before allowing an
   autonomous merge. **It only ever tightens these fields, never loosens one a
   planner already set** - a panel finding something is a reason to escalate,
   never a reason to downgrade an existing risk assessment. It also records a
   `review:` block (panel composition, tallies, raw findings, timestamp) for
   audit, in the same spirit as the existing `handover:` block convention.

4. `integrator_merge_gate` then evaluates the (possibly now-escalated)
   `risk.tier`/`reviewer_required` exactly as it always has - this flow adds a
   verification step upstream of that gate, it does not change the gate itself.

## What this is NOT (yet)

- **Not mechanically enforced.** Nothing currently requires the integrator to
  run this panel before merging - it is an available tool, not a guard. A
  future increment could add a check that cross-verifies a `review:` block's
  `panel_max_severity` against `risk.tier` for internal consistency, the same
  way `evidence_captured` verifies a test claim from the transcript rather
  than the model's word - deliberately deferred to keep this increment small.
- **MEASURED (2026-10-08) against a real session: discovery failed without a
  `name:` field.** The three agent files originally had no `name:` key
  (relying on "defaults to the filename," per secondhand pi-subagents docs at
  design time - wrong, or at least not true for the installed variant). A
  real integrator reported `.pi/agents/review-*.md` were not found even with
  `PI_SUBAGENTS_AGENT_SCOPE=both` set, suspected the missing `name:` field
  itself (listed as the first thing CHANGE-REVIEW.md told it to check), and
  fell back to the built-in generic `reviewer` agent type with the three
  tiers' persona text copied in manually. Fixed: `name: review-light` /
  `review-medium` / `review-heavy` added to each file. NOT yet re-confirmed
  against a live session - if agents are still undiscovered after this, the
  frontmatter schema itself may differ from what's documented upstream.
- **`PI_SUBAGENTS_AGENT_SCOPE`** (fixed 2026-10-08): two different `pi-subagents`
  forks researched document two different DEFAULTS for this exact env var
  (one "user"-only, one "both") - which one `npm:pi-subagents` (the one
  actually installed) matches was never confirmed. Rather than depend on
  that, `scripts/launch-integrator.sh` now forces `PI_SUBAGENTS_AGENT_SCOPE=both`
  by default (overridable) - explicit and inclusive regardless of which
  default would otherwise have silently applied, so `.pi/agents/review-*.md`
  are discoverable without disabling user-level agents.
- **MEASURED (2026-10-08): the integrator was never actively told these three
  agents exist**, only pointed at them passively from `COORDINATION.md` - it
  kept calling an ad-hoc, free-form "reviewer" subagent instead (confirmed by
  inspecting a real session's `subagent-artifacts/*_meta.json`, dated BEFORE
  `.pi/agents/` even existed, proving those calls never referenced a
  predefined persona at all). Fixed by putting the instruction directly in
  `launch-integrator.sh`'s `SEED` text, the same place the lock-claim
  requirement already lives and is reliably followed.
- **Model vs. thinking level - what the three agent files actually control:**
  `thinking` (`off`/`low`/`high` per tier) is set in each file's own
  frontmatter, and pi-subagents LOCKS any field an agent file sets - a caller
  cannot override it, intentionally or by omission. `model` is deliberately
  left UNSET in all three files, so it is NOT locked: it falls through to
  whatever the calling integrator passes as a `model=` tool-call parameter
  (`REVIEW_MODEL_LIGHT`/`_MEDIUM`/`_HEAVY` if set, per the SEED instruction
  above), or to the session's own default model if the integrator doesn't
  pass one. In other words: thinking level is already guaranteed correct per
  tier the moment agent discovery works at all; model-tiering additionally
  depends on the integrator actually reading and following the `model=`
  instruction in the SEED/this file - not yet verified end-to-end.

  **MEASURED consequence of the discovery failure above:** the real fallback
  run used the built-in generic `reviewer` type for all three tiers, which
  has neither property - it ran all three at the SAME model (Claude Opus
  5.5) AND the SAME thinking level (`high`), because thinking level is only
  locked when the NAMED agent file is actually resolved. The persona text was
  still copied in correctly (so the three passes differed in what they looked
  for), but every cost-saving goal of this design - cheap model for the fast
  scan, high-thinking reserved for the deep pass - was lost for that run.
  Nothing to fix here beyond the `name:` field fix above; this is recorded so
  a future "why did /change-review cost more than expected" question has an
  answer on file instead of needing to be re-diagnosed.
