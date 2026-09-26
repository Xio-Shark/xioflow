import { ExecutionDomain } from '../domain.js';
import { PlatformDriver } from '../driver/types.js';
import { Operation, ProcessOperationResult, IndeterminateResult } from '../types.js';

export interface RecoveryReport {
  recoveredOperations: {
    opId: string;
    action: 'cleaned_unspawned' | 'stopped_alive_process' | 'marked_dead' | 'isolated_indeterminate';
    resourcesReleased: boolean;
  }[];
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

    for (const op of unfinishedOps) {
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
        this.domain.internalReleaseResources(op.id, op.requiredResources);
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
            this.domain.internalReleaseResources(op.id, op.requiredResources);
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
          if (pgid !== undefined && this.isGroupAlive(pgid)) {
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
                const opSpawnMs = Date.parse(op.processIdentity.spawnTime);
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
            residualProcessesReaped: reapedOrphans,
            isTruncated: false,
            identityVerification: 'not_original_process',
            durationMs: calcDurationMs(),
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, deadResult, true);
          this.domain.internalReleaseResources(op.id, op.requiredResources);
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
