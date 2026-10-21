# Contracts

A **contract** is the machine-readable rule set a project enforces on its workers. It is compiled
by `compile.mjs` into `AGENTS.md` (guidance), `guards.json` (binding), and `eval-cases.json`
(verification).

| File | Purpose |
|---|---|
| `worker.contract.yaml` | The reference contract and worked example. Its fixture (`TASKS.md`, `add sub`) is illustrative, not a default. |
| `<project>.contract.yaml` | A project's own contract. |

## Choosing a contract

A contract is **per project**. `worker.contract.yaml` is an example, not a default to run against
real code — its `always_state` tokens (`NO-EDIT-OUTSIDE-BOUNDARY`, …) are meaningful only for that
example, and its `file_boundary` default is `src/**`.

To use your own:

```bash
CONTRACT=contracts/warroom.contract.yaml
node "$CONTRACT" --out /work/generated
```

Declaring a boundary in the contract is a **default**. `run-probes --allow` narrows it per task.
