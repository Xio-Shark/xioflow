import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { SecretResolutionError } from '../../src/driver/secret-env.js';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { journalToOtlpTraces } from '../../src/otel/otlp.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function run(driver: NodePlatformDriver, command: Parameters<NodePlatformDriver['spawn']>[0], capabilityId?: string) {
  const handle = await driver.spawn(command, { capabilityId });
  handle.releaseGate?.();
  const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.onExit]);
  return { stdout, stderr, exit };
}

describe('R-08 SecretRef and environment policy', () => {
  it('does not inherit process.env unless inheritEnv is explicitly true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-secret-env-'));
    roots.push(root);
    const hostKey = 'XIOFLOW_R08_HOST_ONLY';
    const previous = process.env[hostKey];
    process.env[hostKey] = 'host-only-value';
    try {
      const driver = new NodePlatformDriver();
      const script = `process.stdout.write(process.env[${JSON.stringify(hostKey)}] ?? 'absent')`;
      const isolated = await run(driver, { execPath: process.execPath, args: ['-e', script], cwd: root });
      expect(isolated.stdout).toBe('absent');

      const inherited = await run(driver, {
        execPath: process.execPath,
        args: ['-e', script],
        cwd: root,
        inheritEnv: true,
      });
      expect(inherited.stdout).toBe('host-only-value');
    } finally {
      if (previous === undefined) delete process.env[hostKey];
      else process.env[hostKey] = previous;
    }
  });

  it('resolves SecretRef only in the driver and redacts values from both output streams', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-secret-resolver-'));
    roots.push(root);
    const secret = 'driver-only-secret-7f2a';
    const resolver = vi.fn((ref: `secret:${string}`, context: { capabilityId?: string }) => {
      expect(ref).toBe('secret:fixture');
      expect(context).toEqual({ capabilityId: 'cap:r08' });
      return secret;
    });
    const driver = new NodePlatformDriver({ resolveSecret: resolver });
    const resolved = await run(driver, {
      execPath: process.execPath,
      args: ['-e', `process.stdout.write(process.env.XIOFLOW_SECRET === ${JSON.stringify(secret)} ? 'resolved' : 'missing')`],
      cwd: root,
      secretEnv: { XIOFLOW_SECRET: 'secret:fixture' },
    }, 'cap:r08');
    expect(resolved.stdout).toBe('resolved');
    expect(resolved.stderr).toBe('');
    expect(resolver).toHaveBeenCalledTimes(1);

    const echoed = await run(driver, {
      execPath: process.execPath,
      args: [
        '-e',
        'const s=process.env.XIOFLOW_SECRET; process.stdout.write(s.slice(0, 8)); setTimeout(() => process.stdout.write(s.slice(8)), 0);',
      ],
      cwd: root,
      secretEnv: { XIOFLOW_SECRET: 'secret:fixture' },
    }, 'cap:r08');
    expect(echoed.stdout).toBe('[REDACTED]');
    expect(echoed.stderr).toBe('');
    expect(echoed.stdout).not.toContain(secret);
    expect(echoed.stderr).not.toContain(secret);

    const echoedError = await run(driver, {
      execPath: process.execPath,
      args: ['-e', 'process.stderr.write(process.env.XIOFLOW_SECRET)'],
      cwd: root,
      secretEnv: { XIOFLOW_SECRET: 'secret:fixture' },
    }, 'cap:r08');
    expect(echoedError.stderr).toBe('[REDACTED]');
  });

  it('fails closed when a driver has no resolver and never copies resolver errors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-secret-fail-'));
    roots.push(root);
    const command = {
      execPath: process.execPath,
      args: ['-e', '0'],
      cwd: root,
      secretEnv: { XIOFLOW_SECRET: 'secret:missing' as const },
    };
    await expect(new NodePlatformDriver().spawn(command)).rejects.toBeInstanceOf(SecretResolutionError);

    const secret = 'resolver-error-secret';
    const driver = new NodePlatformDriver({ resolveSecret: () => { throw new Error(secret); } });
    await expect(driver.spawn(command)).rejects.toThrow(/could not be resolved/);
    await expect(driver.spawn(command)).rejects.not.toThrow(secret);
  });

  it('keeps resolved values out of operation results, journal events and OTLP spans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-secret-journal-'));
    roots.push(root);
    const domain = ExecutionDomain.acquire(root, 'r08-journal');
    const secret = 'journal-secret-2e91';
    try {
      const store = domain.getStore();
      store.saveTask({ id: 'task', domainId: domain.domainId, name: 'task', createdAt: new Date().toISOString() });
      store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'test', status: 'running', startedAt: new Date().toISOString() });
      const driver = new NodePlatformDriver({ resolveSecret: () => secret });
      const supervisor = new ProcessSupervisor(domain, driver);
      const capability = domain.issueCapability({
        scope: { opcodes: ['proc.spawn'], paths: [root], secrets: ['secret:fixture'] },
        issuer: 'test', policyVersion: 'r08', reason: 'secret test',
        limits: { cpuMs: 10_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 * 1024, concurrentOps: 2, processes: 2 },
      });
      const result = await supervisor.executeProcess({
        runId: 'run', opId: 'op-secret', name: 'secret output', capabilityId: capability.id,
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.XIOFLOW_SECRET)'],
          cwd: root,
          secretEnv: { XIOFLOW_SECRET: 'secret:fixture' },
        },
      });
      if (result.kind !== 'process') throw new Error('Expected a process result');
      expect(result.stdout).toBe('[REDACTED]');
      const events = store.getJournalEvents(domain.domainId);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(store.getOperation('op-secret'))).not.toContain(secret);
      const traces = journalToOtlpTraces({
        domainId: domain.domainId,
        events,
        lookupOperation: (opId) => store.getOperation(opId),
      });
      expect(JSON.stringify(traces.payload)).not.toContain(secret);
    } finally {
      domain.close();
    }
  });
});
