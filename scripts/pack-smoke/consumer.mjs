/**
 * Embedder contract checks for @xioflow/kernel.
 *
 * This file only ever runs against an *installed* package (see scripts/verify-package.mjs),
 * never against repository sources. Every check maps to a guarantee an embedding agent
 * runtime depends on.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DomainLockedError,
  ExecutionDomain,
  NodePlatformDriver,
  ProcessSupervisor,
  RecoveryEngine,
} from '@xioflow/kernel';

let checks = 0;
const ok = (name, detail) => {
  checks += 1;
  console.log(`  [ok] ${name}${detail ? `: ${detail}` : ''}`);
};

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-embed-'));
const domainPath = path.join(workspace, '.xioflow');
console.log(`  workspace: ${workspace}`);

const domain = ExecutionDomain.acquire(domainPath, 'embed-check');
const driver = new NodePlatformDriver();
const supervisor = new ProcessSupervisor(domain, driver);
const store = domain.getStore();

const ensureRun = (runId) => {
  const taskId = `task-${runId}`;
  store.saveTask({
    id: taskId,
    domainId: domain.domainId,
    name: runId,
    createdAt: new Date().toISOString(),
  });
  store.saveRun({
    id: runId,
    taskId,
    domainId: domain.domainId,
    owner: 'embed-check',
    status: 'running',
    startedAt: new Date().toISOString(),
  });
};

let active = domain;
let failed = false;

try {
  // 0. Boundary failure is actionable: operations cannot attach to an unknown run.
  assert.throws(
    () =>
      domain.registerOperationIntent({
        id: 'op-orphan',
        runId: 'run-missing',
        kind: 'process',
        name: 'orphan',
        inputFingerprint: 'fp-orphan',
        requiredResources: ['embed:orphan'],
        status: 'pending',
      }),
    /is not registered/
  );
  assert.equal(domain.isResourceLocked('embed:orphan'), false);
  ok('unregistered run fails with an actionable error', 'no raw SQLite constraint leak');

  // 1. No fake running: a spawn that cannot start is terminal, never `running`.
  ensureRun('run-bad');
  const bad = await supervisor.executeProcess({
    runId: 'run-bad',
    opId: 'op-bad',
    name: 'missing-binary',
    command: { execPath: '/nonexistent-xioflow-binary', args: [], cwd: workspace },
    requiredResources: ['embed:bad'],
  });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.exitCode, 127);
  assert.match(bad.spawnFailure ?? '', /nonexistent-xioflow-binary/);
  assert.equal(store.getOperation('op-bad').status, 'done');
  assert.equal(domain.isResourceLocked('embed:bad'), false);
  ok('no fake running', `status=${bad.status} exitCode=${bad.exitCode}`);

  // 2. Bounded drain: memory is capped, full stream is spilled and hashed.
  ensureRun('run-big');
  const maxBytes = 256 * 1024;
  const totalBytes = 4_000_000;
  const big = await supervisor.executeProcess({
    runId: 'run-big',
    opId: 'op-big',
    name: 'large-output',
    command: {
      execPath: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${totalBytes}))`],
      cwd: workspace,
    },
    requiredResources: ['embed:big'],
    maxOutputBytes: maxBytes,
  });
  assert.equal(big.status, 'succeeded');
  assert.equal(big.isTruncated, true);
  assert.equal(big.stdoutTruncated, true);
  assert.equal(big.stderrTruncated, false);
  assert.equal(big.stdoutBytes, totalBytes);
  assert.match(big.stdoutHash, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.byteLength(big.stdout, 'utf8'), maxBytes);
  assert.ok(big.outputRef && fs.existsSync(big.outputRef), 'spill file must exist');
  const spilled = fs.readFileSync(big.outputRef);
  assert.equal(spilled.length, totalBytes);
  assert.equal(crypto.createHash('sha256').update(spilled).digest('hex'), big.outputHash);
  ok('bounded drain + spill + hash', `memory=${Buffer.byteLength(big.stdout)}B spill=${spilled.length}B`);

  // 2b. Environment policy is explicit: a whitelist means exactly that, and
  //     inheritEnv:false yields an empty environment.
  ensureRun('run-env');
  const envProbe = await supervisor.executeProcess({
    runId: 'run-env',
    opId: 'op-env',
    name: 'env-exactness',
    command: {
      execPath: process.execPath,
      args: [
        '-e',
        "process.stdout.write((process.env.XIO_PROBE ?? 'unset') + '|' + (process.env.PATH ? 'has-path' : 'no-path'))",
      ],
      cwd: workspace,
      envWhiteList: { XIO_PROBE: 'visible' },
    },
    requiredResources: ['embed:env'],
  });
  assert.equal(envProbe.stdout, 'visible|no-path');

  const emptyEnv = await supervisor.executeProcess({
    runId: 'run-env',
    opId: 'op-env-empty',
    name: 'env-empty',
    command: {
      execPath: process.execPath,
      args: ['-e', "process.stdout.write(process.env.XIO_PROBE ?? 'unset')"],
      cwd: workspace,
      inheritEnv: false,
    },
    requiredResources: ['embed:env'],
  });
  assert.equal(emptyEnv.stdout, 'unset');
  ok('env policy is explicit', 'whitelist exact, inheritEnv:false empty');

  // 2c. One-shot stdin: the payload is written and the pipe is closed, so a
  //     child that reads until EOF still produces its output.
  ensureRun('run-stdin');
  const stdinEcho = await supervisor.executeProcess({
    runId: 'run-stdin',
    opId: 'op-stdin',
    name: 'stdin-echo',
    command: {
      execPath: process.execPath,
      args: [
        '-e',
        "const c=[];process.stdin.on('data',(b)=>c.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(c).toString('utf8')))",
      ],
      cwd: workspace,
      stdin: 'embedder stdin payload',
    },
    requiredResources: ['embed:stdin'],
  });
  assert.equal(stdinEcho.status, 'succeeded');
  assert.equal(stdinEcho.stdout, 'embedder stdin payload');
  assert.equal(domain.isResourceLocked('embed:stdin'), false);
  ok('one-shot stdin pipe', 'payload written, pipe closed after write');

  // 2d. A descendant that outlives the root and keeps the pipes open must be
  //     reaped so the operation reports the root's real exit facts.
  ensureRun('run-residual');
  const residualScript = [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000)'], { stdio: ['ignore','inherit','inherit'] });",
    "process.stdout.write(String(child.pid)+'\\n');",
    'setTimeout(() => process.exit(0), 30);',
  ].join('');
  const residualStarted = Date.now();
  const residual = await supervisor.executeProcess({
    runId: 'run-residual',
    opId: 'op-residual',
    name: 'residual-descendant',
    command: { execPath: process.execPath, args: ['-e', residualScript], cwd: workspace },
    requiredResources: ['embed:residual'],
    timeoutMs: 10_000,
    drainTimeoutMs: 300,
  });
  assert.equal(residual.status, 'succeeded');
  assert.equal(residual.exitCode, 0);
  assert.equal(residual.residualProcessesReaped, true);
  assert.ok(Date.now() - residualStarted < 5_000, 'residual descendant must not block until timeout');
  const residualPid = Number.parseInt(residual.stdout.trim(), 10);
  assert.ok(Number.isInteger(residualPid) && residualPid > 0, 'descendant pid must be captured');
  assert.throws(() => process.kill(residualPid, 0), 'residual descendant must be dead');
  ok('residual descendant reaped', `descendant=${residualPid} reaped=${residual.residualProcessesReaped}`);

  // 3. Stop pipeline: lease is released only after the stop is confirmed.
  ensureRun('run-cancel');
  const pending = supervisor.executeProcess({
    runId: 'run-cancel',
    opId: 'op-cancel',
    name: 'long-running',
    command: { execPath: '/bin/sh', args: ['-c', 'sleep 30'], cwd: workspace },
    requiredResources: ['embed:cancel'],
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stop = await supervisor.cancelOperation('op-cancel', 1500);
  const cancelled = await pending;
  assert.equal(stop.stopped, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(domain.isResourceLocked('embed:cancel'), false);
  ok('confirmed stop releases lease', `scope=${stop.scope} status=${cancelled.status}`);

  // 4. Recovery: intent persisted before spawn is cleaned up safely.
  ensureRun('run-crash');
  domain.registerOperationIntent({
    id: 'op-crash',
    runId: 'run-crash',
    kind: 'process',
    name: 'crash-before-spawn',
    inputFingerprint: 'fp-crash',
    requiredResources: ['embed:crash'],
    status: 'pending',
  });
  const recovery = await new RecoveryEngine(domain, driver).recover();
  const cleaned = recovery.recoveredOperations.find((entry) => entry.opId === 'op-crash');
  assert.equal(cleaned?.action, 'cleaned_unspawned');
  assert.equal(cleaned?.resourcesReleased, true);
  assert.equal(domain.isResourceLocked('embed:crash'), false);
  ok('recovery cleans unspawned intent', `action=${cleaned.action}`);

  // 5. No blind replay: an unverifiable process identity stays isolated and locked.
  ensureRun('run-unknown');
  domain.registerOperationIntent({
    id: 'op-unknown',
    runId: 'run-unknown',
    kind: 'process',
    name: 'unknown-side-effect',
    inputFingerprint: 'fp-unknown',
    requiredResources: ['embed:unknown'],
    status: 'pending',
  });
  store.updateOperationStatus('op-unknown', 'active', {
    pid: process.pid,
    spawnTime: new Date().toISOString(),
  });
  const secondRecovery = await new RecoveryEngine(domain, driver).recover();
  const isolated = secondRecovery.recoveredOperations.find((entry) => entry.opId === 'op-unknown');
  assert.equal(isolated?.action, 'isolated_indeterminate');
  assert.equal(isolated?.resourcesReleased, false);
  assert.equal(domain.isResourceLocked('embed:unknown'), true);
  const isolatedOp = store.getOperation('op-unknown');
  assert.equal(isolatedOp.status, 'done');
  assert.equal(isolatedOp.result.kind, 'indeterminate');
  ok('unverifiable side effect is isolated', 'lease retained, no auto retry');

  // 6. Single owner per domain, and committed facts survive a close/reopen cycle.
  assert.throws(
    () => ExecutionDomain.acquire(domainPath, 'second-owner'),
    (err) => err instanceof DomainLockedError
  );
  domain.close();
  const reopened = ExecutionDomain.acquire(domainPath, 'second-owner');
  active = reopened;
  const persisted = reopened.getStore().getOperation('op-big');
  assert.equal(persisted.result.isTruncated, true);
  ok('single owner + durable facts', 'relock succeeded after close');
} catch (err) {
  failed = true;
  throw err;
} finally {
  if (active && !active.isClosed()) {
    active.close();
  }
  if (failed) {
    console.log(`  workspace kept for inspection: ${workspace}`);
  } else {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

console.log(`  ${checks} embedder contract checks passed`);
