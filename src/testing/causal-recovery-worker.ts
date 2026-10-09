import { runSample } from './causal-recovery-benchmark.js';

const { mode, fault, trial, config, publication, temp } = JSON.parse(process.argv[2]);
await runSample(mode, fault, trial, config, publication, { temp, stop: boundary => new Promise<never>((_resolve, reject) => {
  if (!process.send) throw new Error('Recovery worker requires IPC');
  // Keep the domain and SQLite connection open until the parent kills this process.
  const keepAlive = setInterval(() => {}, 1000);
  process.send(boundary, error => { if (error) { clearInterval(keepAlive); reject(error); } });
}) });
