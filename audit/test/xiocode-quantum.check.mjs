import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runXiocodeQuantum } from '../observation/xiocode-quantum.mjs';

test('a tool error reaches the model and remains in the saved observation history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-tool-error-'));
  fs.writeFileSync(path.join(root, 'util.mjs'), 'export const foo = 1;\n');
  let checkpoint = { snapshot: null, log: [] };
  let calls = 0;
  const client = { async complete(request) {
    const seen = request.messages.filter((message) => message.role === 'tool');
    const call = (name, args) => ({ content: '', toolCalls: [{ id: `call-${++calls}`, name, arguments: args }] });
    if (seen.length === 0) return call('edit', { path: 'util.mjs', old_string: 'foo', new_string: 'bar' });
    if (seen.length === 1) {
      assert.match(seen[0].content, /read/i);
      return call('read', { path: 'util.mjs' });
    }
    if (seen.length === 2) return call('edit', { path: 'util.mjs', old_string: 'foo', new_string: 'bar' });
    return { content: 'done', toolCalls: [] };
  } };
  try {
    for (let i = 0; i < 4; i++) {
      const result = await runXiocodeQuantum({ input: { root, instruction: 'Rename foo.' }, checkpoint }, client);
      checkpoint = result.checkpoint;
      if (i === 0) {
        assert.equal(checkpoint.log[0].isError, true);
        assert.equal(fs.readFileSync(path.join(root, 'util.mjs'), 'utf8'), 'export const foo = 1;\n');
      }
      assert.equal(result.status, i === 3 ? 'completed' : 'ready');
    }
    assert.equal(calls, 3);
    assert.equal(checkpoint.log.filter((entry) => entry.isError).length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'util.mjs'), 'utf8'), 'export const bar = 1;\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
