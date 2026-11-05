import { createHash } from 'node:crypto';
import path from 'node:path';
import { isPathContained, resolveRealPath } from '../capability/path-utils.js';
import type { ExecutionDomain } from '../domain.js';
import type { ProcessSupervisor } from '../supervisor/supervisor.js';
import type { OperationResult } from '../types.js';
import { decodeProgram, encodeJson, encodeProgram } from './codec.js';
import { IsaControlPlane } from './control.js';
import { executePipeline, PipelineDomainCoordinator, type PipelineInstructionOutcome, type PipelineRunOptions, type PipelineRunResult } from './pipeline.js';
import type { ControlStatusArgs, Instruction, JsonObject, Program, WorkspaceRef } from './types.js';
import { validateProgram, type ValidationIssue } from './validator.js';

/** Preview binding. The host registers the Task/Run and owns workspace names. */
export interface KernelExecutionBinding {
  domain: ExecutionDomain;
  supervisor: ProcessSupervisor;
  workspaces: Readonly<Partial<Record<WorkspaceRef, string>>>;
}

export interface KernelUnsupportedResult {
  status: 'unsupported';
  mode?: string;
  issues: [{ code: 'invalid_value'; path: string; message: string }];
}

const supported = new Set(['workspace.snapshot', 'workspace.rollback', 'control.status', 'control.health']);
const coordinators = new WeakMap<ExecutionDomain, PipelineDomainCoordinator>();
const BINDING_EVENT = 'ISA_INSTRUCTION_BOUND';

function rejected(input: unknown, issues: ValidationIssue[]): PipelineRunResult {
  const program = input as Partial<Program> | null;
  return {
    requestId: program?.requestId, programId: program?.programId,
    status: 'rejected', results: [], issues,
  };
}

function unsupported(path: string, message: string): KernelUnsupportedResult {
  return { status: 'unsupported', mode: 'pipeline', issues: [{ code: 'invalid_value', path, message }] };
}

function workspaceOf(program: Program, instruction: Instruction): WorkspaceRef | undefined {
  const args = instruction.args as unknown as Record<string, unknown>;
  return (args.workspace ?? program.workspace) as WorkspaceRef | undefined;
}

function rootsOf(binding: KernelExecutionBinding, program: Program, instruction: Instruction): string[] {
  if (instruction.op !== 'workspace.snapshot' && instruction.op !== 'workspace.rollback') return [];
  const workspace = workspaceOf(program, instruction);
  const bound = workspace && binding.workspaces[workspace];
  if (!bound) throw new Error(`Workspace '${workspace ?? ''}' has no host binding`);
  const root = resolveRealPath(bound);
  const roots = instruction.args.roots?.length ? instruction.args.roots : ['.'];
  return roots.map((entry) => {
    const resolved = resolveRealPath(path.resolve(root, entry));
    if (!isPathContained(root, resolved)) throw new Error(`Workspace root '${entry}' escapes its host binding`);
    return resolved;
  });
}

function admit(binding: KernelExecutionBinding, program: Program, instruction: Instruction): void {
  if (!program.capability) throw new Error('A persisted domain capability is required');
  if (instruction.op === 'workspace.snapshot' || instruction.op === 'workspace.rollback') {
    const run = binding.domain.getStore().getRun(program.programId);
    if (!run || run.domainId !== binding.domain.domainId || run.status !== 'running') throw new Error('The bound Run is no longer running');
  }
  binding.domain.checkCapabilityAdmission({
    capabilityId: program.capability,
    opcode: instruction.op,
    workspace: workspaceOf(program, instruction),
    mutationRoots: rootsOf(binding, program, instruction),
    requestedLimits: { concurrentOps: 1 },
    runId: program.programId,
    opId: instruction.opId,
  });
}

function fingerprint(binding: KernelExecutionBinding, program: Program, instruction: Instruction): string {
  return createHash('sha256').update(encodeJson({
    isa: program.isa, programId: program.programId, capability: program.capability ?? null,
    workspace: program.workspace ?? null, instruction,
    roots: rootsOf(binding, program, instruction),
  } as unknown as JsonObject, { canonical: true })).digest('hex');
}

