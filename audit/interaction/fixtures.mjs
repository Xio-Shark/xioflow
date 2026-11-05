import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeRecords(count, noteSize = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `service-${String(index).padStart(4, '0')}`,
    group: index % 2 === 0 ? 'alpha' : 'beta',
    enabled: false,
    notes: `record ${index}: ${'诊断🧪 alpha beta\n'.repeat(noteSize)}`,
  }));
}

export function withFixture(records, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-interaction-'));
  const file = path.join(root, 'records.json');
  fs.writeFileSync(file, `${JSON.stringify(records)}\n`);
  try {
    return run({ root, file });
  } finally {
    // The unique fixture directory is created and exclusively owned above.
    fs.rmSync(root, { recursive: true });
  }
}

export const WORKLOADS = [
  { name: 'tiny', count: 1, where: { id: 'service-0000' }, select: ['id', 'enabled'], update: true },
  { name: 'sparse-tail', count: 1000, where: { id: 'service-0999' }, select: ['id', 'enabled'], update: true },
  { name: 'dense-half', count: 1000, where: { group: 'alpha' }, select: ['id', 'enabled'], update: false },
  { name: 'full-long-text', count: 1, noteSize: 600, where: { id: 'service-0000' }, select: ['id', 'enabled'], readText: true, update: false },
];
