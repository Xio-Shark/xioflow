import { runCausalRecoveryBenchmark } from '../../dist/testing/causal-recovery-benchmark.js';

const args = process.argv.slice(2);
if (args.length > 3) throw new Error('Usage: pnpm benchmark:recovery [trials] [branches>=2] [hashRounds]');
const [trials, branches, hashRounds] = args.map(Number);
const report = await runCausalRecoveryBenchmark({ trials, branches, hashRounds });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some(sample => !sample.success)) process.exitCode = 1;
