import { ExecutionDomain } from '../domain.js';
import { PlatformDriver } from '../driver/types.js';
import {
  Operation,
  ProcessOperationResult,
  IndeterminateResult,
  RollbackOperationResult,
  SnapshotOperationResult,
} from '../types.js';
import { GitShadowSnapshotDriver } from '../snapshot/git-shadow.js';
import { deriveRollbackCoverage } from '../supervisor/rollback.js';

export interface RecoveredServiceSummary {
  serviceId: string;
  instanceOpIds: string[];
  action: 'cleaned_unspawned' | 'stopped_alive_process' | 'marked_dead' | 'isolated_indeterminate';
  resourcesReleased: boolean;
}

export interface RecoveryReport {
  recoveredOperations: {
    opId: string;
    action: 'cleaned_unspawned' | 'stopped_alive_process' | 'marked_dead' | 'isolated_indeterminate';
    resourcesReleased: boolean;
  }[];
  recoveredServices?: RecoveredServiceSummary[];
}

export class RecoveryEngine {
  constructor(
    private readonly domain: ExecutionDomain,
    private readonly driver: PlatformDriver
  ) {
    this.domain.setDriver?.(driver);
  }

  /**
   * 恢复协议：对未终结操作现场核查并安全推进至终态或保留隔离
   */
  public async recover(): Promise<RecoveryReport> {
    const store = this.domain.getStore();
    const unfinishedOps = store.getUnfinishedOperations(this.domain.domainId);
    const report: RecoveryReport = { recoveredOperations: [] };

    const releaseOpAndServiceResources = (op: Operation) => {
      this.domain.internalReleaseResources(op.id, op.requiredResources);
      if (op.kind === 'service' || op.id.includes('#')) {
        const serviceId = op.id.split('#')[0];
        this.domain.internalReleaseResources(`service:${serviceId}`, op.requiredResources);
      }
    };

    const recordServiceStoppedIfNeeded = (op: Operation, action: string) => {
      if (op.kind === 'service' || op.id.includes('#')) {
        const serviceId = op.id.split('#')[0];
        store.recordEventAndTransitionState({
          domainId: this.domain.domainId,
          runId: op.runId,
          operationId: op.id,
          type: 'SERVICE_STOPPED',
          payload: {
            serviceId,
            runId: op.runId,
            instanceOpId: op.id,
            reason: 'recovered_after_crash',
            action,
          },
          timestamp: new Date().toISOString(),
        });
      }
    };

    for (const op of unfinishedOps) {
      if (op.kind === 'rollback') {
        const snapshotId = op.outputRef || op.name.replace(/^rollback:/, '');
        const snapshot = store.getSnapshot(snapshotId);
        const snapshotDriver = this.domain.getSnapshotDriver?.() || new GitShadowSnapshotDriver();
        const roots = op.mutationRoots || snapshot?.roots || [];

        let isMatch = false;
        if (snapshot && roots.length > 0) {
          try {
            const currentFp = await snapshotDriver.fingerprint(roots, { against: snapshot });
            isMatch = currentFp === snapshot.treeFingerprint;
          } catch {
            isMatch = false;
          }
        }

        if (isMatch && snapshot) {
          const restoredResult: RollbackOperationResult = {
            kind: 'rollback',
            status: 'restored',
            snapshotId,
            // 崩溃打断的回滚只核验了指纹：没有重新核验「快照以来的操作是否全部受限」，清单也没有比对
            ...deriveRollbackCoverage({
              status: 'restored',
              effects: 'unverified',
              snapshotCoverage: snapshot.coverage,
              ignoredManifest: 'absent',
            }),
            durationMs: 0,
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, restoredResult, true);
          releaseOpAndServiceResources(op);
          report.recoveredOperations.push({
            opId: op.id,
            action: 'cleaned_unspawned',
            resourcesReleased: true,
          });
        } else {
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: 'Rollback interrupted by crash and tree fingerprint does not match target snapshot',
            recoveryGuidance: 'Workspace tree may be dirty or partially restored. Inspect files and retry rollback.',
            durationMs: 0,
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, indetResult, false);
          report.recoveredOperations.push({
            opId: op.id,
            action: 'isolated_indeterminate',
            resourcesReleased: false,
          });
        }
        continue;
      }

      if (op.kind === 'snapshot') {
        const failResult: SnapshotOperationResult = {
          kind: 'snapshot',
          status: 'failed',
          errorMessage: 'Snapshot interrupted by crash before completion',
          durationMs: 0,
          completedAt: new Date().toISOString(),
        };
        store.recordOperationResult(op.id, failResult, true);
        releaseOpAndServiceResources(op);
        report.recoveredOperations.push({
          opId: op.id,
          action: 'cleaned_unspawned',
          resourcesReleased: true,
        });
        continue;
      }

      if (op.status === 'intent_registered' && !op.processIdentity) {
        // 场景 1：意图登记后崩溃，驱动未启动（无进程身份）
        // 安全清理资源，推进至失败终态
        const failResult: ProcessOperationResult = {
          kind: 'process',
          status: 'failed',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: 'Process was never spawned before crash occurred',
          isTruncated: false,
          identityVerification: 'not_original_process',
          durationMs: 0,
          completedAt: new Date().toISOString(),
        };
        store.recordOperationResult(op.id, failResult, true);
        releaseOpAndServiceResources(op);
        recordServiceStoppedIfNeeded(op, 'cleaned_unspawned');
        report.recoveredOperations.push({
          opId: op.id,
          action: 'cleaned_unspawned',
          resourcesReleased: true,
        });
        continue;
      }

      if (op.processIdentity) {
        const spawnTimeMs = op.processIdentity.spawnTime
          ? new Date(op.processIdentity.spawnTime).getTime()
          : NaN;
        const calcDurationMs = () => (!isNaN(spawnTimeMs) ? Math.max(0, Date.now() - spawnTimeMs) : 0);

        // 场景 2-5：存在进程身份，现场向驱动核实身份
        const verification = await this.driver.verifyIdentity(op.processIdentity);

        if (verification === 'is_original_process') {
          // 进程依然存活，发送停止确认流水线
          const stopResult = await this.driver.terminate(op.processIdentity, 2000);
          if (stopResult.stopped === 'confirmed_stopped') {
            const cancelResult: ProcessOperationResult = {
              kind: 'process',
              status: 'cancelled',
              exitCode: null,
              signal: null,
              stdout: '',
              stderr: '',
              evidence: 'unobserved',
              isTruncated: false,
              identityVerification: 'is_original_process',
              durationMs: calcDurationMs(),
              completedAt: new Date().toISOString(),
            };
            store.recordOperationResult(op.id, cancelResult, true);
            releaseOpAndServiceResources(op);
            recordServiceStoppedIfNeeded(op, 'stopped_alive_process');
            report.recoveredOperations.push({
              opId: op.id,
              action: 'stopped_alive_process',
              resourcesReleased: true,
            });
          } else {
            // 无法确认停止，转为 indeterminate，绝不释放资源
            const indetResult: IndeterminateResult = {
              kind: 'indeterminate',
              status: 'indeterminate',
              reason: 'Alive process failed to stop during recovery',
              recoveryGuidance: 'Residual PID detected. Check system processes manually.',
              durationMs: calcDurationMs(),
              completedAt: new Date().toISOString(),
            };
            store.recordOperationResult(op.id, indetResult, false);
            recordServiceStoppedIfNeeded(op, 'isolated_indeterminate');
            report.recoveredOperations.push({
              opId: op.id,
              action: 'isolated_indeterminate',
              resourcesReleased: false,
            });
          }
        } else if (verification === 'not_original_process') {
          // 进程已确定死亡。但"leader 死了"不等于"组空了"：被 SIGKILL 的 leader 会
          // 变成僵尸，它 fork 出来的后代可能还在运行，而这些进程已经没有 owner。
          // 先做 N2 证据核验（bootId + 成员启动时间），证据不足或异常时绝不盲目发信号，判 indeterminate 保留租约；
          // 证据齐全时才按 pgid 定向清场；清不掉如实隔离。
          const pgid = op.processIdentity.pgid;
          let reapedOrphans = false;
          if (op.processIdentity.cgroupPath && this.driver.capabilities.descendantEnumeration === 'cgroup') {
            // 专属 cgroup 装着整棵树（含换了进程组的逃逸者），且只属于这个操作：不需要 pgid 复用核验
            const tree = this.driver.settleTree ? await this.driver.settleTree(op.processIdentity, 0) : 'unknown';
            if (tree !== 'empty') {
              const reaped = await this.driver.terminate(op.processIdentity, 2000);
              if (reaped.stopped !== 'confirmed_stopped') {
                const indetResult: IndeterminateResult = {
                  kind: 'indeterminate',
                  status: 'indeterminate',
                  reason: `Owner is dead but cgroup ${op.processIdentity.cgroupPath} could not be confirmed empty: ${reaped.errorDetails ?? 'still populated'}`,
                  recoveryGuidance: 'Processes left by the crashed owner are still in its cgroup; inspect them before retrying.',
                  durationMs: calcDurationMs(),
                  completedAt: new Date().toISOString(),
                };
                store.recordOperationResult(op.id, indetResult, false);
                report.recoveredOperations.push({ opId: op.id, action: 'isolated_indeterminate', resourcesReleased: false });
                continue;
              }
              reapedOrphans = true;
            }
          } else if (pgid !== undefined && this.isGroupAlive(pgid)) {
            // N2 检查项 1：bootId 跨宿主重启核验
            if (op.processIdentity.bootId && this.driver.readBootId) {
              const currentBootId = await this.driver.readBootId();
              if (currentBootId && op.processIdentity.bootId !== currentBootId) {
                // 宿主在崩溃后已发生重启，当前同号 pgid 属于重启后的全新无关进程组，严禁发送信号
                const indetResult: IndeterminateResult = {
                  kind: 'indeterminate',
                  status: 'indeterminate',
                  reason: `Host bootId changed (recorded: '${op.processIdentity.bootId}', current: '${currentBootId}'); process group ${pgid} belongs to a different boot session`,
                  recoveryGuidance: 'Host was rebooted after the crash. Do not terminate external process groups; manual inspection required.',
                  durationMs: calcDurationMs(),
                  completedAt: new Date().toISOString(),
                };
                store.recordOperationResult(op.id, indetResult, false);
                report.recoveredOperations.push({
                  opId: op.id,
                  action: 'isolated_indeterminate',
                  resourcesReleased: false,
                });
                continue;
              }
            }

            // N2 检查项 2：成员启动时间核验（防同一次 boot 下的 PGID 复用）
            if (this.driver.getGroupEvidence) {
              const members = await this.driver.getGroupEvidence(pgid);
              if (members.length > 0) {
                // 下界优先用 OS 登记的 leader 创建时间；旧记录没有 osStartTime 时才退回宿主 spawnTime
                const opSpawnMs = Date.parse(op.processIdentity.osStartTime ?? op.processIdentity.spawnTime);
                if (!isNaN(opSpawnMs)) {
                  let hasEarlierProcess = false;
                  for (const m of members) {
                    if (m.startTimeMs !== null && m.startTimeMs < opSpawnMs - 1000) {
                      hasEarlierProcess = true;
                      break;
                    }
                  }
                  if (hasEarlierProcess) {
                    // 组成员启动时间早于该 op 启动时间，说明当前 pgid 属于外部更早创建的无关进程组
                    const indetResult: IndeterminateResult = {
                      kind: 'indeterminate',
                      status: 'indeterminate',
                      reason: `Process group ${pgid} membership start time is earlier than operation spawn time; suspected PGID reuse`,
                      recoveryGuidance: 'External process group occupies the recorded PGID. Do not terminate; verify process ownership manually.',
                      durationMs: calcDurationMs(),
                      completedAt: new Date().toISOString(),
                    };
                    store.recordOperationResult(op.id, indetResult, false);
                    report.recoveredOperations.push({
                      opId: op.id,
                      action: 'isolated_indeterminate',
                      resourcesReleased: false,
                    });
                    continue;
                  }
                }
              }
            }

            const reaped = this.driver.terminateGroup
              ? await this.driver.terminateGroup(pgid, 2000)
              : { stopped: 'not_stopped' as const, scope: 'unknown' as const };
            if (reaped.stopped !== 'confirmed_stopped') {
              const indetResult: IndeterminateResult = {
                kind: 'indeterminate',
                status: 'indeterminate',
                reason: 'Owner is dead but its process group could not be confirmed stopped',
                recoveryGuidance: 'Residual processes from the crashed owner are still alive; inspect them before retrying.',
                durationMs: calcDurationMs(),
                completedAt: new Date().toISOString(),
              };
              store.recordOperationResult(op.id, indetResult, false);
              report.recoveredOperations.push({
                opId: op.id,
                action: 'isolated_indeterminate',
                resourcesReleased: false,
              });
              continue;
            }
            reapedOrphans = true;
          }
          const deadResult: ProcessOperationResult = {
            kind: 'process',
            status: 'failed',
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: reapedOrphans ? 'orphaned descendants were reaped during recovery' : '',
            evidence: 'unobserved',
            // 进程已不在，但它是成功还是失败无人看见：不把「未知」写成「失败」
            terminationReason: 'exit_unobserved',
            residualProcessesReaped: reapedOrphans,
            isTruncated: false,
            identityVerification: 'not_original_process',
            durationMs: calcDurationMs(),
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, deadResult, true);
          releaseOpAndServiceResources(op);
          recordServiceStoppedIfNeeded(op, 'marked_dead');
          report.recoveredOperations.push({
            opId: op.id,
            action: 'marked_dead',
            resourcesReleased: true,
          });
        } else {
          // cannot_determine: 无法确认是否为原进程，标记 indeterminate 绝不释放锁
          const indetResult: IndeterminateResult = {
            kind: 'indeterminate',
            status: 'indeterminate',
            reason: 'Cannot determine process identity after restart',
            recoveryGuidance: 'Manual inspection required. Resource isolation remains active.',
            durationMs: calcDurationMs(),
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, indetResult, false);
          recordServiceStoppedIfNeeded(op, 'isolated_indeterminate');
          report.recoveredOperations.push({
            opId: op.id,
            action: 'isolated_indeterminate',
            resourcesReleased: false,
          });
        }
      }
    }

