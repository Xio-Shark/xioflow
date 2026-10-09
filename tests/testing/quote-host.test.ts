import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openWorld } from '../../src/world/handle.js';
import { createQuoteHost } from '../../src/testing/quote-host.js';
import { createQuoteFixture, perturbQuoteFixture, quoteCustomers } from '../../src/testing/quote-fixture.js';
import { verifyQuoteOutputs } from '../../src/testing/quote-oracle.js';

it.each(['stable', 'local', 'all', 'again'] as const)('quote world: %s dependency and strict publication', async scenario => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-host-'));
  const root = path.join(temp, 'repo');
  let world: Awaited<ReturnType<typeof openWorld>> | undefined;
  try {
    await createQuoteFixture(root);
    await promisify(execFile)('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const host = createQuoteHost(async source => (await verifyQuoteOutputs(source)).matched);
    world = await openWorld({ root, statePath: path.join(temp, 'state'), adapter: host.adapter });
    const first = await world.runAgentStep(host.agent, { task: 'quote all customers' });
    if (first.status !== 'prepared') throw new Error(JSON.stringify(first));
    expect(host.generated).toEqual([...quoteCustomers, 'summary']);
    await perturbQuoteFixture(root, scenario === 'again' ? 'local' : scenario);
    const refreshed = await world.refresh(first.candidate, { onUnknown: 'reject' });
    if (refreshed.status !== 'prepared') throw new Error(JSON.stringify(refreshed));
    expect(host.generated.slice(21)).toEqual(scenario === 'stable' ? [] : scenario === 'all'
      ? [...quoteCustomers, 'summary'] : ['C01', 'C02', 'summary']);
    expect(await fs.readdir(path.join(root, 'quotes'))).toEqual([]);
    const evidence = await world.explain(refreshed.ref);
    if (scenario === 'local' || scenario === 'again') {
      const summary = evidence.plan!.invalidated.find(node => node.observation.call.args.path === 'quotes/summary.md')!;
      const causes = evidence.plan!.explanations.find(item => item.nodeSeq === summary.seq)!.causes;
      expect(causes).toHaveLength(2);
      for (const cause of causes) {
        expect(cause.path).toHaveLength(3);
        expect(evidence.plan!.invalidated.find(node => node.seq === cause.changedSeq)!.observation.call.args.path)
          .toBe('prices/SKU-A.json');
      }
    }
    if (scenario === 'again') await perturbQuoteFixture(root, 'again');
    const result = await world.commit(refreshed.candidate, { validation: 'strict', key: 'quote' });
    expect(result.status).toBe(scenario === 'again' ? 'conflict' : 'committed');
    if (scenario === 'again') {
      expect(await fs.readdir(path.join(root, 'quotes'))).toEqual([]);
      const retry = await world.refresh(refreshed.candidate, { onUnknown: 'reject' });
      if (retry.status !== 'prepared') throw new Error(JSON.stringify(retry));
      expect((await world.commit(retry.candidate, { validation: 'strict', key: 'retry' })).status).toBe('committed');
      expect(host.generated.slice(24)).toEqual(['C01', 'C02', 'summary']);
    }
    expect(await verifyQuoteOutputs(root)).toEqual({ matched: true, mismatches: [] });
  } finally {
    await world?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 120_000);
