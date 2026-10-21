# How to add new functionality (the simple version)

This is the one page you need to start a new piece of work — a new module, a new
feature like the War Room, a fix — and have agents build it without making a mess.

You do **not** run any build tools or CI. Your whole job is to create one folder and
fill in a short form. The guardrails do the rest.

---

## The idea in three sentences

1. **One feature = one "change" = one folder** under `docs/changes/`.
2. That folder says, in plain fields, **what to build, which files the work may touch,
   and what it must _not_ do**.
3. An agent implements it **inside that boundary**; two separate guardrails stop an
   agent that strays — automatically.

---

## Who does what (this is the biggest lever you have)

| Use this kind of agent | For |
|---|---|
| **PI agents** (local workers) | Doing the implementation. The boundary is enforced for them automatically, at the moment they try to touch a file. |
| **Frontier agents** (Claude, GPT, Gemini…) | Planning, reviewing, and fixing — **not** unsupervised implementation. |

This split comes straight from your own PI research: the worker's job is mechanical,
the frontier's job is judgement. Don't hand the keys to an unsupervised frontier agent.

---

## The guardrails (you operate none)

Two things are enforced automatically, so an agent cannot quietly leave its scope or
skip test-first:

1. **Boundary** — an agent may only write files inside the change's `owned_paths`.
   - *Inside PI:* blocked live, the moment it tries to write. Automatic.
   - *Everywhere else:* a **git pre-commit hook** refuses a commit touching files
     outside the boundary.
2. **Evidence (test-first)** — a change must be built tests-first and name a real
   `tests.command`.
   - *Inside PI:* the runtime `evidence_captured` guard refuses to let the agent finish
     claiming "done" unless it actually ran the tests and they passed.
   - *Everywhere else:* a **git pre-push hook** refuses to push a change branch unless a
     test commit precedes the first implementation commit (and `tests.command` is set).

No CI, no cloud — the hooks run on your machine.

### One-time setup (run once per copy of the repo)

```bash
git config core.hooksPath .githooks
```

That wires both hooks. They act only on `feature/CHANGE-NNNN-…` branches; on `main` or
any other branch they do nothing. Confirm the checkers are healthy any time:

```bash
node scripts/check-boundary.mjs --selftest     # boundary checker
node scripts/verify-change.mjs  --selftest     # evidence checker
```

---

## Starting a new feature — step by step

**1. Create the change folder.** Start from the canonical template — copy
`docs/changes/change.template.yaml` into a new folder as `change.yaml`
(`docs/changes/CHANGE-0043-war-room/` is the live example; the full field reference is
`docs/changes/README.md`):

```text
docs/changes/CHANGE-0044-my-thing/
├── change.yaml        the form the tools read  (the important one)
└── specification.md   the human description
```

**2. Fill the form (`change.yaml`).** The fields that carry weight:

| Field | What to put |
|---|---|
| `id`, `title` | `CHANGE-0044`, a one-line name |
| `status` | start at `draft`; advance `specified → approved → in_progress → review → complete` (enum in `README.md`). Fine-grained steps live in `checkpoints`. |
| `requirements` | the `REQ-…` ids this satisfies — if you can't name them, the work isn't understood yet |
| `depends_on` | CHANGE ids that must merge first. **Keep it acyclic** — if two changes would need each other, extract the shared piece into its own change and both depend on that (see COORDINATION.md). `check-change-overlap.mjs` flags cycles. |
| `progress` | one key per requirement, value `pending \| red \| green`. The **worker** updates it as it goes so a resumed/second worker and the integrator can see where it stands. |
| `owned_paths` | **the boundary.** The real repo paths this work may touch, e.g. `apps/api/src/harness/war_room/**`. No `<placeholders>` — a boundary you can't name isn't a boundary. |
| `non_goals` | the things an agent might "helpfully" do that it must **not**. This is the cheapest, most effective scope control you have. |
| `tests.command` | how the tests for this change are run, e.g. `uv run --project apps/api pytest apps/api/tests/war_room -q` |

**3. Name the branch to match the change.** The hook keys off this:

```bash
git checkout -b feature/CHANGE-0044-my-thing
```

**4. Hand the change to the agent.** Point it at the folder — but not all of it is the
worker's reading. `discovery.md` and `impact-analysis.md` (when present) are the
**planner's own** Phase 0 research and impact reasoning; by the time a change reaches
`approved`, everything load-bearing in them has already been folded into
`specification.md`'s REQ table and `change.yaml`'s resolved `open_questions`. A worker
re-reading both in full is re-deriving background the spec already distilled — measured
at 2,900 + 1,068 words on a real change (`CHANGE-0070`), on top of the spec itself.

- **Required:** `change.yaml`, `specification.md`, and `tasks.md` **if present** —
  read `tasks.md` FIRST on a resumed/relaunched session: which tasks are already
  `done` is cheaper to read there than to re-derive from `progress` or a transcript.
- **Background only, skip unless something in the spec doesn't add up:**
  `discovery.md`, `impact-analysis.md` — these exist so a reviewer or a second planner
  can audit *how* the spec was reached, not so the worker re-reaches it.

A good brief is just: *"Implement CHANGE-0044 from `change.yaml` and `specification.md`
(and `tasks.md`, if it exists). Stay inside owned_paths. Follow the loop: write the
failing test first, watch it fail for
the right reason, then implement."*

**5. Let the guardrails work.** If the agent strays outside `owned_paths`, PI blocks it
live, or the commit is refused with a message saying exactly which file and which
boundary. That is the system working — not a problem to route around.

