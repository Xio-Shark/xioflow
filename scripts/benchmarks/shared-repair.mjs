import { runSharedRepairBenchmark } from '../../dist/testing/shared-repair-benchmark.js';

const args = process.argv.slice(2);
if (args.length > 3) throw new Error('Usage: pnpm benchmark:shared [trials] [branches] [hashRounds]');
const [trials, branches, hashRounds] = args.map(Number);
const report = await runSharedRepairBenchmark({ trials, branches, hashRounds });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some((sample) => sample.mode !== 'unchecked-reuse' && !sample.success)) process.exitCode = 1;
