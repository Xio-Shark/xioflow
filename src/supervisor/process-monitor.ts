import { ManagedProcessHandle, StopProcessResult } from '../driver/types.js';
import { ProcessOperationResult } from '../types.js';
import { finalizeOperation, indeterminateResult } from './finalize.js';
import { buildProcessResult, ExitFacts, openOutputCapture, OutputCapture } from './process-output.js';
import type { ProcessRunContext, ProcessRunPlan } from './process-run.js';
import { crashpoint } from '../fault/crashpoint.js';
/** 要么拿到根进程退出事实继续收尾，要么已经得出（并落盘）最终结果。 */
type Settled = { exit: ExitFacts } | { final: ProcessOperationResult };

const ROOT_EXIT_WAIT_MS = 1000;
/** 根进程自然退出后，等后代自行结束的上限；超过仍有存活者即按残留回收。 */
const TREE_SETTLE_WAIT_MS = 1000;

/**
 * 已 active 的进程：监督运行、有界排空与流式转储、身份核验、结果落盘。
 * 需要在调用方 finally 中执行的清理（排空器、定时器）登记到 cleanups。
 */
export async function superviseActive(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle,
  cleanups: Array<() => void>
): Promise<ProcessOperationResult> {
  const { options, opState } = plan;
  // 崩溃点：进程已放行运行、结果尚未落盘
  crashpoint('supervisor:process-running');
  const capture = openOutputCapture(ctx, plan, handle);
  cleanups.push(() => capture.stdout.forceFinalize(), () => capture.stderr.forceFinalize());

  // 检查在 spawn 途中是否已被请求取消：若已请求取消，立即触发停止流水线向底层发送终止信号
  if (opState.cancelRequested) {
    ctx.stop(options.opId, 'user_cancelled', opState.cancelGraceMs ?? 2000).catch(() => {});
  }

  let timeoutTimer: NodeJS.Timeout | null = null;
  const timeoutPromise =
    options.timeoutMs && options.timeoutMs > 0
      ? new Promise<'timeout'>((resolve) => {
          timeoutTimer = setTimeout(() => resolve('timeout'), options.timeoutMs);
        })
      : new Promise<'timeout'>(() => {});
  const clearTimer = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  };
  const sampler = startBudgetSampler(ctx, plan, handle);
  cleanups.push(clearTimer, sampler.stop);

  const outcome = await raceRootOutcome(plan, handle, timeoutPromise);
  clearTimer();
  sampler.stop();

  const settled = await settleRootOutcome(ctx, plan, handle, outcome);
  if ('final' in settled) return settled.final;

  const drained = await drainOrReap(ctx, plan, handle, capture, {
    exit: settled.exit,
    exitedNaturally: outcome.type === 'exit',
  });
  if ('final' in drained) return drained.final;

  await recordHardLimitHits(ctx, plan, handle);
  const result = buildProcessResult(plan, capture, {
    exit: settled.exit,
    residualProcessesReaped: drained.residualProcessesReaped,
    treeSettlement: drained.treeSettlement,
    peaks: sampler.peaks(),
    identityVerification: await ctx.driver.verifyIdentity(handle.identity),
  });

  if (opState.stopPromise) {
    const stopRes = await opState.stopPromise;
    if (stopRes.stopped !== 'confirmed_stopped') {
      return recordUnconfirmedStop(ctx, plan, handle, stopRes, true);
    }
  }

  if (plan.readTracking) {
    result.readEvidence = plan.readTracking.collect(capture.artifactsDir);
  }

  // 6. [事务提交结果与释放资源 - Single Writer]
  return finalizeOperation(ctx.domain, options.opId, result, {
    requiredResources: options.requiredResources,
    artifactsDir: capture.artifactsDir,
  });
}

