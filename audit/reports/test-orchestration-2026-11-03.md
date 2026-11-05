# Separate Vitest and native Node research tests

The default Vitest glob also collected seven `audit/interaction/*.test.mjs`
modules written for `node:test`. Their native tests ran as import side effects,
then Vitest failed those files with `No test suite found`. A native test's printed
pass was not a passing Vitest suite.

`vitest.config.ts` now applies the existing Vitest test-file pattern only under
`tests/`, retaining TypeScript and JavaScript test/spec variants. `pnpm test`
uses `scripts/test.mjs`: it runs Vitest first, then explicitly runs the seven
native research suites with `node --test --test-concurrency=1`. Arguments such as
`--maxWorkers=2` and path filters go only to Vitest. A nonzero exit or signal stops
the sequence and remains nonzero. Required files and the native suite inventory
are checked before execution, so incomplete source bundles cannot silently lose
research coverage.

## Actual checks

| Command | Exit | Result |
| --- | --- | --- |
| `node --check scripts/test.mjs` | 0 | Syntax valid |
| `pnpm test tests/scripts --maxWorkers=2` | 0 | Vitest: three files/seven tests pass; native Node: 60 tests pass, zero failed/cancelled/skipped |
| `pnpm test --invalid-test-runner-option` | 1 | Vitest rejected the option; native phase did not start |

The successful native run took about 19.3 seconds. The phase log shows
`--maxWorkers=2` only in the Vitest command; the native command contains just
`--test`, `--test-concurrency=1` and the seven explicit test paths. Full repository
regression is performed separately by the root task; this targeted run does not
claim that unrelated tests passed.

## Research test inputs and network scope

The explicit suites are `view-watch`, `process-suite`, `action-suite`,
`observation`, `research-budget`, `task-suite` and `model-budget`. Inspection of
their imported fixtures found no paid model runner or external API request.
HTTP probes use the fixtures' loopback services. Budget tests create synthetic
ledgers in temporary directories; they do not read the active research ledger.

Remote source bundles need all top-level `audit/interaction/*.mjs`, including
forked `process-service.mjs`, `action-command.mjs`, `session.mjs` and
`task-session.mjs`. The fixed repository fixture is
`spec/isa-v1/registry.json`; other JSON fixtures are generated in temporary
directories. `jq` must be available on PATH. No `results/`, real ledger, API
credential or private configuration is needed.

Rollback: restore the prior `test` package command and Vitest include behavior,
then remove the additive runner; no runtime data or database schema is changed.
