#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SqliteStore } from './store/sqlite.js';
import { KernelMcpServer } from './mcp/server.js';
import { exportJournalToOtlp } from './otel/otlp.js';
import { wrapAgent } from './gateway/shell-shim.js';
import { LandlockConfinementDriver } from './confinement/landlock.js';
import { raceAgentsInVirtualWorkspaces, runInVirtualWorkspace } from './gateway/virtual-workspace.js';
import { forkGatewayRunAtStep, formatGatewayRunTrace, traceGatewayRun } from './gateway/time-fork.js';

const USAGE = `usage:
  xio wrap [--domain <dir>] [--domain-id <id>] [--run-id <id>] [--upstream-url <url>]
           [--shadow] [--gate <cmd>] [--timeout-ms <n>] [--max-output-bytes <n>] [--] <agent-cmd> [args...]
      Wrap an external agent process in a dual-boundary supervised gateway (optionally inside a shadow worktree).
  xio race [--domain <dir>] [--domain-id <id>] [--gate <cmd>] [--mode winner|merge] -- <cmd1> <cmd2> [...]
      Run multiple candidate agent commands in isolated shadow worktrees and reconcile via OCC + Early Cutoff.
  xio trace <runId> [--domain <dir>] [--domain-id <id>] [--json]
      Inspect the Flight Recorder Trace (LLM turns, tool calls, git-shadow snapshots, and HTTP-304 status) for a run.
  xio fork <runId> --at-step <N> [--fork-path <dir>] [--domain <dir>] [--domain-id <id>] [-- <new-agent-cmd> [args...]]
      Materialize the workspace snapshot from step N into an isolated worktree and fast-forward steps 1..N-1 via HTTP-304.
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

const WRAP_VALUE_FLAGS = new Set([
  '--domain',
  '--domain-id',
  '--run-id',
  '--upstream-url',
  '--timeout-ms',
  '--max-output-bytes',
  '--gate',
  '--mode',
  '--at-step',
  '--fork-path',
  '--otlp-endpoint',
  '--otlp-header',
  '--service-name',
]);

const WRAP_BOOLEAN_FLAGS = new Set(['--shadow', '--json']);

function splitWrapArgs(args: string[]): { wrapArgs: string[]; agentArgv: string[] } {
  const wrapArgs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--') {
      return { wrapArgs, agentArgv: args.slice(i + 1) };
    }
    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    if (WRAP_BOOLEAN_FLAGS.has(flagName)) {
      wrapArgs.push(arg);
      i += 1;
      continue;
    }
    if (WRAP_VALUE_FLAGS.has(flagName)) {
      wrapArgs.push(arg);
      if (eqIdx < 0 && i + 1 < args.length) {
        wrapArgs.push(args[i + 1]!);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    return { wrapArgs, agentArgv: args.slice(i) };
  }
  return { wrapArgs, agentArgv: [] };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  await LandlockConfinementDriver.probe();

  if (command === 'wrap') {
    const { wrapArgs, agentArgv } = splitWrapArgs(rest);
    if (agentArgv.length === 0) {
      throw new Error('wrap requires an agent command, e.g. xio wrap -- claude -p "..."');
    }
    const { values } = parseArgs({
      args: wrapArgs,
      options: {
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        'run-id': { type: 'string' },
        'upstream-url': { type: 'string' },
        'timeout-ms': { type: 'string' },
        'max-output-bytes': { type: 'string' },
        shadow: { type: 'boolean' },
        gate: { type: 'string' },
        'otlp-endpoint': { type: 'string' },
        'otlp-header': { type: 'string', multiple: true },
        'service-name': { type: 'string' },
      },
      strict: true,
    });
    const [agentCommand, ...agentArgs] = agentArgv;
    if (values.shadow || values.gate) {
      const shadowRes = await runInVirtualWorkspace({
        command: agentCommand!,
        args: agentArgs,
        workspaceRoot: process.cwd(),
        domainPath: values.domain ? path.resolve(values.domain) : undefined,
        domainId: values['domain-id'],
        runId: values['run-id'],
        upstreamUrl: values['upstream-url'],
        timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
        maxOutputBytes: values['max-output-bytes'] ? Number(values['max-output-bytes']) : undefined,
        gateCommand: values.gate,
        inheritStdio: true,
      });
      process.exitCode = shadowRes.status === 'committed' ? 0 : 1;
      return;
    }
    const result = await wrapAgent({
      command: agentCommand!,
      args: agentArgs,
      cwd: process.cwd(),
      domainPath: values.domain ? path.resolve(values.domain) : undefined,
      domainId: values['domain-id'],
      runId: values['run-id'],
      upstreamUrl: values['upstream-url'],
      timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
      maxOutputBytes: values['max-output-bytes'] ? Number(values['max-output-bytes']) : undefined,
      inheritStdio: true,
    });
    process.exitCode = result.exitCode ?? (result.signal ? 128 : 0);
    return;
  }

  if (command === 'race') {
    const { wrapArgs, agentArgv } = splitWrapArgs(rest);
    if (agentArgv.length < 1) {
      throw new Error('race requires candidate commands after --, e.g. xio race --gate "npm test" -- "cmd1" "cmd2"');
    }
    const { values } = parseArgs({
      args: wrapArgs,
      options: {
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        gate: { type: 'string' },
        mode: { type: 'string' },
      },
      strict: true,
    });
    const raceRes = await raceAgentsInVirtualWorkspaces({
      workspaceRoot: process.cwd(),
      domainPath: values.domain ? path.resolve(values.domain) : undefined,
      domainId: values['domain-id'],
      gateCommand: values.gate,
      mode: values.mode === 'winner' ? 'winner' : 'merge',
      candidates: agentArgv.map((cmdStr, idx) => ({
        id: `candidate-${idx + 1}`,
        command: '/bin/sh',
        args: ['-c', cmdStr],
      })),
    });
    process.stdout.write(`${JSON.stringify(raceRes)}\n`);
    process.exitCode = raceRes.committedCandidateIds.length > 0 ? 0 : 1;
    return;
  }

  if (command === 'trace') {
    const [runId, ...flagArgs] = rest;
    if (!runId || runId.startsWith('-')) {
      throw new Error('trace requires a <runId>, e.g. xio trace <runId>');
    }
    const { values } = parseArgs({
      args: flagArgs,
      options: {
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    });
    const trace = await traceGatewayRun({
      runId,
      workspaceRoot: process.cwd(),
      domainPath: values.domain ? path.resolve(values.domain) : undefined,
      domainId: values['domain-id'],
    });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatGatewayRunTrace(trace)}\n`);
    }
    return;
  }

  if (command === 'fork') {
    const [runId, ...afterRunId] = rest;
    if (!runId || runId.startsWith('-')) {
      throw new Error('fork requires <runId> --at-step <N>');
    }
    const { wrapArgs, agentArgv } = splitWrapArgs(afterRunId);
    const { values } = parseArgs({
      args: wrapArgs,
      options: {
        'at-step': { type: 'string' },
        'fork-path': { type: 'string' },
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        'upstream-url': { type: 'string' },
      },
      strict: true,
    });
    const atStep = Number(values['at-step']);
    if (!Number.isInteger(atStep) || atStep < 1) {
      throw new Error('fork requires --at-step <N> (1-indexed positive integer)');
    }
    const [agentCommand, ...agentArgs] = agentArgv;
    const forkRes = await forkGatewayRunAtStep({
      runId,
      atStep,
      workspaceRoot: process.cwd(),
      domainPath: values.domain ? path.resolve(values.domain) : undefined,
      domainId: values['domain-id'],
      forkPath: values['fork-path'],
      command: agentCommand,
      args: agentArgs,
      upstreamUrl: values['upstream-url'],
      inheritStdio: true,
    });
    process.stdout.write(`${JSON.stringify(forkRes)}\n`);
    process.exitCode = forkRes.agentResult ? (forkRes.agentResult.exitCode ?? 0) : 0;
    return;
  }

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