/** Soft / Observe 模式资源采样治理：记录峰值，soft 超限时走停止流水线；hard 模式读取 OS 限制命中事实。 */
function startBudgetSampler(ctx: ProcessRunContext, plan: ProcessRunPlan, handle: ManagedProcessHandle) {
  const { options, opState } = plan;
  const budget = options.resourceBudget;
  let peakMemoryBytes = 0;
  let peakCpuTimeMs = 0;
  let samplingInterval: NodeJS.Timeout | null = null;
  const stop = () => {
    if (samplingInterval) clearInterval(samplingInterval);
  };
  const peaks = () => ({ peakMemoryBytes, peakCpuTimeMs });

  if (!ctx.driver.sampleMetrics || !budget) {
    return { stop, peaks };
  }
  const stopFor = async (reason: 'memory_exceeded' | 'cpu_exceeded' | 'pids_exceeded') => {
    opState.terminationReason = reason;
    stop();
    await ctx.stop(options.opId, reason, 1000);
  };
  samplingInterval = setInterval(async () => {
    try {
      const metrics = await ctx.driver.sampleMetrics!(handle.identity);
      peakMemoryBytes = Math.max(peakMemoryBytes, metrics.rssBytes);
      peakCpuTimeMs = Math.max(peakCpuTimeMs, metrics.cpuTimeMs);
      if (budget.enforcement === 'hard') {
        // OS 已经在执行上限：OOM 时内核杀掉整组，这里只记原因；pids 上限只拦 fork，不停树就会一直撞线
        const hits = await ctx.driver.readLimitEvents?.(handle.identity);
        if (hits && hits.memoryOomKills > 0) opState.terminationReason ??= 'memory_exceeded';
        else if (hits && hits.pidsMaxHits > 0) await stopFor('pids_exceeded');
        return;
      }
      if (budget.enforcement !== 'soft') return;
      if (budget.maxMemoryBytes && metrics.rssBytes > budget.maxMemoryBytes) {
        await stopFor('memory_exceeded');
      } else if (budget.maxCpuTimeMs && metrics.cpuTimeMs > budget.maxCpuTimeMs) {
        await stopFor('cpu_exceeded');
      } else if (budget.maxPids && metrics.pidsCount > budget.maxPids) {
        await stopFor('pids_exceeded');
      }
    } catch {}
  }, 100);
  return { stop, peaks };
}

/** 退出之后补读一次 OS 限制命中事实，覆盖采样间隔里发生的命中。 */
async function recordHardLimitHits(ctx: ProcessRunContext, plan: ProcessRunPlan, handle: ManagedProcessHandle) {
  const { options, opState } = plan;
  if (options.resourceBudget?.enforcement !== 'hard' || opState.terminationReason || !ctx.driver.readLimitEvents) return;
  const hits = await ctx.driver.readLimitEvents(handle.identity);
  if (hits && hits.memoryOomKills > 0) opState.terminationReason = 'memory_exceeded';
  else if (hits && hits.pidsMaxHits > 0) opState.terminationReason = 'pids_exceeded';
}

type RootOutcome =
  | { type: 'exit'; res: ExitFacts }
  | { type: 'timeout' }
  | { type: 'stop'; stopRes: StopProcessResult };

/** 等待根进程退出、超时触发、或外部停止完成（三者取先）。 */
async function raceRootOutcome(
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle,
  timeoutPromise: Promise<'timeout'>
): Promise<RootOutcome> {
  const { opState } = plan;
  let notifyStop: ((res: StopProcessResult) => void) | undefined;
  const stopTriggerPromise = new Promise<StopProcessResult>((resolve) => {
    notifyStop = resolve;
  });
  const previousResolve = opState.stopResolve;
  opState.stopResolve = (res: StopProcessResult) => {
    previousResolve?.(res);
    notifyStop?.(res);
  };

  const rootExitPromise = handle.onRootExit ?? handle.onExit;
  const stopCandidate = opState.stopPromise ? opState.stopPromise : stopTriggerPromise;
  return Promise.race<RootOutcome>([
    rootExitPromise.then((res) => ({ type: 'exit' as const, res })),
    timeoutPromise.then(() => ({ type: 'timeout' as const })),
    stopCandidate.then((stopRes) => ({ type: 'stop' as const, stopRes })),
  ]);
}

