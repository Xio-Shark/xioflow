# Agent system interaction experiments

Research layer · started 2026-11-03.

This project studies how an agent selects enough fresh evidence, waits for
relevant changes, and verifies the effect of an action. It includes real-file
queries, controlled local processes, readiness probes and reversible
configuration changes. The prototype is not a stable ISA or a security boundary.

## Entry points

| Purpose | Document |
| --- | --- |
| Findings, limitations and evidence index | [RESEARCH-RESULTS.md](RESEARCH-RESULTS.md) |
| Remaining work, budget and recovery conditions | [NEXT.md](NEXT.md) |
| Task progress | [Checklist](../../.xiotask/tasks/11-03-agent-system-interaction/todolist.md) |
| Commands, exit codes and preserved failures | [Verification](../../.xiotask/tasks/11-03-agent-system-interaction/verification.md) |
| Historical inspiration | [HISTORY.md](HISTORY.md) |
| Responsibility split and integration decision | [INTEGRATION.md](INTEGRATION.md) |

Paid experiments are on hold. The user chose to keep the existing ClinePass
configuration and wait for recovery; [NEXT.md](NEXT.md) records the active gates.
Reports describe their own experimental runs, not the current execution state.

## Local commands

Run from the repository root. These commands make no model requests:

```sh
node audit/interaction/research-demo.mjs replay
node audit/interaction/research-demo.mjs live
node audit/interaction/evidence-check.mjs
node audit/interaction/action-model-runner.mjs preflight
```

- `replay` displays an existing model waiting trace and verifies source snapshots.
- `live` uses a deterministic client with new temporary processes, verifies the
  configuration effect, restores the initial value and cleans up.
- `evidence-check` audits source hashes, recorded cleanup, accounting and resources.
- `preflight` checks action-model prerequisites; exit 2 / HOLD means they are unmet.

The action-model trace required by `replay-action` does not exist yet. Paid
runner commands and reporting steps belong to [NEXT.md](NEXT.md); benchmark
scripts are not a general recovery command and may overwrite or reject existing
outputs.

## Frozen experiment protocols

[Read-only tasks](TASK-PROTOCOL.md), [read-only model comparison](MODEL-PROTOCOL.md),
[process facts](PROCESS-PROTOCOL.md), [waiting](WAIT-PROTOCOL.md),
[configuration actions](ACTION-PROTOCOL.md) and [ablations](ABLATION-PROTOCOL.md)
are referenced by result hashes. Preserve their execution versions when editing
current documentation. The earlier [file-view protocol](WATCH-PROTOCOL.md) did
not match detection latency; its results remain separate from the process
waiting experiment.

## Original observation contract

The file prototype accepts a JSON array of objects up to 16 MiB. The full, jq and
structured arms share snapshot metadata and a version guard. Its mechanism
benchmark supplies the correct query to the caller; this tests representation
and protocol cost rather than model query discovery.

- `describe` returns version, record count and fields for the captured snapshot.
- `query` supports scalar equality and projection. Match count, offset and
  continuation make incomplete results explicit.
- `maxBytes` bounds successful result bodies. Oversized rows return
  `budget_too_small`; validation errors are not empty successful results.
- `readText` pages by Unicode code points and can recover the complete field.
- Cursors are local to an observation and bound to their query or field.
  `readText` and `setEnabled` require the returned version; refresh cannot
  reinterpret an old reference.
- `setEnabled` requires fixture write authorization and an unchanged content
  version. Hash checking plus rename is not a multi-writer atomic compare-and-swap.
- Projection and row references do not grant permissions. Current-state views
  do not guarantee a complete event history.

## Interactive read-only sessions

```sh
node audit/interaction/session.mjs spec/isa-v1/registry.json opcodes
node audit/interaction/task-session.mjs --list dev
node audit/interaction/task-session.mjs dev-01 structured
```

The first session accepts JSONL operations `describe`, `query`, `readText` and
`refresh`, with no write operation. For example: `{"id":1,"op":"describe"}`.
Its result budget excludes the transport envelope.

A task session first emits the goal, answer shape and tool definitions. Submit
once with `{"id":2,"op":"submit","args":{"version":"...","answer":{...}}}`.
The independent grader rejects stale evidence, wrong objects and incomplete sets;
ending input without submission fails. `--trace NEW_FILE` preserves the episode
without overwriting an existing file. The host is not an isolation boundary for
hostile jq.
