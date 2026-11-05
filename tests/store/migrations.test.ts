import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations, STORE_MIGRATIONS } from '../../src/store/migrations.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-migrations-'));
  roots.push(root);
  return new DatabaseSync(path.join(root, 'domain.db'));
}

describe('store migration runner', () => {
  it('migrates a new database and records version/checksum atomically', () => {
    const db = openDb();
    expect(runMigrations(db)).toBe(6);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6);
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 1').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[0]!.checksum });
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 2').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[1]!.checksum });
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 3').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[2]!.checksum });
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 4').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[3]!.checksum });
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 5').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[4]!.checksum });
    expect(db.prepare('SELECT state, checksum FROM xio_schema_migrations WHERE version = 6').get()).toMatchObject({ state: 'applied', checksum: STORE_MIGRATIONS[5]!.checksum });
    expect(runMigrations(db)).toBe(6);
  });

  it('upgrades a 0.x database with missing columns', () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, run_id TEXT, domain_id TEXT, kind TEXT, name TEXT,
        input_fingerprint TEXT, status TEXT, required_resources TEXT,
        timeout_ms INTEGER, resource_budget TEXT, output_ref TEXT,
        process_identity TEXT, result TEXT
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY, domain_id TEXT, op_id TEXT, driver TEXT, roots TEXT,
        coverage TEXT, tree_fingerprint TEXT, commit_hash TEXT, journal_seq INTEGER,
        created_at TEXT, tree_size_bytes INTEGER
      );
    `);
    expect(runMigrations(db)).toBe(6);
    const operationColumns = (db.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>).map((column) => column.name);
    const snapshotColumns = (db.prepare('PRAGMA table_info(snapshots)').all() as Array<{ name: string }>).map((column) => column.name);
    const capabilityColumns = (db.prepare('PRAGMA table_info(capabilities)').all() as Array<{ name: string }>).map((column) => column.name);
    const artifactColumns = (db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).map((column) => column.name);
    const runColumns = (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(operationColumns).toEqual(expect.arrayContaining(['mutation_roots', 'capability_id', 'spawn_gated', 'recovery_evidence']));
    expect(snapshotColumns).toContain('ignored_manifest_digest');
    expect(capabilityColumns).toEqual(expect.arrayContaining(['policy_version', 'reason', 'limits']));
    expect(artifactColumns).toEqual(expect.arrayContaining([
      'artifact_id', 'owner_operation_id', 'creating_instruction_id', 'path', 'sha256', 'size_bytes',
      'expires_at', 'sensitivity', 'encryption_state', 'deletion_state', 'dev', 'ino', 'birthtime_ns',
      'deleted_at', 'deletion_reason',
    ]));
    expect(runColumns).toContain('config_binding');
    expect(operationColumns).toContain('config_snapshot');
  });

  it('fails closed on a half-applied or checksum-drifted migration', () => {
    const db = openDb();
    const failing = [{ version: 1, name: 'test', checksum: 'test-checksum', up: () => { throw new Error('migration failed'); } }];
    expect(() => runMigrations(db, failing)).toThrow('migration failed');
    expect(() => runMigrations(db, STORE_MIGRATIONS)).toThrow('half-applied');

    const clean = openDb();
    runMigrations(clean);
    clean.prepare('UPDATE xio_schema_migrations SET checksum = ? WHERE version = 1').run('drifted');
    expect(() => runMigrations(clean)).toThrow('checksum/name mismatch');
  });
});
