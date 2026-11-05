import type { PlatformDriver } from '../driver/types.js';
import type { ProcessIdentity } from '../driver/types.js';
import type { RecoveryEvidence } from '../types.js';

/** Capture the original driver's recovery-relevant claims at intent time. */
export function createRecoveryEvidence(driver: PlatformDriver): RecoveryEvidence {
  const now = new Date().toISOString();
  const capabilities = driver.capabilities;
  return {
    schemaVersion: 'xio/recovery/1.0',
    driverName: driver.name,
    driverCapabilities: {
      processGroupKill: capabilities.processGroupKill,
      accurateStartTime: capabilities.accurateStartTime,
      startTimeSource: capabilities.startTimeSource,
      descendantEnumeration: capabilities.descendantEnumeration,
      gatedSpawn: capabilities.gatedSpawn,
    },
    tree: {
      status: 'unknown',
      source: 'spawn',
      observedAt: now,
    },
    pipes: {
      stdin: 'unknown',
      stdout: 'unknown',
      stderr: 'unknown',
      source: 'spawn',
      observedAt: now,
    },
    containment: {
      kind: containmentKind(capabilities.descendantEnumeration),
      status: 'unknown',
      source: 'spawn',
      observedAt: now,
    },
  };
}

export function withRecoveryIdentity(evidence: RecoveryEvidence | undefined, identity: ProcessIdentity): RecoveryEvidence | undefined {
  if (!evidence) return undefined;
  const now = new Date().toISOString();
  const containment = identity.cgroupPath
    ? { kind: 'cgroup' as const, path: identity.cgroupPath, status: 'held' as const, source: 'spawn' as const, observedAt: now }
    : evidence.containment;
  return {
    ...evidence,
    identity,
    containment,
    pipes: evidence.pipes
      ? {
          ...evidence.pipes,
          stdin: 'open',
          stdout: 'open',
          stderr: 'open',
          observedAt: now,
        }
      : evidence.pipes,
  };
}

function containmentKind(descendantEnumeration: RecoveryEvidence['driverCapabilities']['descendantEnumeration']): NonNullable<RecoveryEvidence['containment']>['kind'] {
  if (descendantEnumeration === 'cgroup') return 'cgroup';
  if (descendantEnumeration === 'subreaper') return 'tracked_tree';
  if (descendantEnumeration === 'full') return 'process_group';
  return 'unknown';
}

