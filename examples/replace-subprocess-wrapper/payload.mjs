import { spawn } from 'node:child_process';

console.log('=== HEAD OF OUTPUT ===');
console.log('Main worker starting...');

// Spawn a background grandchild worker that leaks if only direct parent is killed
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
});

// Write 100KB of output so truncation is visible
for (let i = 0; i < 2000; i++) {
  console.log(`[Line ${i.toString().padStart(4, '0')}] intermediate process log stream buffer chunk payload`);
}

console.log('=== TAIL OF OUTPUT ===');

// Keep running until killed by timeout
setTimeout(() => {
  console.log('Completed naturally');
}, 10000);