/** Binding records map ISA input identity to existing core operations; they are not an execution state machine. */
function bindOperation(binding: KernelExecutionBinding, program: Program, instruction: Instruction): void {
  const { domain } = binding;
  const store = domain.getStore();
  const digest = fingerprint(binding, program, instruction);
  const existing = store.getJournalEvents(domain.domainId, 0, Number.MAX_SAFE_INTEGER, [BINDING_EVENT])
    .find((event) => event.operationId === instruction.opId);
  if (existing) {
    const payload = existing.payload as Record<string, unknown>;
    if (existing.runId !== program.programId || payload.fingerprint !== digest) {
      throw new Error(`Operation id '${instruction.opId}' is bound to different ISA input`);
    }
    return;
  }
  if (store.getOperation(instruction.opId!)) throw new Error(`Operation id '${instruction.opId}' already belongs to an unbound core operation`);
  store.recordJournalEvent({
    domainId: domain.domainId, runId: program.programId, operationId: instruction.opId,
    type: BINDING_EVENT,
    payload: { programId: program.programId, instructionId: instruction.id, opcode: instruction.op, fingerprint: digest },
    timestamp: new Date().toISOString(),
  });
}

function controlTarget(binding: KernelExecutionBinding, program: Program, args: ControlStatusArgs): ControlStatusArgs {
  const target = { ...args };
  const store = binding.domain.getStore();
  if (args.instruction) {
    const declared = program.instructions.find((instruction) => instruction.id === args.instruction);
    const bound = declared?.opId && store.getJournalEvents(binding.domain.domainId, 0, Number.MAX_SAFE_INTEGER, [BINDING_EVENT])
      .some((event) => event.runId === program.programId && event.operationId === declared.opId
        && (event.payload as Record<string, unknown>).instructionId === declared.id);
    if (!declared?.opId || !bound) throw new Error(`Instruction '${args.instruction}' has no durable binding in this Program`);
    target.instruction = declared.opId;
  }
  const fromLease = target.lease?.slice('lease:'.length);
  if (target.instruction && fromLease && target.instruction !== fromLease) throw new Error('Control instruction and lease identify different operations');
  const operationId = fromLease ?? target.instruction;
  const operation = operationId && store.getOperation(operationId);
  if (operation && operation.runId !== program.programId) throw new Error('Control target belongs to another Run');
  return target;
}

function outcome(result: OperationResult, replayed = false): PipelineInstructionOutcome {
  const status = result.status === 'restored' ? 'rolled_back' : result.status;
  const value = JSON.parse(JSON.stringify({ ...result, ...(replayed ? { replayed: true } : {}) })) as JsonObject;
  if (result.kind === 'snapshot' && result.snapshot) value.snapshotRef = `snapshot:${result.snapshot.id}`;
  return {
    status,
    value,
    ...(result.status === 'failed' ? { error: { code: 'kernel_operation_failed', message: 'errorMessage' in result ? result.errorMessage ?? 'kernel operation failed' : 'kernel operation failed' } } : {}),
  };
}

/**
 * Executes only primitives already backed by the durable kernel. Unsupported
 * opcodes reject the entire Program before any supported prefix can execute.
 */
