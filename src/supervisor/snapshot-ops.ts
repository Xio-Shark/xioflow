import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OwnedArtifact, removeOwnedArtifact } from '../artifacts.js';
import { ExecutionDomain } from '../domain.js';
import { Operation, ResourceConflictError, SnapshotDriver, SnapshotOperationResult } from '../types.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { collectIgnoredEntries, ignoredManifestPath, resolveIgnoredManifest, writeIgnoredManifest } from '../snapshot/ignored-manifest.js';
import { CapabilityAdmission, recordCapabilityUsed } from './admission.js';
import { CaptureSnapshotOptions } from './types.js';
import { domainCoordination } from './domain-coordination.js';

export interface SnapshotContext {
  domain: ExecutionDomain;
  snapshotDriver: SnapshotDriver;
}

export function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 快照 / 回滚这类内核内部操作：登记意图并直接转 active，按需记录 capability 使用。 */
export function activateInternalOperation(
  domain: ExecutionDomain,
  op: Operation,
  capAdmission: CapabilityAdmission | undefined
): void {
  domain.registerOperationIntent(op);
  domain.getStore().updateOperationStatus(op.id, 'active');
  domain.getStore().recordEventAndTransitionState({
    domainId: domain.domainId,
    runId: op.runId,
    operationId: op.id,
    type: 'OPERATION_STATUS_TRANSITION',
    payload: { status: 'active' },
    timestamp: new Date().toISOString(),
  });
  if (op.capabilityId && capAdmission) {
    recordCapabilityUsed(domain, { runId: op.runId, opId: op.id, capabilityId: op.capabilityId }, capAdmission);
  }
}

/**
 * 快照捕获协议 (ARCHITECTURE §3.5 / 契约 #32, #53)
 */
export async function captureSnapshot(
  ctx: SnapshotContext,
  options: CaptureSnapshotOptions
): Promise<SnapshotOperationResult> {
  const { domain, snapshotDriver } = ctx;
  const startTime = Date.now();
  let targetRoots = options.roots;
  let capAdmission: CapabilityAdmission | undefined;

  if (options.capabilityId) {
    capAdmission = domain.checkCapabilityAdmission({
      capabilityId: options.capabilityId,
      mutationRoots: targetRoots,
      runId: options.runId,
      opId: options.opId,
    });
    if (!targetRoots || targetRoots.length === 0) {
      targetRoots = capAdmission.effectiveMutationRoots;
    }
  }

  if (!targetRoots || targetRoots.length === 0) {
    throw new Error('captureSnapshot requires at least one root directory');
  }

  const realRoots = targetRoots.map((r) => path.resolve(r));
  const requiredResources = realRoots.map((r) => `workspace:write:${r}`);

  if (snapshotDriver instanceof GitShadowSnapshotDriver) {
    try {
      const { commonDir } = await snapshotDriver.assertGitRepo(realRoots[0]);
      requiredResources.push(`git:objects:${commonDir}`);
    } catch {}
  }

  const op: Operation = {
    id: options.opId,
    runId: options.runId,
    kind: 'snapshot',
    name: `snapshot:${realRoots[0]}`,
    inputFingerprint: sha256Json({
      kind: 'snapshot',
      roots: realRoots,
      includeIgnored: !!options.includeIgnored,
      trackIgnored: options.trackIgnored ?? null,
      maxTreeSizeBytes: options.maxTreeSizeBytes,
      capabilityId: options.capabilityId ?? null,
    }),
    requiredResources,
    mutationRoots: realRoots,
    capabilityId: options.capabilityId,
    timeoutMs: options.timeoutMs,
    status: 'intent_registered',
  };
  activateInternalOperation(domain, op, capAdmission);

  // full_tree 快照已含被忽略文件的内容，清单是多余的
  const manifestFile =
    options.trackIgnored === 'manifest' && !options.includeIgnored
      ? ignoredManifestPath(domain.domainPath, options.opId)
      : undefined;
  let manifestArtifact: OwnedArtifact | undefined;
  let result!: SnapshotOperationResult;
  try {
    let ignoredManifest: { digest: string; entries: number } | undefined;
    if (manifestFile) {
      if (!snapshotDriver.listIgnored) {
        throw new Error(`Snapshot driver ${snapshotDriver.name} cannot list ignored files (trackIgnored: 'manifest')`);
      }
      const entries = collectIgnoredEntries(await snapshotDriver.listIgnored(realRoots));
      const written = writeIgnoredManifest(manifestFile, entries);
      manifestArtifact = written.artifact;
      ignoredManifest = { digest: written.digest, entries: entries.length };
    }

    const snapRef = await snapshotDriver.capture(realRoots, {
      id: options.opId,
      domainId: domain.domainId,
      opId: options.opId,
      includeIgnored: options.includeIgnored,
      maxTreeSizeBytes: options.maxTreeSizeBytes,
    });
    snapRef.ignoredManifestDigest = ignoredManifest?.digest;

    const store = domain.getStore();
    store.transaction(() => {
      const seq = store.recordEventAndTransitionState({
        domainId: domain.domainId,
        runId: options.runId,
        operationId: options.opId,
        type: 'SNAPSHOT_CAPTURED',
        payload: {
          snapshotId: snapRef.id,
          roots: snapRef.roots,
          treeFingerprint: snapRef.treeFingerprint,
          commitHash: snapRef.commitHash,
          // 只记摘要与条目数：清单里的路径名可能敏感，不进 journal
          ignoredManifest,
        },
        timestamp: new Date().toISOString(),
      });
      snapRef.journalSeq = seq;
      store.recordSnapshot(snapRef);

      result = {
        kind: 'snapshot',
        status: 'succeeded',
        snapshot: snapRef,
        capabilityId: options.capabilityId,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
      };

      store.recordOperationResult(options.opId, result);
      store.updateOperationStatus(options.opId, 'done');
      store.recordEventAndTransitionState({
        domainId: domain.domainId,
        runId: options.runId,
        operationId: options.opId,
        type: 'OPERATION_RESULT_RECORDED',
        payload: { status: 'succeeded', snapshotId: snapRef.id },
        timestamp: new Date().toISOString(),
      });
    });

  } catch (err: any) {
    if (manifestArtifact) {
      try {
        removeOwnedArtifact(manifestArtifact);
      } catch (cleanupError) {
        err = new AggregateError([err, cleanupError], `${err.message}; ignored manifest cleanup failed: ${cleanupError}`);
      }
    }
    throw recordFailedSnapshot(domain, options.opId, err, startTime);
  }
  // 成功事实已持久化，产物由快照持有；释放租约失败不能撤销成功或删除证据。
  domain.internalReleaseResources(options.opId);
  return result;
}

