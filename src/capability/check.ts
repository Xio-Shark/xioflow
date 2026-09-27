import {
  Capability,
  CapabilityScope,
  CapabilityViolationError,
} from '../types.js';
import { resolveRealPath, isPathContained } from './path-utils.js';
import { SqliteStore } from '../store/sqlite.js';

export { resolveRealPath, isPathContained };

/**
 * 规范化 Capability 作用域
 */
export function normalizeScope(scope: CapabilityScope): CapabilityScope {
  return {
    write: scope.write.map((w) => resolveRealPath(w)),
    exclusive: [...new Set(scope.exclusive)],
  };
}

/**
 * 校验并生成收窄的作用域（禁止放宽）
 */
export function validateScopeNarrowing(
  parentScope: CapabilityScope,
  narrowerScope: Partial<CapabilityScope>
): CapabilityScope {
  const normParent = normalizeScope(parentScope);

  let newWrite = normParent.write;
  if (narrowerScope.write !== undefined) {
    const resolvedWrites = narrowerScope.write.map((w) => resolveRealPath(w));
    for (const rw of resolvedWrites) {
      const allowed = normParent.write.some((pw) => isPathContained(pw, rw));
      if (!allowed) {
        throw new CapabilityViolationError(
          'attenuation_widened',
          `Cannot widen writable scope: '${rw}' is not contained within parent scope [${normParent.write.join(', ')}]`
        );
      }
    }
    newWrite = resolvedWrites;
  }

  let newExclusive = normParent.exclusive;
  if (narrowerScope.exclusive !== undefined) {
    for (const res of narrowerScope.exclusive) {
      if (!normParent.exclusive.includes(res)) {
        throw new CapabilityViolationError(
          'attenuation_widened',
          `Cannot widen exclusive resource scope: '${res}' is not in parent exclusive scope [${normParent.exclusive.join(', ')}]`
        );
      }
    }
    newExclusive = [...new Set(narrowerScope.exclusive)];
  }

  return {
    write: newWrite,
    exclusive: newExclusive,
  };
}

export interface CheckCapabilityAdmissionOptions {
  domainId: string;
  currentEpoch: number;
  store: SqliteStore;
  capabilityId: string;
  requiredResources?: string[];
  mutationRoots?: string[];
  runId?: string;
  opId?: string;
}

export interface CapabilityAdmissionResult {
  capability: Capability;
  effectiveResources: string[];
  effectiveMutationRoots: string[];
}

/**
 * 准入校验：在意图登记前校验结构完整性与作用域合法性（契约 #55）
 */
export function checkCapabilityAdmission(
  options: CheckCapabilityAdmissionOptions
): CapabilityAdmissionResult {
  const { domainId, currentEpoch, store, capabilityId, runId, opId } = options;

  const reject = (reason: any, message: string): never => {
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

  // 1. 资源推导与越界检查
  let effectiveResources: string[];
  if (options.requiredResources !== undefined && options.requiredResources.length > 0) {
    for (const res of options.requiredResources) {
      if (!cap.scope.exclusive.includes(res)) {
        return reject(
          'out_of_scope_resource',
          `Resource '${res}' is not permitted by capability '${capabilityId}' exclusive scope [${cap.scope.exclusive.join(', ')}]`
        );
      }
    }
    effectiveResources = [...options.requiredResources];
  } else {
    effectiveResources = [...cap.scope.exclusive];
  }

  // 2. 写入根推导与越界检查 (按路径段真实路径包含判定)
  let effectiveMutationRoots: string[];
  if (options.mutationRoots !== undefined && options.mutationRoots.length > 0) {
    const resolvedRoots = options.mutationRoots.map((r) => resolveRealPath(r));
    for (const rr of resolvedRoots) {
      const allowed = cap.scope.write.some((cw) => isPathContained(cw, rr));
      if (!allowed) {
        return reject(
          'out_of_scope_path',
          `Mutation root '${rr}' is outside capability '${capabilityId}' writable scope [${cap.scope.write.join(', ')}]`
        );
      }
    }
    effectiveMutationRoots = resolvedRoots;
  } else {
    effectiveMutationRoots = [...cap.scope.write];
  }

  return {
    capability: cap,
    effectiveResources,
    effectiveMutationRoots,
  };
}
