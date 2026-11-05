# XIO-ISA v1 versioning and compatibility

**Status:** terminology frozen for Gate 0 (A-04), 2026-11-02
**Authority:** this document defines the four version domains used by the
XIO-ISA v1 plan. It does not claim that v1 execution or schema migration is
implemented yet.

## Four independent version domains

| Domain | Shape | What it versions | What changes it | What it must not control |
| --- | --- | --- | --- | --- |
| **ISA version** | `xio/<major>` or `xio/<major>.<minor>`; examples: `xio/1`, `xio/1.0`, `xio/1.1` | Opcode names, instruction/result semantics, state transitions, and compatibility rules | An accepted ISA RFC and registry release | JSON field encoding, SQLite layout, driver implementation, or npm packaging |
| **Schema version** | `<major>.<minor>`; used independently for Program/result/journal/schema artifacts | Wire fields, JSON/CBOR shapes, event envelope, and persisted database projections | A schema change with migration or explicit rejection rules | Opcode meaning, driver capability, or package version |
| **Driver capability version** | `<driver-name>/<major>.<minor>`; examples: `node/1.0`, `reaper/1.0`, `cgroup/1.0` | The facts and guarantees a selected driver can prove (observation, stop, containment, resource limits) | A driver contract or capability-matrix change | ISA compatibility or a claim that another driver can provide the same facts |
| **Package version** | npm SemVer, currently `0.8.0` | The distributed TypeScript package, CLI, generated files, and adapters | Release tooling and `package.json` | ISA/schema/driver meaning; a package release may carry several version domains |

An execution request records or negotiates all applicable domains. A package
version is a delivery coordinate, not a protocol selector. A driver name and
capability version are evidence about the selected host, not a promise to use
another driver after recovery.

## ISA compatibility rules

1. `xio/1` is a major-only request. The peer chooses a supported `1.x` minor
   and returns the exact negotiated value before execution. It does not mean
   “accept every future field”.
2. `xio/1.0` selects the v1 baseline. A 1.1 implementation may execute a 1.0
   Program only with 1.0 semantics; 1.1-only opcodes or required fields are
   rejected at admission.
3. `xio/1.1` selects the 1.1 contract. It may add opcodes, optional fields, or
   evidence while preserving all 1.0 meanings. A peer that only supports 1.0
   must reject the request unless an adapter performs an explicit downgrade
   before admission; the kernel never silently rewrites the Program.
4. An unknown minor is rejected as `unsupported_isa_minor` before journal,
   lease, file, artifact, or process side effects. A peer may report the
   supported minor range so an adapter can retry with a user-approved version.
5. A v1 minor must not remove or reinterpret a stable opcode, result status,
   error meaning, or recovery rule. Such a change requires ISA major 2 and a
   migration plan.

## Schema compatibility rules

- A schema minor may add optional fields and preserve unknown fields during
  forwarding, but readers must not infer meaning for an unknown field.
- A schema major or an incompatible minor is rejected before admission. Persisted
  data is opened only through a numbered migration with checksum and a
  half-applied check; it is never upgraded by changing a version label.
- JSON and CBOR are encodings of the same schema. Encoding changes do not create
  a new ISA version or a new result state.

## Driver capability rules

- Admission records the selected driver name and its capability version. A
  missing, newer, or incompatible capability contract returns `unsupported` and
  does not fall back to a weaker unannounced driver.
- Recovery uses the capability evidence recorded with the original intent. It
  never reinterprets an old intent using the current package or replacement
  driver's version.
- A capability minor may add an observation or limit with an explicit matrix
  entry. Removing a fact or weakening a guarantee requires a new driver major
  or an `unsupported` result for the affected opcode.

## Package release rules

- Patch releases may fix implementation bugs without changing stable ISA or
  schema behavior.
- Minor package releases may add preview/experimental exports and generated
  artifacts; they must preserve the declared ISA/schema contracts.
- A package major release is required for removing a stable export or changing
  a stable contract, and it must link a migration/RFC.
- The package version never authorizes an ISA downgrade or a schema migration;
  those decisions remain explicit in admission and storage.

