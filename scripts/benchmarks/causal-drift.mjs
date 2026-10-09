import { runCausalDriftBenchmark } from '../../dist/testing/causal-drift-benchmark.js';
const options = process.argv[2] ? JSON.parse(process.argv[2]) : {};
console.log(JSON.stringify(await runCausalDriftBenchmark(options), null, 2));
