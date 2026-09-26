import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadPath = path.join(__dirname, 'payload.mjs');

export function runNaive(timeoutMs = 800) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutBuffer = '';
    const child = spawn(process.execPath, [payloadPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      // Naive truncation: simple string concatenation capped at 4KB (completely cuts off tail)
      if (stdoutBuffer.length < 4096) {
        stdoutBuffer += chunk.toString();
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Naive stop: only kills direct child PID, does not terminate process group
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tailPreserved = stdoutBuffer.includes('=== TAIL OF OUTPUT ===');
      resolve({
        wrapper: 'naive',
        durationMs: Date.now() - startTime,
        exitCode: code,
        signal,
        timedOut,
        stdoutLength: stdoutBuffer.length,
        headPreserved: stdoutBuffer.includes('=== HEAD OF OUTPUT ==='),
        tailPreserved,
        pid: child.pid,
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runNaive();
  console.log(JSON.stringify(result, null, 2));
}
