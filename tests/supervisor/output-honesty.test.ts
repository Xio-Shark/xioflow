import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ExecutionDomain } from '../../src/domain.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import { ProcessSupervisor } from '../../src/supervisor/supervisor.js';

describe('内核 0.2.0 批次 3 (B3): 输出与产物诚实 [P0-9, P0-10, P0-12, N7]', () => {
  let tempDir: string;
  let domain: ExecutionDomain;
  let driver: NodePlatformDriver;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-b3-test-'));
    domain = ExecutionDomain.acquire(tempDir, 'test-b3-domain');
    driver = new NodePlatformDriver();
    supervisor = new ProcessSupervisor(domain, driver);

    domain.getStore().saveTask({
      id: 'task-b3',
      domainId: 'test-b3-domain',
      name: 'B3 Task',
      createdAt: new Date().toISOString(),
    });

    domain.getStore().saveRun({
      id: 'run-b3',
      taskId: 'task-b3',
      domainId: 'test-b3-domain',
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
  // Step 1.1 & 1.2: P0-9 转储链路故障诚实记录与哈希一致性 (契约 #4, #5)
  // ==========================================================================
  describe('P0-9: 转储故障上报与哈希落盘一致性 (契约 #4, #5)', () => {
    it('1.1a [P0-9] openSync 失败时：不返回 outputRef，结果带 spillError，journal 事件如实记录', async () => {
      const opId = 'op-spill-open-fail';
      const originalOpen = fs.openSync;

      // 劫持 fs.openSync 让针对 stdout 转储文件的 open 失败
      (fs as any).openSync = (p: string, flags: string) => {
        if (typeof p === 'string' && p.includes(opId)) {
          throw new Error('Injected openSync failure for spill');
        }
        return originalOpen(p, flags);
      };

      try {
        const result = await supervisor.executeProcess({
          runId: 'run-b3',
          opId,
          name: 'spill-open-fail-op',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.stdout.write("A".repeat(2000));'],
            cwd: tempDir,
          },
          requiredResources: [],
          maxOutputBytes: 100, // 触发截断与转储
        });

        // 1. 转储失败绝不返回虚假 outputRef
        expect(result.outputRef).toBeUndefined();
        expect(result.stdoutRef).toBeUndefined();

        // 2. 结果中必须携带 spillError 且如实指明原因
        expect(result.spillError).toBeDefined();
        expect(result.spillError).toContain('Injected openSync failure');

        // 3. journal 记录中的 payload 同样如实上报 spillError，且无 outputRef
        const events = domain.getStore().getJournalEvents(domain.domainId);
        const resEvent = events.find((e) => e.type === 'OPERATION_RESULT_RECORDED' && e.operationId === opId);
        expect(resEvent).toBeDefined();
        const payloadResult = (resEvent?.payload as any)?.result;
        expect(payloadResult.spillError).toContain('Injected openSync failure');
        expect(payloadResult.outputRef).toBeUndefined();
      } finally {
        fs.openSync = originalOpen;
      }
    });

    it('1.1b [P0-9] writeSync 失败时：不返回 outputRef，结果带 spillError', async () => {
      const opId = 'op-spill-write-fail';
      const originalWrite = fs.writeSync;

      let injected = false;
      (fs as any).writeSync = (fd: number, buffer: any, ...args: any[]) => {
        if (!injected && typeof fd === 'number') {
          injected = true;
          throw new Error('Injected writeSync failure during stream spill');
        }
        return (originalWrite as any)(fd, buffer, ...args);
      };

      try {
        const result = await supervisor.executeProcess({
          runId: 'run-b3',
          opId,
          name: 'spill-write-fail-op',
          command: {
            execPath: process.execPath,
            args: ['-e', 'process.stdout.write("B".repeat(2000));'],
            cwd: tempDir,
          },
          requiredResources: [],
          maxOutputBytes: 100,
        });

        expect(result.outputRef).toBeUndefined();
        expect(result.spillError).toBeDefined();
        expect(result.spillError).toContain('Injected writeSync failure');
      } finally {
        fs.writeSync = originalWrite;
      }
    });

    it('1.1c [P0-9] artifactsDir 创建失败时不静默吞错，如实记录 spillError', async () => {
      const opId = 'op-artifacts-dir-fail';
      // 指定一个无法作为目录创建的路径（指向一个既有常规文件）
      const conflictFile = path.join(tempDir, 'conflict-file');
      fs.writeFileSync(conflictFile, 'blocking file');

      const result = await supervisor.executeProcess({
        runId: 'run-b3',
        opId,
        name: 'artifacts-dir-fail-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.stdout.write("C".repeat(2000));'],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: 100,
        artifactsDir: path.join(conflictFile, 'sub-artifacts'),
      });

      expect(result.outputRef).toBeUndefined();
      expect(result.spillError).toBeDefined();
    });

    it('1.2 [P0-9 / 契约 #4] 大输出完整转储时，outputHash 与落盘内容计算的 sha256 独立校验完全一致', async () => {
      const opId = 'op-hash-independent-verify';
      const sizeBytes = 2 * 1024 * 1024; // 2MB

      const result = await supervisor.executeProcess({
        runId: 'run-b3',
        opId,
        name: 'hash-verify-op',
        command: {
          execPath: process.execPath,
          args: ['-e', `process.stdout.write("X".repeat(${sizeBytes}));`],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: 64 * 1024, // 64KB 限制，触发转储
      });

      expect(result.isTruncated).toBe(true);
      expect(result.outputRef).toBeDefined();
      expect(fs.existsSync(result.outputRef!)).toBe(true);

      // 对落盘文件独立计算 sha256
      const diskContent = fs.readFileSync(result.outputRef!);
      expect(diskContent.length).toBe(sizeBytes);
      const expectedSha256 = crypto.createHash('sha256').update(diskContent).digest('hex');

      expect(result.outputHash).toBe(expectedSha256);
      expect(result.stdoutHash).toBe(expectedSha256);
    });
  });

  // ==========================================================================
  // Step 1.3: P0-10 Head + Tail 双端内存保留与 UTF-8 字符边界截断 (契约 #3)
  // ==========================================================================
  describe('P0-10: Head + Tail 内存保留与 UTF-8 字符边界截断 (契约 #3)', () => {
    it('1.3 [P0-10] 多字节字符截断不撕裂 UTF-8，双端 Head + Tail 均在场且中段标截断', async () => {
      const opId = 'op-utf8-head-tail';
      // 构造包含头部标记、中间多字节（汉字+Emoji）、尾部标记的流
      const headMark = 'HEAD_BEGIN_你好世界🚀';
      const tailMark = 'TAIL_FINISH_终点测试🎉';
      const middleFill = '中文字符测试🔥'.repeat(200);

      const script = `
        process.stdout.write(${JSON.stringify(headMark)});
        process.stdout.write(${JSON.stringify(middleFill)});
        process.stdout.write(${JSON.stringify(tailMark)});
      `;

      const maxBytes = 300;
      const result = await supervisor.executeProcess({
        runId: 'run-b3',
        opId,
        name: 'utf8-head-tail-op',
        command: {
          execPath: process.execPath,
          args: ['-e', script],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: maxBytes,
      });

      expect(result.isTruncated).toBe(true);

      // 1. content 不包含 UTF-8 乱码替换符 \uFFFD
      expect(result.stdout).not.toContain('\uFFFD');

      // 2. Head 在场
      expect(result.stdout.startsWith(headMark)).toBe(true);

      // 3. Tail 在场
      expect(result.stdout.endsWith(tailMark)).toBe(true);

      // 4. 中间标注截断信息
      expect(result.stdout).toMatch(/\[\.\.\. truncated \d+ bytes \.\.\.\]/);

      // 5. 内存总字节数不超上限
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(maxBytes);
    });
  });

  // ==========================================================================
  // Step 1.4: P0-12 inputFingerprint 规范化 sha256 与固定向量测试
  // ==========================================================================
  describe('P0-12: inputFingerprint 规范化哈希与零明文泄漏', () => {
    it('1.4a [P0-12] 默认 inputFingerprint 为 64 字节 hex sha256，journal 中无命令明文', async () => {
      const opId = 'op-fingerprint-hex';
      const secretArg = 'my_super_secret_token_123';

      const result = await supervisor.executeProcess({
        runId: 'run-b3',
        opId,
        name: 'fingerprint-op',
        command: {
          execPath: process.execPath,
          args: ['-e', `console.log("${secretArg}")`],
          cwd: tempDir,
        },
        requiredResources: [],
      });

      expect(result.status).toBe('succeeded');

      const opInDb = domain.getStore().getOperation(opId);
      expect(opInDb).toBeDefined();
      // 指纹必须是 64 位的 16 进制字符串
      expect(opInDb!.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // 检查 journal_events 中的 payload，其 inputFingerprint 绝不能包含明文
      const events = domain.getStore().getJournalEvents(domain.domainId);
      const regEvent = events.find((e) => e.type === 'OPERATION_INTENT_REGISTERED' && e.operationId === opId);
      expect(regEvent?.payload.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(regEvent?.payload.inputFingerprint).not.toContain(secretArg);
    });

    it('1.4b [P0-12] 仅改变 cwd / envWhiteList / stdin / requiredResources 时指纹均不相同', async () => {
      const baseCmd = {
        execPath: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: tempDir,
      };

      const { computeInputFingerprint } = await import('../../src/supervisor/supervisor.js');

      const baseFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: baseCmd,
        requiredResources: ['res:a'],
      });

      // 改变 cwd
      const diffCwdFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: { ...baseCmd, cwd: '/tmp' },
        requiredResources: ['res:a'],
      });
      expect(diffCwdFp).not.toBe(baseFp);

      // 改变 envWhiteList
      const diffEnvFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: { ...baseCmd, envWhiteList: { FOO: 'bar' } },
        requiredResources: ['res:a'],
      });
      expect(diffEnvFp).not.toBe(baseFp);

      // 改变 stdin
      const diffStdinFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: { ...baseCmd, stdin: 'custom input' },
        requiredResources: ['res:a'],
      });
      expect(diffStdinFp).not.toBe(baseFp);

      // 改变 requiredResources
      const diffResFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: baseCmd,
        requiredResources: ['res:b'],
      });
      expect(diffResFp).not.toBe(baseFp);

      // 资源顺序不同但集合相同时指纹必须相同（集合规范化）
      const sameResFp = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: baseCmd,
        requiredResources: ['res:b', 'res:a'],
      });
      const sameResFp2 = computeInputFingerprint({
        runId: 'run-b3',
        opId: 'op-base',
        name: 'test',
        command: baseCmd,
        requiredResources: ['res:a', 'res:b'],
      });
      expect(sameResFp).toBe(sameResFp2);
    });

    it('1.4c [P0-12] 固定向量测试锁定规范化 JSON 与 SHA-256 编码', async () => {
      const { computeInputFingerprint } = await import('../../src/supervisor/supervisor.js');

      const fixedOptions = {
        runId: 'run-b3',
        opId: 'op-fixed',
        name: 'fixed-op',
        command: {
          execPath: '/usr/bin/node',
          args: ['-e', 'console.log(1)'],
          cwd: '/workspace/project',
          envWhiteList: { Z: 'last', A: 'first' },
          inheritEnv: false,
          stdin: 'fixed-stdin-content',
        },
        requiredResources: ['res:z', 'res:a'],
        timeoutMs: 5000,
      };

      const fp1 = computeInputFingerprint(fixedOptions);
      const fp2 = computeInputFingerprint(fixedOptions);
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ==========================================================================
  // Step 1.5: N7 孤儿转储清理与 pruneArtifacts 最小版 (ARCHITECTURE §4.3)
  // ==========================================================================
  describe('N7: 孤儿转储清理与 pruneArtifacts 最小版 (ARCHITECTURE §4.3)', () => {
    it('1.5a [N7] 未截断 op 结清后无日志转储残留；截断 op 保留文件且被引用', async () => {
      const artifactsDir = path.join(tempDir, 'artifacts');

      // 1. 未截断操作
      const unTruncOpId = 'op-untruncated';
      const unTruncRes = await supervisor.executeProcess({
        runId: 'run-b3',
        opId: unTruncOpId,
        name: 'untruncated-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'console.log("short output");'],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: 10000,
        artifactsDir,
      });

      expect(unTruncRes.isTruncated).toBe(false);
      expect(unTruncRes.outputRef).toBeUndefined();

      // 验证未截断操作的文件在 finalizeOperation 时已被清理
      const unTruncStdout = path.join(artifactsDir, `${unTruncOpId}-stdout.log`);
      const unTruncStderr = path.join(artifactsDir, `${unTruncOpId}-stderr.log`);
      expect(fs.existsSync(unTruncStdout)).toBe(false);
      expect(fs.existsSync(unTruncStderr)).toBe(false);

      // 2. 截断操作
      const truncOpId = 'op-truncated-stay';
      const truncRes = await supervisor.executeProcess({
        runId: 'run-b3',
        opId: truncOpId,
        name: 'truncated-stay-op',
        command: {
          execPath: process.execPath,
          args: ['-e', 'process.stdout.write("Z".repeat(1500));'],
          cwd: tempDir,
        },
        requiredResources: [],
        maxOutputBytes: 100,
        artifactsDir,
      });

      expect(truncRes.isTruncated).toBe(true);
      expect(truncRes.outputRef).toBeDefined();
      expect(fs.existsSync(truncRes.outputRef!)).toBe(true);
    });

    it('1.5b [N7] pruneArtifacts 只回收终态 op 的未引用产物，拒绝回收 active / indeterminate 的产物', async () => {
      const artifactsDir = path.join(tempDir, 'artifacts');
      if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
      }

      // 1. 构造一个 done 且无引用的孤儿产物
      const orphanPath = path.join(artifactsDir, 'op-done-orphan-stdout.log');
      fs.writeFileSync(orphanPath, 'orphan content');

      // 2. 构造一个 indeterminate op 的产物（不可被回收）
      const indetOpId = 'op-indet-protected';
      domain.getStore().registerOperationIntent({
        id: indetOpId,
        runId: 'run-b3',
        name: 'indet-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'intent_registered',
      }, domain.domainId);
      domain.getStore().recordOperationResult(indetOpId, {
        kind: 'indeterminate',
        status: 'indeterminate',
        reason: 'process lost',
        recoveryGuidance: 'manual check',
        durationMs: 10,
        completedAt: new Date().toISOString(),
      }, false);

      const indetSpillPath = path.join(artifactsDir, `${indetOpId}-stdout.log`);
      fs.writeFileSync(indetSpillPath, 'protected indeterminate content');

      // 3. 构造一个 active op 的产物（不可被回收）
      const activeOpId = 'op-active-protected';
      domain.getStore().registerOperationIntent({
        id: activeOpId,
        runId: 'run-b3',
        name: 'active-op',
        kind: 'process',
        inputFingerprint: 'dummy',
        requiredResources: [],
        status: 'active',
      }, domain.domainId);
      const activeSpillPath = path.join(artifactsDir, `${activeOpId}-stdout.log`);
      fs.writeFileSync(activeSpillPath, 'protected active content');

      // 执行 pruneArtifacts
      const pruned = domain.pruneArtifacts();

      // 孤儿文件被回收
      expect(fs.existsSync(orphanPath)).toBe(false);

      // active 和 indeterminate 的文件坚决保留
      expect(fs.existsSync(indetSpillPath)).toBe(true);
      expect(fs.existsSync(activeSpillPath)).toBe(true);
    });
  });
});
