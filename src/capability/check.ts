import {
  Capability,
  CapabilityLimits,
  CapabilityScope,
  CapabilityScopeInput,
  CapabilityViolationError,
} from '../types.js';
import { resolveRealPath, isPathContained } from './path-utils.js';
import { SqliteStore } from '../store/sqlite.js';
import { ISA_V1_OPCODES } from '../isa/opcodes.generated.js';

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = Object.freeze({
  cpuMs: 315_360_000_000,
  memoryBytes: 1_099_511_627_776,
  outputBytes: 107_374_182_400,
  concurrentOps: 4096,
  processes: 65_536,
});

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Resolve a path or the non-wildcard prefix of a v1 path pattern. */
function normalizePathPattern(value: string): string {
  const wildcard = value.search(/[*?\[]/u);
  if (wildcard < 0) return resolveRealPath(value);
  const prefix = value.slice(0, wildcard);
  const suffix = value.slice(wildcard);
  const resolvedPrefix = resolveRealPath(prefix || '.');
  return `${resolvedPrefix}${suffix}`;
}

export { resolveRealPath, isPathContained };

/**
 * 规范化 Capability 作用域
 */
export function normalizeScope(scope: CapabilityScopeInput): CapabilityScope {
  const legacyWrites = scope.write ?? [];
  const requestedPaths = scope.paths ?? legacyWrites;
  const paths = unique(requestedPaths.map(normalizePathPattern));
  return {
    write: unique(legacyWrites.map(normalizePathPattern)),
    exclusive: unique(scope.exclusive ?? []),
    opcodes: unique(scope.opcodes ?? ISA_V1_OPCODES),
    workspaces: unique(scope.workspaces ?? []),
    paths,
    secrets: unique(scope.secrets ?? []),
  };
}

/**
 * 校验并生成收窄的作用域（禁止放宽）
 */
export function validateScopeNarrowing(
  parentScope: CapabilityScope,
  narrowerScope: CapabilityScopeInput
): CapabilityScope {
  const normParent = normalizeScope(parentScope);

  const requestedPaths = narrowerScope.paths ?? narrowerScope.write;
  const newPaths = requestedPaths === undefined
    ? normParent.paths
    : unique(requestedPaths.map(normalizePathPattern));
  for (const childPath of newPaths) {
    const allowed = normParent.paths.some((parentPath) => isPathContained(parentPath, childPath));
    if (!allowed) {
      throw new CapabilityViolationError(
        'attenuation_widened',
        `Cannot widen path scope: '${childPath}' is not contained within parent paths [${normParent.paths.join(', ')}]`
      );
    }
  }

  const newExclusive = narrowerScope.exclusive === undefined
    ? normParent.exclusive
    : unique(narrowerScope.exclusive);
  for (const res of newExclusive) {
    if (!normParent.exclusive.includes(res)) {
      throw new CapabilityViolationError(
        'attenuation_widened',
        `Cannot widen exclusive resource scope: '${res}' is not in parent exclusive scope [${normParent.exclusive.join(', ')}]`
      );
    }
  }

  const newOpcodes = narrowerScope.opcodes === undefined ? normParent.opcodes : unique(narrowerScope.opcodes);
  for (const opcode of newOpcodes) {
    if (!normParent.opcodes.includes(opcode)) {
      throw new CapabilityViolationError('attenuation_widened', `Cannot widen opcode scope: '${opcode}' is not permitted by the parent capability`);
    }
  }

  const newWorkspaces = narrowerScope.workspaces === undefined ? normParent.workspaces : unique(narrowerScope.workspaces);
  if (normParent.workspaces.length > 0) {
    for (const workspace of newWorkspaces) {
      if (!normParent.workspaces.includes(workspace)) {
        throw new CapabilityViolationError('attenuation_widened', `Cannot widen workspace scope: '${workspace}' is not permitted by the parent capability`);
      }
    }
    if (narrowerScope.workspaces?.length === 0) {
      throw new CapabilityViolationError('attenuation_widened', 'Cannot remove the parent workspace restriction during attenuation');
    }
  }

  const newSecrets = narrowerScope.secrets === undefined ? normParent.secrets : unique(narrowerScope.secrets);
  for (const secret of newSecrets) {
    if (!normParent.secrets.includes(secret)) {
      throw new CapabilityViolationError('attenuation_widened', `Cannot widen secret scope: '${secret}' is not permitted by the parent capability`);
    }
  }

  return {
    write: requestedPaths === undefined ? normParent.write : newPaths,
    exclusive: newExclusive,
    opcodes: newOpcodes,
    workspaces: newWorkspaces,
    paths: newPaths,
    secrets: newSecrets,
  };
}

export interface CheckCapabilityAdmissionOptions {
  domainId: string;
  currentEpoch: number;
  store: SqliteStore;
  capabilityId: string;
  requiredResources?: string[];
  mutationRoots?: string[];
  opcode?: string;
  workspace?: string;
  secretRefs?: string[];
  requestedLimits?: Partial<CapabilityLimits>;
  currentConcurrentOps?: number;
  currentProcesses?: number;
  policyVersion?: string;
  runId?: string;
  opId?: string;
}

export interface CapabilityAdmissionResult {
  capability: Capability;
  effectiveResources: string[];
  effectiveMutationRoots: string[];
  effectiveLimits: CapabilityLimits;
}

/**
 * 准入校验：在意图登记前校验结构完整性与作用域合法性（契约 #55）
 */
export function checkCapabilityAdmission(
  options: CheckCapabilityAdmissionOptions
): CapabilityAdmissionResult {
  const { domainId, currentEpoch, store, capabilityId, runId, opId } = options;

  const reject = (reason: ConstructorParameters<typeof CapabilityViolationError>[0], message: string): never => {
    const err = new CapabilityViolationError(reason, message);
    try {
      store.recordJournalEvent({
        domainId,
        runId,
        operationId: opId,
        type: 'CAPABILITY_REJECTED',
        payload: {
          capabilityId,
          reason,
          message,
          requiredResources: options.requiredResources,
          mutationRoots: options.mutationRoots,
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // 保证即便 journal 写入异常也必须抛出 CapabilityViolationError
    }
    throw err;
  };

  const cap = store.getCapability(capabilityId);
  if (!cap) {
    return reject('revoked', `Capability '${capabilityId}' not found`);
  }

  if (cap.domainId !== domainId) {
    return reject('domain_mismatch', `Capability '${capabilityId}' belongs to domain '${cap.domainId}', not '${domainId}'`);
  }

  if (cap.epoch !== currentEpoch) {
    return reject(
      'epoch_mismatch',
      `Capability '${capabilityId}' epoch ${cap.epoch} does not match current domain epoch ${currentEpoch}`
    );
  }

  if (new Date(cap.expiresAt).getTime() <= Date.now()) {
    return reject('expired', `Capability '${capabilityId}' expired at ${cap.expiresAt}`);
  }

  if (cap.revokedAt) {
    return reject('revoked', `Capability '${capabilityId}' was revoked at ${cap.revokedAt}`);
  }

  if (options.policyVersion !== undefined && cap.policyVersion !== options.policyVersion) {
    return reject('policy_mismatch', `Capability '${capabilityId}' policy version '${cap.policyVersion}' does not match '${options.policyVersion}'`);
  }

  // 递归校验祖先链，父撤销/过期/换代导致子级联失效
  let ancestorId = cap.parentId;
  while (ancestorId) {
    const ancestor = store.getCapability(ancestorId);
    if (!ancestor) {
      return reject('revoked', `Capability ancestor '${ancestorId}' not found`);
    }
    if (ancestor.revokedAt) {
      return reject('revoked', `Capability ancestor '${ancestorId}' was revoked`);
    }
    if (ancestor.epoch !== currentEpoch) {
      return reject('epoch_mismatch', `Capability ancestor '${ancestorId}' epoch mismatch`);
    }
    if (new Date(ancestor.expiresAt).getTime() <= Date.now()) {
      return reject('expired', `Capability ancestor '${ancestorId}' has expired`);
    }
    ancestorId = ancestor.parentId;
  }

  const scope = normalizeScope(cap.scope);

  if (options.opcode !== undefined && !scope.opcodes.includes(options.opcode)) {
    return reject('out_of_scope_opcode', `Opcode '${options.opcode}' is not permitted by capability '${capabilityId}'`);
  }
  if (options.workspace !== undefined && scope.workspaces.length > 0 && !scope.workspaces.includes(options.workspace)) {
    return reject('out_of_scope_workspace', `Workspace '${options.workspace}' is not permitted by capability '${capabilityId}'`);
  }
  if (options.secretRefs !== undefined) {
    for (const secret of options.secretRefs) {
      if (!scope.secrets.includes(secret)) {
        return reject('out_of_scope_secret', `SecretRef '${secret}' is not permitted by capability '${capabilityId}'`);
      }
    }
  }

  const requestedLimits = options.requestedLimits ?? {};
  for (const key of ['cpuMs', 'memoryBytes', 'outputBytes', 'concurrentOps', 'processes'] as const) {
    const requested = requestedLimits[key];
    if (requested !== undefined && requested > cap.limits[key]) {
      return reject('budget_exceeded', `Capability '${capabilityId}' limit '${key}' is ${cap.limits[key]}, requested ${requested}`);
    }
  }
  if (options.currentConcurrentOps !== undefined && options.currentConcurrentOps >= cap.limits.concurrentOps) {
    return reject('concurrency_exceeded', `Capability '${capabilityId}' concurrentOps limit ${cap.limits.concurrentOps} is exhausted`);
  }
  if (options.opcode === 'proc.spawn' && options.currentProcesses !== undefined && options.currentProcesses >= cap.limits.processes) {
    return reject('concurrency_exceeded', `Capability '${capabilityId}' processes limit ${cap.limits.processes} is exhausted`);
  }

  // 1. 资源推导与越界检查
  let effectiveResources: string[];
  if (options.requiredResources !== undefined && options.requiredResources.length > 0) {
    for (const res of options.requiredResources) {
      if (!scope.exclusive.includes(res)) {
        return reject(
          'out_of_scope_resource',
          `Resource '${res}' is not permitted by capability '${capabilityId}' exclusive scope [${scope.exclusive.join(', ')}]`
        );
      }
    }
    effectiveResources = [...options.requiredResources];
  } else {
    effectiveResources = [...scope.exclusive];
  }

  // 2. 写入根推导与越界检查 (按路径段真实路径包含判定)
  let effectiveMutationRoots: string[];
  if (options.mutationRoots !== undefined && options.mutationRoots.length > 0) {
    const resolvedRoots = options.mutationRoots.map(normalizePathPattern);
    for (const rr of resolvedRoots) {
      const allowed = scope.paths.some((cw) => isPathContained(cw, rr));
      if (!allowed) {
        return reject(
          'out_of_scope_path',
          `Mutation root '${rr}' is outside capability '${capabilityId}' path scope [${scope.paths.join(', ')}]`
        );
      }
    }
    effectiveMutationRoots = resolvedRoots;
  } else {
    effectiveMutationRoots = [...scope.paths];
  }

  return {
    capability: { ...cap, scope },
    effectiveResources,
    effectiveMutationRoots,
    effectiveLimits: { ...cap.limits },
  };
}
