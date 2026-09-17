---
name: trellis-update-spec
description: "Captures executable contracts and coding conventions into .trellis/spec/ documents. Use when learning something valuable from debugging, implementing, or discussion that should be preserved for future sessions."
---

# Update Code-Spec — Capture What You Learned

Use after implementing, debugging, or making a design decision worth keeping.

## What Goes Where

- `.trellis/spec/<package>/<layer>/*.md` — **how to write the code**: signatures, contracts, conventions, error behavior
- `.trellis/spec/guides/*.md` — **what to think about**: checklists, questions, pointers to specs

Rule: "how to implement" → layer file; "what to consider" → guide.

## When to Update

- Fixed a bug → the pitfall and its prevention
- Made a design decision → why X over Y
- Found a pattern or convention → with a concrete example
- Cross-layer contract changed → the contract: request/response fields, env keys, error cases

Not every task produces an update — a deliberate "nothing to record" is a valid conclusion.

## How

1. Read the target spec first — match its structure, don't duplicate
2. Be specific: real signatures, `file:line` anchors, short code snippets; explain *why*, not just *what*
3. Update the layer's `index.md` if you added a file or changed a section's status

For contract-level changes (new command/API signature, schema change, infra/env wiring), include: scope, signatures, request/response/env contract, validation & error cases, and at least one wrong-vs-correct example.

## Related

- ``break-loop` (Trellis command)` — bug analysis that often reveals needed spec updates
- ``finish-work` (Trellis command)` — wrap-up that reminds you to check spec updates
