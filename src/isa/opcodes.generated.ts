/** Generated from spec/isa-v1/registry.json. Do not edit by hand. */
export const ISA_V1_OPCODES = [
  "fs.read",
  "fs.write",
  "fs.patch",
  "fs.move",
  "fs.delete",
  "fs.stat",
  "workspace.snapshot",
  "workspace.diff",
  "workspace.commit",
  "workspace.rollback",
  "proc.spawn",
  "proc.wait",
  "proc.signal",
  "proc.inspect",
  "observe.files",
  "observe.resources",
  "control.status",
  "control.health",
  "control.cancel",
  "control.resolve",
  "control.resume",
  "artifact.put",
  "artifact.get",
  "artifact.stream"
] as const;

export type Opcode = typeof ISA_V1_OPCODES[number];
