import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ExecutionDomain,
  NodePlatformDriver,
  ProcessSupervisor,
} from '@xioflow/kernel';
import { defineContractTestSuite, ConsumerContext } from '../../src/testing/contract-suite.js';

// 消费者 A：纯无头 API 消费者（零 UI，零三件套，仅调用公开内核 API）
defineContractTestSuite('Headless API Consumer', async (): Promise<ConsumerContext> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-headless-consumer-'));
  const domain = ExecutionDomain.acquire(tempDir, 'headless-domain');
  const driver = new NodePlatformDriver();
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
