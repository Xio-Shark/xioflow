import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { Operation, ResourceConflictError, RollbackOperationResult, SnapshotRef } from '../types.js';
import { isPathContained } from '../capability/index.js';
import { CapabilityAdmission } from './admission.js';
import { activateInternalOperation, sha256Json, SnapshotContext } from './snapshot-ops.js';
import { RollbackOptions } from './types.js';

/**
 * 回滚协议 (ARCHITECTURE §3.5 / 契约 #28–#30, #56)
 */
export async function rollback(ctx: SnapshotContext, options: RollbackOptions): Promise<RollbackOperationResult> {
  const { domain, snapshotDriver } = ctx;
  const startTime = Date.now();
  const snapshot = domain.getStore().getSnapshot(options.snapshotId);
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${options.snapshotId}`);
  }

  let targetRoots = (options.roots || snapshot.roots).map((r) => path.resolve(r));
  let capAdmission: CapabilityAdmission | undefined;
  if (options.capabilityId) {
    capAdmission = domain.checkCapabilityAdmission({
      capabilityId: options.capabilityId,
      mutationRoots: targetRoots,
      runId: options.runId,
      opId: options.opId,
    });
    targetRoots = capAdmission.effectiveMutationRoots;
  }

  assertRootsQuiescent(domain, targetRoots, options.opId);

  const op: Operation = {
    id: options.opId,
    runId: options.runId,
    kind: 'rollback',
    name: `rollback:${options.snapshotId}`,
    inputFingerprint: sha256Json({
      kind: 'rollback',
      snapshotId: options.snapshotId,
      targetRoots,
      capabilityId: options.capabilityId ?? null,
    }),
    requiredResources: targetRoots.map((r) => `workspace:write:${r}`),
    mutationRoots: targetRoots,
    capabilityId: options.capabilityId,
    outputRef: options.snapshotId,
    timeoutMs: options.timeoutMs,
    status: 'intent_registered',
  };
  activateInternalOperation(domain, op, capAdmission);

  try {
    const { unrestoredPaths } = await snapshotDriver.restore(snapshot, { force: options.force });
    const currentFp = await snapshotDriver.fingerprint(targetRoots, { against: snapshot });
    const status: RollbackOperationResult['status'] =
      currentFp !== snapshot.treeFingerprint ? 'failed' : unrestoredPaths.length > 0 ? 'partial' : 'restored';
    const { coverage, outOfScopeEffects } = rollbackCoverage(status, () =>
      allEffectsConfinedToRoots(domain, snapshot, targetRoots, options.opId)
    );

    let result: RollbackOperationResult;
    domain.getStore().transaction(() => {
      result = {
        kind: 'rollback',
        status,
        snapshotId: options.snapshotId,
        unrestoredPaths: unrestoredPaths.length > 0 ? unrestoredPaths : undefined,
        coverage,
        outOfScopeEffects,
        capabilityId: options.capabilityId,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };
      domain.getStore().recordOperationResult(options.opId, result);
      domain.getStore().updateOperationStatus(options.opId, 'done');
    });

    domain.internalReleaseResources(options.opId);
    return result!;
  } catch (err: any) {
    domain.internalReleaseResources(options.opId);
    throw err;
  }
}

/** 同一根目录的两种写资源名（原路径与 realpath），和它们对应的目录。 */
function rootAliases(root: string): { root: string; realRoot: string; writeRes: string; writeResReal: string } {
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {}
  return { root, realRoot, writeRes: `workspace:write:${root}`, writeResReal: `workspace:write:${realRoot}` };
}

/**
 * 前置条件（契约 #30）：目标根目录上不存在 active / stopping / 未裁决 indeterminate 的操作。
 * 依次检查内存租约、未结清操作、持久化租约（含 indeterminate 保留的租约）。
 */
function assertRootsQuiescent(domain: ExecutionDomain, targetRoots: string[], opId: string): void {
  const aliases = targetRoots.map(rootAliases);

  for (const a of aliases) {
    for (const res of [a.writeRes, a.writeResReal]) {
      if (domain.isResourceLocked(res)) {
        throw new ResourceConflictError(res, domain.getResourceOwner(res) || 'unknown', opId, 0);
      }
    }
  }

  for (const op of domain.getStore().getUnfinishedOperations(domain.domainId)) {
    if (op.id === opId) continue;
    for (const a of aliases) {
      const touchesRoot =
        op.requiredResources.includes(a.writeRes) ||
        op.requiredResources.includes(a.writeResReal) ||
        op.mutationRoots?.some((mr) => {
          const resolved = path.resolve(mr);
          return resolved === a.root || resolved === a.realRoot;
        });
      if (touchesRoot) {
        throw new ResourceConflictError(a.writeRes, op.id, opId, 0);
      }
    }
  }

  for (const lease of domain.getStore().getPersistedResourceLeases(domain.domainId)) {
    for (const a of aliases) {
      if ((lease.resourceId === a.writeRes || lease.resourceId === a.writeResReal) && lease.operationId !== opId) {
        throw new ResourceConflictError(lease.resourceId, lease.operationId, opId, 0);
      }
    }
  }
}

/**
 * 快照之后的每个已记录操作都在写入限制下运行、且写入范围落在回滚根内，才可声称 complete。
 * 快照与回滚本身不产生根外副作用。
 */
function allEffectsConfinedToRoots(
  domain: ExecutionDomain,
  snapshot: SnapshotRef,
  targetRoots: string[],
  rollbackOpId: string
): boolean {
  const store = domain.getStore();
  // An operation still running has no result yet, so nothing proves it ran
  // confined; it may be writing outside the roots right now (long-running
  // services included).
  // An indeterminate one may still be alive, whenever it was recorded.
  const stillRunning = store.getAllOperations(domain.domainId).some((op) =>
    op.id !== rollbackOpId && op.kind !== 'snapshot' && op.kind !== 'rollback' && (
      op.status !== 'done'
      || (op.result?.status === 'indeterminate' && (op.result as { confined?: boolean }).confined !== true)
    )
  );
  if (stillRunning) return false;
  const eventsSince = snapshot.journalSeq !== undefined ? store.getJournalEvents(domain.domainId, snapshot.journalSeq) : [];
  const opResults = eventsSince.filter((e) => e.type === 'OPERATION_RESULT_RECORDED' && e.operationId !== rollbackOpId);

  return opResults.every((e) => {
    const res = (e.payload as any)?.result || e.payload;
    const storedOp = store.getOperation(e.operationId!);
    if (storedOp?.kind === 'snapshot' || storedOp?.kind === 'rollback') {
      return true;
    }
    if (res?.confined !== true) {
      return false;
    }
    const opRoots = storedOp?.mutationRoots || [];
    if (opRoots.length === 0) return true;
    return opRoots.every((opr) => targetRoots.some((sr) => isPathContained(sr, opr)));
  });
}

function rollbackCoverage(
  status: RollbackOperationResult['status'],
  allConfined: () => boolean
): Pick<RollbackOperationResult, 'coverage' | 'outOfScopeEffects'> {
  if (status !== 'restored') {
    return { coverage: status === 'partial' ? 'declared_roots' : 'none', outOfScopeEffects: 'possible' };
  }
  if (allConfined()) {
    return { coverage: 'complete', outOfScopeEffects: 'none_possible' };
  }
  return { coverage: 'declared_roots', outOfScopeEffects: 'possible' };
}
