# Changes — the unit of work

A **change** is one bounded, verifiable piece of work an agent claims, executes, and
hands over. New functionality is organised as changes. This file is the schema
reference; to actually run one, read [`HOW-TO-ADD-A-FEATURE.md`](./HOW-TO-ADD-A-FEATURE.md).

## One change, one folder

```text
docs/changes/CHANGE-NNNN-<slug>/
├── change.yaml        machine-readable: the fields tooling reads (authoritative)
├── specification.md   human view: the REQ table, objective, impact, report
├── discovery.md       (optional) planner's Phase 0 findings - background for a reviewer/
│                      second planner auditing the spec, NOT required worker reading;
│                      load-bearing content is already folded into specification.md
├── impact-analysis.md (optional) planner's impact reasoning - same rule as discovery.md
├── tasks.md           (optional, but required worker reading WHEN present - unlike
│                      discovery.md/impact-analysis.md above) the worker's roadmap:
│                      small, ordered, individually-verifiable implementation steps.
│                      See `tasks.template.md`. Skip for a single-file change with
│                      obvious scope; required once `owned_paths` is large enough
│                      that "just start implementing" means losing track of order.
└── features/*.feature (optional) Gherkin scenarios
```

`change.yaml` wins over `specification.md` for anything a tool reads — above all
`owned_paths`. If they disagree, the prose is the bug.

Copy [`change.template.yaml`](./change.template.yaml) to start. Do not invent fields;
the template is the whole schema. If the change is big enough to need task
breakdown (see `tasks.template.md`'s own triggers), copy
[`tasks.template.md`](./tasks.template.md) too, alongside `specification.md`.

## The fields that carry weight

| Field | Meaning |
|---|---|
| `owned_paths` | **The boundary — the only mechanically enforced field.** Real repo globs the change may write. Enforced live inside PI and by the pre-commit hook everywhere else. No `<placeholders>`. |
| `requirements` | `REQ-NNNN-seq` ids, **defined in this change's `specification.md`** (see below). Proves *why* the work exists. |
| `non_goals` | The things an agent would "helpfully" do but must not. Cheapest scope control there is. |
| `tests.command` | How this change's tests run. Required before implementation — RED comes first. |
| `risk` | Drives whether a reviewer is mandatory (`high`/`critical` ⇒ yes). |
| `open_questions` | A legitimate place to be uncertain. `BLOCKED` is expected, not failure. |
| `checkpoints` | The 13-step progress tracker the agent advances. |
| `history` | One line per decision that changed this change's shape (scope, boundary, amendment). The designated home for what otherwise ends up narrated into `status`'s comment. Append-only. |
| `handover` | **Required once `status` is `review`/`complete` — mechanically enforced.** What the next role reads first. See below. |

## Requirement ids (one scheme, no central register)

Requirement ids are **local to the change**: `REQ-<NNNN>-<seq>`. They are **defined in
that change's `specification.md`** as a table, each tracing to the spec:

```text
| REQ-0043-001 | The system SHALL create a War Room as a sub-resource of one Case. | Q1; spec §4 |
```

Every `REQ-` must trace to one of: a `docs/specs/*` section, an existing spec id
(`CASE-nn`, `EVID-nn`, `CAMP-nn`), or a resolved `open_question`. There is **no global
`requirements.yaml` to maintain** — the spec (`docs/specs/*`) is the product source of
truth, and each change owns its own `REQ-` register. If you cannot name the requirement
a line of code satisfies, the change is not understood yet.

## Status vs checkpoints

`status` is the **coarse** state; `checkpoints` tracks the **fine-grained** 13 steps.
Do not duplicate step tracking into `status`.

**`status`'s own comment is one line, always** — state plus who/when set it, nothing
more. In practice it has drifted into carrying three other things instead: decision
history ("integrator review #3... owner decision 2026-10-08... amendment #2..."),
re-narrated sequencing ("0064, 0065, 0067 and 0072 unblock after this merges"), and
fine-grained progress notes. Measured: two live changes carried 10+ lines of this in
`status` alone. None of it belongs there:

- Decision history goes in `history` (one line per entry, append-only) — see the field
  table above.
- Sequencing ("X unblocks after this") is **derivable** from the OTHER change's own
  `depends_on` and should not be restated in prose at all — a restated fact goes stale
  the instant the dependent change's boundary moves and nobody is obliged to come back
  and edit this one's comment to match.
- Progress is `checkpoints`', per the rule above.

A reviewer or a resumed worker reads `status` to answer "what's true right now," not
"how did we get here" — git log already has the second answer, in full, for free.

```text
draft ─► specified ─► approved ─► in_progress ─► review ─► complete
                │                     │
                └► rejected           └► blocked  (ask; do not guess)
```

| status | means |
|---|---|
| `draft` | being written; spec/boundary not final |
| `specified` | behaviour fully specified (reqs + gherkin done), awaiting boundary approval |
| `approved` | `owned_paths` approved; cleared to implement |
| `in_progress` | implementing (tests RED → GREEN → regression) |
| `review` | handed to a reviewer |
| `complete` | merged to `main` |
| `blocked` | waiting on a decision |
| `rejected` | abandoned: scope, boundary, or spec was wrong |

## `handover` — one fixed shape, every role, every transition

Prose docs (`discovery.md`, `impact-analysis.md`, `specification.md`) are the full
record; `handover` is the compact one a reviewer reads *first*, before deciding whether
it needs to read any of those at all.

```yaml
handover:
  from: worker
  to: integrator
  at: 8461ae33
  summary: "Backend green (50 tests); web panel fixed to 9/9; integration needs a live graph."
  verified:
    - "unit 27/27, api 23/23 green — pytest run, commit 8461ae33"
    - "web suite NOT run — no node_modules in the worker's sandbox"
  must_do_next:
    - "mount narrative.router in main.py (outside owned_paths)"
    - "run tests.command against a live FalkorDB before merging"
  open_risk: "Integration suite (FalkorDB Lua atomicity) unverified in this environment."
```

`verify-change.mjs` enforces three things mechanically once `status` is `review` or
`complete`, so a reviewer does not have to re-derive them by reading everything:

- the block is **present**, with `from`/`to`/`at`/`summary` all non-empty;
- `at` is the **exact current tip** of `branch` — more commits landed after this was
  written and nobody updated it is treated as stale, not current;
- every `verified` entry has a **`claim — how`** shape — a bare claim with nothing
  behind it is not evidence (this is exactly the gap that let a change report "green"
  while its own `checkpoints.green` said `partial`, undetected, for a full review pass).

Every field is **one line** — this is read by a script, not folded by a human. The
project has already paid once for a folded `>-` being read as the literal string `">-"`;
`handover` does not get to repeat that.

## Why this shape

It descends from the triage-v2 experience: changes without a named boundary, written by
many different agents, scatter across the repo. `owned_paths` + the enforcement in
[`HOW-TO-ADD-A-FEATURE.md`](./HOW-TO-ADD-A-FEATURE.md) turns "please stay in scope" into
"cannot leave scope." The live reference change is
[`CHANGE-0043-war-room`](./CHANGE-0043-war-room/).
