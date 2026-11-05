import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const registry = fileURLToPath(new URL('../../spec/isa-v1/registry.json', import.meta.url));
const kinds = ['locate', 'set', 'registry', 'log', 'missing', 'refresh'];
const serviceFields = {
  id: '服务实例标识', name: '服务名称', environment: '部署环境', owner: '负责人；可能缺失、null 或空字符串',
  enabled: '是否启用', ready: '就绪标志', port: '端口', notes: '诊断文本；ERROR 行格式为 code=错误码 message=说明',
};

function definition(split, index) {
  const held = split === 'heldout';
  const kind = kinds[index];
  const environment = held ? 'staging' : 'prod';
  const name = held ? 'catalog-api' : 'billing-api';
  const id = `${split}-${String(index + 1).padStart(2, '0')}`;
  const descriptions = {
    locate: [`找出 ${environment} 环境中的 ${name}，报告它的实例标识、端口和负责人。不要选其他环境的同名服务。`,
      { id: 'string', port: 'number', owner: 'string' }],
    set: [`列出 ${environment} 环境中所有未启用的服务实例，并给出总数。结果必须完整。`,
      { ids: 'string[]，集合，无重复', count: 'number' }],
    registry: held
      ? ['从 ISA 注册表中找出所有 atomicity 为 pure 的操作，报告完整操作名集合和数量。', { ops: 'string[]，集合，无重复', count: 'number' }]
      : ['从 ISA 注册表中找出检查进程的 proc.inspect 操作，报告操作名、支持的 drivers 和 observation。',
        { op: 'string', drivers: 'string[]，集合，无重复', observation: 'string' }],
    log: [`查看 ${environment} 环境中 ${name} 的诊断文本，找出最后一条以 ERROR 开头的记录。报告实例标识、错误码和完整 message；忽略 INFO 行中提到的 ERROR 字样。`,
      { id: 'string', code: 'string', message: 'string' }],
    missing: [`核查 ${environment} 环境的负责人信息，将 owner 字段不存在、显式为 null、为空字符串的实例分别列出。三类不能混在一起，也不能遗漏。`,
      { missing: 'string[]，集合，无重复', null: 'string[]，集合，无重复', empty: 'string[]，集合，无重复' }],
    refresh: [`报告 ${environment} 环境中 ${name} 当前的实例标识、enabled 和端口。采集期间源数据会更新；首次数据观察后请重新获取快照，按提交时的当前版本作答。`,
      { id: 'string', enabled: 'boolean', port: 'number' }],
  };
  const [goal, answerShape] = descriptions[kind];
  return { id, split, kind, environment, name, registryMode: held ? 'pure' : 'inspect',
    publicTask: { id, split, goal, answerShape,
      submission: { version: '最近数据观察返回的源版本', answer: '严格按 answerShape 提交；集合顺序不限' },
      source: kind === 'registry'
        ? { type: 'real-repository-copy', description: 'spec/isa-v1/registry.json 的 opcodes 数组只读副本' }
        : { type: 'synthetic-local-file', description: '合成服务清单，不代表本机真实运行服务', fields: serviceFields } } };
}

export function taskDefinitions(split) {
  if (split !== undefined && !['dev', 'heldout'].includes(split)) throw new Error(`Unknown split: ${split}`);
  return (split ? [split] : ['dev', 'heldout']).flatMap((group) => kinds.map((_kind, index) => definition(group, index)));
}

function recordsFor(spec) {
  const count = spec.split === 'dev' ? 72 : 95;
  const records = Array.from({ length: count }, (_, index) => ({
    id: `svc-${String(index).padStart(4, '0')}`, name: `worker-${index % 7}`,
    environment: ['prod', 'staging', 'test'][index % 3], owner: `team-${index % 5}`,
    enabled: index % 4 !== 0, ready: index % 6 !== 0, port: 8000 + index, notes: `INFO worker ${index} ready`,
  }));
  const target = records[spec.split === 'dev' ? 47 : 61];
  Object.assign(target, { name: spec.name, environment: spec.environment, enabled: false, owner: 'team-payments' });
  Object.assign(records[3], { name: spec.name, environment: spec.environment === 'prod' ? 'staging' : 'prod' });
  if (spec.kind === 'missing') {
    for (const index of [8, 13, 18, 23]) records[index].environment = spec.environment;
    delete records[8].owner;
    records[13].owner = null;
    records[18].owner = '';
    delete records[23].owner;
  }
  if (spec.kind === 'log') {
    const final = spec.split === 'dev'
      ? 'ERROR code=E_CERT message=上游证书已过期，拒绝建立连接🧪'
      : 'ERROR code=E_CONFIG message=配置中的监听端口与探针端口不一致';
    target.notes = [
      ...Array.from({ length: 85 }, (_, i) => `INFO 检查 ${i}：配置已载入，尚未进行最终检查🧪`),
      'ERROR code=E_DNS message=早期域名解析失败，稍后已恢复',
      ...Array.from({ length: 30 }, (_, i) => `INFO 重试 ${i}：等待检查结果`), final,
      'INFO 前面的 ERROR 已记录；此行不是新的失败', 'INFO diagnostic complete',
    ].join('\n');
  }
  return records.sort((a, b) => sha256(`${spec.id}:${a.id}`).localeCompare(sha256(`${spec.id}:${b.id}`)));
}

/** Evaluation-owned fixtures. Observation hosts receive only file and recordsKey. */
export function createTaskCase(id) {
  const spec = taskDefinitions().find((entry) => entry.id === id);
  if (!spec) throw new Error(`Unknown task: ${id}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xio-agent-task-'));
  const file = path.join(root, 'source.json');
  let cleaned = false;
  try {
    const initial = spec.kind === 'registry' ? fs.readFileSync(registry) : Buffer.from(`${JSON.stringify(recordsFor(spec))}\n`);
    fs.writeFileSync(file, initial, { flag: 'wx' });
    const provenance = { type: spec.publicTask.source.type, initialSha256: sha256(initial),
      ...(spec.kind === 'registry' ? { repositoryPath: 'spec/isa-v1/registry.json', originalSha256: sha256(initial) } : {}) };
    let advanced = false;
    return { spec, root, file, recordsKey: spec.kind === 'registry' ? 'opcodes' : undefined, provenance,
      afterDataRead() {
        if (spec.kind !== 'refresh' || advanced) return null;
        const before = fs.readFileSync(file);
        const records = JSON.parse(before);
        const target = records.find((row) => row.name === spec.name && row.environment === spec.environment);
        target.enabled = !target.enabled;
        target.port += 1000;
        const next = Buffer.from(`${JSON.stringify(records.reverse())}\n`);
        const replacement = path.join(root, 'replacement.json');
        fs.writeFileSync(replacement, next, { flag: 'wx' });
        fs.renameSync(replacement, file);
        advanced = true;
        return { type: 'environment_change', previousVersion: sha256(before), version: sha256(next) };
      },
      cleanup() {
        if (cleaned) return;
        fs.rmSync(root, { recursive: true });
        cleaned = true;
      } };
  } catch (error) {
    fs.rmSync(root, { recursive: true });
    throw error;
  }
}
