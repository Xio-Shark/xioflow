/** Generated from spec/isa-v1/registry.json. Do not edit by hand. */
import type { Opcode } from './opcodes.generated.js';

export const ISA_V1_REGISTRY = {
  "fs.read": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsReadArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.read",
      "artifact.put"
    ],
    "atomicity": "pure",
    "observation": "filesystem.content_and_hash",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.read",
      "artifact.write"
    ],
    "drivers": [
      "node.filesystem",
      "artifact.store"
    ]
  },
  "fs.write": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsWriteArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.write",
      "artifact.get"
    ],
    "atomicity": "local_atomic",
    "observation": "filesystem.hash_after_write",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.write",
      "artifact.read"
    ],
    "drivers": [
      "node.filesystem",
      "artifact.store"
    ]
  },
  "fs.patch": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsPatchArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.write",
      "artifact.get"
    ],
    "atomicity": "local_atomic",
    "observation": "filesystem.diff_and_hash",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.read",
      "io.write",
      "artifact.read"
    ],
    "drivers": [
      "node.filesystem",
      "artifact.store"
    ]
  },
  "fs.move": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsMoveArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.write"
    ],
    "atomicity": "local_atomic",
    "observation": "filesystem.path_transition",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.metadata"
    ],
    "drivers": [
      "node.filesystem"
    ]
  },
  "fs.delete": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsDeleteArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.delete"
    ],
    "atomicity": "compensatable",
    "observation": "filesystem.delete_manifest",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.write",
      "artifact.write"
    ],
    "drivers": [
      "node.filesystem",
      "artifact.store"
    ]
  },
  "fs.stat": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/FsStatArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.read"
    ],
    "atomicity": "pure",
    "observation": "filesystem.stat_fingerprint",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.metadata"
    ],
    "drivers": [
      "node.filesystem"
    ]
  },
  "workspace.snapshot": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/WorkspaceSnapshotArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "workspace.snapshot",
      "filesystem.read",
      "artifact.put"
    ],
    "atomicity": "local_atomic",
    "observation": "workspace.tree_fingerprint",
    "idempotency": "op_id_required",
    "rollback": "none",
    "resourceCost": [
      "io.scan",
      "artifact.write"
    ],
    "drivers": [
      "workspace.git-shadow",
      "artifact.store"
    ]
  },
  "workspace.diff": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/WorkspaceDiffArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "workspace.read",
      "filesystem.read"
    ],
    "atomicity": "pure",
    "observation": "workspace.diff_facts",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.scan"
    ],
    "drivers": [
      "workspace.git-shadow"
    ]
  },
  "workspace.commit": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/WorkspaceCommitArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "workspace.commit",
      "filesystem.write"
    ],
    "atomicity": "compensatable",
    "observation": "workspace.conflict_check_and_apply",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.scan",
      "io.write",
      "artifact.write"
    ],
    "drivers": [
      "workspace.git-shadow",
      "node.filesystem",
      "artifact.store"
    ]
  },
  "workspace.rollback": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/WorkspaceRollbackArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "workspace.rollback",
      "filesystem.write"
    ],
    "atomicity": "compensatable",
    "observation": "workspace.rollback_coverage_and_fingerprint",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.scan",
      "io.write"
    ],
    "drivers": [
      "workspace.git-shadow",
      "node.filesystem"
    ]
  },
  "proc.spawn": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ProcSpawnArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "process.spawn"
    ],
    "atomicity": "external",
    "observation": "driver.identity_and_spawn_gate",
    "idempotency": "op_id_required_no_replay",
    "rollback": "impossible",
    "resourceCost": [
      "cpu",
      "memory",
      "pids",
      "output"
    ],
    "drivers": [
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "proc.wait": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ProcWaitArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "process.inspect"
    ],
    "atomicity": "external",
    "observation": "driver.tree_settlement_and_exit",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "cpu",
      "memory",
      "pids",
      "output"
    ],
    "drivers": [
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "proc.signal": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ProcSignalArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "process.signal"
    ],
    "atomicity": "external",
    "observation": "driver.stop_confirmation",
    "idempotency": "op_id_required_no_replay",
    "rollback": "impossible",
    "resourceCost": [
      "pids"
    ],
    "drivers": [
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "proc.inspect": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ProcInspectArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "process.inspect"
    ],
    "atomicity": "pure",
    "observation": "driver.process_facts",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "cpu",
      "memory",
      "pids"
    ],
    "drivers": [
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "observe.files": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ObserveFilesArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "filesystem.observe"
    ],
    "atomicity": "sampled",
    "observation": "filesystem.sample",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.scan"
    ],
    "drivers": [
      "node.filesystem"
    ]
  },
  "observe.resources": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ObserveResourcesArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "process.observe_resources"
    ],
    "atomicity": "sampled",
    "observation": "driver.resource_sample",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "cpu",
      "memory",
      "pids",
      "output"
    ],
    "drivers": [
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "control.status": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ControlStatusArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "control.read"
    ],
    "atomicity": "pure",
    "observation": "journal.status_projection",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "journal.read"
    ],
    "drivers": [
      "journal.store"
    ]
  },
  "control.health": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ControlHealthArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "control.read"
    ],
    "atomicity": "pure",
    "observation": "journal.driver_health",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "journal.read"
    ],
    "drivers": [
      "journal.store"
    ]
  },
  "control.cancel": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ControlCancelArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "control.cancel",
      "process.signal"
    ],
    "atomicity": "external",
    "observation": "driver.stop_confirmation",
    "idempotency": "op_id_required_no_replay",
    "rollback": "impossible",
    "resourceCost": [
      "pids",
      "journal.write"
    ],
    "drivers": [
      "journal.store",
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "control.resolve": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ControlResolveArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "control.resolve"
    ],
    "atomicity": "local_atomic",
    "observation": "journal.resolution_record",
    "idempotency": "op_id_required",
    "rollback": "impossible",
    "resourceCost": [
      "journal.write"
    ],
    "drivers": [
      "journal.store"
    ]
  },
  "control.resume": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ControlResumeArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "control.resume"
    ],
    "atomicity": "external",
    "observation": "journal.resume_and_driver_evidence",
    "idempotency": "op_id_required_no_replay",
    "rollback": "impossible",
    "resourceCost": [
      "journal.write",
      "cpu",
      "memory",
      "pids"
    ],
    "drivers": [
      "journal.store",
      "node.process",
      "reaper.process",
      "cgroup.process"
    ]
  },
  "artifact.put": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ArtifactPutArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "artifact.put"
    ],
    "atomicity": "local_atomic",
    "observation": "artifact.hash_after_write",
    "idempotency": "op_id_required",
    "rollback": "compensatable",
    "resourceCost": [
      "io.write",
      "artifact.write"
    ],
    "drivers": [
      "artifact.store"
    ]
  },
  "artifact.get": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ArtifactGetArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "artifact.get"
    ],
    "atomicity": "pure",
    "observation": "artifact.hash_and_range",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.read",
      "artifact.read"
    ],
    "drivers": [
      "artifact.store"
    ]
  },
  "artifact.stream": {
    "version": "1.0",
    "inputSchema": "./instruction.schema.json#/$defs/ArtifactStreamArgs",
    "outputSchema": "./result.schema.json#/$defs/InstructionValue",
    "requiredCapabilities": [
      "artifact.get"
    ],
    "atomicity": "pure",
    "observation": "artifact.hash_and_cursor",
    "idempotency": "safe",
    "rollback": "none",
    "resourceCost": [
      "io.read",
      "artifact.read"
    ],
    "drivers": [
      "artifact.store"
    ]
  }
} as const;

export type OpcodeMetadata = (typeof ISA_V1_REGISTRY)[Opcode];