function waitRootExit(handle: ManagedProcessHandle): Promise<{ exited: true; res: ExitFacts } | { exited: false }> {
  return Promise.race([
    (handle.onRootExit ?? handle.onExit).then((res) => ({ exited: true as const, res })),
    new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), ROOT_EXIT_WAIT_MS)),
  ]);
}

async function settleRootOutcome(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle,
  outcome: RootOutcome
): Promise<Settled> {
  const { options, opState } = plan;
  if (outcome.type === 'exit') {
    return { exit: outcome.res };
  }

  if (outcome.type === 'stop') {
    if (outcome.stopRes.stopped !== 'confirmed_stopped') {
      if (handle.rawProcess && typeof handle.rawProcess.kill === 'function') {
        try { handle.rawProcess.kill('SIGKILL'); } catch {}
      }
      try {
        (handle.stdout as any).destroy?.();
        (handle.stderr as any).destroy?.();
      } catch {}
      return { final: recordUnconfirmedStop(ctx, plan, handle, outcome.stopRes, false) };
    }
    const rootExit = await waitRootExit(handle);
    return { exit: rootExit.exited ? rootExit.res : { exitCode: null, signal: 'SIGKILL' } };
  }

  opState.timedOut = true;
  opState.terminationReason = 'timed_out';
  const stopRes = await ctx.stop(options.opId, 'timed_out', 1500);

  // 超时路径：根进程已由停止流水线终止，等待根进程退出事实（避免被持有管道的逃逸后代挂死）。
  // 有界上限内未确认停止或根进程仍未退出，转入 indeterminate
  const rootExit = await waitRootExit(handle);
  if (stopRes.stopped === 'confirmed_stopped' && rootExit.exited) {
    return { exit: rootExit.res };
  }
  const stored = ctx.domain.getStore().getOperation(options.opId);
  if (stored && stored.status === 'done' && stored.result?.status === 'indeterminate') {
    return { final: stored.result as unknown as ProcessOperationResult };
  }
  const indet = indeterminateResult({
    reason: `Process ${handle.identity.pid} timed out and root process could not be confirmed exited within ${ROOT_EXIT_WAIT_MS}ms bound: ${stopRes.errorDetails || 'root process still alive'}`,
    startTime: opState.startTime,
  });
  return { final: holdLeases(ctx, plan, indet) };
}

/** 停止未被确认：若停止流水线已写下结果则沿用，否则记为 indeterminate 并保留租约。 */
function recordUnconfirmedStop(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle,
  stopRes: StopProcessResult,
  withCapability: boolean
): ProcessOperationResult {
  const stored = ctx.domain.getStore().getOperation(plan.options.opId);
  if (stored && stored.status === 'done') {
    return (stored.result ?? null) as unknown as ProcessOperationResult;
  }
  const indet = indeterminateResult({
    reason: `Process ${handle.identity.pid} was cancelled or stopped but could not be confirmed: ${stopRes.errorDetails || 'residual processes still alive'}`,
    startTime: plan.opState.startTime,
    capabilityId: withCapability ? plan.options.capabilityId : undefined,
  });
  return holdLeases(ctx, plan, indet);
}

function holdLeases(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  indet: ReturnType<typeof indeterminateResult>
): ProcessOperationResult {
  return finalizeOperation(ctx.domain, plan.options.opId, indet, {
    requiredResources: plan.options.requiredResources,
    releaseResourceLock: false,
  });
}

type Drained = { residualProcessesReaped: boolean; treeSettlement?: ProcessOperationResult['treeSettlement'] };

/**
 * 有界等待流排空。排空超时说明根进程已退出但仍有后代持有管道：回收整个进程组，
 * 否则操作会一直挂到超时，且 root 的真实退出事实会被超时掩盖。
 */
