#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { SqliteStore } from './store/sqlite.js';
import { KernelMcpServer } from './mcp/server.js';
import { exportJournalToOtlp } from './otel/otlp.js';
import { wrapAgent } from './gateway/shell-shim.js';
import { createConfinementDriver, detectAvailableConfinementDrivers, LandlockConfinementDriver } from './confinement/index.js';
import { CgroupPlatformDriver } from './driver/cgroup-driver.js';
import { locateNativeShimLibrary, locateReaperHelper, ReaperPlatformDriver } from './driver/reaper-driver.js';
import { defaultDomainPathForWorkspace, KernelMedium } from './kernel/medium.js';
import { isProcessAlive, readArbiterManifest } from './arbiter/protocol.js';
import { raceAgentsInVirtualWorkspaces, runInVirtualWorkspace } from './gateway/virtual-workspace.js';
import { forkGatewayRunAtStep, formatGatewayRunTrace, traceGatewayRun } from './gateway/time-fork.js';
import { executeIsaProgram, isaResultExitCode } from './adapters/isa.js';
import { connectWorkspace, WorkspaceArbiterClient, WorkspaceArbiterServer } from './arbiter/index.js';

const execFileAsync = promisify(execFile);

const USAGE = `usage:
  OS Medium & Arbiter:
    xioflow mcp [--workspace <dir>] [--domain <dir>] [--domain-id <id>] [--surface v2|legacy]
                [--driver auto|node|reaper] [--otlp-endpoint <url>] [--otlp-header k=v ...] [--otlp-interval-ms <n>]
        Serve the OS medium as an MCP server on stdio (4 golden primitives by default via shared Micro-Arbiter).
    xio status [--domain <dir>] [--domain-id <id>] [--json]
        Connect to (or start) the workspace Micro-Arbiter and print live workspace, git, and managed process state.
    xio doctor [--workspace <dir>] [--domain <dir>] [--json]
        Inspect Node, git, native reaper/shim, OS confinement drivers, cgroup v2, and arbiter socket readiness.
    xio prune [--workspace <dir>] [--domain <dir>] [--domain-id <id>] [--max-age-hours <n>] [--json]
        Prune expired artifacts, unreferenced spill/log blobs, and orphaned transaction forks (default >24h).
    xio arbiter <serve|stop> [--domain <dir>] [--domain-id <id>] [--idle-timeout-ms <n>]
        Explicitly serve or stop the workspace-scoped UDS Micro-Arbiter.

  Agent Gateway & Time-Travel:
    xio wrap [--domain <dir>] [--domain-id <id>] [--run-id <id>] [--upstream-url <url>]
             [--shadow] [--gate <cmd>] [--timeout-ms <n>] [--max-output-bytes <n>] [--] <agent-cmd> [args...]
        Wrap an external agent process in a dual-boundary supervised gateway (optionally inside a shadow worktree).
    xio race [--domain <dir>] [--domain-id <id>] [--gate <cmd>] [--mode winner|merge] -- <cmd1> <cmd2> [...]
        Run multiple candidate agent commands in isolated shadow worktrees and reconcile via OCC + Early Cutoff.
    xio trace <runId> [--domain <dir>] [--domain-id <id>] [--json]
        Inspect the Flight Recorder Trace (LLM turns, tool calls, git-shadow snapshots, and HTTP-304 status) for a run.
    xio fork <runId> --at-step <N> [--fork-path <dir>] [--domain <dir>] [--domain-id <id>] [-- <new-agent-cmd> [args...]]
        Materialize the workspace snapshot from step N into an isolated worktree and fast-forward steps 1..N-1 via HTTP-304.
    xioflow otel-export --otlp-endpoint <url> [--domain <dir>] [--domain-id <id>] [--from-seq <n>]
                        [--otlp-header k=v ...] [--service-name <name>]
        Export the domain journal as OTLP traces once (read-only; works while a server holds the domain).

  Preview Adapter:
    xio plan --input <program.json|->
        Preview: structurally validate an ISA Program without acquiring a domain or executing effects.
    xio execute --input <program.json|->
        Submit an ISA Program through the preview adapter (requires host binding).

  General:
    xio --help | -h          Show this help text
    xio --version | -v       Show package version

  --domain defaults to the workspace domain under ~/.xioflow/domains/<hash> (or ./.xioflow-kernel for legacy/gateway commands)`;

