import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { AgentRuntime, CgroupPlatformDriver, ExecutionDomain, NodePlatformDriver, ReaperPlatformDriver } from '../dist/index.js';
import { executePipeline } from '../dist/isa/index.js';
import { recordArtifactCreated, writeArtifact } from '../dist/artifacts.js';

const profile = process.env.XIOFLOW_SOAK_PROFILE ?? 'smoke';
const profileDurations = { smoke: 120, '24h': 86_400, '7d': 604_800 };
assert(Object.hasOwn(profileDurations, profile), 'XIOFLOW_SOAK_PROFILE must be smoke, 24h or 7d');
const durationSeconds = Number(process.env.XIOFLOW_SOAK_SECONDS ?? profileDurations[profile]);
assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 604800, 'XIOFLOW_SOAK_SECONDS must be 1..604800');
const outputPath = process.env.XIOFLOW_SOAK_OUTPUT ? path.resolve(process.env.XIOFLOW_SOAK_OUTPUT) : undefined;
const rootParent = process.env.XIOFLOW_SOAK_ROOT ? path.resolve(process.env.XIOFLOW_SOAK_ROOT) : os.tmpdir();
fs.mkdirSync(rootParent, { recursive: true });
const root = fs.mkdtempSync(path.join(rootParent, 'xf-agent-soak-'));
function optionalLimit(name) {
  if (process.env[name] === undefined) return undefined;
  const value = Number(process.env[name]);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}
