import path from 'node:path';
import crypto from 'node:crypto';
import { ExecutionDomain } from './domain.js';
import { PlatformDriver, StructuredCommand } from './driver/types.js';
import { NodePlatformDriver } from './driver/node-driver.js';
import { ProcessSupervisor } from './supervisor/supervisor.js';
import { ProcessOperationResult, ResourceBudget } from './types.js';

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
): Promise<ProcessOperationResult> {
  const ownsDomain = !options.domain;
  const domain =
    options.domain ??
    ExecutionDomain.acquire(
      options.domainPath ?? path.join(command.cwd || process.cwd(), '.xioflow', 'kernel'),
      options.domainId ?? 'default'
    );
  const driver = options.driver ?? new NodePlatformDriver();
  const supervisor = new ProcessSupervisor(domain, driver);

  try {
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

    const autoCreatedRun = !options.runId;
    const runId = options.runId ?? `quick-run-${crypto.randomUUID().slice(0, 8)}`;
    if (!store.getRun(runId)) {
      store.saveRun({
        id: runId,
        taskId,
        domainId: domain.domainId,
        owner: 'quick-run',
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    }

    const opId = options.opId ?? `quick-op-${crypto.randomUUID()}`;
    const result = await supervisor.executeProcess({
      runId,
      opId,
      name: options.name ?? path.basename(command.execPath),
      command,
      requiredResources: options.requiredResources ?? [],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      drainTimeoutMs: options.drainTimeoutMs,
      waitTimeoutMs: options.waitTimeoutMs,
      resourceBudget: options.resourceBudget,
      onStreamChunk: options.onStreamChunk,
      abortSignal: options.abortSignal,
      artifactsDir: options.artifactsDir,
    });

    if (autoCreatedRun) {
      if (result.status === 'succeeded') {
        try {
          domain.reportRunSucceeded(runId);
        } catch {}
      } else if (result.status === 'failed') {
        try {
          domain.reportRunFailed(runId);
        } catch {}
      } else if (result.status === 'cancelled') {
        try {
          domain.reportRunCancelled(runId);
        } catch {}
      }
    }

    return result;
  } finally {
    if (ownsDomain) {
      domain.close();
    }
  }
}
