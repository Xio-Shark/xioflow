import type {
  ArtifactRef,
  CapabilityRef,
  Instruction,
  OperationId,
  Program,
  SecretRef,
  SnapshotRef,
  WorkspaceRef,
} from './types.js';

export interface ProgramIdentity {
  requestId: string;
  programId: string;
  capability?: CapabilityRef;
  workspace?: WorkspaceRef;
  mode?: Program['mode'];
}

export interface ProcessCompileSpec extends ProgramIdentity {
  id: string;
  argv: string[];
  cwd: WorkspaceRef;
  stdio?: 'capture' | 'inherit' | 'ignore' | 'stream';
  env?: Record<string, string>;
  secretEnv?: Record<string, SecretRef>;
  timeoutMs?: number;
  opId?: OperationId;
}

export interface WorkspaceSnapshotCompileSpec extends ProgramIdentity {
  label: string;
  roots?: string[];
  opId?: OperationId;
}

export interface WorkspaceDiffCompileSpec extends ProgramIdentity {
  from: string;
  to?: string;
  opId?: OperationId;
}

export interface WorkspaceRollbackCompileSpec extends ProgramIdentity {
  snapshot: SnapshotRef;
  roots?: string[];
  opId?: OperationId;
}

export interface ArtifactPutCompileSpec extends ProgramIdentity {
  content: string;
  mediaType?: string;
  sensitivity?: 'public' | 'internal' | 'secret';
  ttlMs?: number;
  opId?: OperationId;
}

export interface ArtifactGetCompileSpec extends ProgramIdentity {
  artifact: ArtifactRef;
  range?: { start: number; end: number };
  opId?: OperationId;
}

export interface ArtifactStreamCompileSpec extends ProgramIdentity {
  artifact: ArtifactRef;
  cursor?: `cursor:${string}`;
  maxBytes?: number;
  opId?: OperationId;
}

function opId(programId: string, label: string, explicit?: OperationId): OperationId {
  if (explicit) return explicit;
  return `op:${programId}.${label}`;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function identity(spec: ProgramIdentity): Pick<Program, 'isa' | 'requestId' | 'programId' | 'mode' | 'capability' | 'workspace'> {
  return omitUndefined({
    isa: 'xio/1', requestId: spec.requestId, programId: spec.programId, mode: spec.mode ?? 'pipeline', capability: spec.capability, workspace: spec.workspace,
  });
}

function single(spec: ProgramIdentity, instruction: Instruction): Program {
  return { ...identity(spec), instructions: [instruction] };
}

export function compileExecuteProcess(spec: ProcessCompileSpec): Program {
  const spawnId = `${spec.id}.spawn`;
  const waitId = `${spec.id}.wait`;
  const processRef = `process:${spec.programId}.${spec.id}` as const;
  const spawn: Instruction = {
    id: spawnId,
    op: 'proc.spawn',
    args: omitUndefined({
      argv: [...spec.argv], cwd: spec.cwd, stdio: spec.stdio ?? 'capture',
      env: spec.env ? { ...spec.env } : undefined,
      secretEnv: spec.secretEnv ? { ...spec.secretEnv } : undefined,
      timeoutMs: spec.timeoutMs,
    }),
    dependsOn: [], precondition: [], output: `${spec.id}.process`, opId: opId(spec.programId, `${spec.id}.spawn`, spec.opId),
  };
  const wait: Instruction = {
    id: waitId,
    op: 'proc.wait',
    args: omitUndefined({ process: processRef, timeoutMs: spec.timeoutMs }),
    dependsOn: [spawnId], precondition: [{ kind: 'instruction_status', instruction: spawnId, status: 'succeeded' }], output: `${spec.id}.result`, opId: opId(spec.programId, `${spec.id}.wait`),
  };
  return { ...identity(spec), instructions: [spawn, wait] };
}

export function compileWorkspaceSnapshot(spec: WorkspaceSnapshotCompileSpec): Program {
  return single(spec, {
    id: 'workspace.snapshot', op: 'workspace.snapshot',
    args: omitUndefined({ workspace: spec.workspace, label: spec.label, roots: spec.roots ? [...spec.roots] : undefined }),
    dependsOn: [], precondition: [], output: 'snapshot', opId: opId(spec.programId, 'workspace.snapshot', spec.opId),
  });
}

export function compileWorkspaceDiff(spec: WorkspaceDiffCompileSpec): Program {
  return single(spec, {
    id: 'workspace.diff', op: 'workspace.diff', args: omitUndefined({ workspace: spec.workspace, from: spec.from, to: spec.to }),
    dependsOn: [], precondition: [], output: 'diff', opId: opId(spec.programId, 'workspace.diff', spec.opId),
  });
}

export function compileWorkspaceRollback(spec: WorkspaceRollbackCompileSpec): Program {
  return single(spec, {
    id: 'workspace.rollback', op: 'workspace.rollback',
    args: omitUndefined({ workspace: spec.workspace, snapshot: spec.snapshot, roots: spec.roots ? [...spec.roots] : undefined }),
    dependsOn: [], precondition: [], output: 'rollback', opId: opId(spec.programId, 'workspace.rollback', spec.opId),
  });
}

export function compileArtifactPut(spec: ArtifactPutCompileSpec): Program {
  return single(spec, {
    id: 'artifact.put', op: 'artifact.put',
    args: omitUndefined({ content: spec.content, mediaType: spec.mediaType, sensitivity: spec.sensitivity, ttlMs: spec.ttlMs }),
    dependsOn: [], precondition: [], output: 'artifact', opId: opId(spec.programId, 'artifact.put', spec.opId),
  });
}

export function compileArtifactGet(spec: ArtifactGetCompileSpec): Program {
  return single(spec, {
    id: 'artifact.get', op: 'artifact.get', args: omitUndefined({ artifact: spec.artifact, range: spec.range }),
    dependsOn: [], precondition: [], output: 'content', opId: opId(spec.programId, 'artifact.get', spec.opId),
  });
}

export function compileArtifactStream(spec: ArtifactStreamCompileSpec): Program {
  return single(spec, {
    id: 'artifact.stream', op: 'artifact.stream', args: omitUndefined({ artifact: spec.artifact, cursor: spec.cursor, maxBytes: spec.maxBytes }),
    dependsOn: [], precondition: [], output: 'chunk', opId: opId(spec.programId, 'artifact.stream', spec.opId),
  });
}
