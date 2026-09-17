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
  ) {}

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
        this.domain.releaseResources(op.id, op.requiredResources);
        report.recoveredOperations.push({
          opId: op.id,
          action: 'cleaned_unspawned',
          resourcesReleased: true,
        });
        continue;
      }

      if (op.processIdentity) {
        // 场景 2-5：存在进程身份，现场向驱动核实身份
        const verification = await this.driver.verifyIdentity(op.processIdentity);

        if (verification === 'is_original_process') {
          // 进程依然存活，发送停止确认流水线
          const stopResult = await this.driver.terminate(op.processIdentity, 2000);
          if (stopResult.stopped) {
            const cancelResult: ProcessOperationResult = {
              kind: 'process',
              status: 'cancelled',
              exitCode: null,
              signal: 'SIGKILL',
              stdout: '',
              stderr: 'Alive process safely terminated and recovered',
              isTruncated: false,
              identityVerification: 'is_original_process',
              durationMs: 0,
              completedAt: new Date().toISOString(),
            };
            store.recordOperationResult(op.id, cancelResult, true);
            this.domain.releaseResources(op.id, op.requiredResources);
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
        } else if (verification === 'not_original_process') {
          // 进程已确定死亡，核定终态并结清资源
          const deadResult: ProcessOperationResult = {
            kind: 'process',
            status: 'failed',
            exitCode: 137,
            signal: 'SIGKILL',
            stdout: '',
            stderr: 'Process terminated due to system crash',
            isTruncated: false,
            identityVerification: 'not_original_process',
            durationMs: 0,
            completedAt: new Date().toISOString(),
          };
          store.recordOperationResult(op.id, deadResult, true);
          this.domain.releaseResources(op.id, op.requiredResources);
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
      }
    }

    return report;
  }
}
