import { ExecutionDomain } from '../domain.js';
import { OperationIdConflictError, ProcessOperationResult, RecoveryRequiredError } from '../types.js';
import { ActiveOperationState, ExecuteProcessOptions } from './types.js';

/**
 * 在飞操作重放（ARCHITECTURE §3.7 / 契约 #46）：同指纹加入原执行并共享流投影，
 * 不同指纹抛 OperationIdConflictError。abortSignal 只中止本次等待，不影响原操作。
 */
export async function joinInFlight(
  domain: ExecutionDomain,
  inFlight: ActiveOperationState,
  options: ExecuteProcessOptions,
  inputFingerprint: string
): Promise<ProcessOperationResult> {
  if (inFlight.inputFingerprint !== inputFingerprint) {
    throw new OperationIdConflictError(
      options.opId,
      inFlight.inputFingerprint,
      inputFingerprint,
      inFlight.phase,
      inFlight.runId
    );
  }

  domain.getStore().recordReplay(domain.domainId, options.opId, 'joined', options.runId);
  const subscriber = options.onStreamChunk;
  if (subscriber) {
    inFlight.streamSubscribers.add(subscriber);
  }
  const unsubscribe = () => {
    if (subscriber) inFlight.streamSubscribers.delete(subscriber);
  };

  const signal = options.abortSignal;
  if (!signal) {
    const res = await inFlight.resultPromise!;
    unsubscribe();
    return { ...res, replayed: true };
  }
  if (signal.aborted) {
    unsubscribe();
    throw signal.reason || new Error('Operation wait aborted');
  }
  return await new Promise<ProcessOperationResult>((resolve, reject) => {
    const onAbort = () => {
      unsubscribe();
      reject(signal.reason || new Error('Operation wait aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    inFlight.resultPromise!.then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve({ ...res, replayed: true });
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        unsubscribe();
        reject(err);
      }
    );
  });
}

/**
 * 已持久化操作重放（ARCHITECTURE §3.7 / 契约 #45, #47, #48, #49）。
 * 返回 undefined 表示该 opId 从未登记，调用方应正常执行。
 */
export function replayRecorded(
  domain: ExecutionDomain,
  options: ExecuteProcessOptions,
  inputFingerprint: string
): ProcessOperationResult | undefined {
  const existingRecorded = domain.getStore().getOperation(options.opId);
  if (!existingRecorded) return undefined;

  if (existingRecorded.inputFingerprint !== inputFingerprint) {
    throw new OperationIdConflictError(
      options.opId,
      existingRecorded.inputFingerprint,
      inputFingerprint,
      existingRecorded.status,
      existingRecorded.runId
    );
  }

  // 未终结状态且不在内存中 → 必须先执行恢复（崩溃残留现场）
  if (existingRecorded.status !== 'done') {
    throw new RecoveryRequiredError(options.opId, existingRecorded.status, existingRecorded.runId);
  }

  // indeterminate：绝不重跑，原样返回，保留租约；已结清终态返回已持久化结果
  const kind = existingRecorded.result?.status === 'indeterminate' ? 'indeterminate' : 'recorded';
  domain.getStore().recordReplay(domain.domainId, options.opId, kind, options.runId);
  return {
    ...existingRecorded.result,
    replayed: true,
    runId: existingRecorded.runId,
  } as unknown as ProcessOperationResult;
}
