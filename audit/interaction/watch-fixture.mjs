import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeRecords } from './fixtures.mjs';

export function createWatchFixture(count = 100) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-view-watch-'));
  const file = path.join(root, 'records.json');
  const records = makeRecords(count, 2);
  const replace = (value = records) => {
    const temporary = path.join(root, `replace-${randomUUID()}.json`);
    try {
      fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  replace();
  return { file, records, replace, cleanup: () => fs.rmSync(root, { recursive: true }) };
}

export const serviceView = (records) => records.filter((row) => row.id === 'service-0000')
  .map(({ id, enabled }) => ({ id, enabled }));
