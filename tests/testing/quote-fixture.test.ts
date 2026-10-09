import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createQuoteFixture, perturbQuoteFixture } from '../../src/testing/quote-fixture.js';
import { quoteOracle, verifyQuoteOutputs } from '../../src/testing/quote-oracle.js';

const temps: string[] = [];
afterEach(async () => { for (const root of temps.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-fixture-'));
  temps.push(temp);
  const root = path.join(temp, 'repo');
  await createQuoteFixture(root);
  return root;
}
it('reproduces inputs and changes exactly two quotes plus summary by 8000 cents', async () => {
  const root = await fixture();
  const initial = await quoteOracle(root);
  expect(initial).toEqual(await quoteOracle(await fixture()));
  expect(initial.totalCents).toBe('400000');
  expect(initial.files['quotes/C01.md']).toContain('Total (CNY): 200.00\n');
  await expect(createQuoteFixture(root)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await perturbQuoteFixture(root, 'stable')).toEqual([]);
  expect(await quoteOracle(root)).toEqual(initial);
  expect(await perturbQuoteFixture(root, 'local')).toEqual(['prices/SKU-A.json']);
  const changed = await quoteOracle(root);
  expect(changed.totalCents).toBe('408000');
  expect(changed.files['quotes/C01.md']).toContain('Total (CNY): 240.00\n');
  expect(Object.keys(initial.files).filter(name => initial.files[name] !== changed.files[name]))
    .toEqual(['quotes/C01.md', 'quotes/C02.md', 'quotes/summary.md']);
  expect(await perturbQuoteFixture(root, 'local')).toEqual([]);
  await perturbQuoteFixture(root, 'again');
  expect((await quoteOracle(root)).totalCents).toBe('412000');
});
it('changes all 20 quotes and verifies exact bytes including stale and missing output', async () => {
  const root = await fixture();
  const initial = await quoteOracle(root);
  for (const [name, body] of Object.entries(initial.files)) await fs.writeFile(path.join(root, name), body);
  expect(await verifyQuoteOutputs(root)).toEqual({ matched: true, mismatches: [] });
  expect((await perturbQuoteFixture(root, 'all')).length).toBe(19);
  const changed = await quoteOracle(root);
  expect(changed.totalCents).toBe('480000');
  expect((await verifyQuoteOutputs(root)).mismatches).toHaveLength(21);
  for (const [name, body] of Object.entries(changed.files)) await fs.writeFile(path.join(root, name), body);
  await fs.appendFile(path.join(root, 'quotes/C01.md'), ' ');
  await fs.unlink(path.join(root, 'quotes/C02.md'));
  expect(await verifyQuoteOutputs(root)).toEqual({ matched: false, mismatches: ['quotes/C01.md', 'quotes/C02.md'] });
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10000'])('rejects invalid integer cents %s', async value => {
  const root = await fixture();
  await fs.writeFile(path.join(root, 'prices/SKU-A.json'), JSON.stringify({ sku: 'SKU-A', unitPriceCents: value }));
  await expect(quoteOracle(root)).rejects.toThrow('safe integer');
});
it('keeps multiplication exact beyond Number safe range', async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, 'prices/SKU-A.json'), JSON.stringify({ sku: 'SKU-A', unitPriceCents: Number.MAX_SAFE_INTEGER }));
  expect((await quoteOracle(root)).files['quotes/C01.md']).toContain('180143985094819.82');
});
it('rejects missing customers and mismatched price identity', async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, 'prices/SKU-A.json'), JSON.stringify({ sku: 'SKU-X', unitPriceCents: 10000 }));
  await expect(quoteOracle(root)).rejects.toThrow('mismatch');
  await fs.unlink(path.join(root, 'orders/C20.json'));
  await expect(quoteOracle(root)).rejects.toThrow('exactly');
});
