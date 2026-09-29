import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExecutionDomain, NodePlatformDriver, RecoveryEngine } from '@xioflow/kernel';
import { buildReaperHelper } from '../support/reaper-helper.js';
import { buildDist, repoRoot } from '../support/build-dist.js';

/**
 * 崩溃点矩阵：对每个场景先跑一遍记录经过的全部崩溃点，再在每个点上 SIGKILL 监督进程，
 * 然后在新进程里恢复并核对内核不变量。崩溃点覆盖存储层每笔事务的提交前 / 提交后，
 * 以及「进程已放行、结果未落盘」。
 */
const worker = path.join(import.meta.dirname, 'scenario-worker.mjs');
const distIndex = pathToFileURL(path.join(repoRoot, 'dist/index.js')).href;
const helperPath = buildReaperHelper();

// 矩阵针对的是构建产物（子进程里跑，与真实嵌入方式一致）
buildDist();

type Scenario = 'complete' | 'cancel';
type DriverKind = 'node' | 'reaper';

interface Workspace {
  root: string;
  domainPath: string;
  workDir: string;
}

function newWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-crash-'));
  const workDir = path.join(root, 'work');
  fs.mkdirSync(workDir);
  return { root, domainPath: path.join(root, 'domain'), workDir };
}

function runWorker(ws: Workspace, driver: DriverKind, scenario: Scenario, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [worker, distIndex, ws.domainPath, ws.workDir, driver, scenario, helperPath], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

/** 发现阶段：无故障跑一遍，收集经过的崩溃点（排除与时钟相关、次数不确定的 owner 心跳）。 */
function discoverCrashpoints(driver: DriverKind, scenario: Scenario): string[] {
  const ws = newWorkspace();
  const trace = path.join(ws.root, 'trace.log');
  try {
    const run = runWorker(ws, driver, scenario, { XIOFLOW_TEST_CRASHPOINT_TRACE: trace });
    if (run.status !== 0) throw new Error(`discovery run failed: ${run.stderr}`);
    return fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .filter((id) => id && !/OwnerLease/.test(id));
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

function effectCount(ws: Workspace): number {
  const file = path.join(ws.workDir, 'effects.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function checkInvariantsAfterRecovery(ws: Workspace): Promise<string> {
  const domain = ExecutionDomain.acquire(ws.domainPath, 'fault');
  try {
    const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
    const store = domain.getStore();

    // I1 恢复之后没有停在中间态的操作
    expect(store.getUnfinishedOperations(domain.domainId)).toEqual([]);

    const op = store.getOperation('op');
    const indeterminate = op?.result?.status === 'indeterminate';

    // I2 租约只能属于 indeterminate 操作（其余一律已释放）
    for (const lease of store.getPersistedResourceLeases(domain.domainId)) {
      expect(store.getOperation(lease.operationId)?.result?.status).toBe('indeterminate');
    }

    // I3 没有无人认领的存活进程：进程要么已消失，要么操作被隔离为 indeterminate
    const pidFile = path.join(ws.workDir, 'op.pid');
    if (fs.existsSync(pidFile) && !indeterminate) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      expect(await waitGone(pid, 3000)).toBe(true);
    }

    // I4 副作用至多一次；I5 声称成功必须有真实执行与零退出码
    expect(effectCount(ws)).toBeLessThanOrEqual(1);
    if (op?.result?.status === 'succeeded') {
      expect(effectCount(ws)).toBe(1);
      expect((op.result as any).exitCode).toBe(0);
    }

    // I7 恢复没观察到退出时不把「未知」写成「失败」：marked_dead 必带 exit_unobserved
    const recovered = report.recoveredOperations.find((r) => r.opId === 'op');
    if (recovered?.action === 'marked_dead') {
      expect((op?.result as any).terminationReason).toBe('exit_unobserved');
    }

    // I6 结果事实至多记录一次
    const recorded = store
      .getJournalEvents(domain.domainId)
      .filter((e) => e.type === 'OPERATION_RESULT_RECORDED' && e.operationId === 'op');
    expect(recorded.length).toBeLessThanOrEqual(1);

    const action = report.recoveredOperations.find((r) => r.opId === 'op')?.action ?? 'none';
    return `${action} -> ${op?.result?.status ?? 'unregistered'}`;
  } finally {
    domain.close();
  }
}

const matrix: Array<[DriverKind, Scenario]> = [
  ['node', 'complete'],
  ['node', 'cancel'],
  ['reaper', 'complete'],
  ['reaper', 'cancel'],
];

for (const [driver, scenario] of matrix) {
  const points = discoverCrashpoints(driver, scenario);

  describe(`crash matrix: ${driver} driver, ${scenario} scenario`, () => {
    it('discovers the protocol crashpoints', () => {
      expect(points.length).toBeGreaterThan(5);
      expect(points).toContain('supervisor:process-running#1');
    });

    it.each(points)('crash at %s: recovery restores every invariant and replay never re-executes', async (point) => {
      const ws = newWorkspace();
      try {
        const crashed = runWorker(ws, driver, scenario, { XIOFLOW_TEST_CRASHPOINT: point });
        expect(crashed.signal, crashed.stderr).toBe('SIGKILL');

        const outcome = await checkInvariantsAfterRecovery(ws);

        // 同一 opId 在新进程里重新提交：已登记的操作只重放，绝不重跑副作用
        const before = effectCount(ws);
        const replay = runWorker(ws, driver, scenario);
        if (replay.status === 0) {
          const res = JSON.parse(replay.stdout);
          if (before > 0 || res.replayed) expect(effectCount(ws)).toBe(before);
          if (res.replayed === false) expect(before).toBe(0);
        } else {
          // Run 已被恢复收尾为终态：内核拒绝在其上登记或重放（N3），同样不会重跑
          expect(replay.stderr).toMatch(/already finalized/);
          expect(effectCount(ws)).toBe(before);
        }
        expect(effectCount(ws)).toBeLessThanOrEqual(1);
        fs.appendFileSync(path.join(os.tmpdir(), 'xioflow-crash-matrix.log'), `${driver}\t${scenario}\t${point}\t${outcome}\n`);
      } finally {
        fs.rmSync(ws.root, { recursive: true, force: true });
      }
    });
  });
}
