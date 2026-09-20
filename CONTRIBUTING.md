# Contributing

Thanks for helping make agent process execution less guessy. This repository is deliberately small: one package, no runtime dependencies, and tests that assert real process behaviour.

## Development

```bash
git clone https://github.com/Xio-Shark/xioflow.git
cd xioflow
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm verify:package   # packs, installs into a clean project, runs the embedder checks
```

- Node.js >= 22.5 (the store uses `node:sqlite`). CI runs Node 24.
- Linux and macOS. Windows is not supported in 0.1; the driver reports that honestly instead of pretending.
- `pnpm verify:package` is the gate that matters for consumers: it proves the packed tarball works when installed, not just from source.

## What a change has to satisfy

1. **Facts over guesses.** A new state must come from an observable fact (exit status, driver confirmation, store record). Do not add a fallback that turns "unknown" into "fine".
2. **Failures stay visible.** Errors are returned, recorded, or thrown — never swallowed to make a test pass.
3. **Contract coverage.** If you change supervisor or driver behaviour, extend `src/testing/contract-suite.ts` (the suite every embedding runtime runs) and `scripts/pack-smoke/consumer.mjs`.
4. **No new runtime dependencies.** The package intentionally has zero.
5. **Surgical diffs.** Match the surrounding style; skip unrelated reformatting.

## Pull requests

- One behaviour change per PR, with the commands you ran and their real output in the description.
- If the public API changes, update `README.md`, `CHANGELOG.md` and the mapping notes in `ARCHITECTURE.md`.
- Please do not bump the version or push tags in a feature PR.

## Releases

Releases are tag-driven and token-free:

1. Maintainer bumps `version` in `package.json`, moves the changelog entries out of `Unreleased`, and merges to `main`.
2. Push the matching tag: `git tag v0.1.5 && git push origin v0.1.5`.
3. `.github/workflows/release.yml` re-runs typecheck, tests and the pack smoke test, refuses a tag that disagrees with `package.json`, publishes with `--provenance`, then verifies the version and its attestation on the registry.

This requires the one-time npm Trusted Publisher setup (npmjs.com → package settings → Trusted Publisher → GitHub Actions: `Xio-Shark` / `xioflow` / `release.yml`). Until that exists, the workflow fails loudly at the publish step instead of shipping an unverifiable artifact.