function readPackageMeta(): { name: string; version: string } {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
    return { name: raw.name ?? '@xioflow/kernel', version: raw.version ?? '0.0.0' };
  } catch {
    return { name: '@xioflow/kernel', version: '0.0.0' };
  }
}

async function runDoctorCommand(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      workspace: { type: 'string' },
      domain: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const meta = readPackageMeta();
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const resolvedDomain = values.domain ? path.resolve(values.domain) : defaultDomainPathForWorkspace(workspace);
  const directSocket = path.join(resolvedDomain, 'arb.sock');
  const directSocketBytes = Buffer.byteLength(directSocket, 'utf8');

  const [majorStr, minorStr] = process.versions.node.split('.');
  const nodeMajor = Number(majorStr);
  const nodeMinor = Number(minorStr);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);

  let gitVersion: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 2000, encoding: 'utf8' });
    gitVersion = stdout.trim();
  } catch {}

  const reaperPath = locateReaperHelper();
  const shimPath = locateNativeShimLibrary();
  const reaperAvailable = ReaperPlatformDriver.isAvailable();
  let reaperProtocol: unknown = null;
  if (reaperAvailable) {
    try {
      reaperProtocol = await new ReaperPlatformDriver().getProtocolInfo();
    } catch {}
  }

  if (process.platform === 'linux') {
    await LandlockConfinementDriver.probe();
  }
  const confinementDrivers = detectAvailableConfinementDrivers();
  const recommendedConfinement = createConfinementDriver()?.name ?? null;
  const cgroupReason = CgroupPlatformDriver.unavailableReason();

  const warnings: string[] = [];
  if (!nodeOk) warnings.push(`Node ${process.version} is below >=22.13.0`);
  if (!gitVersion) warnings.push('git executable not found (git-shadow snapshots & vfs_tx isolated branches unavailable)');
  if (!reaperAvailable) warnings.push('native xioflow-reaper not found; falling back to NodePlatformDriver');
  if (confinementDrivers.length === 0) warnings.push('no OS write confinement driver detected');

  const report = {
    package: meta.name,
    version: meta.version,
    platform: `${process.platform}-${process.arch}`,
    node: { version: process.version, supported: nodeOk },
    git: { available: gitVersion !== null, version: gitVersion },
    driver: {
      default: reaperAvailable ? 'reaper' : 'node',
      reaperAvailable,
      reaperPath,
      reaperProtocol,
      nativeShimPath: shimPath,
      cgroupV2: { available: cgroupReason === null, unavailableReason: cgroupReason },
    },
    confinement: {
      availableDrivers: confinementDrivers,
      recommended: recommendedConfinement,
      landlockAbi: LandlockConfinementDriver.getAbiVersion(),
    },
    arbiterSocket: {
      domainPath: resolvedDomain,
      directPath: directSocket,
      directPathBytes: directSocketBytes,
      usesShortRunFallback: directSocketBytes > 96,
    },
    ready: nodeOk && gitVersion !== null,
    warnings,
  };

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [
      `${meta.name} v${meta.version} (${report.platform})`,
      `node:        ${report.node.version} (${report.node.supported ? 'ok' : 'unsupported <22.13.0'})`,
      `git:         ${report.git.version ?? 'MISSING'}`,
      `driver:      ${report.driver.default} (reaper=${reaperAvailable ? 'yes' : 'no'}, shim=${shimPath ? 'yes' : 'no'})`,
      `confinement: ${confinementDrivers.length > 0 ? confinementDrivers.join(', ') : 'none'} (recommended=${recommendedConfinement ?? 'none'})`,
      `cgroup v2:   ${report.driver.cgroupV2.available ? 'available' : `unavailable (${cgroupReason ?? 'unknown'})`}`,
      `arbiter ipc: ${report.arbiterSocket.usesShortRunFallback ? 'short fallback (~/.xioflow/run)' : directSocket} (${directSocketBytes} bytes)`,
      ...(warnings.length > 0 ? [`warnings:    ${warnings.join('; ')}`] : []),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode = report.ready ? 0 : 1;
}

