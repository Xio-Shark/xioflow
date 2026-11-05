import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FileObservation } from './observation.mjs';
import { makeRecords, withFixture } from './fixtures.mjs';

withFixture(makeRecords(40), ({ file }) => {
  const observation = new FileObservation(file, { writable: true });
  console.log(JSON.stringify({ step: 'observe', result: observation.describe() }));
  const query = observation.query({ where: { id: 'service-0039' }, select: ['id', 'enabled'], maxBytes: 700 });
  console.log(JSON.stringify({ step: 'query', result: query }));
  const ref = query.rows[0].ref;
  console.log(JSON.stringify({ step: 'inspect_on_demand', result: observation.readText({ version: observation.version, ref, field: 'notes', maxBytes: 500 }) }));
  console.log(JSON.stringify({ step: 'act', result: observation.setEnabled({ version: observation.version, ref, value: true }) }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[39].enabled, true);
  assert.throws(() => observation.setEnabled({ version: observation.version, ref, value: false }), (error) => {
    assert.equal(error.code, 'stale_observation');
    console.log(JSON.stringify({ step: 'stale_action', status: 'rejected', code: error.code }));
    return true;
  });
  console.log(JSON.stringify({ status: 'PASS', persistentSourceChanged: false, fixtureActionVerified: true }));
});