const maxRssBytes = optionalLimit('XIOFLOW_SOAK_MAX_RSS_BYTES');
const maxDatabaseBytes = optionalLimit('XIOFLOW_SOAK_MAX_DATABASE_BYTES');
function databaseBytes() {
  return ['domain.db', 'domain.db-wal', 'domain.db-shm'].reduce((sum, name) => {
    const file = path.join(root, name);
    return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
}
function saveReport(file, report) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
const domain = ExecutionDomain.acquire(root, 'soak');
const selectedDriver = process.env.XIOFLOW_SOAK_DRIVER ?? (process.env.XIOFLOW_EXPECT_CGROUP === '1' ? 'cgroup' : 'node');
assert(['node', 'reaper', 'cgroup'].includes(selectedDriver), 'XIOFLOW_SOAK_DRIVER must be node, reaper or cgroup');
if (process.env.XIOFLOW_EXPECT_CGROUP === '1') assert.equal(selectedDriver, 'cgroup', 'XIOFLOW_EXPECT_CGROUP requires the cgroup driver');
domain.setDriver(selectedDriver === 'reaper' ? new ReaperPlatformDriver()
  : selectedDriver === 'cgroup' ? new CgroupPlatformDriver() : new NodePlatformDriver());
domain.setDomainBudget({ maxConcurrentOps: 1 });
const store = domain.getStore();
store.saveTask({ id: 'task', domainId: domain.domainId, name: 'soak', createdAt: new Date().toISOString() });
const delay = monitorEventLoopDelay({ resolution: 10 });
const isaRoot = path.join(root, 'isa');
fs.mkdirSync(isaRoot, { recursive: true });
const isaCapability = {
  id: 'cap:soak', issuer: 'soak', policyVersion: '1', reason: 'repeatable soak probe',
  scope: { opcodes: ['fs.write'], workspaces: ['workspace:soak'], paths: ['**'], secrets: [] },
  limits: { cpuMs: 10_000, memoryBytes: 2 ** 30, outputBytes: 2 ** 30, concurrentOps: 64, processes: 64 },
  expiresAt: '2099-01-01T00:00:00.000Z', epoch: 1,
};
const isaOptions = {
  capability: isaCapability,
  availableCapabilities: ['filesystem.write', 'artifact.get'],
  drivers: [{ name: 'node.filesystem', opcodes: ['fs.write', 'artifact.get'] }],
  maxConcurrency: 1,
};
const isaExecutor = async ({ instruction }) => {
  const file = path.join(isaRoot, instruction.args.path);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, instruction.args.content);
  return { status: 'succeeded', value: { bytes: Buffer.byteLength(instruction.args.content) } };
};
const getActiveHandleCount = typeof process._getActiveHandles === 'function'
  ? () => process._getActiveHandles().length
  : () => null;
delay.enable();
const start = performance.now();
const initialMemory = process.memoryUsage();
const initialActiveHandles = getActiveHandleCount();
let peakRss = initialMemory.rss;
let peakActiveHandles = initialActiveHandles ?? 0;
let cycles = 0;
let faults = 0;
let crashes = 0;
let rejectedCommands = 0;
let observedPids = 0;
let residualPids = 0;
const unreapedPids = new Set();
let leaseChecks = 0;
let leaseLeaks = 0;
let isaPipelineRuns = 0;
let isaPipelineFailures = 0;
let pruneRuns = 0;
let prunedArtifacts = 0;
const isaPipelineSamples = [];
const samples = [];
let entered;
let runtime;
const pending = new Set();
let completed = false;

function alive(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const observed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const state = observed.stdout?.trim();
  if (observed.status === 0 && state) {
    if (state.startsWith('Z')) { unreapedPids.add(pid); return false; }
    return true;
  }
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  throw new Error(`Cannot independently observe process ${pid}: ${observed.error?.message ?? observed.stderr ?? 'missing ps state'}`);
}

async function crashProbe(mode) {
  const crashRoot = fs.mkdtempSync(path.join(root, 'crash-'));
  const killed = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../tests/agents/crash-worker.mjs'), crashRoot, mode], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const reopened = ExecutionDomain.acquire(crashRoot, 'crash-agents');
  const agents = new AgentRuntime(reopened, { maxConcurrentAgents: 1, step: async () => { throw new Error('Unexpected replay'); } });
  try {
    assert(agents.list().every((agent) => agent.status === 'interrupted'));
    await agents.drain();
    assert.equal(agents.getRunUsage('run').stepsUsed, mode === 'scope-cancel' ? 1 : 2);
  } finally { await agents.shutdown(); reopened.close(); fs.rmSync(crashRoot, { recursive: true, force: true }); }
  crashes++;
}

async function runIsaPipelineProbe(runId) {
  const started = performance.now();
  const program = {
    isa: 'xio/1', requestId: `soak-request-${runId}`, programId: `soak-program-${runId}`,
    mode: 'pipeline', capability: isaCapability.id, workspace: 'workspace:soak',
    instructions: [{
      id: 'write', op: 'fs.write', opId: `op:soak-${runId}`,
      args: { workspace: 'workspace:soak', path: `isa/${runId}.txt`, content: 'artifact:soak' },
      dependsOn: [], precondition: [], output: 'write.result',
    }],
  };
  const result = await executePipeline(program, isaExecutor, isaOptions);
  isaPipelineRuns++;
  isaPipelineSamples.push(performance.now() - started);
  if (result.status !== 'succeeded') {
    isaPipelineFailures++;
    throw new Error(`ISA soak pipeline returned ${result.status}`);
  }
}

function runPruneProbe(runId) {
  const opId = `soak-prune-${runId}`;
  const file = path.join(domain.domainPath, 'artifacts', `${opId}.bin`);
  store.registerOperationIntent({
    id: opId, runId, kind: 'process', name: 'soak-prune', inputFingerprint: opId,
    requiredResources: [], status: 'active',
  }, domain.domainId);
  const artifact = writeArtifact(file, `prune-${runId}`);
  recordArtifactCreated(domain, opId, artifact, { ttlMs: 1 });
  store.recordOperationResult(opId, {
    kind: 'process', status: 'failed', exitCode: 1, signal: null, stdout: '', stderr: '',
    isTruncated: false, identityVerification: 'verified', durationMs: 0,
    completedAt: new Date().toISOString(),
  });
  const result = domain.pruneArtifacts({ nowMs: Date.now() + 10_000 });
  pruneRuns++;
  if (!result.deleted.includes(file)) throw new Error(`prune did not delete ${file}`);
  prunedArtifacts += result.deleted.length;
}

runtime = new AgentRuntime(domain, {
  maxConcurrentAgents: 2,
  runBudget: { maxSteps: 4, maxAgents: 3, maxPendingCommands: 4 },
  step: async (agent, execution) => {
    if (agent.parentId === null) return { status: 'completed', checkpoint: 1 };
    let output = '';
    const commands = Array.from({ length: 64 }, (_, index) => execution.executeProcess({
      opId: `${agent.id}-${index}`, name: 'soak-child', waitTimeoutMs: 10_000, timeoutMs: 10_000,
      requiredResources: ['exclusive'],
      command: {
        execPath: process.execPath, cwd: root,
        args: ['-e', index === 0 ? 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000)' : 'require("node:fs").writeFileSync("unexpected", "x")'],
      },
      onStreamChunk: (stream, chunk) => {
        if (stream !== 'stdout') return;
        output += chunk.toString('utf8');
        if (!output.includes('\n')) return;
        const pids = JSON.parse(output.trim());
        assert(pids.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
        observedPids += pids.length; entered(pids);
      },
    }));
    const results = await Promise.allSettled(commands);
    rejectedCommands += results.filter((result) => result.status === 'rejected').length;
    return { status: 'completed', checkpoint: 2 };
  },
});

try {
  while (performance.now() - start < durationSeconds * 1000) {
    const runId = `run-${cycles}`;
    store.saveRun({ id: runId, taskId: 'task', domainId: domain.domainId, owner: 'soak', status: 'running', startedAt: new Date().toISOString() });
    const parent = `${runId}-parent`; const child = `${runId}-child`;
    for (const id of [parent, child]) runtime.create({ id, runId, ...(id === child ? { parentId: parent } : {}), input: null, checkpoint: 0, maxSteps: 3 });
    await runIsaPipelineProbe(runId);
    runPruneProbe(runId);
    const started = new Promise((resolve) => { entered = resolve; });
    const draining = runtime.drain(); pending.add(draining);
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Soak process did not start in 15 seconds')), 15_000); });
    const pids = await Promise.race([started, timedOut]).finally(() => clearTimeout(timer));
    if (cycles % 5 === 0) {
      const record = store.recordJournalEvent.bind(store);
      store.recordJournalEvent = (event) => {
        if (event.payload.transition === 'interrupt_requested') throw new Error('injected ENOSPC at journal boundary');
        return record(event);
      };
      try {
        await assert.rejects(runtime.interrupt(parent), /injected ENOSPC/);
        assert.equal(runtime.get(child).reason, null);
        faults++;
      } finally { store.recordJournalEvent = record; }
    }
    await runtime.interrupt(parent);
    await draining; pending.delete(draining);
    for (const pid of pids) {
      const stillAlive = alive(pid);
      if (stillAlive) residualPids++;
      assert.equal(stillAlive, false, `Residual process ${pid}`);
    }
    assert.equal(fs.existsSync(path.join(root, 'unexpected')), false, 'Queued side effect escaped cancellation');
    leaseChecks++;
    if (domain.isResourceLocked('exclusive')) leaseLeaks++;
    assert.equal(domain.isResourceLocked('exclusive'), false);
    assert.equal(runtime.getRunUsage(runId).pendingCommands, 0);
    assert.equal(runtime.getRunUsage(runId).stepsUsed, 2);
    assert.equal(runtime.get(child).checkpoint, 0);
    assert.equal(runtime.get(parent).status, 'interrupted');
    store.reportRunFailed(runId, 'user_cancelled');
    cycles++;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (maxRssBytes !== undefined && peakRss > maxRssBytes) {
      throw new Error(`Soak RSS stop gate exceeded: ${peakRss} > ${maxRssBytes}`);
    }
    const activeHandles = getActiveHandleCount();
    if (activeHandles !== null) peakActiveHandles = Math.max(peakActiveHandles, activeHandles);
    if (cycles % 20 === 0) {
      await crashProbe(cycles % 40 === 0 ? 'scope-waiting' : 'scope-cancel');
      const diskBytes = databaseBytes();
      if (maxDatabaseBytes !== undefined && diskBytes > maxDatabaseBytes) {
        throw new Error(`Soak database stop gate exceeded: ${diskBytes} > ${maxDatabaseBytes}`);
      }
      const sample = { cycles, elapsedMs: Math.round(performance.now() - start), rss: process.memoryUsage().rss,
        journalEvents: store.getJournalEvents(domain.domainId).length, eventLoopP99Ms: delay.percentile(99) / 1e6,
        activeHandles, isaPipelineRuns, pruneRuns, leaseChecks, databaseBytes: diskBytes };
      samples.push(sample); console.log(JSON.stringify({ progress: sample }));
      saveReport(outputPath ? `${outputPath}.progress.json` : undefined, {
        status: 'RUNNING', profile, pid: process.pid, startedAt: new Date(Date.now() - (performance.now() - start)).toISOString(),
        domainPath: root, targetDurationSeconds: profileDurations[profile], completedTargetDuration: false,
        limits: { maxRssBytes, maxDatabaseBytes }, progress: sample,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await runtime.shutdown();
  const finalActiveHandles = getActiveHandleCount();
  const isaPipelineP99Ms = isaPipelineSamples.length > 0
    ? [...isaPipelineSamples].sort((a, b) => a - b)[Math.min(isaPipelineSamples.length - 1, Math.ceil(isaPipelineSamples.length * 0.99) - 1)]
    : null;
  const completedTargetDuration = performance.now() - start >= profileDurations[profile] * 1000;
  const report = { status: completedTargetDuration && unreapedPids.size === 0 ? 'PASS' : 'PASS_WITH_CONCERNS', profile,
    targetDurationSeconds: profileDurations[profile], durationSeconds, completedTargetDuration,
    node: process.version, platform: process.platform, execArgv: process.execArgv,
    driver: domain.getDriver()?.constructor.name ?? 'NodePlatformDriver', durationMs: Math.round(performance.now() - start),
    cycles, journalFaults: faults, hostCrashes: crashes, rejectedCommands, observedPids, residualPids,
    residualProcesses: residualPids, leaseChecks, leaseLeaks, prunedArtifacts, pruneRuns,
    unreapedPids: [...unreapedPids],
    isaPipelineRuns, isaPipelineFailures, isaPipelineP99Ms,
    initialMemory, finalMemory: process.memoryUsage(), peakRss, initialActiveHandles, finalActiveHandles, peakActiveHandles,
    journalEvents: store.getJournalEvents(domain.domainId).length,
    databaseBytes: databaseBytes(), limits: { maxRssBytes, maxDatabaseBytes },
    eventLoopP99Ms: delay.percentile(99) / 1e6, eventLoopMaxMs: delay.max / 1e6, samples };
  saveReport(outputPath, report);
  completed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  const failure = {
    status: 'FAIL', profile, completedTargetDuration: false,
    targetDurationSeconds: profileDurations[profile], durationMs: Math.round(performance.now() - start),
    node: process.version, platform: process.platform, execArgv: process.execArgv, domainPath: root,
    cycles, journalFaults: faults, hostCrashes: crashes, residualPids, unreapedPids: [...unreapedPids], leaseLeaks,
    isaPipelineRuns, isaPipelineFailures, peakRss, databaseBytes: databaseBytes(),
    limits: { maxRssBytes, maxDatabaseBytes },
    error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    samples,
  };
  saveReport(outputPath, failure);
  console.error(JSON.stringify(failure));
  throw error;
} finally {
  await runtime.shutdown(); await Promise.allSettled(pending); delay.disable(); domain.close();
  // Failed long runs retain the journal and artifacts needed to diagnose recovery.
  if (completed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Soak evidence retained at ${root}`);
}
