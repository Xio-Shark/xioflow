import { runCausalRefreshBenchmark } from '../../dist/testing/causal-refresh-benchmark.js';

const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
if (flags.some(flag => !['--shared', '--change-shared'].includes(flag))) throw new Error('Unknown benchmark flag');
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (args.length > 4) throw new Error('Usage: pnpm benchmark:refresh [trials] [branches] [hashRounds] [changedBranches] [--shared] [--change-shared]');
const [trials, branches, hashRounds, changedBranches] = args.map(Number);
const report = await runCausalRefreshBenchmark({ trials, branches, hashRounds, changedBranches,
  sharedInput: flags.includes('--shared'), changeSharedInput: flags.includes('--change-shared') });
console.log(JSON.stringify(report, null, 2));
if (report.samples.some((sample) => sample.mode !== 'unchecked-reuse' && !sample.success)) process.exitCode = 1;
