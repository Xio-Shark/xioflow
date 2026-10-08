import { runSpeculativeMergeBenchmark } from '../../dist/testing/speculative-merge-benchmark.js';

const args = process.argv.slice(2);
if (args.length > 3) throw new Error('Usage: pnpm benchmark:merge [trials] [branches] [hashRounds]');
const [trials, branches, hashRounds] = args.map(Number);
const report = await runSpeculativeMergeBenchmark({ trials, branches, hashRounds });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some((sample) => !sample.success || !sample.conflictDetected)) process.exitCode = 1;
