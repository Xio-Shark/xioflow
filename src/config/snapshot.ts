import crypto from 'node:crypto';
import type { PlatformDriver } from '../driver/types.js';
import type { RequestConfigSnapshot } from '../types.js';

export const CONFIG_SCHEMA_VERSION = 'xio/config/1' as const;
export const RETENTION_POLICY_VERSION = 'xio/retention/1' as const;
export const REDACTION_POLICY_VERSION = 'xio/redaction/1' as const;

const SECRET_KEY = /(token|secret|password|authorization|credential|api[_-]?key|private[_-]?key)/iu;

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function scrub(value: unknown, key?: string): JsonLike | undefined {
  // Metadata lists such as `secretEnvKeys` contain names only; retain them so
  // the binding records which policy inputs were present without storing values.
  if (key && SECRET_KEY.test(key) && !/keys$/iu.test(key)) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry)).filter((entry): entry is JsonLike => entry !== undefined);
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonLike> = {};
    for (const keyName of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = scrub((value as Record<string, unknown>)[keyName], keyName);
      if (entry !== undefined) result[keyName] = entry;
    }
    return result;
  }
  return undefined;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
  }
  return false;
}

function cloneAndFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) cloneAndFreeze(child);
  }
  return value;
}

function driverFacts(driver: PlatformDriver): Record<string, boolean | string | string[]> {
  const facts: Record<string, boolean | string | string[]> = {};
  for (const key of Object.keys(driver.capabilities).sort()) {
    const value = driver.capabilities[key as keyof typeof driver.capabilities];
    if (Array.isArray(value)) facts[key] = [...value].sort();
    else if (typeof value === 'boolean' || typeof value === 'string') facts[key] = value;
  }
  return facts;
}

export interface RequestConfigSnapshotInput {
  driver: PlatformDriver;
  capabilityId?: string;
  capabilityPolicyVersion?: string;
  driverVersion?: string;
  config?: Record<string, unknown>;
  retentionVersion?: string;
  redactionVersion?: string;
}

/** Capture only deterministic, non-secret request facts before an operation is admitted. */
export function createRequestConfigSnapshot(input: RequestConfigSnapshotInput): RequestConfigSnapshot {
  const config = (scrub(input.config ?? {}) ?? {}) as Record<string, unknown>;
  const createdAt = new Date().toISOString();
  const snapshotWithoutDigest = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    capabilityId: input.capabilityId,
    capabilityPolicyVersion: input.capabilityPolicyVersion,
    driverName: input.driver.name,
    driverVersion: input.driverVersion ?? `${input.driver.name}/1.0`,
    driverCapabilities: driverFacts(input.driver),
    retentionVersion: input.retentionVersion ?? RETENTION_POLICY_VERSION,
    redactionVersion: input.redactionVersion ?? REDACTION_POLICY_VERSION,
    config,
    createdAt,
  } satisfies Omit<RequestConfigSnapshot, 'digest'>;
  const digest = crypto.createHash('sha256').update(canonical(snapshotWithoutDigest)).digest('hex');
  return cloneAndFreeze({
    ...snapshotWithoutDigest,
    digest,
  });
}

/** Recompute and verify the immutable binding before using it during recovery. */
export function assertRequestConfigSnapshot(snapshot: RequestConfigSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Config snapshot must be an object');
  if (snapshot.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new Error(`Unsupported config snapshot schema '${snapshot.schemaVersion}'`);
  if (typeof snapshot.driverName !== 'string' || !snapshot.driverName || typeof snapshot.driverVersion !== 'string' || !snapshot.driverVersion || typeof snapshot.retentionVersion !== 'string' || !snapshot.retentionVersion || typeof snapshot.redactionVersion !== 'string' || !snapshot.redactionVersion) {
    throw new Error('Config snapshot is incomplete');
  }
  if (snapshot.capabilityId !== undefined && typeof snapshot.capabilityId !== 'string') {
    throw new Error('Config snapshot capabilityId must be a string');
  }
  if (snapshot.capabilityPolicyVersion !== undefined && typeof snapshot.capabilityPolicyVersion !== 'string') {
    throw new Error('Config snapshot capabilityPolicyVersion must be a string');
  }
  if (!snapshot.driverCapabilities || typeof snapshot.driverCapabilities !== 'object' || Array.isArray(snapshot.driverCapabilities)) {
    throw new Error('Config snapshot driverCapabilities is incomplete');
  }
  for (const value of Object.values(snapshot.driverCapabilities)) {
    if (!(typeof value === 'boolean' || typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) {
      throw new Error('Config snapshot driverCapabilities contains an invalid value');
    }
  }
  if (!snapshot.config || typeof snapshot.config !== 'object' || Array.isArray(snapshot.config) || !isJsonValue(snapshot.config)) {
    throw new Error('Config snapshot config is invalid');
  }
  if (typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new Error('Config snapshot createdAt is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(snapshot.digest)) throw new Error('Config snapshot digest is invalid');
  const { digest: _digest, ...withoutDigest } = snapshot;
  const expected = crypto.createHash('sha256').update(canonical(withoutDigest)).digest('hex');
  if (expected !== snapshot.digest) throw new Error('Config snapshot digest mismatch');
}

