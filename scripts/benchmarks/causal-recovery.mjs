import { runCausalRecoveryBenchmark } from '../../dist/testing/causal-recovery-benchmark.js';

const args = process.argv.slice(2);
if (args.length > 4) throw new Error('Usage: pnpm benchmark:recovery [trials] [branches>=2] [hashRounds] [stable|input-changed]');
const [trials, branches, hashRounds] = args.slice(0, 3).map(Number);
const report = await runCausalRecoveryBenchmark({ trials, branches, hashRounds, publication: args[3] });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some(sample => !sample.success)) process.exitCode = 1;
