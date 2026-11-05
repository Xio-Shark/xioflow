import type { ConfinementDriver, SnapshotDriver } from '../types.js';
import type { PlatformCapabilities, PlatformDriver } from './types.js';

/** Version of the machine-readable driver evidence contract. */
export const DRIVER_CONTRACT_SCHEMA_VERSION = 'xio/driver/1' as const;

export type DriverContractKind = 'process' | 'filesystem' | 'workspace' | 'confinement';

export interface DriverEvidenceContract {
  observation: {
    proven: string[];
    unknown: string[];
  };
  stop: {
    scopes: string[];
    confirmedBy: string[];
    unknown: string[];
  };
  rollback: {
    supported: boolean;
    coverage: string[];
    unknown: string[];
  };
  crashRecovery: {
    durableFacts: string[];
    canProve: string[];
    cannotProve: string[];
  };
}

export interface DriverContract {
  schemaVersion: typeof DRIVER_CONTRACT_SCHEMA_VERSION;
  capabilityVersion: string;
  name: string;
  kind: DriverContractKind;
  capabilities: Record<string, boolean | string | string[]>;
  evidence: DriverEvidenceContract;
}

export interface FilesystemDriverContractOptions {
  name: string;
  capabilityVersion?: string;
  capabilities?: Record<string, boolean | string | string[]>;
  noFollowOpen?: boolean;
  identityCheckedDelete?: boolean;
  durableManifest?: boolean;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function freezeContract(contract: DriverContract): DriverContract {
  Object.freeze(contract.capabilities);
  Object.freeze(contract.evidence.observation.proven);
  Object.freeze(contract.evidence.observation.unknown);
  Object.freeze(contract.evidence.stop.scopes);
  Object.freeze(contract.evidence.stop.confirmedBy);
  Object.freeze(contract.evidence.stop.unknown);
  Object.freeze(contract.evidence.rollback.coverage);
  Object.freeze(contract.evidence.rollback.unknown);
  Object.freeze(contract.evidence.crashRecovery.durableFacts);
  Object.freeze(contract.evidence.crashRecovery.canProve);
  Object.freeze(contract.evidence.crashRecovery.cannotProve);
  Object.freeze(contract.evidence.observation);
  Object.freeze(contract.evidence.stop);
  Object.freeze(contract.evidence.rollback);
  Object.freeze(contract.evidence.crashRecovery);
  Object.freeze(contract.evidence);
  return Object.freeze(contract);
}

function processStopScopes(driver: PlatformDriver): string[] {
  const scopes: string[] = [];
  if (driver.capabilities.processGroupKill) scopes.push('process_group');
  if (driver.capabilities.descendantEnumeration === 'cgroup') scopes.push('containment_cgroup');
  if (driver.capabilities.descendantEnumeration === 'subreaper') scopes.push('subreaper_tree');
  if (driver.name === 'reaper' && driver.capabilities.descendantEnumeration === 'full') scopes.push('tracked_tree');
  return sorted(scopes);
}

/** Describe the evidence boundary of a process driver without probing the host. */
export function describePlatformDriver(driver: PlatformDriver): DriverContract {
  const observationProven = ['process_identity.pid', 'operation.recoveryEvidence'];
  const observationUnknown = ['driver errors', 'process-table access failure'];
  if (driver.capabilities.accurateStartTime) observationProven.push('process_identity.osStartTime');
  else observationUnknown.push('process identity when OS start time is unavailable');
  if (driver.readBootId) observationProven.push('process_identity.bootId');
  else observationUnknown.push('cross-host-reboot identity');
  if (driver.getGroupEvidence) observationProven.push('process_group.start_time_members');
  else observationUnknown.push('process-group member start-time evidence');
  if (driver.settleTree) observationProven.push('tree_settlement');
  else observationUnknown.push('descendants after root exit');
  if (driver.sampleMetrics) observationProven.push('resource_samples');
  else observationUnknown.push('resource samples');

  const stopScopes = processStopScopes(driver);
  const confirmedBy = ['driver.terminate result with stopped=confirmed_stopped'];
  if (driver.settleTree) confirmedBy.push('driver.settleTree empty');
  if (driver.capabilities.descendantEnumeration === 'cgroup') confirmedBy.push('cgroup populated=0');
  if (driver.capabilities.descendantEnumeration === 'subreaper') confirmedBy.push('subreaper tree wait/ECHILD');
  const stopUnknown = ['residual descendants', 'identity cannot_determine', 'containment or helper loss'];

  const canProve = ['intent-before-effect ordering', 'persisted identity and capability facts'];
  const cannotProve = ['external side effects', 'application-level success from process exit alone'];
  if (driver.capabilities.gatedSpawn) canProve.push('no command release when gated intent has no identity');
  else cannotProve.push('that an identity-less command never executed after host crash');
  if (driver.capabilities.descendantEnumeration === 'cgroup') canProve.push('containment tree emptiness after cgroup settlement');
  else if (driver.capabilities.descendantEnumeration === 'subreaper') canProve.push('held process tree emptiness after helper settlement');
  else cannotProve.push('complete containment of escaped descendants');

  return freezeContract({
    schemaVersion: DRIVER_CONTRACT_SCHEMA_VERSION,
    capabilityVersion: `${driver.name}/1.0`,
    name: driver.name,
    kind: 'process',
    capabilities: { ...driver.capabilities },
    evidence: {
      observation: { proven: sorted(observationProven), unknown: sorted(observationUnknown) },
      stop: {
        scopes: stopScopes,
        confirmedBy: sorted(confirmedBy),
        unknown: sorted(stopUnknown),
      },
      rollback: {
        supported: false,
        coverage: [],
        unknown: ['process side effects are not rollbackable by a process driver'],
      },
      crashRecovery: {
        durableFacts: ['operation intent', 'process identity', 'recovery evidence', 'driver capability snapshot'],
        canProve: sorted(canProve),
        cannotProve: sorted(cannotProve),
      },
    },
  });
}

/** Describe a snapshot/workspace driver used for capture, restore and rollback. */
export function describeSnapshotDriver(driver: SnapshotDriver): DriverContract {
  const fullTree = driver.coverage === 'full_tree';
  return freezeContract({
    schemaVersion: DRIVER_CONTRACT_SCHEMA_VERSION,
    capabilityVersion: `${driver.name}/1.0`,
    name: driver.name,
    kind: 'workspace',
    capabilities: { coverage: driver.coverage },
    evidence: {
      observation: {
        proven: sorted(['snapshot roots', 'snapshot tree fingerprint', 'snapshot coverage']),
        unknown: sorted(fullTree ? ['external writers outside the declared roots'] : ['ignored-file changes not captured by the snapshot']),
      },
      stop: { scopes: [], confirmedBy: [], unknown: ['stop is not a workspace-driver operation'] },
      rollback: {
        supported: true,
        coverage: sorted([driver.coverage, 'declared snapshot roots']),
        unknown: sorted(['partial restore after host crash', 'external writes outside the declared roots']),
      },
      crashRecovery: {
        durableFacts: ['snapshot reference', 'tree fingerprint', 'snapshot operation intent'],
        canProve: sorted(['which snapshot tree was captured', 'whether a restored tree matches its fingerprint']),
        cannotProve: sorted(['application-level meaning of restored files', 'side effects outside snapshot roots']),
      },
    },
  });
}

/** Describe a write-confinement wrapper; it assists rollback coverage but is not a sandbox. */
export function describeConfinementDriver(driver: ConfinementDriver): DriverContract {
  return freezeContract({
    schemaVersion: DRIVER_CONTRACT_SCHEMA_VERSION,
    capabilityVersion: `${driver.name}/1.0`,
    name: driver.name,
    kind: 'confinement',
    capabilities: { name: driver.name, declaredWriteRoots: true },
    evidence: {
      observation: {
        proven: sorted(['wrapped command and declared writable roots']),
        unknown: sorted(['writes by an unavailable or bypassed host policy', 'external effects']),
      },
      stop: { scopes: [], confirmedBy: [], unknown: ['stop belongs to the selected process driver'] },
      rollback: {
        supported: false,
        coverage: sorted(['declared writable roots only']),
        unknown: sorted(['files outside the declared roots if wrapping failed', 'ignored files not captured by the snapshot']),
      },
      crashRecovery: {
        durableFacts: ['selected confinement name', 'declared writable roots in request config snapshot'],
        canProve: sorted(['the requested wrapper was selected before process admission']),
        cannotProve: sorted(['that an unavailable wrapper was applied', 'host-level security against a malicious process']),
      },
    },
  });
}

/** Define the contract for an artifact/filesystem writer until it becomes a standalone driver. */
export function describeFilesystemDriver(options: FilesystemDriverContractOptions): DriverContract {
  const noFollowOpen = options.noFollowOpen ?? false;
  const identityCheckedDelete = options.identityCheckedDelete ?? false;
  const durableManifest = options.durableManifest ?? false;
  return freezeContract({
    schemaVersion: DRIVER_CONTRACT_SCHEMA_VERSION,
    capabilityVersion: options.capabilityVersion ?? `${options.name}/1.0`,
    name: options.name,
    kind: 'filesystem',
    capabilities: {
      ...(options.capabilities ?? {}),
      noFollowOpen,
      identityCheckedDelete,
      durableManifest,
    },
    evidence: {
      observation: {
        proven: sorted([
          ...(noFollowOpen ? ['exclusive no-follow create'] : []),
          ...(identityCheckedDelete ? ['path identity before delete'] : []),
          ...(durableManifest ? ['durable artifact ownership'] : []),
        ]),
        unknown: sorted([
          ...(!noFollowOpen ? ['symlink replacement during create'] : []),
          ...(!identityCheckedDelete ? ['replacement inode before delete'] : []),
          ...(!durableManifest ? ['owner after host crash'] : []),
        ]),
      },
      stop: { scopes: [], confirmedBy: [], unknown: ['stop is not a filesystem-driver operation'] },
      rollback: {
        supported: identityCheckedDelete,
        coverage: identityCheckedDelete ? ['identity-checked cleanup'] : [],
        unknown: sorted(['unknown-owner files', 'external filesystem writers']),
      },
      crashRecovery: {
        durableFacts: durableManifest ? ['artifact owner', 'path identity', 'hash and size', 'deletion state'] : [],
        canProve: durableManifest && identityCheckedDelete ? ['whether a cleanup target still has the recorded identity'] : [],
        cannotProve: sorted(['file contents not represented by a recorded hash', 'unknown-owner paths']),
      },
    },
  });
}