/** 记录失败快照并释放租约；返回调用方应抛出的错误（失败事实没能落盘时要让调用方知道）。 */
function recordFailedSnapshot(domain: ExecutionDomain, opId: string, err: any, startTime: number): unknown {
  const failResult: SnapshotOperationResult = {
    kind: 'snapshot',
    status: 'failed',
    errorMessage: err.message,
    durationMs: Date.now() - startTime,
    completedAt: new Date().toISOString(),
  };
  let recordError: unknown;
  try {
    domain.getStore().recordOperationResult(opId, failResult);
    domain.getStore().updateOperationStatus(opId, 'done');
  } catch (recErr) {
    recordError = recErr;
  }
  domain.internalReleaseResources(opId);
  if (recordError === undefined) {
    return err;
  }
  const recMsg = recordError instanceof Error ? recordError.message : String(recordError);
  return new Error(`${err.message} (additionally, recording the failed snapshot result failed: ${recMsg})`, {
    cause: err,
  });
}

/**
 * 分叉工作区 Materialize (ARCHITECTURE §3.5 / 契约 #54)
 */
export async function materialize(
  ctx: SnapshotContext,
  snapshotId: string,
  newRoot: string
): Promise<{ worktreePath: string }> {
  const { domain, snapshotDriver } = ctx;
  const absNewRoot = path.resolve(newRoot);
  const writeRes = `workspace:write:${absNewRoot}`;
  if (domain.isResourceLocked(writeRes)) {
    throw new ResourceConflictError(writeRes, domain.getResourceOwner(writeRes) || 'unknown', 'materialize');
  }
  const opId = `mat-${snapshotId}-${crypto.randomUUID()}`;
  domain.assertOperationIdAvailable(opId);
  domain.allocateResources(opId, [writeRes]);

  try {
    if (!snapshotDriver.materialize) {
      throw new Error(`Snapshot driver ${snapshotDriver.name} does not support materialize`);
    }
    const snapshot = domain.getStore().getSnapshot(snapshotId);
    const repoRoot = snapshot?.roots[0];
    const result = await snapshotDriver.materialize(snapshotId, absNewRoot, { repoRoot });
    domainCoordination(domain).materializedWorkspaces.set(writeRes, opId);
    return result;
  } catch (err) {
    domain.internalReleaseResources(opId);
    throw err;
  }
}

