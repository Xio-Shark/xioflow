import fs from 'node:fs';
import path from 'node:path';
import { ManagedProcessHandle } from '../driver/types.js';
import { ProcessOperationResult } from '../types.js';
import { setupStreamDrainer, StreamDrainer } from './drainer.js';
import type { ProcessRunContext, ProcessRunPlan } from './process-run.js';

export type ExitFacts = { exitCode: number | null; signal: NodeJS.Signals | null };

export interface OutputCapture {
  stdout: StreamDrainer;
  stderr: StreamDrainer;
  artifactsDir: string;
  artifactsDirError?: string;
  callbackError(): string | undefined;
}

/** 准备 artifacts 溢出目录，挂上有界排空器；chunk 同时计入输出预算并转发给流订阅者。 */
export function openOutputCapture(ctx: ProcessRunContext, plan: ProcessRunPlan, handle: ManagedProcessHandle): OutputCapture {
  const { options, opState } = plan;
  const artifactsDir = options.artifactsDir || path.join(ctx.domain.domainPath, 'artifacts');
  let artifactsDirError: string | undefined;
  if (!fs.existsSync(artifactsDir)) {
    try {
      fs.mkdirSync(artifactsDir, { recursive: true });
    } catch (dirErr: any) {
      artifactsDirError = dirErr.message || String(dirErr);
    }
  }

  let totalOutputBytes = 0;
  const onChunk = (bytes: number) => {
    totalOutputBytes += bytes;
    const budget = options.resourceBudget;
    if (
      budget?.enforcement === 'soft' &&
      budget.maxOutputBytes &&
      totalOutputBytes > budget.maxOutputBytes &&
      !opState.terminationReason
    ) {
      opState.terminationReason = 'output_exceeded';
      ctx.stop(options.opId, 'output_exceeded', 1000).catch(() => {});
    }
  };

  let streamCallbackError: string | undefined;
  const forwardChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    for (const subscriber of opState.streamSubscribers) {
      try {
        subscriber(stream, chunk);
      } catch (err) {
        streamCallbackError ??= err instanceof Error ? err.message : String(err);
      }
    }
  };

  const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024; // 默认 10MB
  const drainer = (stream: 'stdout' | 'stderr') =>
    setupStreamDrainer(
      handle[stream],
      maxBytes,
      path.join(artifactsDir, `${options.opId}-${stream}.log`),
      onChunk,
      forwardChunk(stream),
      artifactsDirError
    );
  return {
    stdout: drainer('stdout'),
    stderr: drainer('stderr'),
    artifactsDir,
    artifactsDirError,
    callbackError: () => streamCallbackError,
  };
}

export function buildProcessResult(
  plan: ProcessRunPlan,
  capture: OutputCapture,
  facts: {
    exit: ExitFacts;
    residualProcessesReaped: boolean;
    peaks: { peakMemoryBytes: number; peakCpuTimeMs: number };
    identityVerification: ProcessOperationResult['identityVerification'];
  }
): ProcessOperationResult {
  const { options, opState } = plan;
  const stdoutData = capture.stdout.getResult();
  const stderrData = capture.stderr.getResult();
  const spillError = stdoutData.spillError || stderrData.spillError || capture.artifactsDirError;
  const streamCallbackError = capture.callbackError();

  const isResourceOrTimeoutStopped =
    opState.timedOut ||
    opState.terminationReason === 'memory_exceeded' ||
    opState.terminationReason === 'cpu_exceeded' ||
    opState.terminationReason === 'pids_exceeded' ||
    opState.terminationReason === 'output_exceeded';
  const finalStatus = isResourceOrTimeoutStopped
    ? 'failed'
    : opState.cancelRequested
    ? 'cancelled'
    : facts.exit.exitCode === 0
    ? 'succeeded'
    : 'failed';

  return {
    kind: 'process',
    status: finalStatus,
    exitCode: facts.exit.exitCode,
    signal: facts.exit.signal,
    stdout: stdoutData.content,
    stderr: stderrData.content,
    capabilityId: options.capabilityId,
    confined: plan.confined,
    confinementDriver: plan.confinementDriverName,
    isTruncated: stdoutData.isTruncated || stderrData.isTruncated,
    stdoutTruncated: stdoutData.isTruncated,
    stderrTruncated: stderrData.isTruncated,
    stdoutRef: !stdoutData.spillError ? stdoutData.outputRef : undefined,
    stderrRef: !stderrData.spillError ? stderrData.outputRef : undefined,
    stdoutBytes: stdoutData.bytesSeen,
    stderrBytes: stderrData.bytesSeen,
    stdoutHash: !stdoutData.spillError ? stdoutData.outputHash : undefined,
    stderrHash: !stderrData.spillError ? stderrData.outputHash : undefined,
    ...(facts.residualProcessesReaped ? { residualProcessesReaped: true } : {}),
    ...(streamCallbackError ? { streamCallbackError } : {}),
    ...(spillError ? { spillError } : {}),
    ...(stdoutData.spillError ? { stdoutSpillError: stdoutData.spillError } : {}),
    ...(stderrData.spillError ? { stderrSpillError: stderrData.spillError } : {}),
    outputRef: (!spillError && (stdoutData.outputRef || stderrData.outputRef)) || undefined,
    outputHash: (!spillError && (stdoutData.outputHash || stderrData.outputHash)) || undefined,
    terminationReason: opState.terminationReason || (finalStatus === 'succeeded' ? 'completed' : undefined),
    peakMemoryBytes: facts.peaks.peakMemoryBytes,
    cpuTimeMs: facts.peaks.peakCpuTimeMs,
    identityVerification: facts.identityVerification,
    durationMs: Date.now() - opState.startTime,
    completedAt: new Date().toISOString(),
  };
}
