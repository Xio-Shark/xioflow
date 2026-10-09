import { runCausalRefreshHistoryBenchmark } from '../../dist/testing/causal-refresh-history-benchmark.js';
if (process.argv.length > 3) throw new Error('Usage: pnpm benchmark:refresh-history [hashRounds]');
const report = await runCausalRefreshHistoryBenchmark({ hashRounds: process.argv[2] === undefined ? undefined : Number(process.argv[2]) });
console.log(JSON.stringify(report, null, 2));
if (report.summary.some(row => row.successRate !== 1)) process.exitCode = 1;
