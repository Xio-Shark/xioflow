/**
 * xioflow 数据库 Schema 定义与初始化迁移
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS owners (
  domain_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hostname TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  termination_reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  config_snapshot TEXT,
  config_binding TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  required_resources TEXT NOT NULL,
  mutation_roots TEXT,
  capability_id TEXT,
  timeout_ms INTEGER,
  resource_budget TEXT,
  output_ref TEXT,
  process_identity TEXT,
  spawn_gated INTEGER CHECK (spawn_gated IN (0, 1)),
  recovery_evidence TEXT,
  config_snapshot TEXT,
  result TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  budget TEXT,
  PRIMARY KEY (resource_id, operation_id)
);

CREATE TABLE IF NOT EXISTS journal_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id TEXT NOT NULL,
  run_id TEXT,
  operation_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'xio/event/1.0',
  request_id TEXT,
  program_id TEXT,
  instruction_id TEXT,
  op_id TEXT,
  event TEXT NOT NULL DEFAULT 'legacy.event',
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  driver TEXT NOT NULL,
  roots TEXT NOT NULL,
  coverage TEXT NOT NULL,
  tree_fingerprint TEXT NOT NULL,
  commit_hash TEXT,
  journal_seq INTEGER,
  created_at TEXT NOT NULL,
  tree_size_bytes INTEGER,
  ignored_manifest_digest TEXT
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  parent_id TEXT,
  issued_by TEXT NOT NULL,
  scope TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'legacy/0',
  reason TEXT NOT NULL DEFAULT 'legacy-capability',
  limits TEXT NOT NULL DEFAULT '{"cpuMs":315360000000,"memoryBytes":1099511627776,"outputBytes":107374182400,"concurrentOps":4096,"processes":65536}',
  epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

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

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_operations_run_id ON operations(run_id);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_resource_leases_op ON resource_leases(operation_id);
CREATE INDEX IF NOT EXISTS idx_journal_events_domain ON journal_events(domain_id);
CREATE INDEX IF NOT EXISTS idx_journal_events_domain_type_seq ON journal_events(domain_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_snapshots_domain ON snapshots(domain_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_journal_seq ON snapshots(journal_seq);
CREATE INDEX IF NOT EXISTS idx_capabilities_domain ON capabilities(domain_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_domain_path ON artifacts(domain_id, path);
CREATE INDEX IF NOT EXISTS idx_artifacts_domain_state ON artifacts(domain_id, deletion_state);
`;
