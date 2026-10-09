import { runCausalRefreshBenchmark } from '../../dist/testing/causal-refresh-benchmark.js';

const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
if (flags.some(flag => !['--shared', '--change-shared'].includes(flag) && !flag.startsWith('--forecast='))) throw new Error('Unknown benchmark flag');
const forecasts = flags.filter(flag => flag.startsWith('--forecast='));
if (forecasts.length > 1) throw new Error('Specify --forecast only once');
const forecast = forecasts.length ? JSON.parse(forecasts[0].slice('--forecast='.length)) : undefined;
if (forecast !== undefined && (forecast === null || typeof forecast !== 'object' || Array.isArray(forecast))) {
  throw new Error('--forecast must be a JSON object');
}
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (args.length > 6) throw new Error('Usage: pnpm benchmark:refresh [trials] [branches] [hashRounds] [changedBranches] [reusePasses] [estimatedReusePasses] [--shared] [--change-shared] [--forecast=JSON]');
const [trials, branches, hashRounds, changedBranches, reusePasses, estimatedReusePasses] = args.map(Number);
const report = await runCausalRefreshBenchmark({ trials, branches, hashRounds, changedBranches, reusePasses, estimatedReusePasses, forecast,
  sharedInput: flags.includes('--shared'), changeSharedInput: flags.includes('--change-shared') });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some((sample) => sample.mode !== 'unchecked-reuse' && !sample.success)) process.exitCode = 1;