**6. Commit at every `checkpoints` transition, not in one batch at the end.** When a
step in `checkpoints` flips to `complete`, commit then — don't accumulate several steps
into one eventual commit. This project has twice lost real working time recovering
work (a planner's docs, a worktree's registration) that sat uncommitted for hours
because nothing forced a checkpoint boundary onto disk. A small commit per step costs
nothing and makes "what actually survived" a `git log` away instead of a filesystem
forensics exercise. If `tasks.md` exists, the same rule applies one level finer:
flip a task's `Status` to `done` and commit at that point too, not only at the
whole-change checkpoint — a relaunched session should find more than one task already
marked done, not a transcript to re-read to find out.

**7. Fill `handover` before moving `status` to `review` or `complete`.** This is not
optional once you reach that point — `verify-change.mjs` enforces it. `from`/`to`/`at`
(the current commit)/`summary`, plus `verified` entries shaped `"claim — how"`, not bare
assertions. See `README.md`'s `handover` section for the full shape and why.

**8. For a change spanning multiple major phases, prefer a fresh launch at each phase
boundary over one continuous session.** Measured (`scripts/session-cost.mjs --all`
against this project's own real sessions): a single long-running session's `cacheRead`
token cost grows with how much of the conversation gets re-sent on every remaining turn
— in the sessions measured, `cacheRead` was ~97% of total tokens. A session covering
discovery through implementation in one continuous run pays that cost across its full
length; splitting at a natural phase boundary (discovery → **new launch** →
implementation) keeps each session's cache-read area smaller, at the cost of paying
re-orientation overhead (re-reading `AGENTS.md`, the change's own docs) more often. Split
at *major* phase boundaries (2-3 sessions per change), not every `checkpoints` step —
splitting that finely trades nearly all the savings for nearly all the overhead. A small,
narrowly-scoped change in one sitting is still correct; this is for the ones that
genuinely span distinct modes of work.

---

## When a commit gets blocked

The message names the offending file and the allowed paths. There are only two correct
responses:

- **The file really belongs to this change** → add its path to `owned_paths` in
  `change.yaml` (and, for anything sensitive, get that re-approved). Then commit again.
- **The file belongs to different work** → that's a **separate change**, not this one.
  Make a new change folder for it. Do not widen the boundary just to get unstuck.

Never paper over it with `git commit --no-verify` unless it's a genuine emergency — that
flag exists, but using it routinely throws away the only thing protecting the repo.

---

## Scope discipline inside the boundary, not just at its edge

`owned_paths` is enforced mechanically — a write outside it is blocked, full stop. That
guard answers "is this file allowed." It cannot answer a narrower question: once you're
*inside* an allowed file, is every change to it actually part of this task?

A file sitting inside `owned_paths` is not a license to also clean up an adjacent
function, remove a comment you don't fully understand, modernize unrelated syntax, or
refactor something nearby "while you're in there." That is scope creep the boundary
guard structurally cannot catch — it only ever asked "which file," never "which lines,
and why." If you notice something worth improving outside what this change's `REQ-` ids
actually require, name it and move on — offer it as a separate change, don't fix it
inline. The task you were given is the one you finish; an unrelated improvement bundled
into this commit makes both harder to review and, if something breaks, harder to tell
which change caused it.

---

## When the spec and reality disagree — surface it, don't guess

`open_questions` is the planner's version of this: ask before specifying, don't guess.
This is the same discipline for a **worker**, mid-implementation — `specification.md`
said one thing, and the actual code, tests, or an existing pattern in the codebase show
something else. This is not a judgment call to make alone, and it is not something a
guard can catch — no mechanical check can tell "the spec is right and reality is stale"
apart from "reality is right and the spec guessed wrong." Say so, in one dense block, the
moment you notice it:

```
CONFUSION
Spec says: <quote or paraphrase of the relevant line>
Reality shows: <what you actually found - file:line, a failing assumption, an existing
  pattern elsewhere in the codebase that does it differently>
Options:
  A) <concrete option>
  B) <concrete option>
  C) <a third, if one exists>
Recommendation: <which one, and the one sentence why>
```

Then:

- **Record it, don't just say it once and move on.** Append the block (compressed to one
  line — "CONFUSION: spec says X, found Y at path:line, recommend A" — per
  `COORDINATION.md`'s "write for the next agent" rule) to `change.yaml`'s `history`
  field. If the owner or integrator answers it, that answer becomes a resolved
  `open_question`, same shape the planner already uses — a worker does not re-ask a
  question that already has a recorded answer.
- **Block the task, not necessarily the whole change.** If `tasks.md` exists and other
  tasks don't depend on this one, keep making real progress on those while this one
  specific task waits — don't set the whole change to `blocked` over one ambiguous task
  if the rest of the boundary is unaffected. Set `status: blocked` only when nothing left
  can proceed without the decision.
- **Do not silently pick an option and continue.** A worker that guesses instead of
  surfacing this is the exact failure mode `open_questions` already exists to prevent at
  the planning stage — this just extends the same rule to the moment a worker discovers
  the same kind of gap later than the planner did.

---

## Why it's set up this way

The previous module (triage-v2) was built by many different agents, and the ones that
didn't honour the contracts left the repo with dozens of stray branches, duplicate
report files, and an unconditional security hole. The boundary-in-a-field + automatic
enforcement is the fix: it turns "please stay in scope" (which some agents ignore) into
"cannot leave scope" (which none can).