    // 5. [Run 状态收敛] (ARCHITECTURE §3.2 第 5 步)
    //    本轮裁决后，所属 Run 若已无未终结操作：
    //    存在 indeterminate ⇒ Run 置 indeterminate；
    //    否则置 failed(terminationReason = crash_detected)。禁止让 Run 永久停留在 running
    const activeRuns = store.getActiveRuns(this.domain.domainId);
    for (const run of activeRuns) {
      const runOps = store.getOperationsByRun(run.id);
      const hasUnfinished = runOps.some((o) => o.status !== 'done');
      if (!hasUnfinished) {
        const hasIndeterminate = runOps.some((o) => o.result?.status === 'indeterminate');
        if (hasIndeterminate) {
          store.updateRunStatus(run.id, 'indeterminate', undefined, new Date().toISOString());
        } else {
          store.updateRunStatus(run.id, 'failed', 'crash_detected', new Date().toISOString());
        }
      }
    }

    // 6. [Service 维度聚合] (ARCHITECTURE §3.8 / Step 5)
    const serviceMap = new Map<string, {
      instanceOpIds: string[];
      actions: Set<'cleaned_unspawned' | 'stopped_alive_process' | 'marked_dead' | 'isolated_indeterminate'>;
      resourcesReleased: boolean;
    }>();

