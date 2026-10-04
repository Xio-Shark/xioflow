import { ExecutionDomain } from '../domain.js';
import { PlatformDriver, StructuredCommand } from '../driver/types.js';
import { ConfinementDriver, ResourceBudget, UnsupportedCapabilityError } from '../types.js';
import { createConfinementDriver } from '../confinement/index.js';
import { normalizeResourceName } from './fingerprint.js';
import { ExecuteProcessOptions } from './types.js';

export type CapabilityAdmission = ReturnType<ExecutionDomain['checkCapabilityAdmission']>;

/**
 * Capability 准入校验与字段推导（契约 #55）。
 * 会就地改写 `options.requiredResources`（规范化或收窄到 capability 范围）：
 * 随后的输入指纹基于改写后的值计算，已持久化操作的重放依赖这一口径，不能改成副本。
 */
export function admitProcessScope(
  domain: ExecutionDomain,
  options: ExecuteProcessOptions
): { mutationRoots?: string[]; capAdmission?: CapabilityAdmission } {
  if (options.capabilityId) {
    let candidateRoots = options.mutationRoots ? [...options.mutationRoots] : [];
    if (candidateRoots.length === 0 && options.command.cwd) {
      candidateRoots = [options.command.cwd];
    }
    const capAdmission = domain.checkCapabilityAdmission({
      capabilityId: options.capabilityId,
      requiredResources: options.requiredResources,
      mutationRoots: candidateRoots.length > 0 ? candidateRoots : undefined,
      runId: options.runId,
      opId: options.opId,
    });
    options.requiredResources = capAdmission.effectiveResources;
    return { mutationRoots: capAdmission.effectiveMutationRoots, capAdmission };
  }

  options.requiredResources = (options.requiredResources || []).map(normalizeResourceName);
  if (options.mutationRoots && options.mutationRoots.length > 0) {
    return { mutationRoots: options.mutationRoots };
  }
  return {
    mutationRoots: options.requiredResources
      .filter((r) => r.startsWith('workspace:write:'))
      .map((r) => r.slice('workspace:write:'.length)),
  };
}

/** ConfinementDriver 驱动解析（契约 #56）：显式驱动 > 按名创建 > 要求默认 > 监督器默认。 */
export function resolveConfinementDriver(
  options: ExecuteProcessOptions,
  supervisorDefault: ConfinementDriver | undefined
): ConfinementDriver | undefined {
  if (options.confinementDriver) {
    return options.confinementDriver;
  }
  if (typeof options.confinement === 'string') {
    const driver = createConfinementDriver(options.confinement);
    if (!driver) {
      throw new Error(`Confinement driver '${options.confinement}' is not available on this platform`);
    }
    return driver;
  }
  if (options.confinement === true) {
    const driver = supervisorDefault || createConfinementDriver();
    if (!driver) {
      throw new Error('Confinement was requested but no confinement driver is available on this platform');
    }
    return driver;
  }
  return supervisorDefault;
}

/** 准入期强校验：hard 预算要求驱动真的具备对应能力，否则显式拒绝而不是静默降级。 */
export function assertHardBudgetSupported(driver: PlatformDriver, budget: ResourceBudget | undefined): void {
  if (budget?.enforcement !== 'hard') return;
  if (budget.maxMemoryBytes && !driver.capabilities.memoryHardLimit) {
    throw new UnsupportedCapabilityError('memoryHardLimit', driver.name, 'hard');
  }
  if (budget.maxPids && !driver.capabilities.pidsLimit) {
    throw new UnsupportedCapabilityError('pidsLimit', driver.name, 'hard');
  }
  if (budget.maxCpuTimeMs && !driver.capabilities.cpuLimit) {
    throw new UnsupportedCapabilityError('cpuLimit', driver.name, 'hard');
  }
}

/** hard 预算转成驱动在放行前施加的 OS 限制；其余模式原样返回命令。 */
export function withHardLimits(command: StructuredCommand, budget: ResourceBudget | undefined): StructuredCommand {
  if (budget?.enforcement !== 'hard' || (!budget.maxMemoryBytes && !budget.maxPids)) return command;
  return {
    ...command,
    hardLimits: {
      ...(budget.maxMemoryBytes ? { memoryMaxBytes: budget.maxMemoryBytes } : {}),
      ...(budget.maxPids ? { pidsMax: budget.maxPids } : {}),
    },
  };
}

/** N3 契约：未登记的 Run 与终态 Run 都不能登记或重放操作。 */
export function assertRunAcceptsOperations(domain: ExecutionDomain, runId: string, opId: string): void {
  const callingRun = domain.getStore().getRun(runId);
  if (!callingRun) {
    throw new Error(
      `Run "${runId}" is not registered in domain "${domain.domainId}". ` +
        'Register the task and run first (store.saveTask() + store.saveRun()), then execute operations for that run.'
    );
  }
  if (
    callingRun.status === 'succeeded' ||
    callingRun.status === 'failed' ||
    callingRun.status === 'cancelled' ||
    callingRun.status === 'indeterminate'
  ) {
    throw new Error(
      `Cannot register operation "${opId}" for Run "${runId}" because the Run is already finalized with status "${callingRun.status}".`
    );
  }
}

export function recordCapabilityUsed(
  domain: ExecutionDomain,
  ids: { runId: string; opId: string; capabilityId: string },
  capAdmission: CapabilityAdmission
): void {
  domain.getStore().recordJournalEvent({
    domainId: domain.domainId,
    runId: ids.runId,
    operationId: ids.opId,
    type: 'CAPABILITY_USED',
    payload: {
      capabilityId: ids.capabilityId,
      scope: capAdmission.capability.scope,
      actor: capAdmission.capability.issuedBy,
    },
    timestamp: new Date().toISOString(),
  });
}
