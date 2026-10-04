import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { CgroupPlatformDriver, ExecutionDomain, ProcessSupervisor } from '@xioflow/kernel';
import { defineContractTestSuite, ConsumerContext } from '../../src/testing/contract-suite.js';
import { cgroupSuiteName, cgroupUnavailable } from '../support/cgroup.js';

// 同一份共享契约跑在 cgroup v2 驱动上；能力声明不同的契约（7、13、37、38、62）按声明分支断言
if (cgroupUnavailable) {
  describe(cgroupSuiteName('Consistency Contract Suite: [Cgroup Driver Consumer]'), () => {
    it.skip('requires a delegated cgroup v2 hierarchy', () => {});
  });
} else {
  defineContractTestSuite('Cgroup Driver Consumer', async (): Promise<ConsumerContext> => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-cgroup-consumer-'));
    const domain = ExecutionDomain.acquire(tempDir, 'cgroup-domain');
    const driver = new CgroupPlatformDriver();
    const supervisor = new ProcessSupervisor(domain, driver);
    return {
      domain,
      driver,
      supervisor,
      tempDir,
      workflowType: 'headless',
      cleanup: async () => {
        domain.close();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      },
    };
  });
}
