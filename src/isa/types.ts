import type { Opcode } from './opcodes.generated.js';

/** JSON values accepted by the ISA encodings. BigInt, undefined and binary values are excluded. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export type IsaVersion = 'xio/1' | `xio/1.${number}`;
export type SchemaVersion = `${number}.${number}`;
export type RequestId = string;
export type ProgramId = string;
export type InstructionId = string;
export type OperationId = `op:${string}`;
export type OutputRef = string;
export type Path = string;
export type Hash = string;

export type CapabilityRef = `cap:${string}`;
export type WorkspaceRef = `workspace:${string}`;
export type ArtifactRef = `artifact:${string}`;
export type ProcessRef = `process:${string}`;
export type SnapshotRef = `snapshot:${string}`;
export type TransactionRef = `transaction:${string}`;
export type LeaseRef = `lease:${string}`;
export type ResumeToken = `resume:${string}`;
export type SecretRef = `secret:${string}`;
export type EventCursor = `event:${string}`;
export type ArtifactCursor = `cursor:${string}`;

export type { Opcode };

export interface CapabilityScope {
  opcodes: Opcode[];
  workspaces: WorkspaceRef[];
  paths: string[];
  secrets: SecretRef[];
}

export interface CapabilityLimits {
  cpuMs: number;
  memoryBytes: number;
  outputBytes: number;
  concurrentOps: number;
  processes: number;
}

export interface Capability {
  id: CapabilityRef;
  issuer: string;
  policyVersion: string;
  reason: string;
  scope: CapabilityScope;
  limits: CapabilityLimits;
  expiresAt: string;
  parentId?: CapabilityRef;
  epoch: number;
}

export interface Range {
  start: number;
  end: number;
}

export interface FsReadArgs {
  workspace?: WorkspaceRef;
  path: Path;
  range?: Range;
}

export interface FsWriteArgs {
  workspace?: WorkspaceRef;
  path: Path;
  content: ArtifactRef;
  expectedHash?: Hash;
}

export interface FsPatchArgs {
  workspace?: WorkspaceRef;
  path: Path;
  patch: ArtifactRef;
  expectedHash?: Hash;
}

export interface FsMoveArgs {
  workspace?: WorkspaceRef;
  from: Path;
  to: Path;
}

export interface FsDeleteArgs {
  workspace?: WorkspaceRef;
  path: Path;
  recursive?: boolean;
}

export interface FsStatArgs {
  workspace?: WorkspaceRef;
  path: Path;
}

export interface WorkspaceSnapshotArgs {
  workspace?: WorkspaceRef;
  label: string;
  roots?: Path[];
}

export interface WorkspaceDiffArgs {
  workspace?: WorkspaceRef;
  from: string;
  to?: string;
}

export interface WorkspaceCommitArgs {
  workspace?: WorkspaceRef;
  transaction: TransactionRef;
}

export interface WorkspaceRollbackArgs {
  workspace?: WorkspaceRef;
  snapshot: SnapshotRef;
  roots?: Path[];
}

export interface ProcSpawnArgs {
  argv: string[];
  cwd: WorkspaceRef;
  env?: Record<string, string>;
  secretEnv?: Record<string, SecretRef>;
  stdio: 'capture' | 'inherit' | 'ignore' | 'stream';
  timeoutMs?: number;
}

export interface ProcWaitArgs {
  process: ProcessRef;
  timeoutMs?: number;
}

export interface ProcSignalArgs {
  process: ProcessRef;
  signals: string[];
  graceMs?: number;
}

export interface ProcInspectArgs {
  process: ProcessRef;
}

export interface ObserveFilesArgs {
  workspace?: WorkspaceRef;
  paths: Path[];
  depth?: number;
}

export interface ObserveResourcesArgs {
  process: ProcessRef;
  intervalMs?: number;
}

export type ControlTarget =
  | { program: string; instruction?: InstructionId; lease?: LeaseRef }
  | { instruction: InstructionId; program?: string; lease?: LeaseRef }
  | { lease: LeaseRef; program?: string; instruction?: InstructionId };

export type ControlStatusArgs = ControlTarget;
export interface ControlHealthArgs {
  // Intentionally empty: health is a read-only control-plane probe.
}
export type ControlCancelArgs = ControlTarget & { graceMs?: number };

export interface ControlResolveArgs {
  lease: LeaseRef;
  decision: 'succeeded' | 'failed' | 'rolled_back' | 'partial';
  reason: string;
  evidence?: ArtifactRef;
}

export interface ControlResumeArgs {
  resumeToken: ResumeToken;
}

export interface ArtifactPutArgs {
  content: string;
  mediaType?: string;
  sensitivity?: 'public' | 'internal' | 'secret';
  ttlMs?: number;
}

export interface ArtifactGetArgs {
  artifact: ArtifactRef;
  range?: Range;
}

export interface ArtifactStreamArgs {
  artifact: ArtifactRef;
  cursor?: ArtifactCursor;
  maxBytes?: number;
}

export interface FileHashPrecondition {
  kind: 'file_hash';
  path: Path;
  sha256: Hash;
}

export interface ArtifactHashPrecondition {
  kind: 'artifact_hash';
  artifact: ArtifactRef;
  sha256: Hash;
}

export interface InstructionStatusPrecondition {
  kind: 'instruction_status';
  instruction: InstructionId;
  status: 'admitted' | 'succeeded' | 'failed' | 'indeterminate' | 'cancelled' | 'rolled_back' | 'partial';
}

export interface WorkspaceRevisionPrecondition {
  kind: 'workspace_revision';
  workspace: WorkspaceRef;
  revision: string;
}

export type Precondition =
  | FileHashPrecondition
  | ArtifactHashPrecondition
  | InstructionStatusPrecondition
  | WorkspaceRevisionPrecondition;

export interface OpcodeArgs {
  'fs.read': FsReadArgs;
  'fs.write': FsWriteArgs;
  'fs.patch': FsPatchArgs;
  'fs.move': FsMoveArgs;
  'fs.delete': FsDeleteArgs;
  'fs.stat': FsStatArgs;
  'workspace.snapshot': WorkspaceSnapshotArgs;
  'workspace.diff': WorkspaceDiffArgs;
  'workspace.commit': WorkspaceCommitArgs;
  'workspace.rollback': WorkspaceRollbackArgs;
  'proc.spawn': ProcSpawnArgs;
  'proc.wait': ProcWaitArgs;
  'proc.signal': ProcSignalArgs;
  'proc.inspect': ProcInspectArgs;
  'observe.files': ObserveFilesArgs;
  'observe.resources': ObserveResourcesArgs;
  'control.status': ControlStatusArgs;
  'control.health': ControlHealthArgs;
  'control.cancel': ControlCancelArgs;
  'control.resolve': ControlResolveArgs;
  'control.resume': ControlResumeArgs;
  'artifact.put': ArtifactPutArgs;
  'artifact.get': ArtifactGetArgs;
  'artifact.stream': ArtifactStreamArgs;
}

export interface InstructionBase {
  id: InstructionId;
  dependsOn: InstructionId[];
  precondition: Precondition[];
  output: OutputRef;
  opId?: OperationId;
}

export type InstructionFor<Op extends Opcode> = InstructionBase & {
  op: Op;
  args: OpcodeArgs[Op];
};

export type Instruction = {
  [Op in Opcode]: InstructionFor<Op>;
}[Opcode];

export interface ExecutionOptions {
  wait?: 'until_terminal' | 'until_admitted' | 'return_cursor';
  maxOutputBytes?: number;
  eventCursor?: EventCursor | null;
}

export interface Program {
  isa: IsaVersion;
  requestId: RequestId;
  programId: ProgramId;
  mode: 'plan' | 'transaction' | 'pipeline';
  capability?: CapabilityRef;
  workspace?: WorkspaceRef;
  instructions: Instruction[];
  options?: ExecutionOptions;
}

export type ProgramStatus =
  | 'admitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'indeterminate'
  | 'partial';

export type InstructionStatus = ProgramStatus | 'rolled_back';
export type Atomicity = 'pure' | 'local_atomic' | 'compensatable' | 'external' | 'sampled';

export interface Observation {
  status: 'proven' | 'sampled' | 'unknown' | 'unsupported' | 'indeterminate';
  driver?: string;
  evidence?: ArtifactRef;
  reason?: string;
}

export interface Effects {
  changedPaths?: string[];
  createdRefs?: string[];
  possibleEffects?: string[];
}

export type Evidence = Array<ArtifactRef | WorkspaceRef | ProcessRef | SnapshotRef>;

export interface Replay {
  mode: 'none' | 'joined' | 'replayed' | 'not_replayable' | 'requires_adjudication';
  source?: string;
  reason?: string;
}

export interface Rollback {
  status: 'none' | 'available' | 'not_applicable' | 'compensated' | 'partial' | 'impossible';
  coverage?: 'complete' | 'non_ignored' | 'declared_roots' | 'unknown';
  residual?: string[];
}

export type InstructionValue = JsonObject;

export interface InstructionResult {
  id: InstructionId;
  opId?: OperationId;
  status: InstructionStatus;
  atomicity: Atomicity;
  observation: Observation;
  effects: Effects;
  evidence: Evidence;
  artifactRefs: ArtifactRef[];
  replay: Replay;
  rollback: Rollback;
  value?: InstructionValue;
  error?: JsonObject;
  lease?: LeaseRef;
  possibleEffects?: string[];
  nextActions?: string[];
  resumeToken?: ResumeToken;
}

export interface EventPage {
  nextCursor: EventCursor | null;
  omitted: number;
}

export interface ExecutionResult {
  isa: IsaVersion;
  requestId: RequestId;
  programId?: ProgramId;
  status: ProgramStatus;
  committed?: boolean;
  results: InstructionResult[];
  events: EventPage;
}
