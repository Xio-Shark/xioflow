# Conformance evidence report

Task: Q-06 report generation; partial Q-01 generated-source drift guard.

The new dependency-free `scripts/conformance-report.mjs` runs the existing plain
contract suite. It reports the architecture catalog independently from the actual
registered suite, records the driver capabilities, suite/package version, source
and build hashes, platform, exact command, exit code and raw runner result.
`--inventory-only` explicitly reports `NOT_RUN`; it never creates a passing test
claim. Existing output files are not overwritten.

## Verification

Environment: macOS arm64, Node `v26.12.0`, `NodePlatformDriver` (`node-default`).

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm build && node scripts/conformance-report.mjs --output /tmp/xio-conformance-run-20261103.json` | 0 | Raw suite: 57 passed, 0 failed, 0 skipped, no background errors |
| `pnpm exec vitest run tests/scripts` | 0 | 6 tests pass, including unsupported/failure boundaries, unknown CLI rejection and generated opcode byte drift |
| `node scripts/check-isa-registry.mjs` | 0 | 24 opcode registry check passes |
| `node scripts/check-isa-schemas.mjs` | 0 | Capability/instruction/program/result consistency check passes |
| `jq empty spec/conformance-report.schema.json audit/results/conformance-evidence-20261103.json` | 0 | JSON syntax valid |
| `git diff --check` | 0 | No whitespace errors |

The copied raw artifact is
[`audit/results/conformance-evidence-20261103.json`](../results/conformance-evidence-20261103.json).
Its execution counts are **55 passed, 2 unsupported, 0 failed, 0 not run**.
The raw suite's two extra passes validate rejection of unsupported hard memory
and PID limits; they do not prove those limits are enforced by this driver.

The inventory records 67 catalog entries, 57 runnable tests, four archived catalog
entries and ten entries still declared planned by the architecture document.
These are separate views and cannot be added or interpreted as a partition.
The catalog contains historical declarations; this tool preserves them instead
of silently inferring that a similarly numbered test implements the same row.

## Limits and integration

- This run covers one macOS Node driver. Linux, cgroup enforcement and other
  drivers require their own reports.
- The JSON Schema is supplied in `spec/conformance-report.schema.json`. Full
  JSON-Schema validation was not run because Python `jsonschema` is unavailable;
  no dependency was installed. JSON syntax and evidence boundary tests did run.
- The generated-opcode drift test runs the existing generator in an isolated
  temporary workspace and compares its entire output byte for byte. It neither
  rewrites the worktree nor duplicates the generator template. Q-01's complete
  MCP/CLI/schema/document generation chain remains unfinished.
- Build hashes identify executed JavaScript. Run `pnpm build` immediately before
  generating a new report; source test names alone are not build provenance.
- Suggested package command: `conformance:report` =
  `pnpm build && node scripts/conformance-report.mjs`.

Rollback: remove these additive reporting files/tests and the corresponding
package command if added; no database migration or runtime state is changed.

Parent verification addendum: full Draft 2020-12 schema validation subsequently
passed for this report and the later local conformance artifact, using
`jsonschema==4.25.1` in a temporary isolated environment. No runtime dependency
was added to the package. The package script is now installed as
`pnpm conformance:report --output <new-report.json>`.
