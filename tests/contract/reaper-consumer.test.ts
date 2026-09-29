import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '@xioflow/kernel';
import { defineContractTestSuite, ConsumerContext } from '../../src/testing/contract-suite.js';
import { buildReaperHelper } from '../support/reaper-helper.js';

const helperPath = buildReaperHelper();

// 同一份共享契约跑在原生 reaper 驱动上：换驱动不得改变任何诚实性语义
defineContractTestSuite('Reaper Driver Consumer', async (): Promise<ConsumerContext> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-reaper-consumer-'));
  const domain = ExecutionDomain.acquire(tempDir, 'reaper-domain');
  const driver = new ReaperPlatformDriver({ helperPath });
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
