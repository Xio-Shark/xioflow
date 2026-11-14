import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadPath = path.join(__dirname, 'payload.mjs');

let KernelMedium;
try {
  ({ KernelMedium } = await import('@xioflow/kernel'));
} catch {
  ({ KernelMedium } = await import('../../dist/index.js'));
}

export async function runKernel(timeoutMs = 800) {
  const domainPath = path.join(__dirname, '.xioflow-kernel');
  const medium = await KernelMedium.open(__dirname, { domainPath });
  try {
    const result = await medium.exec({
      execPath: process.execPath,
      args: [payloadPath],
      cwd: __dirname,
      timeoutMs,
      inlineMaxBytes: 4096,
    });

    const blobPath = result.stdoutBlob
      ? path.join(domainPath, 'blobs', `${result.stdoutBlob.sha256.slice(0, 24)}.blob`)
      : undefined;

    return {
      wrapper: 'xioflow-kernel',
      durationMs: result.durationMs,
      status: result.status,
      signal: result.signal,
      isTruncated: result.stdoutTruncated ?? false,
      stdoutLength: result.stdout?.length ?? 0,
      headPreserved: result.stdout ? result.stdout.includes('=== HEAD OF OUTPUT ===') : false,
      tailPreserved: result.stdout ? result.stdout.includes('=== TAIL OF OUTPUT ===') : false,
      outputRef: result.stdoutBlob?.blobRef,
      stdoutRef: blobPath ?? result.stdoutBlob?.blobRef,
      stdoutHash: result.stdoutBlob?.sha256,
    };
  } finally {
    await medium.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runKernel();
  console.log(JSON.stringify(result, null, 2));
}
