import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDist, repoRoot } from '../support/build-dist.js';
import { buildReaperHelper } from '../support/reaper-helper.js';

it('releases completed helper streams while retaining identity-bound terminal facts', () => {
  buildDist();
  const result = spawnSync(process.execPath, ['--expose-gc',
    path.join(import.meta.dirname, 'reaper-retention-worker.mjs'),
    pathToFileURL(path.join(repoRoot, 'dist/index.js')).href,
    buildReaperHelper(),
  ], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ retainedStreams: 0, terminalFacts: 8 });
});
