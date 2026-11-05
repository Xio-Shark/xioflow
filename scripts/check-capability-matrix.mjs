#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.cwd(), 'spec/isa-v1/capability-matrix.json');
const matrix = JSON.parse(fs.readFileSync(file, 'utf8'));
const allowedStatuses = new Set(['supported', 'conditional', 'unsupported']);
const allowedPlatforms = new Set(['linux', 'darwin', 'windows']);
const allowedDrivers = new Set(['node', 'reaper', 'cgroup']);
const seen = new Set();
const errors = [];

if (matrix.schemaVersion !== 'xio/capability-matrix/1') errors.push('unsupported matrix schemaVersion');
if (!/^\d{4}-\d{2}-\d{2}$/u.test(matrix.generatedAt ?? '')) errors.push('generatedAt must be YYYY-MM-DD');
if (!Array.isArray(matrix.entries) || matrix.entries.length === 0) errors.push('entries must be non-empty');

for (const [index, entry] of (matrix.entries ?? []).entries()) {
  const key = `${entry.platform}/${entry.environment}/${entry.driver}`;
  if (seen.has(key)) errors.push(`duplicate entry ${key}`);
  seen.add(key);
  if (!allowedPlatforms.has(entry.platform)) errors.push(`${key}: unsupported platform key`);
  if (!allowedDrivers.has(entry.driver)) errors.push(`${key}: unsupported driver key`);
  if (!allowedStatuses.has(entry.status)) errors.push(`${key}: invalid status`);
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) errors.push(`${key}: evidence is required`);
  if (entry.status === 'unsupported' && typeof entry.reason !== 'string') errors.push(`${key}: unsupported reason is required`);
  if (entry.status === 'conditional' && typeof entry.precondition !== 'string') errors.push(`${key}: conditional precondition is required`);
  if (entry.status !== 'unsupported' && (!entry.capabilities || typeof entry.capabilities !== 'object')) errors.push(`${key}: capabilities are required`);
  if (!entry.platform || !entry.environment || !entry.driver) errors.push(`entry ${index}: platform/environment/driver are required`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Capability matrix check: PASS (${matrix.entries.length} entries)`);
