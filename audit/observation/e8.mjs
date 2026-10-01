#!/usr/bin/env node
// Approved real-model pilot: synthetic code only; persistent cumulative $10 cap.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentRuntime, ExecutionDomain, ProcessSupervisor, recoverAgentWorkspace } from '../../dist/index.js';
import { loadXiocode, openModel } from '../lib/xiocode.mjs';
import { GoExperimentBudget } from '../lib/go-budget.mjs';
import { scrubSecrets } from '../lib/secret-scan.mjs';
import { runXiocodeQuantum } from './xiocode-quantum.mjs';
import { createRenameFixture, applyCompetingChange, checkRenameFixture } from './rename-fixture.mjs';

const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex < 0 ? 'comment' : process.argv[scenarioIndex + 1];
assert.ok(['comment', 'new-caller'].includes(scenario), 'Use --scenario comment or new-caller');

const resultsDir = path.resolve(import.meta.dirname, '../results/real-model');
fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
const budget = new GoExperimentBudget(path.join(resultsDir, 'go-deepseek-approved-2026-10-01.sqlite'));
const configured = await openModel({ provider: 'opencodego', model: 'deepseek-v4.1-flash' });
const { registration, modelId } = configured;
const nativeAuth = process.argv.includes('--opencode-auth');
let apiKey = configured.apiKey;
if (nativeAuth) {
  const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/share/opencode/auth.json'), 'utf8'));
  const go = auth['opencode-go'] ?? auth.opencodego;
  if (go?.type !== 'api' || typeof go.key !== 'string' || !go.key) throw new Error('OpenCode Go API credential missing');
  apiKey = go.key;
}
const { createLlmClient } = await loadXiocode('src/runtime/providers/client.ts');
const { observationValidation } = await loadXiocode('src/runtime/parallel-observations.ts');
const trial = `e8-${crypto.randomUUID().slice(0, 8)}`;
const clients = new Map();

function clientFor(label) {
  if (clients.has(label)) return clients.get(label);
  const native = createLlmClient({
    registration: { ...registration, sessionHeader: 'x-opencode-session' }, apiKey,
    identity: { userAgent: 'xioflow-audit/0.6.0', sessionId: `${trial}-${label}` },
    fetchRetryOptions: { maxRetries: 0 },
    fetchImpl: (url, init) => budget.fetch(`${trial}:${label}`, url, init),
  });
  const client = { async complete(request, options) {
    const serialized = JSON.stringify(request.messages);
    if (scrubSecrets(serialized).kinds.length || serialized.includes(apiKey) || serialized.includes(path.join(os.homedir(), 'code') + path.sep)) {
      throw new Error('Outbound fixture payload contains forbidden local data');
    }
    const result = await native.complete({ ...request, model: modelId, maxTokens: 4096 }, options);
    if (result.raw?.choices?.[0]?.finish_reason === 'length') throw new Error('Provider output truncated at token limit');
    console.log(JSON.stringify({ trial, phase: label, reportedModel: result.raw?.model, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens }));
    return result;
  } };
  clients.set(label, client);
  return client;
}

