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
- OpenCode's own CLI storage is not parsed yet. OpenCode models run through pi are covered.
