# Six-harness execution-layer audit — method and status

Status: **method + scenario definitions; results NOT yet in this repository.**
This report deliberately contains no per-harness verdicts. The bench
(`audit/`, see [audit/README](../README.md)) writes its run data to
`audit/results/`, which is **git-ignored** (transcripts contain harness system
prompts and local paths). No results directory was committed, so there is
nothing to quote yet. Run the bench, then fill the results section from
`node audit/matrix.mjs audit/results/<date>`.

This document is the stable part of the deliverable: what is measured, how a
verdict is reached, and what a finding is allowed to claim.

## The question

When something goes wrong underneath a tool call, does what the harness
*says* match what *happened*? The bench impersonates the model service with a
local HTTP endpoint that replays a tape of tool calls, drives each harness
headless in a sandbox, injects faults, and then judges the machine from
outside (process table, side-effect ledger, file tree) against the harness's
own account (the tool results it sent back to the "model").

## Harnesses in scope

`xio` (line REPL; variants `xio:reaper`, `xio:node`, `xio:builtin` change only
the execution layer), `codex`, `opencode`, `gemini`, `claude`, `qwen`.
Headless default configurations plus the minimum needed to let a shell command
run; sandbox/hardening options that change an outcome must be named in a
finding. A fake endpoint is not a real model: every violation found here must
be reproduced once with a real model before it is reported. macOS arm64 only
so far.

## Scenarios and the property each checks

| Scenario | Fault | Property |
|---|---|---|
| `baseline` | none | runs exactly once; output reaches the model |
| `pipe-hold` | root exits, child holds the pipe 20 s | bounded return; nothing left after the session |
| `orphan-at-exit` | command starts a process in its own session | nothing it started survives, unless the harness said so |
| `unconfirmed-stop` | command ignores SIGINT/SIGTERM under the tool's time limit | "stopped" means gone; nothing left after the session |
| `kill-mid-tool` | harness SIGKILLed mid-call, then resumed | effect not repeated; resumed history keeps the call; leftover gone or mentioned |
| `kill-before-report` | SIGKILLed while reporting a completed command's result | effect not repeated; resumed history keeps call and result |
| `output-flood` | 50 MB output ending in a marker | truncation announced; stop reported if the command was stopped |
| `cancel-tree` | three-process chain, SIGINT to the harness's group | no chain process survives the harness |
| `mcp-orphan-exit` / `mcp-orphan-kill` | stdio MCP server, session ends / harness killed | server not left running |
| `spawn-failure` | missing binary, then `exit 127` | the two results can be told apart |

## Verdict discipline

A trial verdict is `holds`, `violated`, `not_applicable` (capability missing),
`inconclusive`, or `bench_error`. Only k/5 with k ≥ 4 counts as stable.
`audit/repro/` generates one reproduction script per stably violated cell
(exit 0 if the violation reproduces 3/3). Wording rules live in
`audit/behavior/wording.json`: findings describe observed behavior, name
whether a hardening option exists, and do not editorialize.

## How to fill this in

```bash
node audit/run.mjs --scenario baseline --harness xio,codex,opencode,gemini,claude --trials 5
node audit/run.mjs --scenario pipe-hold --harness codex --trials 5
node audit/matrix.mjs audit/results/<date> > matrix.md
node audit/repro/generate.mjs audit/results/<date>
```

Redact transcripts before quoting any of them. Publishing the filled report
is an external action and requires the repository owner's explicit sign-off;
the USD 10 real-model authorization in `REAL-MODEL.md` covers specific
experiments only, not publication.
