import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import type { PlatformDriver, ProcessIdentity } from '../../src/driver/types.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { TOOLS, type ToolContext } from '../../src/mcp/tools.js';

function tool(name: string) {
  const definition = TOOLS.find((entry) => entry.name === name);
  assert.ok(definition);
  return definition;
}

describe('MCP execution facts', () => {
  let root: string;
  let domain: ExecutionDomain;
  let node: NodePlatformDriver;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-mcp-facts-')));
    domain = ExecutionDomain.acquire(path.join(root, 'domain'), 'facts');
    node = new NodePlatformDriver();
    domain.getStore().saveTask({ id: 'task', domainId: domain.domainId, name: 'facts', createdAt: new Date().toISOString() });
    domain.getStore().saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
  });

  afterEach(() => {
    domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function context(driver: PlatformDriver = node, maxOutputChars = 8): ToolContext {
    return {
      domain,
      supervisor: new ProcessSupervisor(domain, driver),
      driverName: driver.name,
      sessionTaskId: 'session',
      maxOutputChars,
      bindOperation: () => {},
    };
  }

  function incompleteObserver(): PlatformDriver {
    return {
      name: 'missing-tree-observer',
      capabilities: node.capabilities,
      spawn: node.spawn.bind(node),
      terminate: node.terminate.bind(node),
      verifyIdentity: node.verifyIdentity.bind(node),
      sampleMetrics: async () => { throw new Error('injected unavailable metrics'); },
    };
  }

  it('preserves execution identity and tree uncertainty while marking MCP presentation truncation separately', async () => {
    const ctx = context(incompleteObserver());
    const stdout = 'abcdefghijklmnopqrstuv';
    const response = await tool('run_command').call(ctx, {
      command: process.execPath,
      cwd: root,
      opId: 'display-tail',
      args: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
    });
    expect(response).toMatchObject({
      kind: 'process', status: 'succeeded', treeSettlement: 'unverified',
      isTruncated: false, stdoutTruncated: false,
      stdout: stdout.slice(-8), stdoutBytes: stdout.length,
      stdoutHash: crypto.createHash('sha256').update(stdout).digest('hex'),
      mcpOutput: { maxOutputChars: 8, stdoutOmittedChars: stdout.length - 8, stderrOmittedChars: 0 },
      processIdentity: domain.getStore().getOperation('display-tail')?.processIdentity,
    });
    expect(response.identityVerification).toBeDefined();
    expect(response.completedAt).toBeDefined();
    const zeroDisplay = context(domain.getDriver()!, 0);
    const lookup = await tool('operation_status').call(zeroDisplay, { opId: 'display-tail' });
    expect(lookup.result).toMatchObject({ stdout: '', mcpOutput: { stdoutOmittedChars: stdout.length } });
  });

  it('preserves kernel truncation, complete-stream hashes, references and observation errors through operation_status', async () => {
    const ctx = context(incompleteObserver());
    const stdout = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const stderr = 'stderr-output-that-is-truncated';
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'input.txt'), 'read me');
    const result = await ctx.supervisor.executeProcess({
      runId: 'run', opId: 'recorded-facts', name: 'facts', maxOutputBytes: 16,
      command: { execPath: process.execPath, cwd: workspace, args: ['-e', `require('fs').readFileSync('input.txt'); setTimeout(() => { process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); }, 200)`] },
      resourceBudget: { enforcement: 'observe' },
      trackReads: { roots: [workspace], statCaches: 'ruled_out' },
      onStreamChunk: () => { throw new Error('injected callback failure'); },
    });
    assert.equal(result.kind, 'process');
    expect(result).toMatchObject({
      isTruncated: true, stdoutTruncated: true, stderrTruncated: true,
      stdoutBytes: stdout.length, stderrBytes: stderr.length,
      resourceSamplingError: 'injected unavailable metrics', streamCallbackError: 'injected callback failure',
    });
    const response = await tool('operation_status').call(ctx, { opId: 'recorded-facts' });
    expect(response.result).toMatchObject({
      ...JSON.parse(JSON.stringify(result)),
      stdout: result.stdout.slice(-8),
      stderr: result.stderr.slice(-8),
      mcpOutput: { maxOutputChars: 8, stdoutOmittedChars: result.stdout.length - 8, stderrOmittedChars: result.stderr.length - 8 },
    });
    expect(result.stdoutRef).toBeDefined();
    expect(fs.readFileSync(result.stdoutRef!, 'utf8')).toBe(stdout);
    expect(result.stdoutHash).toBe(crypto.createHash('sha256').update(stdout).digest('hex'));
    expect(result.stderrHash).toBe(crypto.createHash('sha256').update(stderr).digest('hex'));
    expect(result.readEvidence).toBeDefined();
    expect(response.result).not.toHaveProperty('peakMemoryBytes', 0);
    expect(response.result).not.toHaveProperty('cpuTimeMs', 0);
  });

  it('preserves spill failure instead of implying the output reference is complete', async () => {
    const ctx = context();
    const blocked = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocked, 'blocked');
    const result = await ctx.supervisor.executeProcess({
      runId: 'run', opId: 'spill-failure', name: 'spill', maxOutputBytes: 4, artifactsDir: path.join(blocked, 'artifacts'),
      command: { execPath: process.execPath, cwd: root, args: ['-e', 'process.stdout.write("large output")'] },
    });
    assert.equal(result.kind, 'process');
    expect(result.spillError).toBeDefined();
    const response = await tool('operation_status').call(ctx, { opId: 'spill-failure' });
    expect(response.result).toMatchObject({ isTruncated: true, spillError: result.spillError, stdoutSpillError: result.stdoutSpillError });
    expect(response.result).not.toHaveProperty('stdoutRef');
  });

  it('reports recovery without an exit observation explicitly', async () => {
    const ctx = context();
    domain.registerOperationIntent({
      id: 'unobserved', runId: 'run', kind: 'process', name: 'unobserved', inputFingerprint: 'fixture',
      requiredResources: [], status: 'intent_registered',
    });
    const handle = await node.spawn({ execPath: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] });
    domain.getStore().updateOperationStatus('unobserved', 'active', handle.identity);
    handle.stdout.resume();
    handle.stderr.resume();
    handle.releaseGate?.();
    await handle.onExit;
    const report = await new RecoveryEngine(domain, node).recover();
    expect(report.recoveredOperations).toHaveLength(1);
    const response = await tool('operation_status').call(ctx, { opId: 'unobserved' });
    expect(response.result).toMatchObject({ evidence: 'unobserved', terminationReason: 'exit_unobserved', exitCode: null });
  });

  it('does not manufacture output or exit facts for an indeterminate execution or its replay', async () => {
    class UncertainStopDriver extends NodePlatformDriver {
      override async terminate(identity: ProcessIdentity, graceMs = 0) {
        await super.terminate(identity, graceMs);
        return { stopped: 'cannot_determine' as const, scope: 'unknown' as const, errorDetails: 'injected unavailable stop observation' };
      }
    }
    const ctx = context(new UncertainStopDriver());
    const request = { command: process.execPath, cwd: root, args: ['-e', 'setTimeout(() => {}, 2000)'], timeoutMs: 100, opId: 'uncertain-stop', resources: ['workspace'] };
    const first = await tool('run_command').call(ctx, request);
    const replay = await tool('run_command').call(ctx, request);
    for (const response of [first, replay]) {
      expect(response).toMatchObject({ kind: 'indeterminate', status: 'indeterminate', terminationReason: 'timed_out' });
      expect(response.reason).toBeDefined();
      expect(response.recoveryGuidance).toBeDefined();
      expect(response).not.toHaveProperty('stdout');
      expect(response).not.toHaveProperty('stderr');
      expect(response).not.toHaveProperty('exitCode');
      expect(response).not.toHaveProperty('mcpOutput');
    }
    expect(replay.replayed).toBe(true);
    const db = new DatabaseSync(path.join(domain.domainPath, 'domain.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT status, termination_reason FROM runs WHERE task_id = ?').all('session')).toEqual([
        expect.objectContaining({ status: 'indeterminate', termination_reason: 'timed_out' }),
        expect.objectContaining({ status: 'indeterminate', termination_reason: 'timed_out' }),
      ]);
    } finally {
      db.close();
    }
    const status = await tool('operation_status').call(ctx, { opId: 'uncertain-stop' });
    expect(status.leasesHeld).toEqual(['workspace']);
  });
});
