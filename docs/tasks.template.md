<!--
tasks.template.md — copy to docs/changes/CHANGE-NNNN-<slug>/tasks.md

OPTIONAL, same tier as discovery.md/impact-analysis.md (see README.md's folder
table) — but UNLIKE those two, this one IS required worker reading when present,
same as specification.md. discovery.md/impact-analysis.md are the planner's own
background; this is the worker's actual roadmap.

WHY THIS EXISTS
change.yaml's `progress` field (pending|red|green per REQ) and `checkpoints`
(discovery->...->review) track WHETHER something is done, at the WHOLE-CHANGE
phase level. Neither tracks HOW a change's implementation is broken into small,
individually-closeable steps, in what order, or what a relaunched session should
pick up next versus re-derive from scratch.

Measured absence of this cost CHANGE-0077 directly: 9 separate pi sessions plus
antigravity, 50 hours, 187M tokens, and every relaunch had to re-derive "what's
actually left" from `progress` and the transcript — there was no written,
resumable task list the way this file is meant to be. Its own title ("a HARNESS
directory, one visibility rule, lead-managed source AND item access") already
failed the cheapest smell test below before a single task was written.

WHEN TO SKIP THIS FILE ENTIRELY
A single-file fix with obvious scope does not need task breakdown — write the
test, implement, done. Use this file when `owned_paths` spans enough files or
REQs that "just start implementing" would mean holding more than one small step
in mind at once. If you're not sure, the triggers below decide it, not a feeling.

WHO WRITES IT, WHEN
The planner, alongside specification.md, BEFORE status moves to `approved` —
same timing as the spec itself. A worker does not invent its own task breakdown
mid-implementation; if one genuinely wasn't needed and now is (a capability the
map missed), that is escalated per the normal change lifecycle, not freelanced.

WHO UPDATES IT, WHEN
The worker, as it goes — tick a task's Status when its own verification passes,
not at the end of a session. This is the FIRST thing a relaunched session should
read, before specification.md: "which tasks are already done" is cheaper to read
here than to re-derive from a transcript or from `progress` alone.
-->

# Tasks — CHANGE-NNNN-<slug>

## Task sizing — decompose further when any of these are true

| Size | Files touched | Guideline |
|---|---|---|
| XS | 1 | A single function, a config value, a validation rule |
| S | 1–2 | One endpoint, one component |
| M | 3–5 | One vertical slice (schema → API → UI for one capability) |
| L | 5–8 | A multi-component feature — the upper bound before splitting |
| XL | 8+ | **Too large. Split into two or more tasks before writing code.** |

**ESTIMATE, not calibrated against our own task-level history yet** — these file
bands are a reasonable starting point, not a number proven against this project's
own data the way the capability-map thresholds in `COORDINATION.md` are (that one
had real counter-evidence, `CHANGE-0043`, forcing a qualitative test instead of a
number; this one doesn't yet, because we don't have task-level session data to
check it against — revisit once a few changes have used this file for real).

**Split a task further, regardless of file count, when:**
- It would take more than one natural single-sitting session to both implement
  and verify (same unit `HOW-TO-ADD-A-FEATURE.md` §8 already uses for session
  splitting — a task should fit inside ONE of those sessions, not span several).
- Its acceptance criteria exceed 3 bullets.
- It touches 2+ independently-shippable subsystems — if this is true, stop: that
  is a capability-map miss (see `COORDINATION.md`), not a task-sizing problem.
  Escalate rather than splitting it as if it were merely large.
- Its own one-line description needs the word "and" to say what it does. Cheap,
  reliable, and would have flagged a piece of `CHANGE-0077`'s own work before a
  single line of code was written for it.

## Dependency order

List tasks in implementation order — bottom-up (schema before the API that reads
it, the API before the UI that calls it), not necessarily the order they appear
in `specification.md`. A task's `Depends on` field must name only tasks earlier
in this list, or `None` — same acyclic rule `depends_on` follows at the change
level. Put a verification checkpoint after every 2–3 tasks or at the end of each
vertical slice, whichever is sooner — not only at the very end.

## Task format — one block per task

```
### T<n> — <one-line description, no "and">

**Status:** pending | in_progress | done
**Covers:** REQ-NNNN-00X, REQ-NNNN-00Y   (≤3 — split further if it needs a 4th)
**Verified by:** the test case id(s) from change.yaml's tests.cases, e.g. T3, T7
**Depends on:** T<n> | None
**Files:** the specific owned_paths subset this task touches — not the whole
  change's boundary, this task's actual slice of it
**Size:** XS | S | M | L  (if this would be XL, split it before filling this in)
```

---

## Worked example (delete before filling in the real tasks)

### T1 — Add the `directory` read model for HARNESS users

**Status:** done
**Covers:** REQ-0077-014
**Verified by:** T4
**Depends on:** None
**Files:** `apps/api/src/harness/triage_v2/directory.py`
**Size:** S

### T2 — Enforce the visibility rule on item reads

**Status:** in_progress
**Covers:** REQ-0077-005, REQ-0077-006
**Verified by:** T9, T11
**Depends on:** T1
**Files:** `apps/api/src/harness/triage_v2/access.py`, `apps/api/src/harness/triage_v2/queries.py`
**Size:** M

### T3 — Expose `/directory/me`

**Status:** pending
**Covers:** REQ-0077-016
**Verified by:** T6
**Depends on:** T1
**Files:** `apps/api/src/harness/triage_v2/router.py`
**Size:** XS
