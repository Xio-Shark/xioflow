import { ExecutionDomain } from '../domain.js';
import { ManagedProcessHandle, PlatformDriver, StopProcessResult, StructuredCommand } from '../driver/types.js';
import { Operation, ProcessOperationResult, TerminationReason } from '../types.js';
import { CapabilityAdmission, recordCapabilityUsed } from './admission.js';
import { computeInputFingerprint } from './fingerprint.js';
import { finalizeOperation, indeterminateResult } from './finalize.js';
import { superviseActive } from './process-monitor.js';
import { ActiveOperationState, ExecuteProcessOptions } from './types.js';

/** 执行期需要回调监督器的能力：停止流水线与在飞表清理都归监督器所有。 */
export interface ProcessRunContext {
  domain: ExecutionDomain;
  driver: PlatformDriver;
  stop(opId: string, reason: TerminationReason, graceMs: number): Promise<StopProcessResult>;
  forget(opId: string): void;
}

export interface ProcessRunPlan {
  options: ExecuteProcessOptions;
  op: Operation;
  opState: ActiveOperationState;
  /** 已按写入限制包装后的实际启动命令。 */
  command: StructuredCommand;
  confined: boolean;
  confinementDriverName?: string;
  capAdmission?: CapabilityAdmission;
}

/**
 * 启动协议：资源仲裁 -> 先持久化意图 -> 请求驱动启动 -> 登记身份并转 active -> 监督运行 -> 记录结果。
 * 任何出口都会结清 stopResolve 并把操作移出在飞表。
 */
export async function runProcess(ctx: ProcessRunContext, plan: ProcessRunPlan): Promise<ProcessOperationResult> {
  const { options, opState } = plan;
  const cleanups: Array<() => void> = [];
  try {
    // 1. [资源分配与排队等待]
    await ctx.domain.allocateResourcesWithWait(
      options.opId,
      options.requiredResources || [],
      options.waitTimeoutMs ?? 0,
      options.resourceBudget,
      () => opState.cancelRequested === true
    );
    if (opState.cancelRequested) {
      return cancelBeforeSpawn(ctx.domain, options, opState);
    }

    // 2. [启动协议步骤 1] 写入 SQLite (status: intent_registered)
    try {
      ctx.domain.getStore().registerOperationIntent(plan.op, ctx.domain.domainId);
      opState.phase = 'intent_registered';
    } catch (err) {
      ctx.domain.internalReleaseResources(options.opId, options.requiredResources);
      throw err;
    }
    if (opState.cancelRequested) {
      return cancelBeforeSpawn(ctx.domain, options, opState);
    }

    // 3. [启动协议步骤 2] 请求平台驱动启动
    opState.phase = 'spawning';
    let handle: ManagedProcessHandle;
    try {
      handle = await ctx.driver.spawn(plan.command);
      opState.handle = handle;
      opState.command = plan.command;
    } catch (spawnError: any) {
      return failSpawn(ctx.domain, plan, spawnError);
    }

    // 4. [启动协议步骤 3] 登记执行身份，状态推进为 active
    await activateOrAbort(ctx, plan, handle);

    // 5–6. 监督运行、有界排空、结果落盘
    return await superviseActive(ctx, plan, handle, cleanups);
  } finally {
    for (const cleanup of cleanups) cleanup();
    if (opState.stopResolve) {
      const resolveFn = opState.stopResolve;
      opState.stopResolve = undefined;
      resolveFn({
        stopped: 'confirmed_stopped',
        scope: 'direct_child',
        errorDetails: opState.phase === 'done' ? undefined : 'Operation terminated before process activation',
      });
    }
    ctx.forget(options.opId);
  }
}

/** 启动失败（如可执行文件不存在）：不产生假运行状态，直接失败收尾并释放资源。 */
function failSpawn(domain: ExecutionDomain, plan: ProcessRunPlan, spawnError: any): ProcessOperationResult {
  const { options, opState } = plan;
  opState.phase = 'done';
  opState.stopResolve?.({ stopped: 'confirmed_stopped', scope: 'direct_child', errorDetails: spawnError?.message });
  opState.stopResolve = undefined;
  const message = spawnError?.message || String(spawnError);
  const failResult: ProcessOperationResult = {
    kind: 'process',
    status: 'failed',
    exitCode: 127,
    signal: null,
    stdout: '',
    stderr: message,
    spawnFailure: message,
    capabilityId: options.capabilityId,
    confined: plan.confined,
    confinementDriver: plan.confinementDriverName,
    isTruncated: false,
    identityVerification: 'not_original_process',
    durationMs: Date.now() - opState.startTime,
    completedAt: new Date().toISOString(),
  };
  return finalizeOperation(domain, options.opId, failResult, { requiredResources: options.requiredResources });
}

