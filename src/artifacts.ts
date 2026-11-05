import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionDomain } from './domain.js';
import type {
  ArtifactEncryptionState,
  ArtifactRecord,
  ArtifactSensitivity,
} from './types.js';

/** IDs are opaque keys, never path components. Keep existing ordinary filenames readable. */
export function artifactStem(id: string): string {
  return /^[A-Za-z0-9_.:@+#-]{1,180}$/.test(id)
    ? id
    : `~xio-id-${crypto.createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')}`;
}

export function artifactPath(directory: string, id: string, suffix: string): string {
  return path.join(directory, `${artifactStem(id)}${suffix}`);
}

/** The host owns the parent directory; an artifact directory itself must not redirect I/O. */
export function assertArtifactDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Artifact directory must be a real directory: ${directory}`);
  }
}

export interface OwnedArtifact {
  path: string;
  dev: string;
  ino: string;
  birthtimeNs: string;
}

export interface ArtifactCreateOptions {
  artifactId?: string;
  creatingInstructionId?: string;
  ttlMs?: number;
  sensitivity?: ArtifactSensitivity;
  encryptionState?: ArtifactEncryptionState;
  sha256?: string;
  sizeBytes?: number;
}

export interface ArtifactFacts {
  sha256: string;
  sizeBytes: number;
}

export function artifactId(artifact: OwnedArtifact): string {
  const identity = JSON.stringify([path.resolve(artifact.path), artifact.dev, artifact.ino, artifact.birthtimeNs]);
  return `artifact:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
}

export function artifactIdentity(file: string, stat: fs.BigIntStats): OwnedArtifact {
  return { path: file, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}

export function recordArtifactCreated(
  domain: ExecutionDomain,
  opId: string,
  artifact: OwnedArtifact,
  options: ArtifactCreateOptions = {},
): ArtifactRecord {
  const store = domain.getStore();
  const createdAt = new Date().toISOString();
  const record: ArtifactRecord = {
    id: options.artifactId ?? artifactId(artifact),
    domainId: domain.domainId,
    ownerOperationId: opId,
    creatingInstructionId: options.creatingInstructionId ?? opId,
    path: path.resolve(artifact.path),
    sha256: options.sha256,
    sizeBytes: options.sizeBytes,
    createdAt,
    ...(options.ttlMs !== undefined ? { expiresAt: new Date(Date.now() + options.ttlMs).toISOString() } : {}),
    sensitivity: options.sensitivity ?? 'internal',
    encryptionState: options.encryptionState ?? 'unknown',
    deletionState: 'present',
    dev: artifact.dev,
    ino: artifact.ino,
    birthtimeNs: artifact.birthtimeNs,
  };
  store.transaction(() => {
    store.recordArtifact(record);
    store.recordEventAndTransitionState({
      domainId: domain.domainId,
      operationId: opId,
      runId: store.getOperation(opId)?.runId,
      type: 'ARTIFACT_CREATED',
      payload: {
        ...artifact,
        artifactId: record.id,
        ownerOperationId: opId,
        creatingInstructionId: record.creatingInstructionId,
        path: record.path,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
        expiresAt: record.expiresAt,
        sensitivity: record.sensitivity,
        encryptionState: record.encryptionState,
      },
      timestamp: createdAt,
    });
  });
  return record;
}

export function recordArtifactFinalized(domain: ExecutionDomain, artifact: OwnedArtifact, facts: ArtifactFacts): void {
  domain.getStore().finalizeArtifact(domain.domainId, { ...artifact, path: path.resolve(artifact.path) }, facts);
}

export function recordArtifactDeleted(domain: ExecutionDomain, artifact: OwnedArtifact, reason: string = 'pruned'): void {
  domain.getStore().markArtifactDeleted(domain.domainId, { ...artifact, path: path.resolve(artifact.path) }, reason);
}

/** Exclusive creation also rejects pre-existing symlinks and hard links without modifying them. */
export function createArtifact(file: string, onCreated?: (artifact: OwnedArtifact) => void): { fd: number; artifact: OwnedArtifact } {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  assertArtifactDirectory(directory);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let artifact: OwnedArtifact | undefined;
  try {
    artifact = artifactIdentity(file, fs.fstatSync(fd, { bigint: true }));
    onCreated?.(artifact);
    return { fd, artifact };
  } catch (error) {
    const errors = [error];
    try { fs.closeSync(fd); } catch (closeError) { errors.push(closeError); }
    if (artifact) {
      try { removeOwnedArtifact(artifact); } catch (cleanupError) { errors.push(cleanupError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join('; '));
    throw error;
  }
}

/** Never infer ownership from a filename when removing a transient artifact. */
export function removeOwnedArtifact(artifact: OwnedArtifact): void {
  assertArtifactDirectory(path.dirname(artifact.path));
  const current = fs.lstatSync(artifact.path, { bigint: true, throwIfNoEntry: false });
  if (!current) return;
  if (!current.isFile() || current.dev.toString() !== artifact.dev || current.ino.toString() !== artifact.ino || current.birthtimeNs.toString() !== artifact.birthtimeNs) {
    throw new Error(`Artifact was replaced before cleanup: ${artifact.path}`);
  }
  fs.unlinkSync(artifact.path);
}

export function writeArtifact(file: string, data: string | Buffer): OwnedArtifact {
  const { fd, artifact } = createArtifact(file);
  const errors: unknown[] = [];
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (error) { errors.push(error); }
  try { fs.closeSync(fd); } catch (error) { errors.push(error); }
  if (errors.length > 0) {
    try { removeOwnedArtifact(artifact); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, errors.map(String).join('; '), { cause: errors[0] });
  }
  return artifact;
}

export function readArtifact(file: string): Buffer {
  return readOwnedArtifact(file).data;
}

export function readOwnedArtifact(file: string): { data: Buffer; artifact: OwnedArtifact } {
  assertArtifactDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${file}`);
    return { data: fs.readFileSync(fd), artifact: artifactIdentity(file, stat) };
  } finally {
    fs.closeSync(fd);
  }
}
