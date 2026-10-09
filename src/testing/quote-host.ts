import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileWorldAdapter, WorldAgent } from '../world/contract.js';
import { quoteCustomers, quoteSkus } from './quote-fixture.js';

function safe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid or overflowing quote amount');
  return value;
}
function money(value: number): string {
  safe(value);
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

/** Deterministic host fixture, not a model benchmark. No oracle code generates outputs. */
export function createQuoteHost(accept: FileWorldAdapter['accept']) {
  const generated: string[] = [];
  const outputs = [...quoteCustomers.map(id => `quotes/${id}.md`), 'quotes/summary.md'];
  const inputs = [...quoteCustomers.map(id => `orders/${id}.json`), ...quoteSkus.map(id => `prices/${id}.json`)];
  const adapter: FileWorldAdapter = {
    id: 'quote-demo-host', version: '1',
    declareCoverage: async () => ({ paths: [...inputs, ...outputs], excluded: [],
      symlinks: 'reject', externalReads: 'unsupported', externalWrites: 'unsupported' }),
    replay: async (entry, root) => {
      const name = entry.call.args.path as string;
      if (entry.call.tool === 'read' && inputs.includes(name)) return fs.readFile(path.join(root, name), 'utf8');
      if (entry.call.tool === 'write' && outputs.includes(name) && typeof entry.call.args.body === 'string') {
        await fs.mkdir(path.join(root, 'quotes'), { recursive: true });
        await fs.writeFile(path.join(root, name), entry.call.args.body);
        return entry.call.args.body;
      }
      throw new Error('Unsupported quote tool call');
    },
    accept,
  };
  const agent: WorldAgent = { execute: async context => {
    const heads: number[] = [];
    const reuse = (index: number) => context.refresh?.reusedNodes.find(node =>
      node.sourceSeq === context.refresh?.previous.heads?.[index])?.replacementSeq;
    const write = async (name: string, body: string, dependencies: number[]) => {
      await fs.mkdir(path.join(context.forkRoot, 'quotes'), { recursive: true });
      await fs.writeFile(path.join(context.forkRoot, name), body);
      return context.record({ kind: 'mutate', call: { tool: 'write', args: { path: name, body } },
        resultHash: body }, dependencies);
    };
    for (const [index, customer] of quoteCustomers.entries()) {
      const reused = reuse(index);
      if (reused !== undefined) { heads.push(reused); continue; }
      // Each customer sees only its own order and selected SKU prices.
      const dependencies: number[] = [];
      const read = async (name: string) => {
        const body = await fs.readFile(path.join(context.forkRoot, name), 'utf8');
        const seq = await context.record({ kind: 'observe', call: { tool: 'read', args: { path: name } },
          resultHash: body }, [...dependencies]);
        dependencies.push(seq);
        return JSON.parse(body);
      };
      const order = await read(`orders/${customer}.json`);
      if (order.customer !== customer || !Array.isArray(order.lines) || !order.lines.length) throw new Error('Invalid order');
      let total = 0;
      const rows: string[] = [];
      for (const line of order.lines) {
        if (!quoteSkus.includes(line.sku) || safe(line.quantity) === 0) throw new Error('Invalid order line');
        const price = await read(`prices/${line.sku}.json`);
        if (price.sku !== line.sku) throw new Error('Invalid price identity');
        const amount = safe(safe(price.unitPriceCents) * line.quantity);
        total = safe(total + amount);
        rows.push(`| ${line.sku} | ${line.quantity} | ${money(price.unitPriceCents)} | ${money(amount)} |`);
      }
      const body = `# Quote ${customer}\n\n| SKU | Quantity | Unit price (CNY) | Amount (CNY) |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\nTotal (CNY): ${money(total)}\n`;
      heads.push(await write(`quotes/${customer}.md`, body, dependencies));
      generated.push(customer);
    }
    const summary = reuse(20);
    if (summary !== undefined) heads.push(summary);
    else {
      let total = 0;
      const rows: string[] = [];
      for (const customer of quoteCustomers) {
        const quote = await fs.readFile(path.join(context.forkRoot, 'quotes', `${customer}.md`), 'utf8');
        const match = /\nTotal \(CNY\): (\d+)\.(\d{2})\n$/.exec(quote);
        if (!match) throw new Error('Invalid quote total');
        const amount = safe(Number(match[1]) * 100 + Number(match[2]));
        total = safe(total + amount);
        rows.push(`| ${customer} | ${money(amount)} |`);
      }
      heads.push(await write('quotes/summary.md', `# Quote summary\n\n| Customer | Total (CNY) |\n| --- | ---: |\n${rows.join('\n')}\n\nTotal (CNY): ${money(total)}\n`, [...heads]));
      generated.push('summary');
    }
    return { coverage: { status: 'complete', manifestHash: context.version.manifestHash }, heads, artifacts: [] };
  } };
  return { adapter, agent, generated };
}
