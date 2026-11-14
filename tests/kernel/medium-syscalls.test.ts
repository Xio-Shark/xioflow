import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelMedium } from '../../src/kernel/index.js';

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

describe('KernelMedium 6 orthogonal syscalls & SessionView causal protection', () => {
  let tempDir: string;
  let workspace: string;
  let domainPath: string;
  let medium: KernelMedium;

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-medium-')));
    workspace = path.join(tempDir, 'repo');
    domainPath = path.join(tempDir, 'domain');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'src/math.ts'),
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function mul(a: number, b: number): number {',
        '  return a * b;',
        '}',
        '',
      ].join('\n'),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@xioflow.local'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Xio Test'], { cwd: workspace });
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspace });

    medium = await KernelMedium.open(workspace, { domainPath });
  });

  afterEach(async () => {
    await medium.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. SessionView suppresses unrelated/comment edits via Early Cutoff and blocks real stale overwrites', async () => {
    // Session A reads src/math.ts scoped to symbol `add`
    const sliceRes = await medium.blob({
      sessionId: 'agent-a',
      op: 'slice',
      target: 'src/math.ts',
      symbols: ['add'],
    });
    expect(sliceRes.rev).toBeDefined();
    expect(sliceRes.content).toContain('1|export function add');

    // External writer modifies `mul` and adds a comment, leaving `add` semantically untouched!
    fs.writeFileSync(
      path.join(workspace, 'src/math.ts'),
      [
        '// Header comment added concurrently',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function mul(a: number, b: number): number {',
        '  return a * b * 1;',
        '}',
        '',
      ].join('\n'),
    );

    const obsAfterCutoff = await medium.observe({ sessionId: 'agent-a' });
    expect(obsAfterCutoff.staleReads).toHaveLength(0);
    expect(obsAfterCutoff.sessionStats.earlyCutoffHits).toBeGreaterThanOrEqual(1);

    // Now an external writer changes `add` itself -> must emit compactDiff staleRead and block blind patch!
    fs.writeFileSync(
      path.join(workspace, 'src/math.ts'),
      [
        'export function add(a: number, b: number): number {',
        '  return a + b + 100;',
        '}',
        '',
      ].join('\n'),
    );

    const execNotice = await medium.exec({
      sessionId: 'agent-a',
      cmd: 'echo hello',
    });
    expect(execNotice.staleReads).toHaveLength(1);
    expect(execNotice.staleReads[0]?.path).toBe('src/math.ts');
    expect(execNotice.staleReads[0]?.compactDiff).toContain('+  return a + b + 100;');

    // Attempting a blind write without re-reading is rejected with conflict
    const blockedTx = await medium.vfs_tx({
      sessionId: 'agent-a',
      mutations: [
        {
          kind: 'write',
          path: 'src/math.ts',
          content: 'export const broken = true;\n',
        },
      ],
    });
    expect(blockedTx.status).toBe('conflict');
    expect(blockedTx.conflicts).toHaveLength(1);
  });

  it('2. spills oversized exec output to a paged blobRef and supports grep/slice without context overflow', async () => {
    const res = await medium.exec({
      cmd: `${JSON.stringify(process.execPath)} -e "for(let i=1;i<=3000;i++){console.log(i===1742?'FATAL_ERR_CODE_991: boom':'info line '+i+' padding '.repeat(8))}"`,
      inlineMaxBytes: 4096,
    });
    expect(res.status).toBe('succeeded');
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stdoutBlob?.blobRef).toMatch(/^blob:/);
    expect(res.stdoutBlob!.totalLines).toBe(3000);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThan(12_000);

    const grepRes = await medium.blob({
      op: 'grep',
      target: res.stdoutBlob!.blobRef,
      pattern: 'FATAL_ERR_CODE_991',
      contextLines: 1,
    });
    expect(grepRes.matches).toHaveLength(1);
    expect(grepRes.matches![0]?.line).toBe(1742);
    expect(grepRes.matches![0]?.text).toContain('FATAL_ERR_CODE_991: boom');

    const pageRes = await medium.blob({
      op: 'slice',
      target: res.stdoutBlob!.blobRef,
      startLine: 1740,
      endLine: 1744,
    });
    expect(pageRes.content).toContain('1742|FATAL_ERR_CODE_991: boom');
  });

  it('3. manages background server readiness via exec+waitUntil and short-circuits immediately on crash', async () => {
    const port = await getFreePort();

    // Case A: crashing background server short-circuits `await` in milliseconds instead of hanging until 10s timeout!
    const crashStart = Date.now();
    const crashed = await medium.exec({
      background: true,
      timeoutMs: 10_000,
      cmd: `${JSON.stringify(process.execPath)} -e "console.error('EADDR_SYNTAX_CRASH'); process.exit(2);"`,
      waitUntil: { kind: 'port_open', port },
    });
    const crashElapsed = Date.now() - crashStart;
    expect(crashed.waitOutcome?.status).toBe('process_exited_early');
    expect(crashed.waitOutcome?.processExit?.exitCode).toBe(2);
    expect(crashed.waitOutcome?.processExit?.stderrPreview).toContain('EADDR_SYNTAX_CRASH');
    expect(crashElapsed).toBeLessThan(3000);

    // Case B: healthy HTTP server launches in background, waits until HTTP 200 ready, shows in observe(), and stops cleanly
    const serverScript = [
      "const http = require('http');",
      `const srv = http.createServer((req, res) => { res.writeHead(200); res.end('READY_OK'); });`,
      `setTimeout(() => srv.listen(${port}, '127.0.0.1'), 120);`,
    ].join(' ');
    const started = await medium.exec({
      background: true,
      timeoutMs: 8000,
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serverScript)}`,
      waitUntil: {
        kind: 'http_ready',
        url: `http://127.0.0.1:${port}/health`,
        expectedStatus: 200,
        bodyPattern: 'READY_OK',
      },
    });
    expect(started.status).toBe('running');
    expect(started.waitOutcome?.status).toBe('satisfied');
    expect(started.waitOutcome?.httpStatus).toBe(200);

    const obs = await medium.observe();
    expect(obs.activeProcesses.some((p) => p.opId === started.opId)).toBe(true);

    const stopped = await medium.exec({
      stopOpId: started.opId,
      graceMs: 500,
    });
    expect(stopped.status).toBe('stopped');
  });

  it('4. atomically rolls back vfs_tx mutations on gateCmd failure and commits isolated git-shadow branches on success', async () => {
    // Direct vfs_tx with failing gateCmd -> workspace stays byte-identical!
    const failedGate = await medium.vfs_tx({
      mutations: [
        {
          kind: 'patch',
          path: 'src/math.ts',
          oldText: 'return a + b;',
          newText: 'return a - b;',
        },
        {
          kind: 'write',
          path: 'src/unwanted.ts',
          content: 'syntax error !!!',
        },
      ],
      gateCmd: 'exit 1',
    });
    expect(failedGate.status).toBe('rolled_back');
    expect(fs.existsSync(path.join(workspace, 'src/unwanted.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'src/math.ts'), 'utf8')).toContain('return a + b;');

    // Isolated git-shadow branch vfs_tx: runs branchCmd + passing gateCmd and merges via OCC!
    const branchOk = await medium.vfs_tx({
      isolated: true,
      mutations: [
        {
          kind: 'patch',
          path: 'src/math.ts',
          oldText: 'return a + b;',
          newText: 'return a + b + 0;',
        },
      ],
      branchCmd: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('src/generated.txt', 'ok\\n')"`,
      gateCmd: 'test -f src/generated.txt',
    });
    expect(branchOk.status).toBe('committed');
    expect(branchOk.changedFiles).toEqual(['src/generated.txt', 'src/math.ts']);
    expect(fs.readFileSync(path.join(workspace, 'src/generated.txt'), 'utf8')).toBe('ok\n');
    expect(fs.readFileSync(path.join(workspace, 'src/math.ts'), 'utf8')).toContain('return a + b + 0;');
  });
});
