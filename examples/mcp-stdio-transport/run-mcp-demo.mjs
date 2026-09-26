#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ExecutionDomain, ProcessSupervisor } from '@xioflow/kernel';
import { KernelStdioTransport } from './kernel-transport.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, 'server.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xioflow-mcp-demo-'));

console.log('================================================================');
console.log('MCP Stdio Transport Demonstration using @xioflow/kernel');
console.log('================================================================\n');

const domain = ExecutionDomain.acquire(tempDir, 'mcp-demo-domain');
const store = domain.getStore();
const supervisor = new ProcessSupervisor(domain);

const taskId = 'task-mcp-demo';
const runId = 'run-mcp-demo-1';
store.saveTask({
  id: taskId,
  domainId: domain.domainId,
  name: 'MCP Demo Task',
  createdAt: new Date().toISOString(),
});
store.saveRun({
  id: runId,
  taskId,
  domainId: domain.domainId,
  owner: 'demo-runner',
  status: 'running',
  startedAt: new Date().toISOString(),
});

console.log('1. Initializing KernelStdioTransport with service supervision...');
const transport = new KernelStdioTransport({
  supervisor,
  spec: {
    serviceId: 'sample-mcp-server',
    runId,
    command: {
      execPath: process.execPath,
      args: [serverScript],
      cwd: __dirname,
    },
    readiness: 'spawned',
    restart: { policy: 'on-failure', maxRestarts: 2, backoffMs: 100 },
  },
  graceMs: 1500,
});

const client = new Client(
  {
    name: 'mcp-kernel-client',
    version: '1.0.0',
  },
  {
    capabilities: {},
  }
);

console.log('2. Connecting MCP Client to Kernel Transport (initialize handshake)...');
await client.connect(transport);
console.log('   - MCP Client connected successfully!');

const op = store.getOperation('sample-mcp-server#1');
const serverPid = op?.processIdentity?.pid;
console.log(`   - Supervised Server PID: ${serverPid}`);
console.log(`   - Kernel Operation ID: ${op?.id} (status: ${op?.status})`);

console.log('\n3. Calling tools/list...');
const toolsResult = await client.listTools();
console.log('   - Tools discovered:', toolsResult.tools.map((t) => t.name));

console.log('\n4. Executing tool call: add(15, 27)...');
const callResult = await client.callTool({
  name: 'add',
  arguments: { a: 15, b: 27 },
});
console.log('   - Tool output:', callResult.content[0].text);

console.log('\n5. Closing MCP Client and stopping supervised service...');
await client.close();
console.log('   - Client closed.');

console.log('\n6. Verifying clean process termination in the OS...');
let processAlive = true;
try {
  process.kill(serverPid, 0);
} catch (err) {
  if (err.code === 'ESRCH') {
    processAlive = false;
  }
}

// Additional verification with ps command
let psOutput = '';
try {
  psOutput = execFileSync('ps', ['-p', String(serverPid), '-o', 'pid,stat,command'], { encoding: 'utf8' });
} catch {
  // ps exits non-zero if PID does not exist
  psOutput = '';
}

const isZombieOrDead = !processAlive || psOutput.includes('Z');
console.log(`   - Server PID ${serverPid} alive in OS: ${processAlive}`);
console.log(`   - Verified 0 orphan processes leaked: ${isZombieOrDead ? 'YES' : 'NO'}`);

domain.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {}

if (!isZombieOrDead) {
  console.error('\nFAIL: MCP Server process leaked!');
  process.exit(1);
} else {
  console.log('\nPASS: MCP Stdio Transport ran cleanly with 0 process leaks!');
}
