import { createHash } from 'node:crypto';
import { decodeProgram, encodeJson, encodeProgram } from './codec.js';
import { ISA_V1_REGISTRY } from './registry.generated.js';
import { validateProgram, type ValidateProgramOptions, type ValidationIssue, type ValidationPlan } from './validator.js';
import type { Instruction, InstructionStatus, JsonObject, Opcode, Precondition, Program } from './types.js';

export type PipelineStatus = 'succeeded' | 'failed' | 'partial' | 'rejected' | 'indeterminate';

export interface PipelineInstructionOutcome {
  status: Extract<InstructionStatus, 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' | 'rolled_back' | 'partial'>;
  value?: JsonObject;
  error?: JsonObject;
  evidence?: string[];
}

export interface PipelineInstructionResult extends PipelineInstructionOutcome {
  id: string;
  op: Opcode;
  resources: string[];
  joined?: boolean;
}

export interface PipelineExecutionContext {
  program: Program;
  instruction: Instruction;
  resources: readonly string[];
  signal: AbortSignal;
}

export type PipelineExecutor = (context: PipelineExecutionContext) => Promise<PipelineInstructionOutcome>;

export type ExternalPrecondition = Exclude<Precondition, { kind: 'instruction_status' }>;
export type PreconditionVerdict = 'valid' | 'stale' | 'unknown';

export interface PipelineRunOptions extends ValidateProgramOptions {
  domain?: PipelineDomainCoordinator;
  maxConcurrency?: number;
  signal?: AbortSignal;
  /** Checked under coordinator locks immediately before dispatch. Omission fails closed. */
  checkPrecondition?(condition: ExternalPrecondition, context: PipelineExecutionContext): Promise<PreconditionVerdict>;
}

export interface PipelineRunResult {
  isa?: string;
  requestId?: string;
  programId?: string;
  status: PipelineStatus;
  plan?: ValidationPlan;
  results: PipelineInstructionResult[];
  issues: ValidationIssue[];
}

interface ResourceWaiter {
  resources: string[];
  resolve: (release: () => void) => void;
}

/** Per-domain resource and in-flight coordination. It has no persistence or host side effects. */
export class PipelineDomainCoordinator {
  private readonly heldResources = new Set<string>();
  private readonly waiters: ResourceWaiter[] = [];
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<PipelineInstructionResult> }>();
  private commitTail: Promise<void> = Promise.resolve();

  acquire(resources: readonly string[]): Promise<() => void> {
    const unique = [...new Set(resources)].sort();
    return new Promise((resolve) => {
      this.waiters.push({ resources: unique, resolve });
      this.drainWaiters();
    });
  }

  joinInFlight(key: string, fingerprint: string): Promise<PipelineInstructionResult> | undefined {
    const entry = this.inFlight.get(key);
    if (entry && entry.fingerprint !== fingerprint) throw new Error(`Operation id '${key}' is already in flight with different input`);
    return entry?.result;
  }

  registerInFlight(key: string, fingerprint: string, result: Promise<PipelineInstructionResult>): void {
    this.inFlight.set(key, { fingerprint, result });
    void result.then(() => {
      if (this.inFlight.get(key)?.result === result) this.inFlight.delete(key);
    }, () => {
      if (this.inFlight.get(key)?.result === result) this.inFlight.delete(key);
    });
  }

  async withCommitQueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.commitTail;
    let release!: () => void;
    this.commitTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private drainWaiters(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (waiter.resources.some((resource) => this.heldResources.has(resource))) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      for (const resource of waiter.resources) this.heldResources.add(resource);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        for (const resource of waiter.resources) this.heldResources.delete(resource);
        this.drainWaiters();
      });
    }
  }
}

function abortOutcome(instruction: Instruction): PipelineInstructionResult {
  return {
    id: instruction.id,
    op: instruction.op,
    status: 'cancelled',
    resources: [...ISA_V1_REGISTRY[instruction.op].resourceCost],
    error: { code: 'cancelled', message: 'pipeline execution was cancelled' },
  };
}

function skippedOutcome(instruction: Instruction, dependency: string): PipelineInstructionResult {
  return {
    id: instruction.id,
    op: instruction.op,
    status: 'partial',
    resources: [...ISA_V1_REGISTRY[instruction.op].resourceCost],
    error: { code: 'dependency_failed', message: `dependency '${dependency}' did not succeed` },
  };
}

function rejectedResult(input: unknown, issues: ValidationIssue[]): PipelineRunResult {
  const value = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  return {
    isa: typeof value?.isa === 'string' ? value.isa : undefined,
    requestId: typeof value?.requestId === 'string' ? value.requestId : undefined,
    programId: typeof value?.programId === 'string' ? value.programId : undefined,
    status: 'rejected',
    results: [],
    issues,
  };
}

function finalStatus(results: PipelineInstructionResult[]): PipelineStatus {
  if (results.some((result) => result.status === 'indeterminate')) return 'indeterminate';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'partial' || result.status === 'cancelled')) return 'partial';
  return 'succeeded';
}

function dependencySucceeded(result: PipelineInstructionResult | undefined): boolean {
  return result?.status === 'succeeded' || (result?.op === 'workspace.rollback' && result.status === 'rolled_back');
}

function instructionFingerprint(program: Program, instruction: Instruction): string {
  const input = {
    isa: program.isa,
    programId: program.programId,
    capability: program.capability ?? null,
    workspace: program.workspace ?? null,
    options: program.options ?? null,
    instruction,
  };
  return createHash('sha256').update(encodeJson(input as unknown as JsonObject, { canonical: true })).digest('hex');
}

