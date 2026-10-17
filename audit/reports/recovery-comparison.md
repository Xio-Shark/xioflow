# Crash-recovery correctness comparison (E4–E9)

Status: **results**, from experiments in [`audit/observation/`](../observation/).
Published from repository data on 2026-10-13. No new runs were made for this
report. All numbers below are deterministic-fixture measurements; none are
real-model cost benchmarks (E8's real-model pilot is separated and labelled).

## What is being compared

After another actor changes a workspace, a suspended agent can either
**restart its whole task** or **reuse the valid prefix of its history** —
the part whose recorded observations still hold against the changed workspace.
The kernel mechanism under test selects the last complete checkpoint before
divergence, reconstructs that prefix, and recomputes the suffix.

Prior art was checked against primary sources on 2026-10-01 (AIOS, LangGraph
time travel, build systems à la carte, AutoGen); the experiment reuses
xioflow's existing transaction replay. The proposed contribution is the
**automatic selection of a valid recovery boundary from changed execution
evidence** — not agent lifecycle management, checkpointing or scheduling,
which are established.

## Correctness results (deterministic fixtures)

Every arm asserts exact final-tree equivalence, preservation of the other
actor's changes, and executable behavior of the result.

| Experiment | Setting | Whole restart | Observation-aware recovery | Correctness |
|---|---|---|---|---|
| E4 | replayed mutations, disposable workspaces, three-decision agent | reruns all decisions | validates old trace, reconstructs prefix, recomputes suffix | both arms: exact final-tree equivalence + other actor's changes preserved |
| E5 | existing runner across process restart (scripted provider) | 4 requests | 2–4 requests depending on which observation changed; blind resume wrong in 2 of 3 scenarios, validated resume correct in all 3 | validated resume: correct in 3/3 |
| E6 | kernel-owned agents (AgentRuntime, xiocode loop as one-quantum adapter) | — | evidence gate pauses the agent without a provider request; resumes from the latest valid boundary | correct; A completed in 5 charged steps, B in 4 |
| E7 | code edits and competing commits (real read/edit tools) | 5 resumed requests | 4 resumed requests; 1 reused observation, 4 candidate transactions, 7 replayed tool calls | byte-for-byte match with baseline, B's commit preserved, executable caller assertion passed |

E7's deterministic-prefix policy additionally skips checkpoints whose prefix
was already disproved: candidate forks 4 → 2, replayed tools 7 → 3, at the same
resumed-request count and the same correctness assertions. Deterministic
replay is opt-in because hidden callback state can invalidate prefix reuse.

## Real-model pilot (E8) — descriptive, not proof of savings

Three paired runs with DeepSeek V4.1 Flash (opencodego endpoint) on a
generated three-file rename task, with a competing comment added post-pause.
All held-out checks passed in both arms.

| Quantity | Whole restart | Recovery |
|---|---:|---:|
| Post-change requests (3 trials) | 27 | 20 |
| Peak-rate token estimate | USD 0.0141111 | USD 0.0114681 (18.7% lower observed) |
| Model/tool execution time | 48.937 s | 55.629 s (reconstruction + resume) |

**The negative control weakens the causal claim.** A later nine-file
semantic-change trial retained zero history (its first `glob` observation had
changed) yet still showed a request-count gap between two fresh runs
(21 vs 14): the model chose different tool sequences. Therefore the 18.7%
request gap cannot yet be attributed to recovery rather than model variation.
There is no speed win in these observations. Budget discipline: USD 10 cap,
ledger persisted across invocations, USD 6.15 conservative reservations after
all trials; no additional calls were made to obtain a more favorable result.

## Journal compaction (E9)

Not a recovery experiment, included because it bounds stored growth for long
trajectories: compact v2 encoding shrank journal payload 70.2% versus the
complete-state control (7,579,626 vs 25,457,438 bytes over 181 state events)
with unchanged restored data across all 61 checkpoint boundaries. These are
logical JSON bytes, not filesystem/WAL traffic; timings are small-sample local
measurements and must not be extrapolated.

## Early Cutoff and tree-fingerprint command dedup (E10)

Deterministic and scripted (no model calls). `audit/observation/e10.mjs`, raw
output in `audit/results/e10.json`. Part A uses the E8 fixtures with a scripted
agent (one tool call per step: `glob`, then `read` + `edit` per file); a step
stands in for one model request. The linear baseline is credited with a
checkpoint after every step, its best case.

| Scenario | Mode | Recorded | Reused | Cutoffs | Steps to redo | Hidden check |
|---|---|---:|---:|---:|---:|---|
| new-caller | linear | 17 | 0 | 0 | 19 | pass |
| new-caller | early cutoff | 17 | 17 | 1 (`glob`) | 2 | pass |
| comment | linear | 7 | 1 | 0 | 6 | pass |
| comment | early cutoff | 7 | 7 | 1 (`read`) | 0 | pass |

Cutoff rules used by the host: `glob` may cut off only if the new listing is a
strict superset of the recorded one, and the added files are handed to the
resumed agent as its remaining work; `read` may cut off when the comment-free,
whitespace-normalized slice mentioning `foo` is unchanged. Without the delta
hand-off the new-caller cutoff would be unsound (the new file would stay
unrenamed). The kernel only enforces that mutations still apply; the soundness
of each cutoff rule is the host's claim.

Part B: K=4 transaction forks of one 60-file TypeScript fixture run the real
`tsc --noEmit` concurrently, then again with no change (median of 3 trials,
macOS, multi-core):

| Mode | Round 1 wall | Round 1 spawned | Round 2 wall | Round 2 spawned |
|---|---:|---:|---:|---:|
| naive (`executeProcess`, distinct opIds) | 295 ms | 4 | 293 ms | 4 |
| dedup (`executeWorkspaceCommand`) | 282 ms | 1 | 64 ms | 0 |

Round 1 wall time barely moves because the naive runs execute in parallel on
separate cores; the saving there is 3 of 4 processes (CPU, memory). Round 2 is
the repeated-verification case: no process is spawned and the remaining 64 ms
is tree fingerprinting plus journal reads. `tsc` on this fixture takes ~250 ms;
larger projects were not measured.

## Protocol-Layer HTTP-304 Causal Fast-Forward & Virtual Workspace Benchmark (`wrap-cure-benchmark`)

Recorded in `audit/results/wrap-cure-benchmark.json` via [`audit/observation/wrap-cure-benchmark.mjs`](../observation/wrap-cure-benchmark.mjs) (see also [`wrap-before-after.md`](./wrap-before-after.md)). Unlike E4–E7 (which required explicit kernel transaction APIs), this benchmark runs an unmodified black-box OpenAI SSE agent through `xio wrap` on an 8-file TypeScript refactoring task (`computeLegacySubtotal` $\rightarrow$ `computeAuditedSubtotal` across 10 turns):

| Scenario | Baseline (Raw / Linear SHA) | `xio wrap` (`HTTP-304` + Early Cutoff) | Savings / Outcome |
|---|---|---|---|
| Mid-refactoring crash recovery (Turn 7/10) | `10` requests, `23,500` tokens, `6,022 ms` | `3` requests (`7` local `304` hits), `7,750` tokens, `2,845 ms` | **67.0% fewer tokens, 52.8% lower recovery wall time** |
| Concurrent doc-comment edit on `src/discount-engine.ts` | `8` requests, `20,250` tokens (invalidated at Turn 2) | `3` requests (`7` local `304` hits), `7,750` tokens, `2,833 ms` | **61.7% fewer tokens vs linear SHA cache** |
| Virtual Workspace `--shadow --gate "tsc"` + `xio race` | Faulty edit pollutes working tree | `gate_rejected` leaves **0 dirty files**; `xio race --mode merge` commits both `agent-a` and `agent-b` (`REFACTOR_VERIFIED_OK`) | **0 host workspace pollution** |

## What these results do not establish

- Production correctness, novelty, or general task performance;
- Real-model cost or speed savings (E8's gap is confounded by model variation;
  larger counterbalanced samples are needed before any claim);
- Concurrent scheduling (the fixtures are serial recovery after a completed
  concurrent change);
- Restoration of arbitrary extension state (each quantum rebuilds host/tool
  instances).

## Reproduce

```sh
pnpm build
node audit/observation/e4.mjs
node audit/observation/e5.mjs
node audit/observation/e6.mjs
node audit/observation/e7.mjs
node audit/observation/e9.mjs
node audit/observation/wrap-cure-benchmark.mjs
# E8 requires the real-model authorization and endpoint; see REAL-MODEL.md
```
