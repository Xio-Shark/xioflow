#!/usr/bin/env node
/**
 * 可重复的 XIO-ISA v1 本地基准。
 *
 * 该脚本只测公开 ISA plan/pipeline 边界，不把宿主网络、模型或真实外部副作用
 * 混入样本。每个场景都报告 p50/p95/p99、异常失败率和状态计数；工作区/输出
 * fixture 在计时之外创建。冷启动场景通过新 Node 进程测量，热路径在当前进程重复。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  execute,
  executePipeline,
  PipelineDomainCoordinator,
} from '../dist/isa/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'isa-benchmark.mjs');
const ITERATIONS = Number(process.env.XIOFLOW_BENCH_ITERATIONS ?? 10);
const OUTPUT_PATH = process.env.XIOFLOW_BENCH_OUTPUT
  ? path.resolve(process.env.XIOFLOW_BENCH_OUTPUT)
  : path.resolve(HERE, '../audit/results/isa-benchmark.json');

assert(Number.isSafeInteger(ITERATIONS) && ITERATIONS >= 3 && ITERATIONS <= 100, 'XIOFLOW_BENCH_ITERATIONS must be 3..100');

const capability = {
  id: 'cap:benchmark', issuer: 'benchmark', policyVersion: '1', reason: 'repeatable local benchmark',
  scope: { opcodes: ['fs.read', 'fs.write', 'artifact.put'], workspaces: ['workspace:bench'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 10_000, memoryBytes: 2 ** 30, outputBytes: 2 ** 30, concurrentOps: 256, processes: 256 },
  expiresAt: '2099-01-01T00:00:00.000Z', epoch: 1,
};
const planOptions = {
  capability,
  availableCapabilities: ['filesystem.read', 'filesystem.write', 'artifact.put', 'artifact.get'],
  drivers: [
    { name: 'node.filesystem', opcodes: ['fs.read', 'fs.write'] },
    { name: 'artifact.store', opcodes: ['fs.read', 'fs.write', 'artifact.put'] },
  ],
};

function makeInstruction(id, op, args, dependsOn = [], opId) {
  return {
    id,
    op,
    args,
    dependsOn,
    precondition: [],
    output: `${id}.result`,
    ...(opId ? { opId: `op:${opId}` } : {}),
  };
}

function makeProgram(label, instructions, mode = 'pipeline') {
  return {
    isa: 'xio/1',
    requestId: `bench-request-${label}`,
    programId: `bench-program-${label}`,
    mode,
    capability: capability.id,
    workspace: 'workspace:bench',
    instructions,
  };
}

function makeReadProgram(label, count, root = 'small', mode = 'pipeline') {
  const instructions = Array.from({ length: count }, (_, index) => {
    const name = `${root}/file-${index}.txt`;
    return makeInstruction(`read-${index}`, 'fs.read', { workspace: 'workspace:bench', path: name }, [], `${label}.${index}`);
  });
  return makeProgram(label, instructions, mode);
}

function makeWriteProgram(label, count) {
  const instructions = Array.from({ length: count }, (_, index) =>
    makeInstruction(`write-${index}`, 'fs.write', {
      workspace: 'workspace:bench', path: `writes/file-${index}.txt`, content: 'artifact:benchmark',
    }, [], `${label}.${index}`));
  return makeProgram(label, instructions);
}

function makeExecutor(root, behavior = 'success') {
  return async ({ instruction }) => {
    if (behavior === 'failed') return { status: 'failed', error: { code: 'benchmark_failure', message: 'deterministic failure' } };
    if (behavior === 'indeterminate') return { status: 'indeterminate', error: { code: 'benchmark_indeterminate', message: 'deterministic unknown outcome' } };
    if (instruction.op === 'fs.read') {
      const file = path.join(root, instruction.args.path);
      const content = await fsp.readFile(file);
      return { status: 'succeeded', value: { bytes: content.byteLength } };
    }
    if (instruction.op === 'fs.write') {
      const file = path.join(root, instruction.args.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, instruction.args.content);
      return { status: 'succeeded', value: { bytes: Buffer.byteLength(instruction.args.content) } };
    }
    if (instruction.op === 'artifact.put') {
      return { status: 'succeeded', value: { bytes: Buffer.byteLength(instruction.args.content) } };
    }
    return { status: 'succeeded' };
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function nonSuccessRate(statuses, iterations) {
  const successCount = (statuses.succeeded ?? 0) + (statuses.admitted ?? 0);
  return Number(((iterations - successCount) / iterations).toFixed(4));
}

async function measure(name, iterations, fn, expectedStatus = 'succeeded', metadata = {}) {
  const samples = [];
  const statuses = {};
  let unexpected = 0;
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    try {
      const result = await fn(i);
      const elapsedMs = performance.now() - started;
      samples.push(elapsedMs);
      const status = result?.status ?? 'returned';
      statuses[status] = (statuses[status] ?? 0) + 1;
      if (status !== expectedStatus) unexpected++;
    } catch (error) {
      samples.push(performance.now() - started);
      statuses.exception = (statuses.exception ?? 0) + 1;
      unexpected++;
    }
  }
  return {
    name,
    iterations,
    expectedStatus,
    p50Ms: Number(percentile(samples, 50).toFixed(3)),
    p95Ms: Number(percentile(samples, 95).toFixed(3)),
    p99Ms: Number(percentile(samples, 99).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    failureRate: Number((unexpected / iterations).toFixed(4)),
    nonSuccessRate: nonSuccessRate(statuses, iterations),
    statuses,
    ...metadata,
  };
}

async function runChildColdPlan() {
  const started = performance.now();
  const result = await execute(makeReadProgram('cold-plan', 1, 'small', 'plan'), planOptions);
  process.stdout.write(JSON.stringify({ elapsedMs: performance.now() - started, status: result.status }));
}

async function main() {
  if (process.argv[2] === '--child-cold-plan') {
    await runChildColdPlan();
    return;
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-isa-bench-')));
  const smallFiles = 8;
  const bigFiles = 128;
  try {
    fs.mkdirSync(path.join(root, 'small'), { recursive: true });
    fs.mkdirSync(path.join(root, 'big'), { recursive: true });
    for (let i = 0; i < smallFiles; i++) fs.writeFileSync(path.join(root, 'small', `file-${i}.txt`), `small-${i}\n`);
    for (let i = 0; i < bigFiles; i++) fs.writeFileSync(path.join(root, 'big', `file-${i}.txt`), `big-${i}-${'x'.repeat(1024)}\n`);
    fs.mkdirSync(path.join(root, 'writes'), { recursive: true });
    const scenarios = [];

    const cold = [];
    for (let i = 0; i < Math.min(ITERATIONS, 10); i++) {
      const started = performance.now();
      const child = spawnSync(process.execPath, [SCRIPT, '--child-cold-plan'], { encoding: 'utf8', timeout: 30_000 });
      const elapsedMs = performance.now() - started;
      if (child.status !== 0) cold.push({ elapsedMs, status: 'exception' });
      else cold.push({ elapsedMs, status: JSON.parse(child.stdout).status });
    }
    const coldSamples = cold.map((item) => item.elapsedMs);
    scenarios.push({
      name: 'plan.cold-start', iterations: cold.length, expectedStatus: 'admitted',
      p50Ms: Number(percentile(coldSamples, 50).toFixed(3)), p95Ms: Number(percentile(coldSamples, 95).toFixed(3)), p99Ms: Number(percentile(coldSamples, 99).toFixed(3)),
      minMs: Number(Math.min(...coldSamples).toFixed(3)), maxMs: Number(Math.max(...coldSamples).toFixed(3)),
      failureRate: Number((cold.filter((item) => item.status !== 'admitted').length / cold.length).toFixed(4)),
      nonSuccessRate: Number((cold.filter((item) => item.status !== 'admitted').length / cold.length).toFixed(4)),
      statuses: Object.fromEntries(cold.reduce((map, item) => map.set(item.status, (map.get(item.status) ?? 0) + 1), new Map())),
      workspace: 'small', coldProcess: true,
    });

    const smallPlan = makeReadProgram('small-plan', smallFiles, 'small', 'plan');
    const bigPlan = makeReadProgram('big-plan', bigFiles, 'big', 'plan');
    scenarios.push(await measure('plan.hot-small', ITERATIONS, async () => execute(smallPlan, planOptions), 'admitted', { workspace: 'small', coldProcess: false }));
    scenarios.push(await measure('plan.hot-big', ITERATIONS, async () => execute(bigPlan, planOptions), 'admitted', { workspace: 'big', files: bigFiles, coldProcess: false }));

    const executor = makeExecutor(root);
    scenarios.push(await measure('pipeline.single-instruction', ITERATIONS, async (i) => {
      const program = makeReadProgram(`single-${i}`, 1, 'small');
      return executePipeline(program, executor, { ...planOptions, maxConcurrency: 1 });
    }, 'succeeded', { workspace: 'small', instructions: 1 }));
    scenarios.push(await measure('pipeline.multi-instruction', ITERATIONS, async (i) => {
      const program = makeWriteProgram(`multi-${i}`, 8);
      return executePipeline(program, executor, { ...planOptions, maxConcurrency: 4 });
    }, 'succeeded', { workspace: 'small', instructions: 8 }));
    scenarios.push(await measure('pipeline.big-workspace', ITERATIONS, async (i) => {
      const program = makeReadProgram(`big-work-${i}`, bigFiles, 'big');
      return executePipeline(program, executor, { ...planOptions, maxConcurrency: 8 });
    }, 'succeeded', { workspace: 'big', files: bigFiles, instructions: bigFiles }));

    const bigOutput = 'o'.repeat(1024 * 1024);
    scenarios.push(await measure('pipeline.big-output', Math.min(ITERATIONS, 5), async (i) => executePipeline(makeProgram(`output-${i}`, [
      makeInstruction('put', 'artifact.put', { content: bigOutput, mediaType: 'text/plain' }, [], `output.${i}`),
    ]), executor, { ...planOptions, maxConcurrency: 1 }), 'succeeded', { outputBytes: bigOutput.length }));

    scenarios.push(await measure('pipeline.concurrent-four', Math.min(ITERATIONS, 5), async (i) => {
      const runs = Array.from({ length: 4 }, (_, n) => executePipeline(makeReadProgram(`concurrent-${i}-${n}`, 8, 'small'), executor, {
        ...planOptions, maxConcurrency: 4,
      }));
      const results = await Promise.all(runs);
      return { status: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed' };
    }, 'succeeded', { concurrentPrograms: 4, instructionsPerProgram: 8 }));

    scenarios.push(await measure('pipeline.replay-join', Math.min(ITERATIONS, 5), async (i) => {
      const coordinator = new PipelineDomainCoordinator();
      let calls = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const program = makeWriteProgram(`replay-${i}`, 1);
      const replayExecutor = async (context) => { calls++; await gate; return executor(context); };
      const first = executePipeline(program, replayExecutor, { ...planOptions, domain: coordinator });
      await new Promise((resolve) => setImmediate(resolve));
      const second = executePipeline(program, replayExecutor, { ...planOptions, domain: coordinator });
      release();
      const [a, b] = await Promise.all([first, second]);
      return { status: a.status === 'succeeded' && b.status === 'succeeded' && calls === 1 ? 'succeeded' : 'failed' };
    }, 'succeeded', { replay: 'in_flight_join' }));

    scenarios.push(await measure('pipeline.failure', ITERATIONS, async (i) => executePipeline(makeReadProgram(`failure-${i}`, 1, 'small'), makeExecutor(root, 'failed'), planOptions), 'failed', { expected: 'failed' }));
    scenarios.push(await measure('pipeline.indeterminate', ITERATIONS, async (i) => executePipeline(makeReadProgram(`indeterminate-${i}`, 1, 'small'), makeExecutor(root, 'indeterminate'), planOptions), 'indeterminate', { expected: 'indeterminate' }));

    const report = {
      schemaVersion: 'xio/benchmark/1',
      recordedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpuCount: os.cpus().length,
      driver: 'ISA plan/pipeline pure adapter + filesystem benchmark executor',
      iterations: ITERATIONS,
      environment: {
        coldProcess: 'new node process per plan.cold-start sample',
        workspace: { smallFiles, bigFiles, bigFileBytes: 'approximately 1 KiB per file' },
        outputBytes: bigOutput.length,
        journal: false,
        wal: false,
      },
      scenarios,
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();
