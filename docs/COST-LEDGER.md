# Cost ledger

`scripts/cost-ledger.mjs` turns every model turn the harness ran into one ledger row, tagged by
role and change, priced at list API rates, and lined up against the subscription meters.

```
node scripts/cost-ledger.mjs --print              # last 7 days, report on stdout
node scripts/cost-ledger.mjs --days 30 --print
node scripts/cost-ledger.mjs --sqlite ledger.db   # also a `ledger` table (Node 22.13+)
node scripts/cost-ledger.mjs --json               # the summary as JSON
```

It writes `.pi-session/routing/ledger.jsonl` (one row per turn) and `ledger-summary.json`.

## What it answers

- **Which role spends the budget**: planner, integrator, worker.
- **What each change cost**: rows are grouped by `CHANGE-NNNN`.
- **The fan-out tax**: `cw%` is the share of dollars spent on cache writes, and `sub%` the share
  spent in Claude subagents. A high `cw%` on short-lived workers means many cold starts.
- **Peak vs off-peak**: every row is tagged against Anthropic's peak hours, weekdays
  05:00–11:00 America/Los_Angeles. This is computed in LA time, so the weeks when Europe and the
  US switch daylight saving on different dates are handled.
- **$ per meter point**: how many API-equivalent dollars one percent of each subscription meter
  bought, split peak/off-peak. Same method as
  [phuryn/experiments, 05-claude-pro](https://github.com/phuryn/experiments/blob/main/subscription-multipliers/05-claude-pro/README.md).

## Sources

No launcher changes are needed. The launchers already persist each backend's own logs inside
the session dir, and the session-dir name carries the role and change:

| Session dir | Role | Change |
|---|---|---|
| `.worktrees/*/.pi-session/harness-change-NNNN[-label][-NN]` | worker | CHANGE-NNNN |
| `.worktrees/*/.pi-session/harness-planner-*` | planner | – |
| `.pi-session/integrator-*` | integrator | – |

| Backend | Log | Notes |
|---|---|---|
| pi | `*.jsonl` at the session-dir top level | carries its own cost; used when no list price |
| Claude Code | `claude-projects/**.jsonl` | last record per message id; 5m/1h cache writes split; `isSidechain` = subagent |
| Codex | `codex-sessions/**.jsonl` | `token_count` events; input includes cached; no cache-write count |
| Antigravity | `gemini-antigravity-cli/brain/…/transcript.jsonl`, `antigravity-brain/…` | model from the Model-Selection announcement; no cache-write count |
| OpenCode | `opencode-home/opencode.db`, plus the shared login dir's `opencode.db` | OpenCode's own billed `cost` kept as logged cost; reasoning counts as output; child sessions = subagents. Shared-store turns have no change id |

Meters come from `.pi-session/routing/usage-history.jsonl`, which `route-worker.mjs
--refresh-usage` appends to. The more often it runs, the finer the $/point spans.

## Prices

`scripts/list-prices.json`, USD per million tokens. Only add rows checked against a price page.
A model without a row is reported as unpriced tokens and never guessed. Codex, Gemini/Antigravity
and OpenCode models have no rows yet, so their turns show up as unpriced until you add them.

## Caveats

- $/point is a **lower bound**: your own interactive use on the same account moves the meter
  too, but only harness sessions are counted.
- Codex and Antigravity report no cache writes, so their `cw%` reads 0. That means "not
  reported", not "none happened".
- OpenCode's shared session store has no session dir, so its turns count as unattributed
  worker turns (no change id).
- Peak-window spans are only as fine as the usage refreshes (the watcher refreshes at most every
  5 minutes). Spans that straddle a window edge are counted as "mixed" and skipped.

## Peak windows

`herdr-plugin/peak-windows.json` lists provider peak hours (helpers in `scripts/peak-windows.mjs`;
`node scripts/peak-windows.mjs` shows what is open now):

| Window | Hours | Status | Router |
|---|---|---|---|
| Anthropic | weekdays 05–11 America/Los_Angeles | published | +3 cost on Claude models while open |
| DeepSeek | weekdays 01–04 and 06–10 UTC (API bills 2×) | measure | nothing until the ledger confirms it |

Every ledger row carries `windows` (the windows it fell in and that apply to its model). For each
window the ledger runs a **window test** on that window's meters: it pairs meter rises with the
weighted tokens spent in each span (fresh 1, cache write 1.25, cache read 0.1, output 5), keeps
spans where at least 80% of the tokens came from the window's models, and compares meter points
per weighted Mtok inside vs outside the window.

- `ratio` ≈ 2: the provider's peak price reaches this meter → verdict `passes_through`.
- `ratio` ≈ 1: it does not → `flat`.
- `clientRatio`: the same comparison on OpenCode's own logged cost, which shows whether the
  OpenCode client itself prices the peak.
- Fewer than 5 spans (or 5 points) on either side → `insufficient`. Thresholds live in the
  `test` block of the JSON.

A `measure` window only steers routing once its verdict is `passes_through`. Free models are
never penalised (their tokens do not draw on the Go dollar cap). The watcher rebuilds the ledger at
most hourly, so the verdict the router reads is at most an hour old. The DeepSeek window's days
are from codingplans.dev; check DeepSeek's pricing page and fix the JSON if they differ.
