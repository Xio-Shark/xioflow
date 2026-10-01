import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import {
  IgnoredChanges,
  Operation,
  ResourceConflictError,
  RollbackOperationResult,
  SnapshotDriver,
  SnapshotRef,
} from '../types.js';
import { isPathContained } from '../capability/index.js';
import {
  collectIgnoredEntries,
  diffIgnoredEntries,
  ignoredManifestPath,
  readIgnoredManifest,
} from '../snapshot/ignored-manifest.js';
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
    const restored = await snapshotDriver.restore(snapshot, {
      force: options.force,
      removeNewIgnored: options.removeNewIgnored,
    });
    const newIgnoredPaths = restored.newIgnoredPaths ?? [];
    // 快照之后新出现的被忽略文件是有意保留的：核验时不算它们，但如实列为未恢复
    const currentFp = await snapshotDriver.fingerprint(targetRoots, {
      against: snapshot,
      excludeNewIgnored: newIgnoredPaths.length > 0,
    });
    const unrestoredPaths = [...restored.unrestoredPaths, ...newIgnoredPaths];
    const status: RollbackOperationResult['status'] =
      currentFp !== snapshot.treeFingerprint ? 'failed' : unrestoredPaths.length > 0 ? 'partial' : 'restored';
    const ignored = await compareIgnoredManifest(domain, snapshotDriver, snapshot);
    const derived = deriveRollbackCoverage({
      status,
      effects: allEffectsConfinedToRoots(domain, snapshot, targetRoots, options.opId) ? 'confined' : 'unconfined',
      snapshotCoverage: snapshot.coverage,
      ignoredManifest: ignored.state,
    });

    let result: RollbackOperationResult;
    domain.getStore().transaction(() => {
      result = {
        kind: 'rollback',
        status,
        snapshotId: options.snapshotId,
        unrestoredPaths: unrestoredPaths.length > 0 ? unrestoredPaths : undefined,
        ...derived,
        ignoredChanges: ignored.changes,
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

/** 被忽略文件清单相对现状的比较结果；`absent` 表示快照没带清单，`unreadable` 表示清单丢失或与登记的摘要不符。 */
export type IgnoredManifestState = 'unchanged' | 'changed' | 'inconclusive' | 'unreadable' | 'absent';

async function compareIgnoredManifest(
  domain: ExecutionDomain,
  snapshotDriver: SnapshotDriver,
  snapshot: SnapshotRef
): Promise<{ state: IgnoredManifestState; changes?: IgnoredChanges }> {
  if (!snapshot.ignoredManifestDigest) return { state: 'absent' };
  const before = readIgnoredManifest(
    ignoredManifestPath(domain.domainPath, snapshot.id),
    snapshot.ignoredManifestDigest
  );
  if (!before || !snapshotDriver.listIgnored) return { state: 'unreadable' };
  const after = collectIgnoredEntries(await snapshotDriver.listIgnored(snapshot.roots));
  const { verdict, changes } = diffIgnoredEntries(before, after);
  return { state: verdict, changes };
}

export interface RollbackCoverageFacts {
  status: RollbackOperationResult['status'];
  /** 快照以来的操作：全部受限且写根在回滚根内 / 至少一个不是 / 没有核验（崩溃恢复路径）。 */
  effects: 'confined' | 'unconfined' | 'unverified';
  snapshotCoverage: SnapshotRef['coverage'];
  ignoredManifest: IgnoredManifestState;
}

const EFFECTS_BASIS = {
  confined: 'all_ops_confined',
  unconfined: 'unconfined_op_since_snapshot',
  unverified: 'effects_unverified',
} as const;

const MANIFEST_BASIS = {
  unchanged: 'ignored_manifest_unchanged',
  changed: 'ignored_manifest_changed',
  inconclusive: 'ignored_manifest_ctime_only',
  unreadable: 'ignored_manifest_unreadable',
  absent: 'ignored_not_captured',
} as const;

/**
 * 回滚覆盖声明的唯一推导处（ARCHITECTURE §0.2 裁决 4 / §3.5）：输入是核验到的事实，输出是结论加依据。
 * `complete` 需要三件事同时成立：核验通过、快照以来的操作全部受限、被忽略文件已恢复或被证明未变。
 */
export function deriveRollbackCoverage(
  facts: RollbackCoverageFacts
): Pick<RollbackOperationResult, 'coverage' | 'outOfScopeEffects' | 'ignoredFiles' | 'coverageBasis'> {
  const fullTree = facts.snapshotCoverage === 'full_tree';
  const ignoredFiles: RollbackOperationResult['ignoredFiles'] = fullTree
    ? facts.status === 'failed'
      ? 'unverified'
      : 'restored'
    : facts.ignoredManifest === 'unchanged'
      ? 'unchanged_verified'
      : 'not_captured';
  const ignoredBasis = fullTree ? 'snapshot_full_tree' : MANIFEST_BASIS[facts.ignoredManifest];

  if (facts.status === 'failed') {
    return { coverage: 'none', outOfScopeEffects: 'possible', ignoredFiles, coverageBasis: ['fingerprint_mismatch'] };
  }
  if (facts.status === 'partial') {
    return {
      coverage: 'declared_roots',
      outOfScopeEffects: 'possible',
      ignoredFiles,
      coverageBasis: ['unrestored_paths', ignoredBasis],
    };
  }
  const coverageBasis = [EFFECTS_BASIS[facts.effects], ignoredBasis];
  if (facts.effects !== 'confined') {
    return { coverage: 'declared_roots', outOfScopeEffects: 'possible', ignoredFiles, coverageBasis };
  }
  return {
    coverage: ignoredFiles === 'not_captured' ? 'non_ignored' : 'complete',
    outOfScopeEffects: 'none_possible',
    ignoredFiles,
    coverageBasis,
  };
}