    for (const rec of report.recoveredOperations) {
      const op = unfinishedOps.find((o) => o.id === rec.opId);
      const isService = op?.kind === 'service' || rec.opId.includes('#');
      if (isService) {
        const serviceId = rec.opId.split('#')[0];
        let entry = serviceMap.get(serviceId);
        if (!entry) {
          entry = {
            instanceOpIds: [],
            actions: new Set(),
            resourcesReleased: true,
          };
          serviceMap.set(serviceId, entry);
        }
        entry.instanceOpIds.push(rec.opId);
        entry.actions.add(rec.action);
        if (!rec.resourcesReleased) {
          entry.resourcesReleased = false;
        }
      }
    }

    // 检查并释放处于重启 backoff 间隙遗留的 service 租约（无活跃 op）
    const persistedLeases = store.getPersistedResourceLeases(this.domain.domainId);
    for (const lease of persistedLeases) {
      if (lease.operationId.startsWith('service:')) {
        const serviceId = lease.operationId.slice('service:'.length);
        this.domain.internalReleaseResources(lease.operationId, [lease.resourceId]);
        if (!serviceMap.has(serviceId)) {
          serviceMap.set(serviceId, {
            instanceOpIds: [],
            actions: new Set(['stopped_alive_process']),
            resourcesReleased: true,
          });
          store.recordEventAndTransitionState({
            domainId: this.domain.domainId,
            type: 'SERVICE_STOPPED',
            payload: {
              serviceId,
              reason: 'recovered_after_crash',
              action: 'cleared_backoff_lease',
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    report.recoveredServices = Array.from(serviceMap.entries()).map(([serviceId, entry]) => {
      let action: 'cleaned_unspawned' | 'stopped_alive_process' | 'marked_dead' | 'isolated_indeterminate';
      if (entry.actions.has('isolated_indeterminate')) {
        action = 'isolated_indeterminate';
      } else if (entry.actions.has('stopped_alive_process')) {
        action = 'stopped_alive_process';
      } else if (entry.actions.has('marked_dead')) {
        action = 'marked_dead';
      } else {
        action = 'cleaned_unspawned';
      }
      return {
        serviceId,
        instanceOpIds: entry.instanceOpIds,
        action,
        resourcesReleased: entry.resourcesReleased,
      };
    });

    return report;
  }

  /** 进程组是否仍存在（僵尸也算存在；具体是否"能工作"由驱动的 terminateGroup 判定）。 */
  private isGroupAlive(pgid: number): boolean {
    if (typeof (this.driver as any).isGroupAlive === 'function') {
      return (this.driver as any).isGroupAlive(pgid);
    }
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }
}
