import { describe, expect, it } from 'vitest';
import { buildDist } from '../support/build-dist.js';

buildDist();

describe('First-principles empirical benchmark (xioflow OS Medium v2 vs Raw Bash)', () => {
  it('proves >99% context reduction on 2MB logs, early-crash short-circuiting, causal dirty-read protection, and atomic gate rollback', async () => {
    const { runMediumVsBashBenchmark } = await import('../../benchmarks/medium-vs-bash.mjs');
    const report = await runMediumVsBashBenchmark();
    expect(report.scenarios).toHaveLength(4);

    const [s1, s2, s3, s4] = report.scenarios;
    expect(s1.contextReductionPct).toBeGreaterThan(99);
    expect(s1.xioMedium.dataIntegrity).toBe('exact_line_18420');

    expect(s2.xioMedium.dataIntegrity).toBe('process_exited_early');
    expect(s2.speedupFactor).toBeGreaterThan(2);

    expect(s3.xioMedium.dataIntegrity).toBe('EARLY_CUTOFF_AND_ZERO_LOST_UPDATES');
    expect(s4.xioMedium.dataIntegrity).toBe('ATOMIC_100PCT_CLEAN_ROLLBACK');
  });
});
