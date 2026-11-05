import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelMcpServer } from '../../src/mcp/server.js';
import { execute } from '../../src/isa/execute.js';
import type { Program, CapabilityRef } from '../../src/isa/types.js';
import type { IsaAdapterOptions } from '../../src/adapters/isa.js';
import { ExecutionDomain } from '../../src/domain.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { DEFAULT_CAPABILITY_LIMITS } from '../../src/capability/check.js';
import { executeIsaProgram } from '../../src/adapters/isa.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

async function within(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP cancellation did not reach the host binding')), 3000);
    })]);
  } finally { clearTimeout(timer!); }
}

describe('MCP ISA preview adapter', () => {
  let root: string;
  const domains: ExecutionDomain[] = [];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-mcp-isa-')); });
  afterEach(() => {
    for (const domain of domains.splice(0)) domain.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const program = (mode: Program['mode'] = 'plan'): Program => ({
    isa: 'xio/1', requestId: 'request', programId: 'program', mode,
    instructions: [{ id: 'health', op: 'control.health', args: {}, dependsOn: [], precondition: [], output: 'health' }],
  });

  async function rpc(method: string, params: unknown, isa?: IsaAdapterOptions) {
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    await new KernelMcpServer({ domainPath: path.join(root, 'unopened'), isaOnly: true, isa, input, output, log: () => {} }).serve();
    return JSON.parse(response.trim());
  }

  it('lists one execute tool and plans without invoking binding or creating domain state', async () => {
    expect((await rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['execute']);
    let bindings = 0;
    const response = await rpc('tools/call', { name: 'execute', arguments: { program: program() } }, {
      bindKernel: () => { bindings++; throw new Error('plan must not bind'); },
    });
    expect(response.result.structuredContent).toEqual(await execute(program(), { requireCapability: false }));
    expect(response.result.structuredContent).toMatchObject({ status: 'admitted', capability: 'not_requested' });
    expect(response.result.isError).toBe(false);
    expect(bindings).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('returns unsupported for unbound pipeline and rejects extra transport authority fields', async () => {
    const unbound = await rpc('tools/call', { name: 'execute', arguments: { program: program('pipeline') } });
    expect(unbound.result.structuredContent).toEqual(await execute(program('pipeline')));
    expect(unbound.result.isError).toBe(true);
    const extra = await rpc('tools/call', { name: 'execute', arguments: { program: program(), kernel: {} } });
    expect(extra.error.code).toBe(-32602);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('preserves SDK results for the same Program with an explicit persisted host binding', async () => {
    const domain = ExecutionDomain.acquire(path.join(root, 'owned'), 'mcp-isa');
    domains.push(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'host task', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'program', taskId: 'task', domainId: domain.domainId, owner: 'host', status: 'running', startedAt: new Date().toISOString() });
    const capability = domain.issueCapability({
      issuer: 'host', policyVersion: 'test/1', reason: 'explicit host binding', ttlMs: 60_000,
      scope: { opcodes: ['control.health'], workspaces: [], paths: [] }, limits: { ...DEFAULT_CAPABILITY_LIMITS, concurrentOps: 1 },
    });
    const input: Program = { ...program('pipeline'), capability: capability.id as CapabilityRef };
    const kernel = { domain, supervisor: new ProcessSupervisor(domain), workspaces: {} };
    const expected = await execute(input, { kernel });
    const response = await rpc('tools/call', { name: 'execute', arguments: { program: input } }, { bindKernel: () => kernel });
    expect(response.result.structuredContent).toEqual(expected);
    expect(response.result.isError).toBe(false);
    expect(store.getAllRuns(domain.domainId)).toHaveLength(1);
    expect(store.getAllOperations(domain.domainId)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'unopened'))).toBe(false);
  });

  function snapshotBinding() {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'before\n');
    const domain = ExecutionDomain.acquire(path.join(root, 'owned'), 'mcp-isa-cancel');
    domains.push(domain);
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'host task', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'program', taskId: 'task', domainId: domain.domainId, owner: 'host', status: 'running', startedAt: new Date().toISOString() });
    const capability = domain.issueCapability({
      issuer: 'host', policyVersion: 'test/1', reason: 'cancel test', ttlMs: 60_000,
      scope: { opcodes: ['workspace.snapshot', 'control.health'], workspaces: ['workspace:root'], paths: [workspace] },
      limits: { ...DEFAULT_CAPABILITY_LIMITS, concurrentOps: 2 },
    });
    const input: Program = {
      ...program('pipeline'), capability: capability.id as CapabilityRef, workspace: 'workspace:root',
      instructions: [{ id: 'snapshot', op: 'workspace.snapshot', args: { workspace: 'workspace:root', label: 'before' }, dependsOn: [], precondition: [], output: 'snapshot', opId: 'op:cancel-snapshot' }],
    };
    const kernel = { domain, supervisor: new ProcessSupervisor(domain), workspaces: { 'workspace:root': workspace } };
    return { input, kernel, store };
  }

  it('rejects a pre-aborted request before calling the host binding', async () => {
    const controller = new AbortController();
    controller.abort();
    const bindKernel = vi.fn();
    await expect(executeIsaProgram(program('pipeline'), { signal: controller.signal, bindKernel })).rejects.toMatchObject({ name: 'AbortError' });
    expect(bindKernel).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('cancels a request awaiting host binding without starting snapshot effects', async () => {
    const { input: programInput, kernel, store } = snapshotBinding();
    const bindingEntered = deferred();
    const releaseBinding = deferred();
    const cancellationReachedHost = deferred();
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const serving = new KernelMcpServer({
      domainPath: path.join(root, 'unopened'), isaOnly: true, input, output, log: () => {},
      isa: { bindKernel: async (_program, signal) => {
        expect(signal).toBeDefined();
        signal!.addEventListener('abort', cancellationReachedHost.resolve, { once: true });
        bindingEntered.resolve();
        await releaseBinding.promise;
        return kernel;
      } },
    }).serve();
    try {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'execute', arguments: { program: programInput } } })}\n`);
      await within(bindingEntered.promise);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } })}\n`);
      await within(cancellationReachedHost.promise);
    } finally {
      releaseBinding.resolve();
      input.end();
      await serving;
    }
    expect(JSON.parse(response.trim()).error.message).toContain('MCP ISA request cancelled');
    expect(store.getAllOperations(kernel.domain.domainId)).toEqual([]);
    expect(store.getJournalEvents(kernel.domain.domainId).filter((event) => event.type === 'ISA_INSTRUCTION_BOUND' || event.type === 'SNAPSHOT_CAPTURED')).toEqual([]);
  });

  it('waits for an already dispatched snapshot result and cancels later dispatch', async () => {
    const { input: programInput, kernel, store } = snapshotBinding();
    programInput.instructions.push({ id: 'health-after', op: 'control.health', args: {}, dependsOn: ['snapshot'], precondition: [], output: 'health-after' });
    const snapshotEntered = deferred();
    const releaseSnapshot = deferred();
    const cancellationReachedHost = deferred();
    const capture = kernel.supervisor.captureSnapshot.bind(kernel.supervisor);
    vi.spyOn(kernel.supervisor, 'captureSnapshot').mockImplementation(async (args) => {
      snapshotEntered.resolve();
      await releaseSnapshot.promise;
      return capture(args);
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let response = '';
    output.on('data', (chunk) => { response += chunk.toString(); });
    const serving = new KernelMcpServer({
      domainPath: path.join(root, 'unopened'), isaOnly: true, input, output, log: () => {},
      isa: { bindKernel: (_program, signal) => {
        signal!.addEventListener('abort', cancellationReachedHost.resolve, { once: true });
        return kernel;
      } },
    }).serve();
    try {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'execute', arguments: { program: programInput } } })}\n`);
      await within(snapshotEntered.promise);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } })}\n`);
      await within(cancellationReachedHost.promise);
      expect(response).toBe('');
    } finally {
      releaseSnapshot.resolve();
      input.end();
      await serving;
    }
    const result = JSON.parse(response.trim()).result.structuredContent;
    expect(result.status).toBe('partial');
    expect(result.results).toMatchObject([{ id: 'snapshot', status: 'succeeded' }, { id: 'health-after', status: 'cancelled' }]);
    expect(store.getJournalEvents(kernel.domain.domainId).filter((event) => event.type === 'SNAPSHOT_CAPTURED')).toHaveLength(1);
  });
});
