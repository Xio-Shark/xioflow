/**
 * Kernel-side self-check of the plain-node conformance path.
 *
 * Third parties run the shared contract suite without vitest through
 * `@xioflow/kernel/testing/plain` (see spec/conformance.md). This script proves
 * that path end-to-end against this repository's own build, on the
 * NodePlatformDriver, and prints the machine-readable JSON report.
 *
 * Run: pnpm build && pnpm conformance
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPlainEnvironment, runPlainSuite } from '../dist/testing/plain-runner.js';
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '../dist/index.js';

// The workspace-transaction and read-evidence contracts observe atime; CI sets
// the same variable for the vitest path.
process.env.XIOFLOW_EXPECT_READ_TRACKING ??= 'atime';

installPlainEnvironment();
const { defineContractTestSuite } = await import('../dist/testing/contract-suite.js');

defineContractTestSuite('plain-node selfcheck (NodePlatformDriver)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-plain-selfcheck-'));
  const domain = ExecutionDomain.acquire(tempDir, 'plain-selfcheck');
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

const report = await runPlainSuite({ consumerName: 'plain-node selfcheck' });
if (report.failures.length > 0) {
  process.stderr.write(`plain conformance: ${report.failed} failing test(s)\n`);
}
process.exit(report.failed > 0 || report.errors.length > 0 ? 1 : 0);
