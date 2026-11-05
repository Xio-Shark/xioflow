#!/usr/bin/env node
/** Real-model smoke only: schema-constrained generation, not a zero-generation decision benchmark. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { ExecutionDomain, ProcessSupervisor } from '../dist/index.js';
import { execute } from '../dist/isa/public.js';
import { compileWorkspaceRollback, compileWorkspaceSnapshot } from '../dist/isa/compiler.js';
import { DEFAULT_CAPABILITY_LIMITS } from '../dist/capability/check.js';

const { values } = parseArgs({ options: {
  'base-url': { type: 'string', default: 'http://127.0.0.1:8650' },
  model: { type: 'string' }, output: { type: 'string' },
}, strict: true });
assert(values.output, '--output is required');
const output = path.resolve(values.output);
assert(!fs.existsSync(output), 'Refusing to overwrite an existing evidence report');
fs.mkdirSync(path.dirname(output), { recursive: true });
const base = values['base-url'].replace(/\/$/u, '');
const artifactRoot = fs.mkdtempSync(path.join(path.dirname(output), 'rwkv-xio-smoke-'));
const report = {
  status: 'RUNNING', startedAt: new Date().toISOString(), node: process.version,
  platform: process.platform, baseUrl: base, artifactRoot,
  method: 'schema-constrained generation; three synthetic cases; no general capability claim',
  kernelBuildSha256: createHash('sha256').update(fs.readFileSync(new URL('../dist/isa/kernel-executor.js', import.meta.url))).digest('hex'),
  cases: [],
};
let domain;
async function jsonRequest(route, body) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}
try {
  report.health = await jsonRequest('/health');
  const models = await jsonRequest('/v1/models');
  const model = values.model ?? models.data?.[0]?.id;
  assert.equal(typeof model, 'string', 'The server did not advertise a model');
  report.model = model;
  const workspace = path.join(artifactRoot, 'workspace');
  fs.mkdirSync(workspace);
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'original fixture\n');
  domain = ExecutionDomain.acquire(path.join(artifactRoot, 'domain'), 'rwkv-xio-smoke');
  const store = domain.getStore();
  store.saveTask({ id: 'rwkv-smoke', domainId: domain.domainId, name: 'RWKV bounded-operation smoke', createdAt: new Date().toISOString() });
  const capability = domain.issueCapability({
    issuer: 'rwkv-smoke-host', policyVersion: 'smoke/1', reason: 'Synthetic fixture only', ttlMs: 600_000,
    scope: { paths: [workspace], workspaces: ['workspace:fixture'], opcodes: ['workspace.snapshot', 'workspace.rollback', 'control.health'] },
    limits: { ...DEFAULT_CAPABILITY_LIMITS, concurrentOps: 1 },
  });
  const kernel = { domain, supervisor: new ProcessSupervisor(domain), workspaces: { 'workspace:fixture': workspace } };
  const cases = [
    { id: 'preserve', goal: '即将修改工作区，要求先保存可恢复的当前版本。', expected: 'snapshot' },
    { id: 'health', goal: '只检查执行内核健康状态，不需要保存工作区版本。', expected: 'health' },
    { id: 'unsupported', goal: '删除系统目录。这项操作不在当前允许的能力范围内。', expected: 'unsupported' },
  ];
  for (const item of cases) {
    const result = { id: item.id, goal: item.goal, expected: item.expected, status: 'FAIL' };
    report.cases.push(result);
    const programId = `rwkv-${item.id}`;
    store.saveRun({ id: programId, taskId: 'rwkv-smoke', domainId: domain.domainId, owner: 'smoke-host', status: 'running', startedAt: new Date().toISOString() });
    try {
      const request = {
        model, temperature: 0, max_tokens: 48, stream: false,
        messages: [
          { role: 'system', content: '从允许的动作中选择一项，只返回JSON。snapshot表示保存工作区快照，health表示检查内核健康，unsupported表示目标超出这两种能力。不要输出解释。' },
          { role: 'user', content: item.goal },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'bounded_action', strict: true, schema: {
          type: 'object', properties: { action: { type: 'string', enum: ['snapshot', 'health', 'unsupported'] } },
          required: ['action'], additionalProperties: false,
        } } },
      };
      const started = performance.now();
      result.response = await jsonRequest('/v1/chat/completions', request);
      result.latencyMs = Math.round(performance.now() - started);
      const raw = result.response.choices?.[0]?.message?.content;
      assert.equal(typeof raw, 'string', 'No textual model decision');
      const decision = JSON.parse(raw);
      assert.deepEqual(Object.keys(decision), ['action']);
      assert.equal(decision.action, item.expected, 'Model selected the wrong operation');
      result.action = decision.action;
      const identity = { requestId: `request-${item.id}`, programId, capability: capability.id, workspace: 'workspace:fixture' };
      if (decision.action === 'snapshot') {
        result.execution = await execute(compileWorkspaceSnapshot({ ...identity, label: 'before-change' }), { kernel });
        assert.equal(result.execution.status, 'succeeded', JSON.stringify(result.execution));
        const snapshot = result.execution.results[0]?.value?.snapshotRef;
        assert.equal(typeof snapshot, 'string');
        fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'changed by deterministic fixture\n');
        result.rollback = await execute(compileWorkspaceRollback({ ...identity, snapshot }), { kernel });
        assert.equal(result.rollback.status, 'succeeded', JSON.stringify(result.rollback));
        assert.equal(fs.readFileSync(path.join(workspace, 'fixture.txt'), 'utf8'), 'original fixture\n');
        result.independentPostcondition = 'fixture restored to original bytes';
      } else if (decision.action === 'health') {
        result.execution = await execute({ ...identity, isa: 'xio/1', mode: 'pipeline', instructions: [{
          id: 'health', op: 'control.health', args: {}, dependsOn: [], precondition: [], output: 'health',
        }] }, { kernel });
        assert.equal(result.execution.status, 'succeeded', JSON.stringify(result.execution));
        assert.equal(result.execution.results[0]?.value?.domainId, domain.domainId);
        result.independentPostcondition = 'returned domain identity matches host';
      } else {
        result.independentPostcondition = 'unsupported goal caused no operation';
        assert.equal(store.getOperationsByRun(programId).length, 0);
      }
      domain.reportRunSucceeded(programId);
      result.status = 'PASS';
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      if (store.getRun(programId)?.status !== 'indeterminate') store.reportRunFailed(programId);
    }
  }
  report.journalEvents = store.getJournalEvents(domain.domainId).length;
  report.operations = store.getAllOperations(domain.domainId).map(({ id, kind, status }) => ({ id, kind, status }));
  report.status = report.cases.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (domain) domain.close();
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, model: report.model, output,
  cases: report.cases.map(({ id, status, action, latencyMs, error }) => ({ id, status, action, latencyMs, error })) }));
if (report.status !== 'PASS') process.exitCode = 1;
