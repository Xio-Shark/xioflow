import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRenameFixture, applyCompetingChange, checkRenameFixture } from '../observation/rename-fixture.mjs';

for (const scenario of ['comment', 'new-caller']) {
  test(`${scenario}: checker detects missed callers and deletion of competing work`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-rename-check-'));
    try {
      createRenameFixture(root, scenario); applyCompetingChange(root, scenario);
      assert.equal(checkRenameFixture(root, scenario, root).passed, false);
      for (const name of fs.readdirSync(root)) {
        if (name === 'new-caller.mjs') continue;
        const file = path.join(root, name);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('foo', 'bar'));
      }
      if (scenario === 'new-caller') {
        assert.equal(checkRenameFixture(root, scenario, root).passed, false);
        const file = path.join(root, 'new-caller.mjs');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('foo', 'bar'));
      }
      assert.equal(checkRenameFixture(root, scenario, root).passed, true);
      if (scenario === 'new-caller') {
        const late = path.join(root, 'new-caller.mjs');
        const correct = fs.readFileSync(late, 'utf8');
        fs.writeFileSync(late, correct.replace('+ 100', '+ 101'));
        assert.equal(checkRenameFixture(root, scenario, root).passed, false);
        fs.writeFileSync(late, correct);
      }
      const file = path.join(root, scenario === 'comment' ? 'caller.mjs' : 'new-caller.mjs');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n'));
      assert.equal(checkRenameFixture(root, scenario, root).passed, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
