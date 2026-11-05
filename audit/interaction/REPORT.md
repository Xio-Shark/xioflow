# System interaction mechanism results

2026-11-03 · RFC-SI-001 · deterministic fixtures on real files; no model calls.

The same caller-supplied predicate, projected fields, snapshot metadata and version guard are available to every arm. All modifications were independently checked against the entire expected document.

| Workload | Arm | Request + response bytes | Calls | Median operation ms | State check |
| --- | --- | ---: | ---: | ---: | --- |
| tiny | full | 1096 | 3 | 0.227 | PASS |
| tiny | jq | 976 | 3 | 2.472 | PASS |
| tiny | structured | 995 | 3 | 0.487 | PASS |
| tiny | adaptive | 995 | 3 | 0.214 | PASS |
| sparse-tail | full | 353145 | 3 | 3.697 | PASS |
| sparse-tail | jq | 988 | 3 | 7.326 | PASS |
| sparse-tail | structured | 1010 | 3 | 2.319 | PASS |
| sparse-tail | adaptive | 1010 | 3 | 2.374 | PASS |
| dense-half | full | 352786 | 2 | 1.772 | PASS |
| dense-half | jq | 31508 | 2 | 6.28 | PASS |
| dense-half | structured | 46875 | 22 | 1.681 | PASS |
| dense-half | adaptive | 38905 | 4 | 1.165 | PASS |
| full-long-text | full | 14267 | 2 | 0.052 | PASS |
| full-long-text | jq | 14474 | 2 | 2.159 | PASS |
| full-long-text | structured | 17686 | 10 | 2.022 | PASS |
| full-long-text | adaptive | 15197 | 4 | 0.486 | PASS |

## Failure checks

All 4 arms rejected a deliberately stale observation and preserved the external edit. The structured adapter additionally reports complete match counts and continuations. This is not a capability missing from all possible shell programs: the jq baseline intentionally shares the same freshness guard.

## Interpretation

Filtering reduces transferred bytes compared with full output, but jq is the important baseline. Protocol metadata and continuation requests are real costs. Dense retrieval and complete long-text consumption measure this cost rather than assuming progressive disclosure always helps.

No Agent accuracy, token savings or production performance is established. The query was supplied by the experiment, not discovered by a model. Three local timing samples are descriptive; compare their operation scope before using them. All source hashes, trials and per-exchange byte counts are in [the raw result](results/mechanism.json).

## Reproduce

`node --test audit/interaction/observation.test.mjs`

`node audit/interaction/benchmark.mjs --adaptive`
