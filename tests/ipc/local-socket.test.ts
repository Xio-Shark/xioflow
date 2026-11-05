import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callLocalIpc,
  capabilityBoundNonce,
  createLocalIpcSessionKey,
  LocalIpcServer,
} from '../../src/ipc/local-socket.js';

describe('authenticated local IPC', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function socketPath(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-local-ipc-'));
    roots.push(root);
    return path.join(root, 'kernel.sock');
  }

  it('generates a random session key, binds nonce to capability epoch, and enforces owner-only socket mode', async () => {
    const socket = socketPath();
    const server = new LocalIpcServer({
      socketPath: socket,
      resolveCapability: (id) => id === 'cap:read' ? { epoch: 7 } : null,
      handler: async (method, params, context) => ({ method, params, context }),
    });
    const otherKey = createLocalIpcSessionKey();
    expect(server.getSessionKey()).not.toBe(otherKey);
    await server.start();
    expect(fs.lstatSync(socket).isSocket()).toBe(true);
    expect(fs.statSync(socket).mode & 0o077).toBe(0);

    const credentials = server.credentials('cap:read', 7);
    const result = await callLocalIpc({ socketPath: socket, auth: credentials }, {
      id: 1, method: 'status', params: { request: 'health' },
    }) as any;
    expect(result).toMatchObject({ method: 'status', params: { request: 'health' }, context: { capabilityId: 'cap:read', epoch: 7 } });
    expect(credentials.nonce).toBe(capabilityBoundNonce(server.getSessionKey(), 'cap:read', 7));
    await server.close();
    expect(fs.existsSync(socket)).toBe(false);
  });

  it('rejects invalid session keys, stale epoch nonces, and revoked capabilities before handler execution', async () => {
    const socket = socketPath();
    let calls = 0;
    const server = new LocalIpcServer({
      socketPath: socket,
      resolveCapability: (id) => id === 'cap:live' ? { epoch: 2 } : null,
      handler: () => { calls += 1; return { ok: true }; },
    });
    await server.start();
    const valid = server.credentials('cap:live', 2);
    await expect(callLocalIpc({ socketPath: socket, auth: { ...valid, sessionKey: createLocalIpcSessionKey() } }, { id: 1, method: 'ping' })).rejects.toThrow('invalid_session_key');
    await expect(callLocalIpc({ socketPath: socket, auth: { ...valid, nonce: capabilityBoundNonce(valid.sessionKey, 'cap:live', 1) } }, { id: 2, method: 'ping' })).rejects.toThrow('invalid_nonce');
    await expect(callLocalIpc({ socketPath: socket, auth: server.credentials('cap:gone', 2) }, { id: 3, method: 'ping' })).rejects.toThrow('capability_rejected');
    expect(calls).toBe(0);
    await server.close();
  });

  it('fails closed on an existing socket path instead of unlinking another owner path', async () => {
    const socket = socketPath();
    fs.writeFileSync(socket, 'sentinel');
    const server = new LocalIpcServer({
      socketPath: socket,
      resolveCapability: () => ({ epoch: 0 }),
      handler: () => null,
    });
    await expect(server.start()).rejects.toThrow('already exists');
    expect(fs.readFileSync(socket, 'utf8')).toBe('sentinel');
  });
});
