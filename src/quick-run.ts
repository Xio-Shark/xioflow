import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutionDomain } from './domain.js';
import { PlatformDriver, StructuredCommand } from './driver/types.js';
import { ProcessSupervisor } from './supervisor/supervisor.js';
import { validateExecuteProcessOptions } from './supervisor/input-validation.js';
import type { ExecuteProcessOptions } from './supervisor/types.js';
import { ProcessExecutionResult, ResourceBudget } from './types.js';

export interface QuickRunOptions {
  domain?: ExecutionDomain;
  domainPath?: string;
  domainId?: string;
  driver?: PlatformDriver;
  opId?: string;
  runId?: string;
  taskId?: string;
  name?: string;
  requiredResources?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  drainTimeoutMs?: number;
  waitTimeoutMs?: number;
  resourceBudget?: ResourceBudget;
  onStreamChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  abortSignal?: AbortSignal;
  artifactsDir?: string;
}

/**
 * 快速执行受管进程：自动创建 Task 与 Run，支持可选 opId 幂等重放
 */
export async function quickRun(
  command: StructuredCommand,
  options: QuickRunOptions = {}
): Promise<ProcessExecutionResult> {
  const autoCreatedRun = options.runId === undefined;
  const runId = options.runId === undefined ? `quick-run-${crypto.randomUUID().slice(0, 8)}` : options.runId;
  const processOptions: ExecuteProcessOptions = {
    runId,
    opId: options.opId === undefined ? `quick-op-${crypto.randomUUID()}` : options.opId,
    name: options.name === undefined
      ? (typeof command?.execPath === 'string' ? path.basename(command.execPath) : 'quick-run')
      : options.name,
    command,
    requiredResources: options.requiredResources,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    drainTimeoutMs: options.drainTimeoutMs,
    waitTimeoutMs: options.waitTimeoutMs,
    resourceBudget: options.resourceBudget,
    onStreamChunk: options.onStreamChunk,
    abortSignal: options.abortSignal,
    artifactsDir: options.artifactsDir,
  };
  // 先校验执行参数，再创建目录、域和请求记录；null 不等同于未提供参数。
  validateExecuteProcessOptions(processOptions);
  const ownsDomain = !options.domain;
  const domain =
    options.domain ??
    ExecutionDomain.acquire(
      options.domainPath ?? path.join(command.cwd || process.cwd(), '.xioflow', 'kernel'),
      options.domainId ?? 'default'
    );
  try {
    const supervisor = new ProcessSupervisor(domain, options.driver);
    const store = domain.getStore();
    const taskId = options.taskId ?? 'quick-task';
    if (!store.getTask(taskId)) {
      store.saveTask({
        id: taskId,
        domainId: domain.domainId,
        name: 'QuickRun Task',
        createdAt: new Date().toISOString(),
      });
    }

    const existingRun = store.getRun(runId);
    const createsRequestRun = autoCreatedRun && !existingRun;
    if (!existingRun) {
      store.saveRun({
        id: runId,
        taskId,
        domainId: domain.domainId,
        owner: 'quick-run',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }

    let result: ProcessExecutionResult;
    try {
      result = await supervisor.executeProcess(processOptions);
    } catch (error) {
      if (createsRequestRun) {
        try {
          if (store.getRun(runId)?.status !== 'indeterminate') domain.reportRunFailed(runId);
        } catch (finalizeError) {
          throw new AggregateError([error, finalizeError], 'QuickRun execution and request run finalization both failed', { cause: error });
        }
      }
      throw error;
    }

    if (createsRequestRun) {
      // Run 是本函数自建的，收敛失败（例如 owner 已被 epoch 栅栏淘汰）不能吞掉，
      // 否则 Run 会静默停在 running；操作事实已写入 journal，错误原样抛给调用方
      if (result.status === 'succeeded') {
        domain.reportRunSucceeded(runId);
      } else if (result.status === 'failed') {
        domain.reportRunFailed(runId);
      } else if (result.status === 'cancelled') {
        domain.reportRunCancelled(runId);
      } else {
        // 重放或加入的事实属于原 Run；本次自建请求 Run 也必须收敛为不确定。
        store.updateRunStatus(runId, 'indeterminate', result.terminationReason, new Date().toISOString());
      }
    }

    return result;
  } finally {
    if (ownsDomain) {
      domain.close();
    }
  }
}