if (process.argv.includes('--probe')) {
  try {
    const result = await clientFor('probe').complete({ model: modelId, messages: [{ role: 'user', content: 'Reply only READY.' }], tools: [] });
    console.log(JSON.stringify({ provider: 'opencodego', model: modelId, credentialSource: nativeAuth ? 'opencode-go' : 'xiocode', reply: result.content, budget: budget.report() }));
  } catch (error) {
    console.error(scrubSecrets(String(error).split(apiKey).join('<key>')).clean);
    console.log(JSON.stringify({ budget: budget.report() }));
    process.exitCode = 1;
  } finally { budget.close(); }
} else {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-real-pilot-')));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  createRenameFixture(root, scenario);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'synthetic fixture');
  const domain = ExecutionDomain.acquire(path.join(temp, 'domain'), trial);
  const supervisor = new ProcessSupervisor(domain);
  let initial = true;
  let phase = 'initial';
  const instruction = 'Rename the exported function foo in util.mjs to bar and update every use across this small repository. Preserve all other behavior and comments. Inspect files before editing. Use only relative paths. Do not create new files. No terminal is available. Make exactly one tool call per response. Once finished, briefly summarize.';
  const agents = new AgentRuntime(domain, { maxConcurrentAgents: 1, step: async (agent) => {
    const result = await runXiocodeQuantum(agent, clientFor(agent.id === 'baseline' ? 'baseline' : phase));
    if (agent.id === 'a' && initial && result.checkpoint.log.some((entry) => entry.kind === 'mutate')) {
      initial = false; agents.pause('a');
    }
    return result;
  } });
  const timings = {};
  const resumeFirst = process.argv.includes('--resume-first');
  const record = { experiment: 'e8-real-model-pilot', trial, provider: 'opencodego', model: modelId,
    scenario, adapter: 'tool-errors-returned-v1', order: resumeFirst ? 'resumed-first' : 'baseline-first', status: 'running' };

  function check(workspace) {
    return checkRenameFixture(workspace, scenario, temp);
  }
  async function drain(label) {
    const start = performance.now(); await agents.drain(); timings[label] = performance.now() - start;
  }
  function requireState(id, expected) {
    const agent = agents.get(id);
    if (agent.status !== expected) throw new Error(`${id}: ${agent.status} (${agent.reason}): ${agent.error ?? 'no error'}`);
    return agent;
  }
  async function create(id) {
    const workspace = await supervisor.beginWorkspaceTransaction({ txId: id, runId: 'run', root, forkPath: path.join(temp, id) });
    agents.create({ id, runId: 'run', workspace, input: { instruction }, checkpoint: { snapshot: null, log: [] }, maxSteps: scenario === 'new-caller' ? 48 : 24 });
    return workspace;
  }

  try {
    const store = domain.getStore();
    store.saveTask({ id: 'task', domainId: domain.domainId, name: 'synthetic rename', createdAt: new Date().toISOString() });
    store.saveRun({ id: 'run', taskId: 'task', domainId: domain.domainId, owner: 'e8', status: 'running', startedAt: new Date().toISOString() });
    const old = await create('a'); await drain('initial');
    const paused = requireState('a', 'paused');
    record.initialSteps = paused.stepsUsed;
    record.initialTools = paused.checkpoint.log.map((entry) => entry.tool);
    applyCompetingChange(root, scenario);

    const runBaseline = async () => {
      const setupStart = performance.now();
      const baseline = await create('baseline');
      timings.baselinePreparation = performance.now() - setupStart;
      await drain('baseline');
      const state = requireState('baseline', 'completed');
      record.baseline = { ...check(baseline.forkRoot), toolErrors: state.checkpoint.log.filter((entry) => entry.isError).length };
    };
    if (!resumeFirst) await runBaseline();
    const start = performance.now();
    const recovered = await recoverAgentWorkspace(agents, supervisor, {
      agentId: 'a', recoveryId: 'recovery', root, forkPath: path.join(temp, 'recovery'), replayPolicy: 'deterministic',
      observations: (checkpoint) => observationValidation(checkpoint.log),
    });
    timings.reconstruction = performance.now() - start;
    assert.equal(recovered.status, 'restored');
    record.recovery = { attempts: recovered.attempts, replayedTools: recovered.replayedSteps, skippedCheckpoints: recovered.skippedCheckpoints,
      reusedObservations: agents.get('a').checkpoint.log.length, rejected: recovered.rejections.map(({ replay }) => ({ index: replay.divergedAt, reason: replay.reason })) };
    await supervisor.abortWorkspaceTransaction(old.txId);
    phase = 'resumed'; agents.resume('a'); await drain('resumed');
    const resumed = requireState('a', 'completed');
    record.resumed = { ...check(recovered.transaction.forkRoot), toolErrors: resumed.checkpoint.log.filter((entry) => entry.isError).length };
    if (resumeFirst) await runBaseline();
    record.status = record.baseline.passed && record.resumed.passed ? 'passed' : 'validation_failed';
  } catch (error) {
    record.status = 'experiment_error';
    record.error = scrubSecrets(String(error).split(apiKey).join('<key>')).clean;
  } finally {
    record.timingsMs = timings;
    record.cost = budget.report().filter((row) => row.label.startsWith(`${trial}:`));
    fs.writeFileSync(path.join(resultsDir, `${trial}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ cumulativeBudget: budget.report() }));
    agents.close(); domain.close(); budget.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (record.status !== 'passed') process.exitCode = 1;
}
