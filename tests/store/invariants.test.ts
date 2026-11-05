import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SqliteStore } from '../../src/store/sqlite.js';

describe('journal invariant checker', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function database(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-invariants-'));
    roots.push(root);
    const dbPath = path.join(root, 'domain.db');
    const store = new SqliteStore(dbPath);
    store.close();
    return dbPath;
  }

  function check(dbPath: string) {
    return spawnSync(process.execPath, ['scripts/check-invariants.mjs', dbPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  }

  it('accepts an initialized store with no invariant violations', () => {
    const result = check(database());
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('PASS: All 11 invariants');
  });

  it('rejects an effect-before-intent event and a leaked sensitive key', () => {
    const dbPath = database();
    const db = new DatabaseSync(dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO journal_events (
          domain_id, run_id, operation_id, type, payload, timestamp,
          schema_version, event, sensitivity, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'domain',
        'run',
        'op-without-intent',
        'SERVICE_STARTED',
        JSON.stringify({ prompt: 'must not persist' }),
        now,
        'xio/event/1.0',
        'SERVICE_STARTED',
        'internal',
        now,
      );
    } finally {
      db.close();
    }

    const result = check(dbPath);
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('I-ISA-1 (Durable Intent Before Effect)');
    expect(output).toContain('I-ISA-5 (Sensitive Key Redaction)');
  });
});