async function drainOrReap(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle,
  capture: OutputCapture,
  facts: { exit: ExitFacts; exitedNaturally: boolean }
): Promise<Drained | { final: ProcessOperationResult }> {
  const { options, opState } = plan;
  const drainTimeoutMs = options.drainTimeoutMs ?? 2000;
  const drainPromise = Promise.all([capture.stdout.finishPromise, capture.stderr.finishPromise]);
  const drainedWithin = (ms: number) =>
    Promise.race([drainPromise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  let drained = await drainedWithin(drainTimeoutMs);
  let residualProcessesReaped = false;
  if (!drained && facts.exitedNaturally) {
    const reapResult = await ctx.driver.terminate(handle.identity, 1500);
    if (reapResult.stopped !== 'confirmed_stopped') {
      const indet = indeterminateResult({
        reason: `Process ${handle.identity.pid} exited but residual descendants could not be confirmed stopped: ${reapResult.errorDetails}`,
        startTime: opState.startTime,
      });
      return { final: holdLeases(ctx, plan, indet) };
    }
    residualProcessesReaped = true;
    // 被杀死的后代释放管道后，给排空最后一次机会
    drained = await drainedWithin(250);
  }

  if (drained) {
    // 停止流水线在途时由它确认整棵树（停止结果的 scope），不再另做结算
    if (!facts.exitedNaturally || opState.stopPromise) return { residualProcessesReaped };
    if (residualProcessesReaped) return { residualProcessesReaped, treeSettlement: 'reaped' };
    return settleTree(ctx, plan, handle);
  }
  // 排空超时路径强制调用 fsyncSync + closeSync 结清刷盘
  capture.stdout.forceFinalize();
  capture.stderr.forceFinalize();
  // 走到这里时进程组已被确认停止，管道写端却仍被持有：
  // 必然存在一个驱动未观测到的逃逸进程（例如 setsid 后被 init 收养、采样器没来得及记录）。
  // 无法确认隔离，不能报告 succeeded / residualProcessesReaped，必须如实判 indeterminate 并保留租约。
  const indet = indeterminateResult({
    reason: `Process ${handle.identity.pid} exited (exitCode=${facts.exit.exitCode}, signal=${facts.exit.signal}) and its process group was confirmed stopped, but stdout/stderr pipes are still held by an unobserved escaped process`,
    recoveryGuidance:
      'An escaped process outside the observed process tree still holds the output pipes. Inspect system processes manually before adjudicating and releasing resources.',
    capabilityId: options.capabilityId,
    startTime: opState.startTime,
  });
  return { final: holdLeases(ctx, plan, indet) };
}

/**
 * 管道排空不代表树已空：关闭了 stdio 的 daemon 化后代（setsid + /dev/null）不持有管道。
 * 问驱动树是否已空；已知有残留就走停止流水线回收，确认不了则保留租约判 indeterminate。
 */
async function settleTree(
  ctx: ProcessRunContext,
  plan: ProcessRunPlan,
  handle: ManagedProcessHandle
): Promise<Drained | { final: ProcessOperationResult }> {
  const answer = ctx.driver.settleTree ? await ctx.driver.settleTree(handle.identity, TREE_SETTLE_WAIT_MS) : 'unknown';
  if (answer === 'empty') return { residualProcessesReaped: false, treeSettlement: 'empty' };
  if (answer === 'unknown') return { residualProcessesReaped: false, treeSettlement: 'unverified' };

  const reapResult = await ctx.driver.terminate(handle.identity, 1500);
  if (reapResult.stopped !== 'confirmed_stopped') {
    const indet = indeterminateResult({
      reason: `Process ${handle.identity.pid} exited but descendants that left its output pipes could not be confirmed stopped: ${reapResult.errorDetails ?? 'residual processes still alive'}`,
      capabilityId: plan.options.capabilityId,
      startTime: plan.opState.startTime,
    });
    return { final: holdLeases(ctx, plan, indet) };
  }
  return { residualProcessesReaped: true, treeSettlement: 'reaped' };
}