/**
 * 回收分叉工作区 Dematerialize (ARCHITECTURE §3.5 / 契约 #54)
 */
export async function dematerialize(
  ctx: SnapshotContext,
  newRoot: string,
  options?: { force?: boolean },
  internalLeaseOwner?: string
): Promise<void> {
  const { domain, snapshotDriver } = ctx;
  const absNewRoot = path.resolve(newRoot);
  let realNewRoot = absNewRoot;
  try {
    realNewRoot = fs.realpathSync(absNewRoot);
  } catch {}

  if (!snapshotDriver.dematerialize) {
    throw new Error(`Snapshot driver ${snapshotDriver.name} does not support dematerialize`);
  }
  // 回收不能先删除目录再释放别人的租约。materialize 自己保留的租约允许交还；
  // 事务内部回收只能使用它明确持有的 owner，公共入口不能借此绕过活跃进程。
  const resources = [...new Set([`workspace:write:${absNewRoot}`, `workspace:write:${realNewRoot}`])];
  const materialized = domainCoordination(domain).materializedWorkspaces;
  let recordedOwner: string | undefined;
  for (const resource of resources) {
    const owner = domain.getResourceOwner(resource);
    if (owner && owner !== internalLeaseOwner && materialized.get(resource) !== owner) {
      throw new ResourceConflictError(resource, owner, 'dematerialize');
    }
    if (owner) recordedOwner = owner;
  }
  const owner = internalLeaseOwner ?? recordedOwner ?? `demat-${crypto.randomUUID()}`;
  if (!internalLeaseOwner && !recordedOwner) domain.assertOperationIdAvailable(owner);
  domain.allocateResources(owner, resources);
  // 内部创建的租约只允许交还一次；并发公共回收不能借同一 owner 重入。
  for (const resource of resources) materialized.delete(resource);
  let primaryError: unknown;
  try {
    await snapshotDriver.dematerialize(absNewRoot, options);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // 释放后同名公开操作可以合法出现，旧的内部授权不能继续跟随该名字。
    for (const resource of resources) materialized.delete(resource);
    try { domain.internalReleaseResources(owner, resources); }
    catch (error) {
      if (primaryError !== undefined) throw new AggregateError([primaryError, error], 'Worktree removal and isolation release both failed');
      throw error;
    }
  }
}

/**
 * 回收快照：删除驱动侧的私有 ref 与 store 记录，并写 SNAPSHOT_PRUNED。
 * 宿主按自己的保留策略调用（例如每轮只保留会话基线与当前轮检查点），否则快照 ref 会无限累积。
 * 未知 id 视为已回收（幂等）；驱动删除失败直接抛出，store 记录保留，便于重试。
 */
export async function pruneSnapshots(
  ctx: SnapshotContext,
  snapshotIds: string[],
  options?: { runId?: string }
): Promise<string[]> {
  const { domain, snapshotDriver } = ctx;
  const store = domain.getStore();
  const pruned: string[] = [];
  for (const id of snapshotIds) {
    const snapshot = store.getSnapshot(id);
    if (!snapshot) continue;
    store.verifyEpochFencing(domain.domainId);
    const repoRoot =
      snapshotDriver instanceof GitShadowSnapshotDriver
        ? (await snapshotDriver.assertGitRepo(snapshot.roots[0])).repoRoot
        : undefined;
    let manifestToRemove: OwnedArtifact | undefined;
    if (snapshot.ignoredManifestDigest) {
      const manifest = resolveIgnoredManifest(domain.domainPath, id, snapshot.ignoredManifestDigest);
      if (manifest.state === 'mismatch') throw new Error(`Ignored manifest changed before pruning snapshot: ${id}`);
      if (manifest.state === 'found') manifestToRemove = manifest.artifact;
    }
    await snapshotDriver.prune([id], { repoRoot });
    if (manifestToRemove) removeOwnedArtifact(manifestToRemove);
    store.transaction(() => {
      store.deleteSnapshot(id);
      store.recordEventAndTransitionState({
        domainId: domain.domainId,
        runId: options?.runId,
        type: 'SNAPSHOT_PRUNED',
        payload: { snapshotId: id, roots: snapshot.roots },
        timestamp: new Date().toISOString(),
      });
    });
    pruned.push(id);
  }
  return pruned;
}