async function runPruneCommand(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      workspace: { type: 'string' },
      domain: { type: 'string' },
      'domain-id': { type: 'string' },
      'max-age-hours': { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const workspace = fs.realpathSync(path.resolve(values.workspace ?? process.cwd()));
  const domainPath = values.domain ? path.resolve(values.domain) : defaultDomainPathForWorkspace(workspace);
  const maxAgeHours = values['max-age-hours'] !== undefined ? Number(values['max-age-hours']) : 24;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new Error('--max-age-hours must be a non-negative number');
  }
  const maxAgeMs = Math.round(maxAgeHours * 60 * 60 * 1000);

  const manifest = readArbiterManifest(domainPath);
  const liveArbiter = manifest !== null && isProcessAlive(manifest.pid);
  const dbExists = fs.existsSync(path.join(domainPath, 'domain.db'));

  if (!liveArbiter && !dbExists) {
    const emptyRes = {
      skipped: true,
      reason: 'no kernel domain found',
      domainPath,
      deletedArtifacts: 0,
      deletedBlobs: 0,
      deletedForks: 0,
      freedBytes: 0,
    };
    process.stdout.write(
      values.json ? `${JSON.stringify(emptyRes, null, 2)}\n` : `prune skipped: no kernel domain at ${domainPath}\n`,
    );
    return;
  }

  let res: { deletedArtifacts: number; deletedBlobs: number; deletedForks: number; freedBytes: number };
  if (liveArbiter) {
    const medium = await connectWorkspace(workspace, {
      domainPath,
      domainId: values['domain-id'],
      mode: 'arbiter',
    });
    try {
      res = await (medium as WorkspaceArbiterClient).prune({ maxAgeMs });
    } finally {
      await medium.close();
    }
  } else {
    const medium = await KernelMedium.open(workspace, {
      domainPath,
      domainId: values['domain-id'],
    });
    try {
      res = medium.prune({ maxAgeMs });
    } finally {
      await medium.close();
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ domainPath, maxAgeHours, ...res }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `pruned ${domainPath}: ${res.deletedArtifacts} artifacts, ${res.deletedBlobs} blobs, ${res.deletedForks} forks (${res.freedBytes} bytes freed)\n`,
    );
  }
}

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

const WRAP_BOOLEAN_FLAGS = new Set(['--shadow', '--json', '--persist-raw-prompts']);

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

