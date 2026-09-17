/**
 * xioflow 数据库 Schema 定义与初始化迁移
 */

export const SCHEMA_SQL = `
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
  timeout_ms INTEGER,
  process_identity TEXT,
  result TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, operation_id)
);

CREATE TABLE IF NOT EXISTS journal_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id TEXT NOT NULL,
  run_id TEXT,
  operation_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_operations_run_id ON operations(run_id);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_resource_leases_op ON resource_leases(operation_id);
CREATE INDEX IF NOT EXISTS idx_journal_events_domain ON journal_events(domain_id);
`;
