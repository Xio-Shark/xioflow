import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ActionEpisode, referenceAction } from './action-episode.mjs';
import { digest } from './observation.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'replay';
if (process.argv.length > 3 || !['replay', 'replay-action', 'live'].includes(mode)) throw new Error('Usage: research-demo.mjs replay|replay-action|live');
if (mode !== 'live') {
  const root = path.join(directory, 'results', mode === 'replay-action' ? 'action-model-v1' : 'process-model-v1');
  const file = path.join(root, mode === 'replay-action' ? 'dev-dev-01-object-0.json' : 'dev-dev-03-event-view-0.json');
  if (!fs.existsSync(file)) throw new Error('Requested model episode is not available; no silent scripted substitute');
  const record = JSON.parse(fs.readFileSync(file));
  for (const [name, sha] of Object.entries(record.sourceHashes)) {
    assert.equal(digest(fs.readFileSync(path.join(root, 'source-snapshots', `${sha}.source`))), sha, name);
  }
  console.log(JSON.stringify({ mode: 'recorded-model-trace', experiment: record.experiment, newModelRequests: 0,
    source: file, sourceSha256: digest(fs.readFileSync(file)), taskId: record.taskId, modelCalls: record.modelCalls }));
  for (const event of record.toolEvents) console.log(JSON.stringify(event));
  console.log(JSON.stringify({ verdict: record.trace.verdict, cleanup: record.trace.cleanup, restoration: record.trace.restoration }));
} else {
  const episode = await ActionEpisode.create('dev-02', 'object');
  console.log(JSON.stringify({ mode: 'live-fixture-scripted-client', newModelRequests: 0, task: episode.ready.task }));
  try { await referenceAction(episode); }
  finally { await episode.close(); }
  for (const event of episode.trace.events) console.log(JSON.stringify(event));
  console.log(JSON.stringify({ verdict: episode.trace.verdict, restoration: episode.trace.restoration, cleanup: episode.trace.cleanup }));
  assert.equal(episode.trace.verdict.passed, true);
}