export async function executeKernelPipeline(
  input: unknown,
  binding: KernelExecutionBinding,
  options: Pick<PipelineRunOptions, 'signal' | 'maxConcurrency'> = {},
): Promise<PipelineRunResult | KernelUnsupportedResult> {
  binding = { ...binding, workspaces: { ...binding.workspaces } };
  const validation = validateProgram(input, { requireCapability: false });
  if (!validation.ok) return rejected(input, validation.issues);
  const program = decodeProgram(encodeProgram(validation.program));
  if (program.mode !== 'pipeline') return unsupported('mode', 'The kernel pipeline adapter only accepts mode=pipeline');
  if (program.options && Object.keys(program.options).length > 0) return unsupported('options', 'The preview kernel adapter does not yet implement Program options');
  if (binding.supervisor.getDomain() !== binding.domain) return rejected(program, [{ code: 'invalid_value', path: 'kernel', message: 'supervisor and domain bindings differ' }]);
  if (binding.domain.isClosed() || binding.domain.isDomainFenced()) return rejected(program, [{ code: 'invalid_value', path: 'kernel', message: 'execution domain is closed or fenced' }]);
  const unimplemented = program.instructions.find((instruction) => !supported.has(instruction.op));
  if (unimplemented) return unsupported(`instructions.${unimplemented.id}.op`, `No durable kernel adapter for '${unimplemented.op}'`);
  if (program.instructions.some((instruction) => instruction.precondition.some((condition) => condition.kind !== 'instruction_status'))) {
    return unsupported('precondition', 'The preview kernel adapter does not yet provide atomic external precondition checks');
  }
  const run = binding.domain.getStore().getRun(program.programId);
  const readOnlyControl = program.instructions.every((instruction) => instruction.op === 'control.health' || instruction.op === 'control.status');
  if (!run || run.domainId !== binding.domain.domainId || (!readOnlyControl && run.status !== 'running')) {
    return rejected(program, [{ code: 'invalid_value', path: 'programId', message: 'programId must identify a registered Run; side effects require status=running' }]);
  }
  try {
    for (const instruction of program.instructions) {
      admit(binding, program, instruction);
      if (instruction.op === 'workspace.snapshot' || instruction.op === 'workspace.rollback') bindOperation(binding, program, instruction);
    }
  } catch (error) {
    return rejected(program, [{ code: 'capability_denied', path: 'capability', message: error instanceof Error ? error.message : String(error) }]);
  }
  let coordinator = coordinators.get(binding.domain);
  if (!coordinator) {
    coordinator = new PipelineDomainCoordinator();
    coordinators.set(binding.domain, coordinator);
  }
  const control = new IsaControlPlane(binding.domain, binding.supervisor);
  return executePipeline(program, async ({ instruction }) => {
    // A queued request must not reuse admission made before revocation or expiry.
    admit(binding, program, instruction);
    if (instruction.op === 'control.health') return { status: 'succeeded', value: JSON.parse(JSON.stringify(control.health())) as JsonObject };
    if (instruction.op === 'control.status') return { status: 'succeeded', value: JSON.parse(JSON.stringify(control.status(controlTarget(binding, program, instruction.args)))) as JsonObject };
    bindOperation(binding, program, instruction);
    const previous = binding.domain.getStore().getOperation(instruction.opId!);
    if (previous) {
      if (previous.runId !== program.programId) throw new Error('Core operation belongs to another Run');
      if (previous.result) return outcome(previous.result, true);
      return {
        status: 'indeterminate',
        value: { operationId: previous.id, lease: `lease:${previous.id}`, nextActions: ['control.status', 'control.resolve'], possibleEffects: ['kernel operation has no durable terminal result'] },
      };
    }
    const roots = rootsOf(binding, program, instruction);
    if (instruction.op === 'workspace.snapshot') {
      return outcome(await binding.supervisor.captureSnapshot({
        runId: program.programId, opId: instruction.opId!, roots,
        capabilityId: program.capability, capabilityWorkspace: workspaceOf(program, instruction),
      }));
    }
    if (instruction.op === 'workspace.rollback') {
      const snapshotId = instruction.args.snapshot.slice('snapshot:'.length);
      const snapshot = binding.domain.getStore().getSnapshot(snapshotId);
      if (!snapshot || snapshot.domainId !== binding.domain.domainId) throw new Error('Snapshot does not belong to this domain');
      if (!snapshot.roots.every((root) => roots.some((allowed) => isPathContained(allowed, root)))) throw new Error('Snapshot roots escape the bound workspace');
      return outcome(await binding.supervisor.rollback({
        runId: program.programId, opId: instruction.opId!, snapshotId, roots,
        capabilityId: program.capability, capabilityWorkspace: workspaceOf(program, instruction),
      }));
    }
    throw new Error(`Unsupported kernel opcode '${instruction.op}'`);
  }, { ...options, domain: coordinator, requireCapability: false });
}
