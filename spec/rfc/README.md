# XIO RFC queue

This queue records proposals that are outside the frozen XIO-ISA v1 boundary
or cannot yet be assigned to one layer and one opcode. A queue entry is not a
roadmap commitment. It becomes implementation work only after an accepted RFC
updates the relevant registry, schema, current contract, and tests.

## Entry template

```text
ID / title:
Status: queued | accepted | rejected | superseded
Requester / date:
Affected layer:
Opcode/control operation:
Problem and user-visible trigger:
Atomicity:
Observation and evidence:
Rollback:
External side effects:
Capability impact:
Privacy and retention impact:
Driver contract and unsupported cases:
Fault, recovery, and idempotency matrix:
Migration and compatibility plan:
Performance budget:
Exit strategy and success condition:
```

## Initial queue

| ID | Proposal | Status | Reopen condition |
| --- | --- | --- | --- |
| RFC-0001 | A Rust or other-language kernel implementation | queued | A real non-Node host, measured performance limit, or independent implementation requirement with a maintainer and migration budget |
| RFC-0002 | Daemon and cross-process arbitration | queued | Multiple external frameworks contend for one workspace after worktree isolation is shown insufficient; IPC identity, leases, disconnect recovery, and a threat model are included |
| RFC-0003 | Windows or remote execution driver | queued | Platform facts, containment, artifact/secret transport, and runnable conformance evidence are defined before API work |
| RFC-0004 | Network, MCP-service, or model-provider external opcodes | queued | Secret handling, audit redaction, retry/non-replay semantics, capability limits, and a driver contract are accepted |

The historical design sections in `ARCHITECTURE.md` and `ROADMAP.md` remain
useful references for these entries, but they do not expand the v1 critical
path or the stable package contract.
