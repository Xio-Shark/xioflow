import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadPath = path.join(__dirname, 'payload.mjs');

let quickRun;
try {
  ({ quickRun } = await import('@xioflow/kernel'));
} catch {
  ({ quickRun } = await import('../../dist/index.js'));
}

export async function runKernel(timeoutMs = 800) {
  const result = await quickRun(
    {
      execPath: process.execPath,
      args: [payloadPath],
      cwd: __dirname,
    },
    {
      timeoutMs,
      maxOutputBytes: 4096,
      domainPath: path.join(__dirname, '.xioflow-kernel'),
    }
  );

  return {
    wrapper: 'xioflow-kernel',
    durationMs: result.durationMs,
    status: result.status,
    signal: result.signal,
    isTruncated: result.isTruncated,
    stdoutLength: result.stdout?.length ?? 0,
    headPreserved: result.stdout ? result.stdout.includes('=== HEAD OF OUTPUT ===') : false,
    tailPreserved: result.stdout ? result.stdout.includes('=== TAIL OF OUTPUT ===') : false,
    outputRef: result.outputRef,
    stdoutRef: result.stdoutRef,
    stdoutHash: result.stdoutHash,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runKernel();
  console.log(JSON.stringify(result, null, 2));
}
