import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CgroupPlatformDriver,
  ExecutionDomain,
  KernelMedium,
  LandlockConfinementDriver,
  NodePlatformDriver,
  ProcessSupervisor,
  ReaperPlatformDriver,
  WorkspaceArbiterClient,
  WorkspaceArbiterServer,
} from '../../dist/index.js';
import { initGitRepo, summarizeMs, systemEnvironmentMetadata, writeBenchmarkJson } from './_stats.mjs';

function parseArgs(argv) {
  const out = { iterations: 20, dockerIterations: 8, warmup: 3, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iterations' && argv[i + 1]) out.iterations = Number(argv[++i]);
    else if (a === '--docker-iterations' && argv[i + 1]) out.dockerIterations = Number(argv[++i]);
    else if (a === '--warmup' && argv[i + 1]) out.warmup = Number(argv[++i]);
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
  }
  return out;
}

async function timeAsync(fn) {
  const t0 = process.hrtime.bigint();
  const res = await fn();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { elapsedMs, res };
}

async function benchLoop(name, { warmup, iterations }, fn) {
  for (let i = 0; i < warmup; i++) await fn(`warmup-${i}`);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const { elapsedMs } = await timeAsync(() => fn(`iter-${i}`));
    samples.push(elapsedMs);
  }
  return { name, ...summarizeMs(samples) };
}

function spawnShellDirect(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`direct shell exited ${code}`));
    });
  });
}

function runCommandSync(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(' ')} exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

