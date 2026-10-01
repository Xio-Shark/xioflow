# E9: agent journal data duplication

## Reproduce

```sh
pnpm build
node audit/observation/e9.mjs --legacy-control
node audit/observation/e9.mjs
```

No model or network calls. A single agent completes 60 quanta. Each checkpoint
adds a 4096-character synthetic history entry; input contains a fixed instruction.
The benchmark sums serialized AGENT_STATE payload bytes, reopens the runtime,
checks all 61 checkpoint boundaries and the complete 60-entry final history,
then completes its Run.

The legacy control uses the same scheduler and real SQLite store, materializing
each compact event back into the former complete-state payload at the store
boundary. It does not fake writes or results. That control adds a small JS
projection step, so timings are not a pristine benchmark of the old implementation.

## Logical payload result

| Encoding | State events | Journal payload bytes | Single-copy data bytes | Ratio |
| --- | ---: | ---: | ---: | ---: |
| complete-state control | 181 | 25,457,438 | 7,541,870 | 3.3755 |
| compact v2 | 181 | 7,579,626 | 7,541,870 | 1.0050 |

Payload shrank 70.2%, with unchanged restored data. Single-copy data means one
input plus one copy of each full checkpoint, not an information-theoretic lower
bound. These are logical JSON bytes, not measured filesystem/WAL write traffic.

The original implementation measured 114.20 ms once. An early standalone compact
run measured 226.66 ms. Three later alternating control/compact runs measured
191.80/89.13, 170.30/85.90 and 178.28/104.97 ms. Timing is variable and the control
has instrumentation overhead; do not extrapolate these small local measurements
to model latency or production throughput.

The final verification also compared every entry of all 61 recovered checkpoint
histories and the original input; it passed (60.34 ms dispatch time in that run).

## Protocol and verification

v2 writes input only at creation, checkpoint data at creation/step completion,
and references when restoring. Other lifecycle events hold metadata. The reader
supports v1 full-state rows and mixed journals. Tests cover legacy references,
chained restores, reopen, null/false data, missing payloads, missing references,
cross-agent references, forward/self references and repeated reads after a bad
event. The existing SIGKILL tests exercise new-format persistence as well.

Full checkpoints still contain their history prefixes, so long trajectories can
still grow quadratically in stored data. This experiment does not implement a
generic delta codec, external blob store or journal pruning policy.
