import fs from 'node:fs/promises';
import path from 'node:path';

function integer(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid nonnegative safe integer: ${label}`);
  }
  return BigInt(value);
}
function money(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** Reads actual inputs independently of the agent, fixture generator and causal runtime. */
export async function quoteOracle(root: string): Promise<{ files: Record<string, string>; totalCents: string }> {
  const orders = (await fs.readdir(path.join(root, 'orders'))).sort();
  const expected = Array.from({ length: 20 }, (_, i) => `C${String(i + 1).padStart(2, '0')}.json`);
  if (JSON.stringify(orders) !== JSON.stringify(expected)) throw new Error('Expected exactly orders C01–C20');
  const files: Record<string, string> = {};
  const totals: [string, bigint][] = [];
  for (const filename of orders) {
    const order = JSON.parse(await fs.readFile(path.join(root, 'orders', filename), 'utf8'));
    const customer = filename.slice(0, -5);
    if (order.customer !== customer || !Array.isArray(order.lines) || order.lines.length === 0) {
      throw new Error(`Invalid order: ${filename}`);
    }
    let total = 0n;
    const rows: string[] = [];
    for (const line of order.lines) {
      if (typeof line.sku !== 'string' || !/^SKU-[A-Z0-9]+$/.test(line.sku)) throw new Error('Invalid SKU');
      const quantity = integer(line.quantity, 'quantity');
      if (quantity === 0n) throw new Error('Quantity must be positive');
      const price = JSON.parse(await fs.readFile(path.join(root, 'prices', `${line.sku}.json`), 'utf8'));
      if (price.sku !== line.sku) throw new Error('Price SKU mismatch');
      const unitPrice = integer(price.unitPriceCents, 'unitPriceCents');
      const amount = quantity * unitPrice;
      total += amount;
      rows.push(`| ${line.sku} | ${quantity} | ${money(unitPrice)} | ${money(amount)} |`);
    }
    files[`quotes/${customer}.md`] = `# Quote ${customer}\n\n| SKU | Quantity | Unit price (CNY) | Amount (CNY) |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\nTotal (CNY): ${money(total)}\n`;
    totals.push([customer, total]);
  }
  const total = totals.reduce((sum, [, amount]) => sum + amount, 0n);
  files['quotes/summary.md'] = `# Quote summary\n\n| Customer | Total (CNY) |\n| --- | ---: |\n${totals.map(([id, amount]) => `| ${id} | ${money(amount)} |`).join('\n')}\n\nTotal (CNY): ${money(total)}\n`;
  return { files, totalCents: total.toString() };
}

export async function verifyQuoteOutputs(root: string): Promise<{ matched: boolean; mismatches: string[] }> {
  const { files } = await quoteOracle(root);
  const mismatches: string[] = [];
  for (const [name, expected] of Object.entries(files)) {
    let actual: string;
    try { actual = await fs.readFile(path.join(root, name), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mismatches.push(name);
      continue;
    }
    if (actual !== expected) mismatches.push(name);
  }
  return { matched: mismatches.length === 0, mismatches };
}
