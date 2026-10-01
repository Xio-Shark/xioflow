// Each fixture subcommand does what audit/README.md says, and the self-destruct timer works.
// Run: node --test audit/test/fixture.check.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isAlive, killMatching, taggedProcesses } from '../observe/ps.mjs';

const FIXTURE = path.join(import.meta.dirname, '../fixture/xf-fixture.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRun(run) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-fixture-check-'));
  const tag = `chk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const argv = (...args) => [FIXTURE, ...args, `--xf-run=${runDir}`, `--xf-tag=${tag}`];
  const marker = (name) => fs.readFileSync(path.join(runDir, name), 'utf8').trim().split(' ');
  const waitMarker = async (name) => {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(runDir, name)); i++) await sleep(25);
    assert.ok(fs.existsSync(path.join(runDir, name)), `marker ${name} never appeared`);
    return marker(name);
  };
  try {
    await run({ runDir, tag, argv, waitMarker });
  } finally {
    killMatching(`--xf-tag=${tag}`);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

test('effect appends one ledger line per run', async () => {
  await withRun(async ({ runDir, argv }) => {
    for (let i = 0; i < 2; i++) assert.match(spawnSync(process.execPath, argv('effect', 'A'), { encoding: 'utf8' }).stdout, /XF-EFFECT-DONE A/);
    assert.equal(fs.readFileSync(path.join(runDir, 'effects.log'), 'utf8').split('\n').filter(Boolean).length, 2);
  });
});

test('slow-effect performs the effect first and exits later', async () => {
  await withRun(async ({ runDir, argv, waitMarker }) => {
    const child = spawn(process.execPath, argv('slow-effect', 'S', '400'), { stdio: 'ignore' });
    await waitMarker('effect-S.started');
    assert.match(fs.readFileSync(path.join(runDir, 'effects.log'), 'utf8'), /^S /);
    assert.equal(child.exitCode, null);
    assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
  });
});

test('hold-pipe-after-exit: root exits with the given code while the holder keeps stdout open', async () => {
  await withRun(async ({ argv, waitMarker }) => {
    const child = spawn(process.execPath, argv('hold-pipe-after-exit', '1', '--exit=3'), { stdio: ['ignore', 'pipe', 'inherit'] });
    let closedAt;
    child.stdout.on('close', () => { closedAt = Date.now(); });
    const exitedAt = await new Promise((resolve) => child.on('exit', (code) => { assert.equal(code, 3); resolve(Date.now()); }));
    const [holderPid] = await waitMarker('pipe-holder.started');
    assert.ok(isAlive(Number(holderPid)));
    await waitMarker('pipe-holder.exited');
    await sleep(100);
    assert.ok(closedAt - exitedAt > 700, `stdout closed ${closedAt - exitedAt}ms after the root exited`);
  });
});

test('spawn-tree starts a chain and escape-setsid leaves its process group', async () => {
  await withRun(async ({ tag, argv, waitMarker }) => {
    const tree = spawn(process.execPath, argv('spawn-tree', '3'), { stdio: 'ignore' });
    await waitMarker('tree-1.started');
    assert.equal(taggedProcesses(tag).filter((p) => p.command.includes('spawn-tree')).length, 3);
    tree.kill('SIGKILL');

    const root = spawn(process.execPath, argv('escape-setsid'), { stdio: 'ignore' });
    const [escapedPid] = await waitMarker('escaped.started');
    const escaped = taggedProcesses(tag).find((p) => p.pid === Number(escapedPid));
    assert.ok(escaped, 'escaped process is running');
    assert.equal(escaped.pgid, escaped.pid, 'escaped process leads its own group');
    assert.notEqual(escaped.pgid, root.pid);
  });
});

test('ignore-signals survives SIGTERM and SIGINT, dies on SIGKILL', async () => {
  await withRun(async ({ runDir, argv, waitMarker }) => {
    const child = spawn(process.execPath, argv('ignore-signals'), { stdio: 'ignore' });
    await waitMarker('ignore-signals.started');
    child.kill('SIGTERM');
    child.kill('SIGINT');
    await sleep(300);
    assert.ok(isAlive(child.pid));
    const received = fs.readFileSync(path.join(runDir, 'signals.log'), 'utf8');
    assert.ok(received.includes('SIGTERM') && received.includes('SIGINT'), `signals.log: ${received}`);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  });
});

test('flood-output prints the requested volume and ends with the marker', async () => {
  await withRun(async ({ argv }) => {
    const out = spawnSync(process.execPath, argv('flood-output', '300000', '--tail=XF-TAIL-t'), { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout;
    assert.ok(out.startsWith('XF-HEAD XF-TAIL-t\n'));
    assert.ok(out.endsWith('XF-TAIL-t\n'));
    assert.ok(out.length >= 300000 && out.length < 400000, `got ${out.length} bytes`);
  });
});

test('write-files makes one change of each kind', async () => {
  await withRun(async ({ runDir, argv }) => {
    const work = path.join(runDir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'tracked.txt'), 'a\n');
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'u\n');
    spawnSync(process.execPath, argv('write-files'), { cwd: work });
    assert.match(fs.readFileSync(path.join(work, 'tracked.txt'), 'utf8'), /changed by xf-fixture/);
    assert.equal(fs.existsSync(path.join(work, 'untracked.txt')), false);
    assert.ok(fs.existsSync(path.join(work, 'ignored.tmp')) && fs.existsSync(path.join(work, 'created.txt')));
  });
});

test('mcp-server answers initialize and tools/list and stays up after stdin closes', async () => {
  await withRun(async ({ argv, waitMarker }) => {
    const child = spawn(process.execPath, argv('mcp-server'), { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < 2; i++) await sleep(20);
    const [init, tools] = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(init.result.serverInfo.name, 'xf-fixture');
    assert.equal(tools.result.tools[0].name, 'xf_noop');
    child.stdin.end();
    await waitMarker('mcp-server.stdin-closed');
    await sleep(200);
    assert.ok(isAlive(child.pid), 'the server does not exit on stdin EOF');
    child.kill('SIGKILL');
  });
});

test('every fixture process exits on its own after --xf-ttl', async () => {
  await withRun(async ({ tag, argv, waitMarker }) => {
    spawn(process.execPath, [...argv('escape-setsid', '30'), '--xf-ttl=1'], { stdio: 'ignore' });
    await waitMarker('escaped.started');
    assert.ok(taggedProcesses(tag).length >= 2);
    await sleep(1600);
    assert.equal(taggedProcesses(tag).length, 0);
  });
});
