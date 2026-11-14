import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

export function summarizeMs(samples) {
  if (!samples || samples.length === 0) {
    return { n: 0, meanMs: null, stdMs: null, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  const variance = sorted.length > 1
    ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (sorted.length - 1)
    : 0;
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    n: sorted.length,
    meanMs: round(mean),
    stdMs: round(Math.sqrt(variance)),
    minMs: round(sorted[0]),
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

export function systemEnvironmentMetadata() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    nodeVersion: process.version,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGiB: Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100,
    collectedAt: new Date().toISOString(),
  };
}

export function initGitRepo(repoDir) {
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'bench@example.invalid'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Bench User'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
}

export function writeBenchmarkJson(outPath, payload) {
  if (!outPath) return;
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
