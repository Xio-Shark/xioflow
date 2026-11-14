import { parseArgs } from 'node:util';
import { WorkspaceArbiterServer } from './server.js';

async function runDaemon(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      workspace: { type: 'string' },
      domain: { type: 'string' },
      'domain-id': { type: 'string' },
      'idle-timeout-ms': { type: 'string' },
    },
    strict: true,
  });

  if (!values.workspace) {
    throw new Error('arbiter daemon requires --workspace <path>');
  }

  const idleTimeoutMs = values['idle-timeout-ms'] ? Number(values['idle-timeout-ms']) : 300_000;
  const server = new WorkspaceArbiterServer({
    workspaceRoot: values.workspace,
    domainPath: values.domain,
    domainId: values['domain-id'],
    idleTimeoutMs,
    onIdleShutdown: () => {
      process.exit(0);
    },
  });

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await server.start();
}

runDaemon().catch((err) => {
  process.stderr.write(`xio-arbiter: ${err?.message ?? err}\n`);
  process.exit(1);
});
