#!/usr/bin/env node
/**
 * Invariant Checker for xioflow SQLite Domain Stores.
 *
 * Checks core domain invariants from verification §3 (I2, I3, I-N6, I-P0-7, I-N8).
 * Any non-empty result indicates an invariant violation and causes non-zero exit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: node scripts/check-invariants.mjs <domain.db>');
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), dbPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`Database file does not exist: ${resolvedPath}`);
  process.exit(1);
}

const db = new DatabaseSync(resolvedPath);
try {
  db.exec('PRAGMA query_only = ON;');
} catch {
  // Ignore pragma error if any
}

const INVARIANTS = [
  {
    name: 'I2 (No Orphan Leases)',
    description: 'Finished non-indeterminate operations must not retain leases in resource_leases',
    sql: `
      SELECT l.resource_id, l.operation_id
      FROM resource_leases l
      JOIN operations o ON o.id = l.operation_id
      WHERE o.status = 'done' AND json_extract(o.result, '$.status') <> 'indeterminate';
    `,
  },
  {
    name: 'I3 (Single Writer Fact Honesty)',
    description: 'Each operation has at most one OPERATION_RESULT_RECORDED journal event',
    sql: `
      SELECT operation_id, COUNT(*) AS count
      FROM journal_events
      WHERE type = 'OPERATION_RESULT_RECORDED'
      GROUP BY operation_id
      HAVING count > 1;
    `,
  },
  {
    name: 'I-N6 (Lease Release Auditability)',
    description: 'Finished non-indeterminate ops that requested resources must have a RESOURCES_RELEASED event',
    sql: `
      SELECT o.id
      FROM operations o
      WHERE o.status = 'done'
        AND o.required_resources <> '[]'
        AND json_extract(o.result, '$.status') <> 'indeterminate'
        AND NOT EXISTS (
          SELECT 1 FROM journal_events j
          WHERE j.operation_id = o.id AND j.type = 'RESOURCES_RELEASED'
        );
    `,
  },
  {
    name: 'I-P0-7 (Indeterminate Adjudication Guard)',
    description: 'Indeterminate ops without leases must have been released through OPERATION_ADJUDICATED',
    sql: `
      SELECT o.id
      FROM operations o
      WHERE json_extract(o.result, '$.status') = 'indeterminate'
        AND o.required_resources <> '[]'
        AND NOT EXISTS (
          SELECT 1 FROM resource_leases l WHERE l.operation_id = o.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM journal_events j
          WHERE j.operation_id = o.id AND j.type = 'OPERATION_ADJUDICATED'
        );
    `,
  },
  {
    name: 'I-N8 (Exclusive Resource Lease)',
    description: 'No single resource is held by more than one operation simultaneously',
    sql: `
      SELECT resource_id, COUNT(*) AS holders
      FROM resource_leases
      GROUP BY resource_id
      HAVING holders > 1;
    `,
  },
];

let hasViolations = false;

for (const inv of INVARIANTS) {
  try {
    const stmt = db.prepare(inv.sql);
    const rows = stmt.all();
    if (rows.length > 0) {
      hasViolations = true;
      console.error(`\n❌ INVARIANT VIOLATION: ${inv.name}`);
      console.error(`   ${inv.description}`);
      console.error(`   Found ${rows.length} violating row(s):`);
      console.error(JSON.stringify(rows, null, 2));
    } else {
      console.log(`✓ ${inv.name}: OK`);
    }
  } catch (err) {
    hasViolations = true;
    console.error(`\n❌ ERROR executing query for ${inv.name}:`, err);
  }
}

try {
  db.close();
} catch {}

if (hasViolations) {
  console.error('\nFAIL: Invariant check failed.');
  process.exit(1);
} else {
  console.log(`\nPASS: All 5 invariants (I2, I3, I-N6, I-P0-7, I-N8) verified successfully for ${path.basename(resolvedPath)}.`);
  process.exit(0);
}
