#!/usr/bin/env node
// Fault fixture for the audit bench. Every process it starts carries --xf-tag=<runId> in its argv (so the runner
// can find and remove it even after it left its process group) and kills itself after --xf-ttl seconds.
// Usage: node xf-fixture.mjs <subcommand> [args] --xf-run=<dir> --xf-tag=<runId> [--xf-ttl=120]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const flags = {};
const args = [];
for (const arg of process.argv.slice(2)) {
  const match = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
  if (match) flags[match[1]] = match[2] ?? 'true';
  else args.push(arg);
}
const [subcommand, ...rest] = args;
const runDir = flags['xf-run'];
const tag = flags['xf-tag'];
const ttlSeconds = Number(flags['xf-ttl'] ?? 120);
if (!subcommand || !runDir || !tag) {
  console.error('usage: xf-fixture.mjs <subcommand> [args] --xf-run=<dir> --xf-tag=<runId>');
  process.exit(64);
}

// Nothing started here may outlive the run: the runner cleans up by tag, this is the backstop.
setTimeout(() => process.exit(99), ttlSeconds * 1000).unref();

const mark = (name, extra = '') => fs.writeFileSync(path.join(runDir, name), `${process.pid} ${Date.now()}${extra ? ` ${extra}` : ''}\n`);
const keepAlive = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // a ref'd timer keeps the process up
const self = (subArgs, options) => spawn(process.execPath, [
  process.argv[1], ...subArgs, `--xf-run=${runDir}`, `--xf-tag=${tag}`, `--xf-ttl=${ttlSeconds}`,
], options);
// Synchronous, so a marker printed right before exit is not lost in a pipe buffer.
const say = (line) => fs.writeSync(1, `${line}\n`);
const appendEffect = (id) => fs.appendFileSync(path.join(runDir, 'effects.log'), `${id} ${process.pid} ${Date.now()}\n`);

const commands = {
  /** A non-idempotent side effect: one line per execution. */
  async effect([id = 'A']) {
    mark(`effect-${id}.started`);
    appendEffect(id);
    say(`XF-EFFECT-DONE ${id}`);
  },

  /** The side effect happens at once, the process only exits later: the "done but not yet reported" window. */
  async 'slow-effect'([id = 'A', ms = '30000']) {
    appendEffect(id);
    mark(`effect-${id}.started`);
    await keepAlive(Number(ms));
    say(`XF-EFFECT-DONE ${id}`);
  },

  /** The root exits immediately; a child in the same process group keeps the inherited stdout/stderr open. */
  async 'hold-pipe-after-exit'([seconds = '20']) {
    const holder = self(['_hold', seconds], { stdio: ['ignore', 'inherit', 'inherit'] });
    holder.unref();
    say('XF-ROOT-EXIT');
    mark('pipe-root.exited', `holder=${holder.pid}`);
    process.exit(Number(flags.exit ?? 0));
  },
  async _hold([seconds]) {
    mark('pipe-holder.started');
    await keepAlive(Number(seconds) * 1000);
    mark('pipe-holder.exited');
  },

  /** A chain of children, all sleeping. */
  async 'spawn-tree'([depth = '3']) {
    mark(`tree-${depth}.started`);
    if (Number(depth) > 1) self(['spawn-tree', String(Number(depth) - 1)], { stdio: 'ignore' });
    await keepAlive(ttlSeconds * 1000);
  },

  /** Starts a descendant in its own session (it leaves the process group), then sleeps. */
  async 'escape-setsid'([rootSeconds = '0']) {
    const escaped = self(['_escaped'], { stdio: 'ignore', detached: true });
    escaped.unref();
    mark('escape-root.started', `escaped=${escaped.pid}`);
    say(`XF-ESCAPE-STARTED ${escaped.pid}`);
    if (Number(rootSeconds) > 0) await keepAlive(Number(rootSeconds) * 1000);
  },
  async _escaped() {
    mark('escaped.started');
    await keepAlive(ttlSeconds * 1000);
  },

  /** Ignores SIGINT / SIGTERM / SIGHUP: only SIGKILL stops it. */
  async 'ignore-signals'() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => fs.appendFileSync(path.join(runDir, 'signals.log'), `${signal} ${Date.now()}\n`));
    mark('ignore-signals.started');
    say('XF-IGNORING-SIGNALS');
    await keepAlive(ttlSeconds * 1000);
  },

  /** Writes <bytes> of numbered lines and ends with a marker line, to see what survives truncation. */
  async 'flood-output'([bytes = '1048576']) {
    const marker = flags.tail ?? 'XF-TAIL';
    mark('flood.started');
    say(`XF-HEAD ${marker}`);
    const line = `${'x'.repeat(98)}\n`;
    const block = line.repeat(640); // ~64 KiB per write
    let written = 0;
    const total = Number(bytes);
    while (written < total) {
      const chunk = written + block.length > total ? block.slice(0, Math.ceil((total - written) / line.length) * line.length) : block;
      if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once('drain', resolve));
      written += chunk.length;
    }
    await new Promise((resolve) => process.stdout.write(`${marker}\n`, resolve));
    mark('flood.done', `bytes=${written}`);
  },

  /** One change of each kind a rollback has to account for. cwd must be the workspace. */
  async 'write-files'() {
    mark('write-files.started');
    fs.appendFileSync('tracked.txt', 'changed by xf-fixture\n');
    fs.rmSync('untracked.txt', { force: true });
    fs.writeFileSync('ignored.tmp', 'written by xf-fixture\n');
    fs.writeFileSync('created.txt', 'created by xf-fixture\n');
    say('XF-WRITE-FILES-DONE');
  },

  /** Minimal stdio MCP server: answers initialize / tools/list, then stays up until stdin closes or the ttl. */
  async 'mcp-server'() {
    mark('mcp-server.started');
    let buffer = '';
    const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'initialize') {
          reply(message.id, { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'xf-fixture', version: '0.0.0' } });
        } else if (message.method === 'tools/list') {
          reply(message.id, { tools: [{ name: 'xf_noop', description: 'Does nothing.', inputSchema: { type: 'object', properties: {} } }] });
        } else if (message.method === 'ping') {
          reply(message.id, {});
        } else if (message.id !== undefined) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })}\n`);
        }
      }
    });
    process.stdin.on('end', () => fs.appendFileSync(path.join(runDir, 'mcp-server.stdin-closed'), `${Date.now()}\n`));
    // Deliberately does not exit on stdin EOF: whether the harness stops it is what the scenario observes.
    await keepAlive(ttlSeconds * 1000);
  },
};

if (!commands[subcommand]) {
  console.error(`xf-fixture: unknown subcommand ${subcommand}`);
  process.exit(64);
}
await commands[subcommand](rest);