/**
 * 登记 active 并放行闸门。登记失败时（N4）进程已存在：先停掉它，再按停止是否确认
 * 记为 failed 或 indeterminate，最后把原始登记错误抛给调用方，防止产生孤儿进程。
 */
async function activateOrAbort(ctx: ProcessRunContext, plan: ProcessRunPlan, handle: ManagedProcessHandle): Promise<void> {
  const { options, opState } = plan;
  try {
    ctx.domain.getStore().updateOperationStatus(options.opId, 'active', handle.identity);
    opState.phase = 'active';
    handle.releaseGate?.();
    if (options.capabilityId && plan.capAdmission) {
      recordCapabilityUsed(
        ctx.domain,
        { runId: options.runId, opId: options.opId, capabilityId: options.capabilityId },
        plan.capAdmission
      );
    }
  } catch (statusError: any) {
    handle.destroyGate?.();
    opState.phase = 'stopping';
    const stopRes = await ctx.driver.terminate(handle.identity, 2000);
    // 有界等待退出与关闭流，防止管道悬挂
    await Promise.race([
      (handle.onRootExit ?? handle.onExit).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    try {
      (handle.stdout as any).destroy?.();
      (handle.stderr as any).destroy?.();
    } catch {}

    opState.phase = 'done';
    if (opState.stopResolve) {
      const resolveFn = opState.stopResolve;
      opState.stopResolve = undefined;
      resolveFn(stopRes);
    }

    const statusMessage = statusError?.message || String(statusError);
    if (stopRes.stopped === 'confirmed_stopped') {
      const failResult: ProcessOperationResult = {
        kind: 'process',
        status: 'failed',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `Failed to register active status: ${statusMessage}`,
        spawnFailure: statusMessage,
        isTruncated: false,
        identityVerification: 'not_original_process',
        durationMs: Date.now() - opState.startTime,
        completedAt: new Date().toISOString(),
      };
      finalizeOperation(ctx.domain, options.opId, failResult, { requiredResources: options.requiredResources });
    } else {
      const indet = indeterminateResult({
        reason: `Failed to register active status: ${statusMessage}, and process ${handle.identity.pid} could not be confirmed stopped: ${stopRes.errorDetails || 'residual processes still alive'}`,
        startTime: opState.startTime,
      });
      finalizeOperation(ctx.domain, options.opId, indet, {
        requiredResources: options.requiredResources,
        releaseResourceLock: false,
      });
    }
    throw statusError;
  }
}

/** 进程启动前被取消：记录 cancelled（evidence: unobserved），不写虚假租约或意图事件。 */
export function cancelBeforeSpawn(
  domain: ExecutionDomain,
  options: ExecuteProcessOptions,
  opState: ActiveOperationState
): ProcessOperationResult {
  opState.phase = 'done';
  const stopRes: StopProcessResult = { stopped: 'confirmed_stopped', scope: 'direct_child' };
  opState.stopResolve?.(stopRes);
  opState.stopResolve = undefined;

  const cancelResult: ProcessOperationResult = {
    kind: 'process',
    status: 'cancelled',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    capabilityId: options.capabilityId,
    isTruncated: false,
    terminationReason: 'user_cancelled',
    evidence: 'unobserved',
    identityVerification: 'not_original_process',
    durationMs: Date.now() - opState.startTime,
    completedAt: new Date().toISOString(),
  };

  const stored = domain.getStore().getOperation(options.opId);
  if (!stored) {
    // 此时操作是在 waiting_resources 阶段就被取消，尚未获取资源租约，亦未正常注册意图。
    // 为保证 store 中有该操作记录以便写入 cancelled 结果，直接记录预意图取消操作，
    // 绝不向 resource_leases 写入虚假租约，亦不产生虚假的 OPERATION_INTENT_REGISTERED 事件。
    const op: Operation = {
      id: options.opId,
      runId: options.runId,
      kind: 'process',
      name: options.name,
      inputFingerprint: options.inputFingerprint || computeInputFingerprint(options),
      requiredResources: options.requiredResources || [],
      status: 'done',
    };
    domain.getStore().recordPreIntentCancelledOperation(op, domain.domainId, cancelResult);
    domain.internalReleaseResources(options.opId, options.requiredResources);
    return cancelResult;
  }

  return finalizeOperation(domain, options.opId, cancelResult, { requiredResources: options.requiredResources });
}
