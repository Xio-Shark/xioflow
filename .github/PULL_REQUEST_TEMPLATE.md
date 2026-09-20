## What changed

<!-- One paragraph. Lead with the behaviour change, not the file list. -->

## Why

<!-- The failure or gap this closes. Link the issue if there is one. -->

## Evidence

<!-- Real commands and their real output. "Tests pass" alone is not evidence. -->

```text
$ pnpm typecheck
$ pnpm test
$ pnpm verify:package
```

## Risk and rollback

<!-- What could this break for an embedding runtime, and how do we undo it? -->

- Risk:
- Rollback:

## Checklist

- [ ] One behaviour change, surgical diff
- [ ] No new runtime dependency
- [ ] Contract suite / embedder smoke checks extended if supervisor or driver behaviour changed
- [ ] README / CHANGELOG / ARCHITECTURE updated when the public API changed
- [ ] No secrets, tokens, or private paths in the diff
