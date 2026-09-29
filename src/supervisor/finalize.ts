import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDomain } from '../domain.js';
import { IndeterminateResult, OperationResult, ProcessOperationResult, TerminationReason } from '../types.js';

export const RESIDUAL_PID_GUIDANCE =
  'Residual PID detected. Inspect system processes manually before releasing resources.';

export function indeterminateResult(options: {
  reason: string;
  startTime: number;
  capabilityId?: string;
  recoveryGuidance?: string;
}): IndeterminateResult {
  return {
    kind: 'indeterminate',
    status: 'indeterminate',
    reason: options.reason,
    recoveryGuidance: options.recoveryGuidance ?? RESIDUAL_PID_GUIDANCE,
    ...(options.capabilityId !== undefined ? { capabilityId: options.capabilityId } : {}),
    durationMs: Date.now() - options.startTime,
    completedAt: new Date().toISOString(),
  };
}

export interface FinalizeOptions {
  requiredResources?: string[];
  /** false 表示保留租约（indeterminate 永远保留，与此无关）。 */
  releaseResourceLock?: boolean;
  artifactsDir?: string;
}

/**
 * 操作结果的唯一写入口（Single Writer）：写事实、清理未引用的溢出文件、按结果处理租约。
 * indeterminate 结果不释放租约并把 Run 置为 indeterminate；对已 done 的操作重复终结直接抛错。
 */
export function finalizeOperation(
  domain: ExecutionDomain,
  opId: string,
  result: OperationResult,
  options: FinalizeOptions = {}
): ProcessOperationResult {
  const store = domain.getStore();
  const existing = store.getOperation(opId);
  if (existing && existing.status === 'done') {
    throw new Error(
      `Cannot finalize operation "${opId}": operation is already finalized with status "${existing.status}"`
    );
  }
  if (existing) {
    result.runId = existing.runId;
    if (existing.capabilityId && !result.capabilityId) {
      result.capabilityId = existing.capabilityId;
    }
  }

  if (result.kind === 'process') {
    removeUnreferencedSpills(result as ProcessOperationResult, opId, options.artifactsDir || path.join(domain.domainPath, 'artifacts'));
  }

  if (result.status === 'indeterminate') {
    store.recordOperationResult(opId, result, false);
    const op = store.getOperation(opId);
    if (op) {
      const termReason = (result as { terminationReason?: TerminationReason }).terminationReason;
      store.updateRunStatus(op.runId, 'indeterminate', termReason);
    }
  } else {
    store.recordOperationResult(opId, result, true);
    if (options.releaseResourceLock ?? true) {
      domain.internalReleaseResources(opId, options.requiredResources);
    }
  }
  return result as ProcessOperationResult;
}

function removeUnreferencedSpills(procRes: ProcessOperationResult, opId: string, targetDir: string): void {
  const spills: Array<[string | undefined, string]> = [
    [procRes.stdoutRef, path.join(targetDir, `${opId}-stdout.log`)],
    [procRes.stderrRef, path.join(targetDir, `${opId}-stderr.log`)],
  ];
  for (const [ref, spillPath] of spills) {
    if (ref || !fs.existsSync(spillPath)) continue;
    try {
      fs.unlinkSync(spillPath);
    } catch (unlinkErr: any) {
      procRes.spillError = procRes.spillError || unlinkErr.message || String(unlinkErr);
    }
  }
}
