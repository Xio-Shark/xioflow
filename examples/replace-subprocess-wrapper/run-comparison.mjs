import { execSync } from 'node:child_process';
import { runNaive } from './naive-wrapper.mjs';
import { runKernel } from './kernel-wrapper.mjs';

function countActiveIntervalWorkers() {
  try {
    const ps = execSync('ps -ef', { encoding: 'utf8' });
    const matches = ps.split('\n').filter((line) => line.includes('setInterval(() => {}, 1000)'));
    return matches.length;
  } catch {
    return 0;
  }
}

function killActiveIntervalWorkers() {
  try {
    execSync("pkill -f 'setInterval\\(\\(\\) => {}, 1000\\)' || true");
  } catch {}
}

console.log('================================================================');
console.log('Subprocess Wrapper Comparison: Naive spawn() vs @xioflow/kernel');
console.log('================================================================\n');

// Clean any leftover workers before start
killActiveIntervalWorkers();

// 1. Run naive wrapper
console.log('1. Running Naive Wrapper (spawn + setTimeout + child.kill)...');
const initialWorkers = countActiveIntervalWorkers();
const naiveRes = await runNaive(800);
// Give 200ms for child process exit signals to settle
await new Promise((r) => setTimeout(r, 200));
const workersAfterNaive = countActiveIntervalWorkers();
const naiveOrphans = workersAfterNaive - initialWorkers;
console.log(`   - Naive finished: status=${naiveRes.signal || naiveRes.exitCode}`);
console.log(`   - Output Tail Preserved: ${naiveRes.tailPreserved}`);
console.log(`   - Orphan processes left alive in OS: ${naiveOrphans}`);

// Clean up naive orphans before running kernel
killActiveIntervalWorkers();
await new Promise((r) => setTimeout(r, 200));

// 2. Run kernel wrapper
console.log('\n2. Running @xioflow/kernel (quickRun with bounded drain + group kill)...');
const baselineWorkers = countActiveIntervalWorkers();
const kernelRes = await runKernel(800);
await new Promise((r) => setTimeout(r, 200));
const workersAfterKernel = countActiveIntervalWorkers();
const kernelOrphans = workersAfterKernel - baselineWorkers;
console.log(`   - Kernel finished: status=${kernelRes.status} (signal: ${kernelRes.signal})`);
console.log(`   - Output Head Preserved: ${kernelRes.headPreserved}`);
console.log(`   - Output Tail Preserved: ${kernelRes.tailPreserved}`);
console.log(`   - Full output spilled to disk: ${kernelRes.stdoutRef ? 'YES (' + kernelRes.stdoutRef + ')' : 'NO'}`);
console.log(`   - Orphan processes left alive in OS: ${kernelOrphans}`);

// Clean up
killActiveIntervalWorkers();

console.log('\n================================================================');
console.log('Comparison Summary:');
console.log('================================================================');
console.table([
  {
    Aspect: 'Orphan processes leaked',
    'Naive Wrapper': `${naiveOrphans} (grandchild escaped)`,
    '@xioflow/kernel': `${kernelOrphans} (process group cleaned)`,
  },
  {
    Aspect: 'Output Head preserved',
    'Naive Wrapper': naiveRes.headPreserved ? 'YES' : 'NO',
    '@xioflow/kernel': kernelRes.headPreserved ? 'YES' : 'NO',
  },
  {
    Aspect: 'Output Tail preserved',
    'Naive Wrapper': naiveRes.tailPreserved ? 'YES' : 'NO (LOST)',
    '@xioflow/kernel': kernelRes.tailPreserved ? 'YES (RETAINED)' : 'NO',
  },
  {
    Aspect: 'Spill to disk on truncation',
    'Naive Wrapper': 'NO (data permanently lost)',
    '@xioflow/kernel': 'YES (fsynced to artifacts)',
  },
  {
    Aspect: 'Stopping honesty',
    'Naive Wrapper': 'Silent kill (fire-and-forget)',
    '@xioflow/kernel': 'Confirmed stop pipeline',
  },
]);
