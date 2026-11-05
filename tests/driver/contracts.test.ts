import { describe, expect, it } from 'vitest';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';
import {
  DRIVER_CONTRACT_SCHEMA_VERSION,
  describeConfinementDriver,
  describeFilesystemDriver,
  describePlatformDriver,
  describeSnapshotDriver,
} from '../../src/driver/contract.js';
import type { ConfinementDriver, SnapshotDriver } from '../../src/types.js';

describe('driver evidence contracts', () => {
  it('declares honest process observation, stop, and crash boundaries', () => {
    const contract = describePlatformDriver(new NodePlatformDriver());
    expect(contract.schemaVersion).toBe(DRIVER_CONTRACT_SCHEMA_VERSION);
    expect(contract.kind).toBe('process');
    expect(contract.capabilityVersion).toBe('node-default/1.0');
    expect(contract.evidence.observation.proven).toContain('process_identity.osStartTime');
    expect(contract.evidence.stop.scopes).toContain('process_group');
    expect(contract.evidence.rollback.supported).toBe(false);
    expect(contract.evidence.crashRecovery.cannotProve).toContain('external side effects');
  });

  it('separates workspace rollback evidence from process stop evidence', () => {
    const snapshotDriver: SnapshotDriver = {
      name: 'fixture-workspace',
      coverage: 'worktree_non_ignored',
      capture: async () => { throw new Error('not used'); },
      restore: async () => ({ unrestoredPaths: [] }),
      fingerprint: async () => 'fixture',
      prune: async () => {},
    };
    const contract = describeSnapshotDriver(snapshotDriver);
    expect(contract.kind).toBe('workspace');
    expect(contract.evidence.rollback.supported).toBe(true);
    expect(contract.evidence.rollback.coverage).toContain('worktree_non_ignored');
    expect(contract.evidence.stop.unknown).toContain('stop is not a workspace-driver operation');
  });

  it('marks confinement as rollback assistance, not a security boundary', () => {
    const confinement: ConfinementDriver = {
      name: 'fixture-confinement',
      wrap: (command) => command,
    };
    const contract = describeConfinementDriver(confinement);
    expect(contract.kind).toBe('confinement');
    expect(contract.evidence.rollback.supported).toBe(false);
    expect(contract.evidence.rollback.coverage).toContain('declared writable roots only');
    expect(contract.evidence.crashRecovery.cannotProve).toContain('host-level security against a malicious process');
  });

  it('defines the filesystem writer contract with conservative unknowns', () => {
    const contract = describeFilesystemDriver({
      name: 'artifact-store',
      noFollowOpen: true,
      identityCheckedDelete: true,
      durableManifest: true,
    });
    expect(contract.kind).toBe('filesystem');
    expect(contract.evidence.observation.proven).toEqual([
      'durable artifact ownership',
      'exclusive no-follow create',
      'path identity before delete',
    ]);
    expect(contract.evidence.crashRecovery.canProve).toContain('whether a cleanup target still has the recorded identity');
    expect(contract.evidence.rollback.unknown).toContain('unknown-owner files');
  });
});