function failedOutcome(instruction: Instruction, code: string, message: string): PipelineInstructionResult {
  return {
    id: instruction.id, op: instruction.op, resources: [...ISA_V1_REGISTRY[instruction.op].resourceCost],
    status: 'failed', error: { code, message },
  };
}

export async function executePipeline(input: unknown, executor: PipelineExecutor, options: PipelineRunOptions = {}): Promise<PipelineRunResult> {
  const validation = validateProgram(input, options);
  if (!validation.ok) return rejectedResult(input, validation.issues);
  if (validation.program.mode !== 'pipeline') return rejectedResult(input, [{ code: 'invalid_value', path: 'mode', message: 'executePipeline only accepts mode=pipeline' }]);
  // Callers may reuse or mutate their objects while this program waits for resources.
  const program = decodeProgram(encodeProgram(validation.program));
  const domain = options.domain ?? new PipelineDomainCoordinator();
  const maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? 8, 256));
  const signal = options.signal ?? new AbortController().signal;
  const byId = new Map(program.instructions.map((instruction) => [instruction.id, instruction]));
  const pending = new Set(program.instructions.map((instruction) => instruction.id));
  const completed = new Map<string, PipelineInstructionResult>();
  const active = new Map<string, Promise<void>>();

  const start = (instruction: Instruction): void => {
    pending.delete(instruction.id);
    const metadata = ISA_V1_REGISTRY[instruction.op];
    const key = instruction.opId ?? `${program.programId}:${instruction.id}`;
    const fingerprint = instructionFingerprint(program, instruction);
    let joined: Promise<PipelineInstructionResult> | undefined;
    try {
      joined = domain.joinInFlight(key, fingerprint);
    } catch (error) {
      completed.set(instruction.id, failedOutcome(instruction, 'op_id_conflict', error instanceof Error ? error.message : String(error)));
      return;
    }
    if (joined) {
      const promise = joined.then((result) => {
        completed.set(instruction.id, { ...result, id: instruction.id, joined: true });
      });
      active.set(instruction.id, promise);
      return;
    }
    const promise = (async (): Promise<PipelineInstructionResult> => {
      if (signal.aborted) return abortOutcome(instruction);
      const release = await domain.acquire(metadata.resourceCost);
      try {
        const run = async (): Promise<PipelineInstructionResult> => {
          try {
            if (signal.aborted) return abortOutcome(instruction);
            const context = { program, instruction, resources: metadata.resourceCost, signal };
            for (const [index, condition] of instruction.precondition.entries()) {
              const verdict = condition.kind === 'instruction_status'
                ? completed.get(condition.instruction)?.status === condition.status ? 'valid' : 'stale'
                : options.checkPrecondition ? await options.checkPrecondition(condition, context) : 'unknown';
              if (verdict !== 'valid') {
                return failedOutcome(instruction, 'precondition_failed', `precondition[${index}] '${condition.kind}' is ${verdict}`);
              }
            }
            if (signal.aborted) return abortOutcome(instruction);
            const outcome = await executor(context);
            return { id: instruction.id, op: instruction.op, resources: [...metadata.resourceCost], ...outcome };
          } catch (error) {
            return {
              id: instruction.id,
              op: instruction.op,
              resources: [...metadata.resourceCost],
              status: 'failed',
              error: { code: 'executor_error', message: error instanceof Error ? error.message : String(error) },
            };
          }
        };
        return metadata.resourceCost.some((resource) => resource === 'io.write' || resource === 'journal.write')
          ? await domain.withCommitQueue(run)
          : await run();
      } finally {
        release();
      }
    })();
    domain.registerInFlight(key, fingerprint, promise);
    const tracked = promise.then((result) => { completed.set(instruction.id, result); });
    active.set(instruction.id, tracked);
  };

  while (pending.size > 0 || active.size > 0) {
    if (signal.aborted) {
      for (const instructionId of pending) {
        const instruction = byId.get(instructionId);
        if (instruction) completed.set(instructionId, abortOutcome(instruction));
      }
      pending.clear();
    }
    let progressed = false;
    for (const instructionId of [...pending]) {
      if (active.size >= maxConcurrency) break;
      const instruction = byId.get(instructionId)!;
      const dependencies = instruction.dependsOn;
      if (!dependencies.every((dependency) => completed.has(dependency))) continue;
      const failedDependency = dependencies.find((dependency) => !dependencySucceeded(completed.get(dependency)));
      if (failedDependency) {
        pending.delete(instructionId);
        completed.set(instructionId, skippedOutcome(instruction, failedDependency));
      } else {
        start(instruction);
      }
      progressed = true;
    }
    if (active.size > 0) {
      await Promise.race(active.values());
      for (const [instructionId, promise] of [...active]) {
        if (completed.has(instructionId)) active.delete(instructionId);
      }
      continue;
    }
    if (pending.size > 0 && !progressed) {
      const issue: ValidationIssue = { code: 'dependency_cycle', path: 'instructions', message: 'pipeline could not make progress because dependencies are unresolved' };
      return rejectedResult(input, [issue]);
    }
  }
  const results = program.instructions.map((instruction) => completed.get(instruction.id) ?? skippedOutcome(instruction, 'unknown'));
  return {
    isa: validation.plan.negotiatedIsa,
    requestId: program.requestId,
    programId: program.programId,
    status: finalStatus(results),
    plan: validation.plan,
    results,
    issues: [],
  };
}