function dockerHasImage(image) {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await LandlockConfinementDriver.probe();
  const reaperAvailable = ReaperPlatformDriver.isAvailable();
  const cgroupAvailable = CgroupPlatformDriver.unavailableReason() === null;
  const landlockAbi = LandlockConfinementDriver.getAbiVersion();

  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xio-microbench-')));
  const repoDir = path.join(tempRoot, 'workspace');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(repoDir, 'src', `f${i}.js`), `export const v${i} = ${i};\n`, 'utf8');
  }
  fs.writeFileSync(path.join(repoDir, 'package.json'), '{"name":"bench-repo","type":"module"}\n', 'utf8');
  initGitRepo(repoDir);

  const nodeWorkCmd = `${JSON.stringify(process.execPath)} -e "const fs=require('fs'); for (let i=0;i<10;i++) fs.readFileSync('src/f'+i+'.js','utf8');"`;
  const noopCmd = 'true';
  const dockerNodeWorkCmd = 'node -e "const fs=require(\'fs\'); for (let i=0;i<10;i++) fs.readFileSync(\'/work/src/f\'+i+\'.js\',\'utf8\');"';

  const results = [];
  const skipped = [];

  try {
    // 1. Direct Node child_process
    results.push(await benchLoop('direct_child_process:noop', opts, () => spawnShellDirect(noopCmd, repoDir)));
    results.push(await benchLoop('direct_child_process:node10', opts, () => spawnShellDirect(nodeWorkCmd, repoDir)));

    // 2. NodePlatformDriver via ProcessSupervisor
    {
      const domain = ExecutionDomain.acquire(path.join(tempRoot, 'dom-node'), 'bench-node');
      try {
        const s = domain.getStore();
        s.saveTask({ id: 't1', domainId: domain.domainId, name: 'bench', createdAt: new Date().toISOString() });
        s.saveRun({ id: 'r1', taskId: 't1', domainId: domain.domainId, owner: 'bench', status: 'running', startedAt: new Date().toISOString() });
        const sup = new ProcessSupervisor(domain, new NodePlatformDriver());
        results.push(await benchLoop('supervisor_node_driver:node10', opts, (tag) =>
          sup.executeProcess({
            runId: 'r1',
            opId: `node-${tag}`,
            name: 'bench',
            command: { execPath: '/bin/sh', args: ['-c', nodeWorkCmd], cwd: repoDir, inheritEnv: true },
          }),
        ));
      } finally {
        domain.close();
      }
    }

    // 3. Reaper / Landlock / VFS modes via KernelMedium
    if (reaperAvailable) {
      const medium = await KernelMedium.open(repoDir, {
        domainPath: path.join(tempRoot, 'dom-medium'),
        driver: new ReaperPlatformDriver(),
      });
      try {
        results.push(await benchLoop('kernel_reaper:noop', opts, (tag) =>
          medium.exec({ opId: `noop-${tag}`, cmd: noopCmd }),
        ));
        results.push(await benchLoop('kernel_reaper:node10', opts, (tag) =>
          medium.exec({ opId: `bare-${tag}`, cmd: nodeWorkCmd }),
        ));
        if (process.platform === 'linux') {
          results.push(await benchLoop('kernel_reaper_vfs_ldpreload:node10', opts, (tag) =>
            medium.exec({ opId: `vfs-${tag}`, cmd: nodeWorkCmd, trackReads: true }),
          ));
        }
        if (landlockAbi > 0 || process.platform === 'darwin') {
          results.push(await benchLoop('kernel_reaper_confinement:node10', opts, (tag) =>
            medium.exec({ opId: `conf-${tag}`, cmd: nodeWorkCmd, confinement: true }),
          ));
        }
        if (process.platform === 'linux' && landlockAbi > 0) {
          results.push(await benchLoop('kernel_reaper_confinement_vfs:node10', opts, (tag) =>
            medium.exec({ opId: `both-${tag}`, cmd: nodeWorkCmd, confinement: true, trackReads: true }),
          ));
        }
        results.push(await benchLoop('kernel_vfs_tx_isolated_commit', { warmup: 2, iterations: Math.min(10, opts.iterations) }, (tag) =>
          medium.vfs_tx({
            txId: `tx-ok-${tag}`,
            isolated: true,
            mutations: [{ kind: 'write', path: 'src/f0.js', content: `export const v0 = "${tag}";\n` }],
            gateCmd: 'true',
          }),
        ));
        results.push(await benchLoop('kernel_vfs_tx_isolated_rollback', { warmup: 2, iterations: Math.min(10, opts.iterations) }, (tag) =>
          medium.vfs_tx({
            txId: `tx-rb-${tag}`,
            isolated: true,
            mutations: [{ kind: 'write', path: 'src/f0.js', content: `export const v0 = "bad-${tag}";\n` }],
            gateCmd: 'false',
          }),
        ));
      } finally {
        await medium.close();
      }
    } else {
      skipped.push({ name: 'kernel_reaper:*', reason: 'reaper binary unavailable' });
    }

    // 4. CgroupPlatformDriver
    if (cgroupAvailable) {
      const domain = ExecutionDomain.acquire(path.join(tempRoot, 'dom-cg'), 'bench-cg');
      try {
        const s = domain.getStore();
        s.saveTask({ id: 't1', domainId: domain.domainId, name: 'bench', createdAt: new Date().toISOString() });
        s.saveRun({ id: 'r1', taskId: 't1', domainId: domain.domainId, owner: 'bench', status: 'running', startedAt: new Date().toISOString() });
        const sup = new ProcessSupervisor(domain, new CgroupPlatformDriver());
        results.push(await benchLoop('supervisor_cgroup_v2:noop', opts, (tag) =>
          sup.executeProcess({
            runId: 'r1',
            opId: `cg-noop-${tag}`,
            name: 'bench',
            command: { execPath: '/bin/sh', args: ['-c', noopCmd], cwd: repoDir, inheritEnv: true },
          }),
        ));
        results.push(await benchLoop('supervisor_cgroup_v2:node10', opts, (tag) =>
          sup.executeProcess({
            runId: 'r1',
            opId: `cg-node-${tag}`,
            name: 'bench',
            command: { execPath: '/bin/sh', args: ['-c', nodeWorkCmd], cwd: repoDir, inheritEnv: true },
          }),
        ));
      } finally {
        domain.close();
      }
    } else {
      skipped.push({ name: 'supervisor_cgroup_v2:*', reason: CgroupPlatformDriver.unavailableReason() ?? 'unavailable' });
    }

    // 5. Cold KernelMedium.open vs Warm WorkspaceArbiterClient UDS RPC
    results.push(await benchLoop('kernel_cold_open_exec_close:noop', { warmup: 2, iterations: Math.min(12, opts.iterations) }, async (tag) => {
      const m = await KernelMedium.open(repoDir, {
        domainPath: path.join(tempRoot, `dom-cold-${tag}`),
      });
      try {
        await m.exec({ opId: `cold-${tag}`, cmd: noopCmd });
      } finally {
        await m.close();
      }
    }));

    {
      const arbDomain = path.join(tempRoot, 'dom-arbiter');
      const server = new WorkspaceArbiterServer({ workspaceRoot: repoDir, domainPath: arbDomain });
      const manifest = await server.start();
      const client = new WorkspaceArbiterClient(manifest, 'bench-client');
      await client.registerHello();
      try {
        results.push(await benchLoop('arbiter_uds_rpc:noop', opts, (tag) =>
          client.exec({ opId: `arb-noop-${tag}`, cmd: noopCmd }),
        ));
        results.push(await benchLoop('arbiter_uds_rpc:node10', opts, (tag) =>
          client.exec({ opId: `arb-node-${tag}`, cmd: nodeWorkCmd }),
        ));
      } finally {
        await client.close();
        await server.close();
      }
    }

    // 6. Docker baselines (persistent docker exec + ephemeral docker run --rm)
    let dockerOk = false;
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
      dockerOk = true;
    } catch {}

    if (dockerOk) {
      const dOpts = { warmup: 1, iterations: opts.dockerIterations };
      if (dockerHasImage('alpine:3.20')) {
        results.push(await benchLoop('docker_run_ephemeral_alpine:noop', dOpts, () =>
          runCommandSync('docker', ['run', '--rm', '-v', `${repoDir}:/work:ro`, 'alpine:3.20', '/bin/sh', '-c', 'true'], repoDir),
        ));
        const cid = execFileSync(
          'docker',
          ['run', '-d', '--rm', '-v', `${repoDir}:/work:ro`, 'alpine:3.20', '/bin/sh', '-c', 'sleep 120'],
          { encoding: 'utf8' },
        ).trim();
        try {
          results.push(await benchLoop('docker_exec_persistent_alpine:noop', dOpts, () =>
            runCommandSync('docker', ['exec', cid, '/bin/sh', '-c', 'true'], repoDir),
          ));
        } finally {
          try { execFileSync('docker', ['rm', '-f', cid], { stdio: 'ignore' }); } catch {}
        }
      } else {
        skipped.push({ name: 'docker_alpine:*', reason: 'image alpine:3.20 not present locally' });
      }

      if (dockerHasImage('node:22-bookworm-slim')) {
        results.push(await benchLoop('docker_run_ephemeral_node22:noop', dOpts, () =>
          runCommandSync('docker', ['run', '--rm', '-v', `${repoDir}:/work:ro`, 'node:22-bookworm-slim', '/bin/sh', '-c', 'true'], repoDir),
        ));
        results.push(await benchLoop('docker_run_ephemeral_node22:node10', dOpts, () =>
          runCommandSync('docker', ['run', '--rm', '-v', `${repoDir}:/work:ro`, 'node:22-bookworm-slim', '/bin/sh', '-c', dockerNodeWorkCmd], repoDir),
        ));
        const cid = execFileSync(
          'docker',
          ['run', '-d', '--rm', '-v', `${repoDir}:/work:ro`, 'node:22-bookworm-slim', '/bin/sh', '-c', 'sleep 120'],
          { encoding: 'utf8' },
        ).trim();
        try {
          results.push(await benchLoop('docker_exec_persistent_node22:node10', dOpts, () =>
            runCommandSync('docker', ['exec', cid, '/bin/sh', '-c', dockerNodeWorkCmd], repoDir),
          ));
        } finally {
          try { execFileSync('docker', ['rm', '-f', cid], { stdio: 'ignore' }); } catch {}
        }
      } else {
        skipped.push({ name: 'docker_node22:*', reason: 'image node:22-bookworm-slim not present locally' });
      }
    } else {
      skipped.push({ name: 'docker:*', reason: 'docker daemon unavailable' });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const report = {
    benchmark: 'microbench-baselines',
    env: systemEnvironmentMetadata(),
    capabilities: { reaperAvailable, cgroupAvailable, landlockAbi },
    config: opts,
    results,
    skipped,
  };
  writeBenchmarkJson(opts.output, report);

  console.log('\nMicrobenchmark Baselines Summary:');
  console.table(
    results.map((r) => ({
      name: r.name,
      n: r.n,
      p50_ms: r.p50Ms,
      p95_ms: r.p95Ms,
      mean_ms: r.meanMs,
      std_ms: r.stdMs,
    })),
  );
  if (skipped.length > 0) console.log('Skipped:', skipped);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