const HELP_SUBCOMMANDS = new Set(['status', 'doctor', 'prune', 'arbiter', 'mcp', 'otel-export', 'trace', 'plan', 'execute']);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const meta = readPackageMeta();
    process.stdout.write(`${meta.name} v${meta.version}\n`);
    process.exitCode = 0;
    return;
  }
  if (HELP_SUBCOMMANDS.has(command) && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (command === 'doctor') {
    await runDoctorCommand(rest);
    return;
  }
  if (command === 'prune') {
    await runPruneCommand(rest);
    return;
  }
  if (command === 'plan' || command === 'execute') {
    const { values } = parseArgs({ args: rest, options: { input: { type: 'string' } }, strict: true });
    if (!values.input) throw new Error(`${command} requires --input <program.json|->`);
    const source = fs.readFileSync(values.input === '-' ? 0 : path.resolve(values.input), 'utf8');
    const program: unknown = JSON.parse(source);
    const result = await executeIsaProgram(program, { mode: command === 'plan' ? 'plan' : undefined });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = isaResultExitCode(result);
    return;
  }
  await LandlockConfinementDriver.probe();

  if (command === 'status') {
    const { values } = parseArgs({
      args: rest,
      options: {
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    });
    const medium = await connectWorkspace(process.cwd(), {
      domainPath: values.domain ? path.resolve(values.domain) : undefined,
      domainId: values['domain-id'],
    });
    try {
      const obs = await medium.observe();
      if (values.json) {
        process.stdout.write(`${JSON.stringify(obs, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            `workspace: ${obs.workspaceRoot}`,
            `domain:    ${obs.domainId} (epoch ${obs.epoch})`,
            `git:       ${obs.git.isRepo ? `${obs.git.branch ?? 'detached'}@${obs.git.head ?? 'unborn'} (${obs.git.dirtyFiles.length} dirty)` : 'not a git repository'}`,
            `processes: ${obs.activeProcesses.length} running`,
          ].join('\n') + '\n',
        );
      }
    } finally {
      await medium.close();
    }
    return;
  }

  if (command === 'arbiter') {
    const [sub, ...arbArgs] = rest;
    const { values } = parseArgs({
      args: arbArgs,
      options: {
        domain: { type: 'string' },
        'domain-id': { type: 'string' },
        'idle-timeout-ms': { type: 'string' },
      },
      strict: true,
    });
    if (sub === 'stop') {
      const medium = await connectWorkspace(process.cwd(), {
        domainPath: values.domain ? path.resolve(values.domain) : undefined,
        domainId: values['domain-id'],
      });
      if (medium instanceof WorkspaceArbiterClient) {
        await medium.shutdownArbiter();
      } else {
        await medium.close();
      }
      process.stdout.write('arbiter stopped\n');
      return;
    }
    if (sub === 'serve') {
      const server = new WorkspaceArbiterServer({
        workspaceRoot: process.cwd(),
        domainPath: values.domain ? path.resolve(values.domain) : undefined,
        domainId: values['domain-id'],
        idleTimeoutMs: values['idle-timeout-ms'] ? Number(values['idle-timeout-ms']) : 300_000,
        onIdleShutdown: () => process.exit(0),
      });
      const manifest = await server.start();
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
      return;
    }
    throw new Error('arbiter expects subcommand: serve | stop');
  }

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
        'persist-raw-prompts': { type: 'boolean' },
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
        persistRawPrompts: values['persist-raw-prompts'] === true,
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
      persistRawPrompts: values['persist-raw-prompts'] === true,
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
      workspace: { type: 'string' },
      domain: { type: 'string' },
      'domain-id': { type: 'string' },
      driver: { type: 'string' },
      surface: { type: 'string' },
      'otlp-endpoint': { type: 'string' },
      'otlp-header': { type: 'string', multiple: true },
      'otlp-interval-ms': { type: 'string' },
      'from-seq': { type: 'string' },
      'service-name': { type: 'string' },
    },
    strict: true,
  });
  const domainPath = values.domain ? path.resolve(values.domain) : undefined;
  const domainId = values['domain-id'];

  if (command === 'mcp') {
    const driver = values.driver ?? 'auto';
    if (driver !== 'auto' && driver !== 'node' && driver !== 'reaper') throw new Error(`--driver must be auto, node or reaper`);
    const surface = values.surface ?? 'v2';
    if (surface !== 'v2' && surface !== 'legacy') throw new Error(`--surface must be v2 or legacy`);
    const endpoint = values['otlp-endpoint'];
    await new KernelMcpServer({
      workspaceRoot: values.workspace ? path.resolve(values.workspace) : process.cwd(),
      domainPath: domainPath ?? (surface === 'legacy' ? path.resolve('.xioflow-kernel') : undefined),
      domainId,
      driver,
      surface,
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
    const resolvedDomain = domainPath ?? path.resolve('.xioflow-kernel');
    const dbPath = path.join(resolvedDomain, 'domain.db');
    if (!fs.existsSync(dbPath)) throw new Error(`no kernel domain at ${resolvedDomain} (missing domain.db)`);
    const store = new SqliteStore(dbPath);
    try {
      const res = await exportJournalToOtlp(
        { domainId: domainId ?? 'default', getStore: () => store },
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

