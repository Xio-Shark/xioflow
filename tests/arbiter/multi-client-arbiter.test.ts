import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  arbiterManifestPath,
  connectWorkspace,
  isProcessAlive,
  readArbiterManifest,
  WorkspaceArbiterClient,
} from '../../src/arbiter/index.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('Workspace-scoped on-demand UDS Micro-Arbiter', () => {
  let tempDir: string;
  let workspace: string;
  let domainPath: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-arbiter-')));
    workspace = path.join(tempDir, 'repo');
    domainPath = path.join(tempDir, 'domain');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(workspace, 'src/b.ts'), 'export const b = 2;\n');

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@xioflow.local'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Xio Test'], { cwd: workspace });
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspace });
  });

  afterEach(async () => {
    const manifest = readArbiterManifest(domainPath);
    if (manifest && isProcessAlive(manifest.pid)) {
      try {
        process.kill(manifest.pid, 'SIGTERM');
      } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns a single shared Micro-Arbiter under concurrent connectWorkspace calls, coordinates multi-client sessions, and auto-exits when idle', async () => {
    // 1. Thundering-herd bootstrap: 3 clients connect concurrently without DomainLockedError!
    const [clientA, clientB, clientC] = await Promise.all([
      connectWorkspace(workspace, { domainPath, sessionId: 'ide-mcp', idleTimeoutMs: 300 }),
      connectWorkspace(workspace, { domainPath, sessionId: 'cli-agent', idleTimeoutMs: 300 }),
      connectWorkspace(workspace, { domainPath, sessionId: 'sub-agent', idleTimeoutMs: 300 }),
    ]);

    assert(clientA instanceof WorkspaceArbiterClient);
    assert(clientB instanceof WorkspaceArbiterClient);
    assert(clientC instanceof WorkspaceArbiterClient);
    expect(clientA.manifest.pid).toBe(clientB.manifest.pid);
    expect(clientB.manifest.pid).toBe(clientC.manifest.pid);
    const arbiterPid = clientA.manifest.pid;
    expect(arbiterPid).not.toBe(process.pid);

    // Verify 0600 socket permission
    const sockStat = fs.lstatSync(clientA.manifest.socketPath);
    expect(sockStat.isSocket()).toBe(true);
    expect(sockStat.mode & 0o077).toBe(0);

    // 2. Cross-client SessionView dirty-read notification & conflict protection
    const readA = await clientA.blob({ op: 'slice', target: 'src/a.ts' });
    expect(readA.content).toContain('1|export const a = 1;');

    const writeB = await clientB.vfs_tx({
      mutations: [{ kind: 'write', path: 'src/a.ts', content: 'export const a = 42;\n' }],
    });
    expect(writeB.status).toBe('committed');

    // Client B does NOT get a false-positive staleRead from its own write
    const obsB = await clientB.observe();
    expect(obsB.staleReads).toHaveLength(0);

    // Client A immediately receives compactDiff staleRead and cannot blindly clobber src/a.ts!
    const execA = await clientA.exec({ cmd: 'echo check' });
    expect(execA.staleReads).toHaveLength(1);
    expect(execA.staleReads[0]?.path).toBe('src/a.ts');
    expect(execA.staleReads[0]?.compactDiff).toContain('+export const a = 42;');

    const blockedWriteA = await clientA.vfs_tx({
      mutations: [{ kind: 'write', path: 'src/a.ts', content: 'export const a = 999;\n' }],
    });
    expect(blockedWriteA.status).toBe('conflict');

    // 3. Cross-client shared background process ledger
    const port = await getFreePort();
    const srvCmd = `${JSON.stringify(process.execPath)} -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('OK')}).listen(${port},'127.0.0.1')"`;
    const bgStart = await clientA.exec({
      background: true,
      cmd: srvCmd,
      waitUntil: { kind: 'port_open', port },
    });
    expect(bgStart.status).toBe('running');
    expect(bgStart.waitOutcome?.status).toBe('satisfied');

    // Client C sees Client A's background server and stops it cleanly!
    const obsC = await clientC.observe();
    expect(obsC.activeProcesses.some((p) => p.opId === bgStart.opId)).toBe(true);
    const stopFromC = await clientC.exec({ stopOpId: bgStart.opId, graceMs: 300 });
    expect(stopFromC.status).toBe('stopped');

    // 4. Parallel isolated git-shadow branches from Client B and Client C on disjoint files both commit via OCC!
    const [txB, txC] = await Promise.all([
      clientB.vfs_tx({
        isolated: true,
        mutations: [{ kind: 'write', path: 'src/from-b.ts', content: 'export const fromB = true;\n' }],
        gateCmd: 'test -f src/from-b.ts',
      }),
      clientC.vfs_tx({
        isolated: true,
        mutations: [{ kind: 'write', path: 'src/from-c.ts', content: 'export const fromC = true;\n' }],
        gateCmd: 'test -f src/from-c.ts',
      }),
    ]);
    expect(txB.status).toBe('committed');
    expect(txC.status).toBe('committed');
    expect(fs.existsSync(path.join(workspace, 'src/from-b.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'src/from-c.ts'))).toBe(true);

    // 4b. Remote prune over live UDS Micro-Arbiter RPC
    const orphanFork = path.join(domainPath, 'forks', 'tx-arbiter-orphan');
    fs.mkdirSync(orphanFork, { recursive: true });
    fs.writeFileSync(path.join(orphanFork, 'stale.txt'), 'orphan', 'utf8');
    const pruneRes = await clientA.prune({ maxAgeMs: 0 });
    expect(pruneRes.deletedForks).toBe(1);
    expect(fs.existsSync(orphanFork)).toBe(false);

    // 5. Close all 3 clients -> Arbiter automatically shuts down after idleTimeoutMs (300ms)!
    await Promise.all([clientA.close(), clientB.close(), clientC.close()]);

    const waitDeadline = Date.now() + 4000;
    while (Date.now() < waitDeadline && isProcessAlive(arbiterPid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isProcessAlive(arbiterPid)).toBe(false);
    expect(fs.existsSync(arbiterManifestPath(domainPath))).toBe(false);
  });
});
