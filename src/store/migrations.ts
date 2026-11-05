import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

export interface StoreMigration {
  version: number;
  name: string;
  checksum: string;
  up: (db: DatabaseSync) => void;
}

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  state: 'applying' | 'applied';
}

export const STORE_SCHEMA_VERSION = 6;

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!columns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function migrateLegacySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'operations', 'mutation_roots', 'TEXT');
  ensureColumn(db, 'operations', 'capability_id', 'TEXT');
  ensureColumn(db, 'operations', 'spawn_gated', 'INTEGER CHECK (spawn_gated IN (0, 1))');
  ensureColumn(db, 'snapshots', 'ignored_manifest_digest', 'TEXT');
}

function migrateEventEnvelope(db: DatabaseSync): void {
  ensureColumn(db, 'journal_events', 'schema_version', "TEXT NOT NULL DEFAULT 'xio/event/1.0'");
  ensureColumn(db, 'journal_events', 'request_id', 'TEXT');
  ensureColumn(db, 'journal_events', 'program_id', 'TEXT');
  ensureColumn(db, 'journal_events', 'instruction_id', 'TEXT');
  ensureColumn(db, 'journal_events', 'op_id', 'TEXT');
  ensureColumn(db, 'journal_events', 'event', "TEXT NOT NULL DEFAULT 'legacy.event'");
  ensureColumn(db, 'journal_events', 'sensitivity', "TEXT NOT NULL DEFAULT 'internal'");
  ensureColumn(db, 'journal_events', 'created_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
}

function migrateRecoveryEvidence(db: DatabaseSync): void {
  ensureColumn(db, 'operations', 'recovery_evidence', 'TEXT');
}

function migrateCapabilityV1(db: DatabaseSync): void {
  ensureColumn(db, 'capabilities', 'policy_version', "TEXT NOT NULL DEFAULT 'legacy/0'");
  ensureColumn(db, 'capabilities', 'reason', "TEXT NOT NULL DEFAULT 'legacy-capability'");
  ensureColumn(db, 'capabilities', 'limits', "TEXT NOT NULL DEFAULT '{\"cpuMs\":315360000000,\"memoryBytes\":1099511627776,\"outputBytes\":107374182400,\"concurrentOps\":4096,\"processes\":65536}'");
}

function migrateArtifactOwnership(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      owner_operation_id TEXT,
      creating_instruction_id TEXT,
      path TEXT NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'secret')),
      encryption_state TEXT NOT NULL CHECK (encryption_state IN ('unknown', 'plaintext', 'encrypted')),
      deletion_state TEXT NOT NULL CHECK (deletion_state IN ('present', 'deleted', 'unknown')),
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      birthtime_ns TEXT NOT NULL,
      deleted_at TEXT,
      deletion_reason TEXT,
      UNIQUE(domain_id, path, dev, ino, birthtime_ns)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_domain_path ON artifacts(domain_id, path);
    CREATE INDEX IF NOT EXISTS idx_artifacts_domain_state ON artifacts(domain_id, deletion_state);
  `);
}

function migrateConfigSnapshots(db: DatabaseSync): void {
  ensureColumn(db, 'runs', 'config_binding', 'TEXT');
  ensureColumn(db, 'operations', 'config_snapshot', 'TEXT');
}

const checksum = crypto.createHash('sha256').update('xioflow-store-migration:1:legacy-schema').digest('hex');
const eventEnvelopeChecksum = crypto.createHash('sha256').update('xioflow-store-migration:2:event-envelope').digest('hex');
const recoveryEvidenceChecksum = crypto.createHash('sha256').update('xioflow-store-migration:3:recovery-evidence').digest('hex');
const capabilityV1Checksum = crypto.createHash('sha256').update('xioflow-store-migration:4:capability-v1').digest('hex');
const artifactOwnershipChecksum = crypto.createHash('sha256').update('xioflow-store-migration:5:artifact-ownership').digest('hex');
const configSnapshotsChecksum = crypto.createHash('sha256').update('xioflow-store-migration:6:config-snapshots').digest('hex');

export const STORE_MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  { version: 1, name: 'legacy-schema', checksum, up: migrateLegacySchema },
  { version: 2, name: 'event-envelope', checksum: eventEnvelopeChecksum, up: migrateEventEnvelope },
  { version: 3, name: 'recovery-evidence', checksum: recoveryEvidenceChecksum, up: migrateRecoveryEvidence },
  { version: 4, name: 'capability-v1', checksum: capabilityV1Checksum, up: migrateCapabilityV1 },
  { version: 5, name: 'artifact-ownership', checksum: artifactOwnershipChecksum, up: migrateArtifactOwnership },
  { version: 6, name: 'config-snapshots', checksum: configSnapshotsChecksum, up: migrateConfigSnapshots },
]);

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number };
  return Number(row?.user_version ?? 0);
}

function migrationRows(db: DatabaseSync): Map<number, MigrationRow> {
  return new Map((db.prepare('SELECT version, name, checksum, state FROM xio_schema_migrations ORDER BY version').all() as unknown as MigrationRow[]).map((row) => [Number(row.version), row]));
}

/** Apply numbered store migrations and fail closed on a missing or half-applied ledger row. */
export function runMigrations(db: DatabaseSync, migrations: readonly StoreMigration[] = STORE_MIGRATIONS): number {
  if (migrations.length === 0) return userVersion(db);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  if (ordered.some((migration, index) => migration.version !== index + 1)) throw new Error('Store migrations must be contiguous and start at version 1');
  db.exec(`
    CREATE TABLE IF NOT EXISTS xio_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
      applied_at TEXT
    );
  `);
  const current = userVersion(db);
  const latest = ordered.at(-1)!.version;
  if (current > latest) throw new Error(`Unsupported store schema version ${current}; latest supported is ${latest}`);
  for (const migration of ordered) {
    const existing = migrationRows(db).get(migration.version);
    if (existing) {
      if (existing.state !== 'applied') throw new Error(`Store migration ${migration.version} is half-applied`);
      if (existing.checksum !== migration.checksum || existing.name !== migration.name) throw new Error(`Store migration ${migration.version} checksum/name mismatch`);
      if (current < migration.version) throw new Error(`Store migration ${migration.version} is marked applied but PRAGMA user_version is ${current}`);
      continue;
    }
    if (current >= migration.version) throw new Error(`Store migration ${migration.version} ledger row is missing at user_version ${current}`);
    db.prepare('INSERT INTO xio_schema_migrations (version, name, checksum, state, applied_at) VALUES (?, ?, ?, ?, NULL)').run(migration.version, migration.name, migration.checksum, 'applying');
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('UPDATE xio_schema_migrations SET state = ?, applied_at = ? WHERE version = ?').run('applied', new Date().toISOString(), migration.version);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Store migration rollback failed', { cause: error }); }
      throw error;
    }
  }
  return userVersion(db);
}
