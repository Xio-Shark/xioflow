import { runCausalRefreshBenchmark } from '../../dist/testing/causal-refresh-benchmark.js';

const args = process.argv.slice(2);
if (args.length > 4) throw new Error('Usage: pnpm benchmark:refresh [trials] [branches] [hashRounds] [changedBranches]');
const [trials, branches, hashRounds, changedBranches] = args.map(Number);
const report = await runCausalRefreshBenchmark({ trials, branches, hashRounds, changedBranches });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some((sample) => sample.mode !== 'unchecked-reuse' && !sample.success)) process.exitCode = 1;
