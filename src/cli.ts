#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SqliteStore } from './store/sqlite.js';
import { KernelMcpServer } from './mcp/server.js';
import { exportJournalToOtlp } from './otel/otlp.js';

const USAGE = `usage:
  xioflow mcp [--domain <dir>] [--domain-id <id>] [--driver auto|node|reaper]
              [--otlp-endpoint <url>] [--otlp-header k=v ...] [--otlp-interval-ms <n>]
      Serve the kernel as an MCP server on stdio (recovers the domain first).
  xioflow otel-export --otlp-endpoint <url> [--domain <dir>] [--domain-id <id>] [--from-seq <n>]
                      [--otlp-header k=v ...] [--service-name <name>]
      Export the domain journal as OTLP traces once (read-only; works while a server holds the domain).

  --domain defaults to ./.xioflow-kernel`;

function headers(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const i = v.indexOf('=');
    if (i <= 0) throw new Error(`--otlp-header expects key=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      domain: { type: 'string' },
      'domain-id': { type: 'string' },
      driver: { type: 'string' },
      'otlp-endpoint': { type: 'string' },
      'otlp-header': { type: 'string', multiple: true },
      'otlp-interval-ms': { type: 'string' },
      'from-seq': { type: 'string' },
      'service-name': { type: 'string' },
    },
    strict: true,
  });
  const domainPath = path.resolve(values.domain ?? '.xioflow-kernel');
  const domainId = values['domain-id'] ?? 'default';

  if (command === 'mcp') {
    const driver = values.driver ?? 'auto';
    if (driver !== 'auto' && driver !== 'node' && driver !== 'reaper') throw new Error(`--driver must be auto, node or reaper`);
    const endpoint = values['otlp-endpoint'];
    await new KernelMcpServer({
      domainPath,
      domainId,
      driver,
      otlp: endpoint
        ? {
            endpoint,
            headers: headers(values['otlp-header']),
            intervalMs: values['otlp-interval-ms'] ? Number(values['otlp-interval-ms']) : undefined,
            serviceName: values['service-name'],
          }
        : undefined,
    }).serve();
    return;
  }

  if (command === 'otel-export') {
    const endpoint = values['otlp-endpoint'];
    if (!endpoint) throw new Error('otel-export needs --otlp-endpoint');
    const dbPath = path.join(domainPath, 'domain.db');
    if (!fs.existsSync(dbPath)) throw new Error(`no kernel domain at ${domainPath} (missing domain.db)`);
    const store = new SqliteStore(dbPath);
    try {
      const res = await exportJournalToOtlp(
        { domainId, getStore: () => store },
        {
          endpoint,
          headers: headers(values['otlp-header']),
          fromSeq: values['from-seq'] ? Number(values['from-seq']) : 0,
          serviceName: values['service-name'],
        }
      );
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } finally {
      store.close();
    }
    return;
  }

  process.stderr.write(`${USAGE}\n`);
  process.exitCode = command ? 64 : 0;
}

main().catch((err) => {
  process.stderr.write(`xioflow: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
