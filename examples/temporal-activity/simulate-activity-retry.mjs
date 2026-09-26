import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAppendActivity, effectsLogPath } from './activities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Clean up effects.log and .xioflow-kernel before test
if (fs.existsSync(effectsLogPath)) {
  fs.unlinkSync(effectsLogPath);
}
const kernelDir = path.join(__dirname, '.xioflow-kernel');
if (fs.existsSync(kernelDir)) {
  fs.rmSync(kernelDir, { recursive: true, force: true });
}

console.log('================================================================');
console.log('Temporal Activity Retry Idempotency Simulation');
console.log('================================================================\n');

const workflowId = 'wf-demo-8491';
const activityId = 'act-append-file-1';
const mockMessage = `event-${Date.now()}`;

console.log(`Simulating Temporal Workflow: ${workflowId}`);
console.log(`Activity ID: ${activityId}`);
console.log(`Target effect file: ${effectsLogPath}\n`);

// 1. Attempt 1 runs
console.log('--- Attempt 1: Worker executes activity for the first time ---');
const res1 = await executeAppendActivity(mockMessage);
console.log('Attempt 1 result:', res1);

let lines = fs.readFileSync(effectsLogPath, 'utf8').trim().split('\n');
console.log(`Lines in effects.log after Attempt 1: ${lines.length}`);

// 2. Simulated worker crash & retry
console.log('\n[SIMULATED WORKER CRASH]: Worker process terminates midway / network timeout.');
console.log('Temporal cluster schedules retry of the same activity with identical workflowId & activityId.\n');

// 3. Attempt 2 runs
console.log('--- Attempt 2: New worker runs retry of activity ---');
const res2 = await executeAppendActivity(mockMessage);
console.log('Attempt 2 result:', res2);

lines = fs.readFileSync(effectsLogPath, 'utf8').trim().split('\n');
console.log(`Lines in effects.log after Attempt 2: ${lines.length}`);

console.log('\n================================================================');
console.log('Verification:');
console.log('================================================================');
console.log(`Is Attempt 2 marked as replayed? ${res2.replayed === true}`);
console.log(`Is effect duplicate prevented (exactly 1 line)? ${lines.length === 1}`);

if (lines.length !== 1 || res2.replayed !== true) {
  console.error('FAIL: Idempotency was violated!');
  process.exit(1);
} else {
  console.log('SUCCESS: Side effect executed exactly once despite Temporal activity retry.');
}
