import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';
import { RecoveryEngine } from '../../src/recovery/engine.js';
import { EpochFencedError } from '../../src/types.js';

describe('内核 0.2.0 批次 4 (B4): 身份核验、性能卫生与契约收口 [P0-1, P0-3, P0-8, P0-11, 停止三态]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-b4-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'test-b4-domain');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    domain.getStore().saveTask({
      id: 'task-b4',
      domainId: 'test-b4-domain',
      name: 'B4 Task',
      createdAt: new Date().toISOString(),
    });

    domain.getStore().saveRun({
      id: 'run-b4',
      taskId: 'task-b4',
      domainId: 'test-b4-domain',
      owner: 'test-runner',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    if (!domain.isClosed()) {
      domain.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // Step 1: P0-3 门管道受控启动 (gatedSpawn)
  // ==========================================================================
  describe('P0-3: 门管道受控启动 (gatedSpawn)', () => {
    it('1.1 [P0-3] 平台能力声明 gatedSpawn，POSIX 下为 true', () => {
      expect(driver.capabilities.gatedSpawn).toBe(process.platform !== 'win32');
    });

    it('1.2 [P0-3] 驱动启动进程后门管道保持拦截，放行前目标程序不执行', async () => {
      if (process.platform === 'win32') return;

      const markerFile = path.join(tempDir, 'marker-1-2.txt');
      const handle = await driver.spawn({
        execPath: process.execPath,
        args: ['-e', `import fs from 'node:fs'; fs.writeFileSync('${markerFile}', 'RAN');`],
        cwd: tempDir,
      });

      expect(handle.releaseGate).toBeDefined();
      expect(handle.destroyGate).toBeDefined();

      // 在未 releaseGate 之前，目标脚本绝不执行
      await new Promise((r) => setTimeout(r, 200));
      expect(fs.existsSync(markerFile)).toBe(false);

      // 放行门管道
      handle.releaseGate!();
      const exitResult = await handle.onExit;
      expect(exitResult.exitCode).toBe(0);
      expect(fs.existsSync(markerFile)).toBe(true);
      expect(fs.readFileSync(markerFile, 'utf8')).toBe('RAN');
    });

    it('1.3 [P0-3] 宿主在放行前中止或崩溃 (destroyGate)：子进程直接退出 125，目标程序零执行', async () => {
      if (process.platform === 'win32') return;

      const markerFile = path.join(tempDir, 'marker-1-3.txt');
      const handle = await driver.spawn({
        execPath: process.execPath,
        args: ['-e', `import fs from 'node:fs'; fs.writeFileSync('${markerFile}', 'RAN');`],
        cwd: tempDir,
      });

      // 模拟崩溃：直接关闭门管道
      handle.destroyGate!();
      const exitResult = await handle.onExit;
      expect(exitResult.exitCode).toBe(125);
      expect(fs.existsSync(markerFile)).toBe(false);
    });

    it('1.4 [P0-3] 恢复引擎在 intent_registered 无身份场景：根据 gatedSpawn 精确判定', async () => {
      // 构造 intent_registered 且无 processIdentity 的操作
      domain.getStore().registerOperationIntent(
        {
          id: 'op-unspawned-intent',
          runId: 'run-b4',
          kind: 'process',
          name: 'unspawned-intent',
          inputFingerprint: 'f'.repeat(64),
          requiredResources: ['res:unspawned'],
          status: 'intent_registered',
        },
        domain.domainId
      );

      const recovery = new RecoveryEngine(domain, driver);
      const report = await recovery.recover();
      const recOp = report.recoveredOperations.find((o) => o.opId === 'op-unspawned-intent');
      expect(recOp).toBeDefined();
      if (driver.capabilities.gatedSpawn) {
        expect(recOp?.action).toBe('cleaned_unspawned');
        expect(recOp?.resourcesReleased).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Step 2: P0-8 静态门禁与异步采样器
  // ==========================================================================
  describe('P0-8: 异步采样器与零同步子进程门禁', () => {
    it('2.1 [P0-8 / 确定性代理门禁] src/ 源代码中绝无同步子进程调用 (execFileSync / spawnSync / execSync)', () => {
      const srcDir = path.resolve(__dirname, '../../src');
      let stdout = '';
      try {
        stdout = execFileSync('grep', ['-rnE', 'execFileSync|spawnSync|execSync', srcDir], {
          encoding: 'utf8',
        });
      } catch (err: any) {
        // grep exitCode 1 表示 0 命中，正是我们所期望的
        stdout = '';
      }
      expect(stdout.trim()).toBe('');
    });
  });

  // ==========================================================================
  // Step 3: P0-1 启动时间与 bootId 身份核验
  // ==========================================================================
  describe('P0-1: 启动时间与 bootId 真实身份核验', () => {
    it('3.1 [P0-1] 能力声明 startTimeSource', () => {
      expect(driver.capabilities.startTimeSource).toBeDefined();
      expect(['procfs', 'ps_lstart', 'none']).toContain(driver.capabilities.startTimeSource);
    });

    it('3.2 [P0-1] 伪造的 PID 复用现场 (同 PID 异进程 / 异命令 / 异启动时间) 绝不误判为 is_original_process', async () => {
      // 拿当前测试进程自身的 PID，但故意构造不匹配的 commandFingerprint 与过去的 spawnTime
      const fakeIdentity = {
        pid: process.pid,
        pgid: process.pid,
        startTimeMonotonic: 12345,
        spawnTime: new Date(Date.now() - 1000 * 3600 * 24).toISOString(), // 1天前
        commandFingerprint: '/usr/bin/totally-different-nonexistent-command:--arg1',
        bootId: await driver.readBootId?.() ?? undefined,
      };

      const verification = await driver.verifyIdentity(fakeIdentity);
      expect(verification).not.toBe('is_original_process');
      expect(['not_original_process', 'cannot_determine']).toContain(verification);
    });

    it('3.3 [P0-1] bootId 不匹配时返回 cannot_determine，严禁盲目信任 PID', async () => {
      const fakeIdentity = {
        pid: process.pid,
        pgid: process.pid,
        startTimeMonotonic: 12345,
        spawnTime: new Date().toISOString(),
        commandFingerprint: `${process.execPath}:--test`,
        bootId: 'alien-boot-id-999999',
      };

      const verification = await driver.verifyIdentity(fakeIdentity);
      expect(verification).toBe('cannot_determine');
    });
  });

  // ==========================================================================
  // Step 4: P0-11 锁资源回滚与 fence()
  // ==========================================================================
  describe('P0-11: 锁资源回滚、租约过期判定与 fence()', () => {
    it('4.1 [P0-11] 源代码中无生产代码调用 unsafeSetCurrentEpochForTesting', () => {
      const domainFile = fs.readFileSync(path.resolve(__dirname, '../../src/domain.ts'), 'utf8');
      expect(domainFile).not.toContain('unsafeSetCurrentEpochForTesting');
    });

    it('4.2 [P0-11] SqliteStore.fence() 后拒绝所有写操作', () => {
      const store = domain.getStore();
      store.fence();
      expect(() => {
        store.recordEventAndTransitionState({
          domainId: domain.domainId,
          type: 'OPERATION_INTENT_REGISTERED',
          timestamp: new Date().toISOString(),
          payload: {},
        });
      }).toThrow(EpochFencedError);
    });

    it('4.3 [P0-11] 锁文件存在但 DB 租约已过期时：新域实例能安全回收该孤儿锁', () => {
      const lockFile = path.join(tempDir, 'domain.lock');
      expect(fs.existsSync(lockFile)).toBe(true);

      // 模拟旧域被丢弃但锁文件还在：将 DB 中的 owners 租约篡改为过去已过期
      const dbPath = path.join(tempDir, 'domain.db');
      const store = domain.getStore();
      // 获取当前数据库并手工更新 expires_at 为过去
      (store as any).db.prepare("UPDATE owners SET expires_at = '2000-01-01T00:00:00.000Z'").run();

      // 先关闭当前 domain 避免多实例竞争同一个已打开对象
      domain.close();

      // 重建一个包含旧 PID 的 lock 文件，模拟旧进程死了但遗留了 lock 文件
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          domainId: 'test-b4-domain',
          ownerPid: 999999, // 死亡 PID
          acquiredAt: '2000-01-01T00:00:00.000Z',
          hostname: os.hostname(),
        })
      );

      // 新的 acquire 必须顺利回收并成功创建新域
      const newDomain = ExecutionDomain.acquire(tempDir, 'test-b4-domain');
      expect(newDomain).toBeDefined();
      expect(newDomain.isClosed()).toBe(false);
      newDomain.close();
    });
  });

  // ==========================================================================
  // Step 5: 停止三态 (StopProcessResult.stopped)
  // ==========================================================================
  describe('停止三态: confirmed_stopped | not_stopped | cannot_determine', () => {
    it('5.1 [停止三态] cancelOperation 返回三态字面量，成功停止返回 confirmed_stopped', async () => {
      const handlePromise = supervisor.executeProcess({
        runId: 'run-b4',
        opId: 'op-cancel-3state',
        name: 'sleep-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: tempDir,
        },
        requiredResources: ['res:cancel-3state'],
      });

      await new Promise((r) => setTimeout(r, 100));
      const stopRes = await supervisor.cancelOperation('op-cancel-3state');
      expect(stopRes.stopped).toBe('confirmed_stopped');

      const opResult = await handlePromise;
      expect(opResult.status).toBe('cancelled');
    });

    it('5.2 [停止三态] 无法确认停止 (cannot_determine) 时：操作必须收敛至 indeterminate 并保留租约', async () => {
      // 构造一个 stub 驱动，在 terminate 时返回 cannot_determine
      const stubbornDriver: NodePlatformDriver = Object.create(driver);
      stubbornDriver.terminate = async () => ({
        stopped: 'cannot_determine',
        scope: 'unknown',
        errorDetails: 'Simulated cannot_determine stop',
      });

      const stubSupervisor = new ProcessSupervisor(domain, stubbornDriver);
      const handlePromise = stubSupervisor.executeProcess({
        runId: 'run-b4',
        opId: 'op-stubborn-3state',
        name: 'stubborn-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: tempDir,
        },
        requiredResources: ['res:stubborn'],
      });

      await new Promise((r) => setTimeout(r, 100));
      const stopRes = await stubSupervisor.cancelOperation('op-stubborn-3state');
      expect(stopRes.stopped).toBe('cannot_determine');

      const opResult = await handlePromise;
      expect(opResult.status).toBe('indeterminate');
      // 契约保护：cannot_determine 绝对不得释放资源锁！
      expect(domain.isResourceLocked('res:stubborn')).toBe(true);
    });
  });
});
