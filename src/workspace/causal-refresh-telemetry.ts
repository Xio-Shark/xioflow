import type { ExecutionDomain } from '../domain.js';
import type { WorkspaceCausalRefreshOptions } from './causal-refresh.js';

export interface CausalRefreshCallbackMeasurement {
  /** Actual callback attempts, including rejected calls; cache hits are not calls. */
  calls: number;
  errors: number;
  durationMs: number;
}

export interface CausalRefreshTelemetry {
  seq: number;
  runId: string;
  decisionSeq: number;
  strategy: 'probe' | 'recompute';
  /** threw may include an unknown commit outcome; consult transaction events. */
  status: 'unchanged' | 'failed' | 'committed' | 'conflict' | 'threw';
  validationSeq?: number;
  /** Wall time after decision persistence, including workspace setup and cleanup. */
  durationMs: number;
  callbacks: Record<'probe' | 'reuse' | 'execute' | 'commitReplay', CausalRefreshCallbackMeasurement>;
}

/** Query actual work, independent of forecast units. Missing reports are not zero-cost runs. */
export function listWorkspaceCausalRefreshTelemetry(
  domain: ExecutionDomain, options: { runId?: string; atSeq?: number } = {},
): CausalRefreshTelemetry[] {
  const atSeq = options.atSeq ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Invalid refresh telemetry history sequence');
  return domain.getStore().getJournalEvents(domain.domainId)
    .filter(event => event.type === 'CAUSAL_REFRESH_MEASURED' && event.seq <= atSeq
      && (options.runId === undefined || event.runId === options.runId))
    .map(event => {
      if (event.payload.version !== 1) throw new Error('Unsupported causal refresh telemetry version');
      return { ...structuredClone(event.payload.report) as Omit<CausalRefreshTelemetry, 'seq'>, seq: event.seq };
    });
}

/** @internal Invocation-local instrumentation; never modifies host callbacks or supervisor methods. */
export function measureCausalRefreshCallbacks(options: WorkspaceCausalRefreshOptions, strategy: 'probe' | 'recompute') {
  const empty = (): CausalRefreshCallbackMeasurement => ({ calls: 0, errors: 0, durationMs: 0 });
  const callbacks: CausalRefreshTelemetry['callbacks'] = {
    probe: empty(), reuse: empty(), execute: empty(), commitReplay: empty(),
  };
  // Refresh finishes probing before entering repair. Replays after repair are OCC checks.
  let repairing = strategy === 'recompute';
  async function measure<T>(phase: keyof typeof callbacks, call: () => Promise<T>): Promise<T> {
    const metric = callbacks[phase];
    metric.calls++;
    const started = performance.now();
    try { return await call(); }
    catch (error) { metric.errors++; throw error; }
    finally { metric.durationMs += performance.now() - started; }
  }
  const measured: WorkspaceCausalRefreshOptions = {
    ...options,
    replay: (...args) => measure(repairing ? 'commitReplay' : 'probe', () => options.replay(...args)),
    repair: {
      ...options.repair,
      validateReuse: (...args) => {
        repairing = true;
        return measure('reuse', () => options.repair.validateReuse(...args));
      },
      execute: (...args) => {
        repairing = true;
        return measure('execute', () => options.repair.execute(...args));
      },
    },
  };
  return { options: measured, callbacks };
}
