import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CgroupPlatformDriver } from '../../src/driver/cgroup-driver.js';
import { describePlatformDriver } from '../../src/driver/contract.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';

interface MatrixEntry {
  platform: string;
  environment: string;
  driver: string;
  status: 'supported' | 'conditional' | 'unsupported';
  capabilities?: Record<string, unknown>;
  reason?: string;
  precondition?: string;
  evidence: string[];
}

const matrix = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'spec/isa-v1/capability-matrix.json'), 'utf8')) as {
  schemaVersion: string;
  entries: MatrixEntry[];
};

describe('driver capability matrix', () => {
  it('binds the current Node declaration to a platform matrix cell', () => {
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'windows';
    const environment = platform === 'windows' ? 'unsupported-platform' : 'default';
    const entry = matrix.entries.find((candidate) => candidate.platform === platform && candidate.environment === environment && candidate.driver === 'node');
    expect(entry).toBeDefined();
    const contract = describePlatformDriver(new NodePlatformDriver());
    expect(matrix.schemaVersion).toBe('xio/capability-matrix/1');
    expect(entry!.evidence.length).toBeGreaterThan(0);
    if (entry!.status === 'supported') {
      for (const key of ['processGroupKill', 'accurateStartTime', 'memoryHardLimit', 'pidsLimit', 'cpuLimit', 'descendantEnumeration', 'gatedSpawn']) {
        expect(contract.capabilities[key]).toBe(entry!.capabilities?.[key]);
      }
    } else {
      expect(entry!.reason).toBeTruthy();
    }
  });

  it('keeps no-delegation and non-Linux cgroup evidence explicit', () => {
    const noDelegation = matrix.entries.find((entry) => entry.platform === 'linux' && entry.environment === 'no-cgroup-delegation' && entry.driver === 'cgroup');
    const darwin = matrix.entries.find((entry) => entry.platform === 'darwin' && entry.driver === 'cgroup');
    expect(noDelegation?.status).toBe('unsupported');
    expect(noDelegation?.reason).toMatch(/unavailableReason|delegation|fallback/i);
    expect(darwin?.status).toBe('unsupported');
    expect(darwin?.reason).toMatch(/Linux-only/i);
    expect(CgroupPlatformDriver.unavailableReason({ root: '/sys/fs/cgroup/xioflow-matrix-not-the-host' })).toMatch(
      process.platform === 'linux' ? /must run inside|not mounted|not in a cgroup v2/ : /Linux only/
    );
  });
});
