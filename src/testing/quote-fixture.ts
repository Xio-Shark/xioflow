import fs from 'node:fs/promises';
import path from 'node:path';

export const quoteCustomers = Array.from({ length: 20 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
export const quoteSkus = ['SKU-A', ...quoteCustomers.slice(2).map(id => `SKU-${id}`)];
export type QuotePerturbation = 'stable' | 'local' | 'all' | 'again';

/** Only creates a new directory, so a demo cannot overwrite an existing workspace. */
export async function createQuoteFixture(root: string): Promise<void> {
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'orders'));
  await fs.mkdir(path.join(root, 'prices'));
  await fs.mkdir(path.join(root, 'quotes'));
  for (const [index, customer] of quoteCustomers.entries()) {
    const sku = index < 2 ? 'SKU-A' : `SKU-${customer}`;
    await fs.writeFile(path.join(root, 'orders', `${customer}.json`),
      `${JSON.stringify({ customer, lines: [{ sku, quantity: 2 }] })}\n`);
  }
  for (const sku of quoteSkus) {
    await fs.writeFile(path.join(root, 'prices', `${sku}.json`),
      `${JSON.stringify({ sku, unitPriceCents: 10000 })}\n`);
  }
}

/** Absolute prices make repeated invocations reproducible; again models a second change. */
export async function perturbQuoteFixture(root: string, scenario: QuotePerturbation): Promise<string[]> {
  if (!['stable', 'local', 'all', 'again'].includes(scenario)) throw new Error('Unknown quote perturbation');
  const skus = scenario === 'stable' ? [] : scenario === 'all' ? quoteSkus : ['SKU-A'];
  const changed: string[] = [];
  for (const sku of skus) {
    const relative = `prices/${sku}.json`;
    // Refuse to silently create a missing input or change a mismatched SKU.
    const price = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    if (price.sku !== sku) throw new Error(`Invalid price identity: ${relative}`);
    const body = `${JSON.stringify({ sku, unitPriceCents: scenario === 'again' ? 13000 : 12000 })}\n`;
    if (await fs.readFile(path.join(root, relative), 'utf8') !== body) {
      await fs.writeFile(path.join(root, relative), body);
      changed.push(relative);
    }
  }
  return changed;
}
