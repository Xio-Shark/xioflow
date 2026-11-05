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
    name: 'I-ISA-1 (Durable Intent Before Effect)',
    description: 'Operation-scoped journal effects must have a prior durable OPERATION_INTENT_REGISTERED event',
    sql: `
      SELECT j.seq, COALESCE(j.operation_id, j.op_id) AS operation_id, j.type
      FROM journal_events j
      WHERE COALESCE(j.operation_id, j.op_id) IS NOT NULL
        AND j.type NOT IN ('OPERATION_INTENT_REGISTERED', 'OPERATION_REPLAYED', 'RESOURCES_RELEASED')
        AND NOT (
          j.type = 'OPERATION_RESULT_RECORDED'
          AND json_extract(j.payload, '$.preIntentCancelled') = 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM journal_events i
          WHERE COALESCE(i.operation_id, i.op_id) = COALESCE(j.operation_id, j.op_id)
            AND i.type = 'OPERATION_INTENT_REGISTERED'
            AND i.seq < j.seq
        );
    `,
  },
  {
    name: 'I-ISA-2 (Result Requires Intent)',
    description: 'Every final result event must be intent-backed unless it is an explicit pre-intent cancellation',
    sql: `
      SELECT j.seq, COALESCE(j.operation_id, j.op_id) AS operation_id
      FROM journal_events j
      WHERE j.type = 'OPERATION_RESULT_RECORDED'
        AND json_extract(j.payload, '$.preIntentCancelled') IS NOT 1
        AND NOT EXISTS (
          SELECT 1
          FROM journal_events i
          WHERE COALESCE(i.operation_id, i.op_id) = COALESCE(j.operation_id, j.op_id)
            AND i.type = 'OPERATION_INTENT_REGISTERED'
            AND i.seq < j.seq
        );
    `,
  },
  {
    name: 'I-ISA-3 (Release Audit Envelope)',
    description: 'Every resource release event carries an operation owner, released resource list, and release reason',
    sql: `
      SELECT seq, operation_id, payload
      FROM journal_events
      WHERE type = 'RESOURCES_RELEASED'
        AND (
          COALESCE(operation_id, op_id) IS NULL
          OR json_valid(payload) = 0
          OR COALESCE(json_type(payload, '$.operationId'), '') <> 'text'
          OR json_extract(payload, '$.operationId') <> COALESCE(operation_id, op_id)
          OR COALESCE(json_type(payload, '$.resources'), '') <> 'array'
          OR COALESCE(json_type(payload, '$.releaseReason'), '') <> 'text'
        );
    `,
  },
  {
    name: 'I-ISA-4 (Event Envelope Integrity)',
    description: 'Journal rows have complete envelope metadata and secret events are irreversibly redacted',
    sql: `
      SELECT seq, type
      FROM journal_events
      WHERE schema_version IS NULL
        OR event IS NULL
        OR sensitivity IS NULL
        OR created_at IS NULL
        OR json_valid(payload) = 0
        OR (
          sensitivity = 'secret'
          AND (
            COALESCE(json_type(payload, '$.redacted'), '') <> 'true'
            OR json_extract(payload, '$.redacted') <> 1
          )
        );
    `,
  },
  {
    name: 'I-ISA-5 (Sensitive Key Redaction)',
    description: 'Journal payloads must not retain known prompt, credential, environment, or stream-content keys',
    sql: `
      SELECT j.seq, CAST(t.key AS TEXT) AS key
      FROM journal_events j, json_tree(j.payload) t
      WHERE t.key IS NOT NULL
        AND (
          lower(CAST(t.key AS TEXT)) LIKE '%prompt%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%secret%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%token%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%password%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%authorization%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%credential%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%content%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%body%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%stdin%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%stdout%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%stderr%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%environment%'
          OR lower(CAST(t.key AS TEXT)) = 'env'
          OR lower(CAST(t.key AS TEXT)) LIKE 'env[_-]%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%api_key%'
          OR lower(CAST(t.key AS TEXT)) LIKE '%api-key%'
        );
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
  {
    name: 'I-ISA-6 (Artifact Ownership Manifest)',
    description: 'Settled artifacts have durable owner/instruction, identity, retention metadata, and finalized content facts',
    sql: `
      SELECT a.artifact_id, a.path, a.deletion_state
      FROM artifacts a
      LEFT JOIN operations o ON o.id = a.owner_operation_id
      WHERE a.owner_operation_id IS NULL
        OR a.creating_instruction_id IS NULL
        OR a.path IS NULL OR a.path = ''
        OR a.dev IS NULL OR a.ino IS NULL OR a.birthtime_ns IS NULL
        OR a.sensitivity NOT IN ('public', 'internal', 'secret')
        OR a.encryption_state NOT IN ('unknown', 'plaintext', 'encrypted')
        OR a.deletion_state NOT IN ('present', 'deleted', 'unknown')
        OR (a.deletion_state = 'deleted' AND a.deleted_at IS NULL)
        OR (
          a.deletion_state = 'present'
          AND o.status = 'done'
          AND json_extract(o.result, '$.status') <> 'indeterminate'
          AND (a.sha256 IS NULL OR length(a.sha256) <> 64 OR a.size_bytes IS NULL OR a.size_bytes < 0)
        );
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
  console.log(`\nPASS: All 11 invariants (I2, I3, I-ISA-1..6, I-N6, I-P0-7, I-N8) verified successfully for ${path.basename(resolvedPath)}.`);
  process.exit(0);
}
