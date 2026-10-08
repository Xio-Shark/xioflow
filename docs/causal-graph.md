# 因果图与增量重算计划（实验性 API）

`WorkspaceCausalGraph` 将已完成的工具结果写入现有 SQLite journal。节点关联事务的 run 和基线快照；`actorId` 标识宿主 agent 或策略，`dependsOn` 引用其他节点的 journal 序号，可跨事务、跨 agent。只允许引用本 domain 已存在的因果节点，因此 journal 顺序也是拓扑顺序。

下面的代码可放在已有 `domain` / `supervisor` 宿主中。`root` 是 Git 工作区，`forkPath` 是尚不存在的分叉目录，`runId` 是已创建且活跃的 run。

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkspaceCausalGraph } from '@xioflow/kernel';

const graph = new WorkspaceCausalGraph(domain);
const tx = await supervisor.beginWorkspaceTransaction({
  txId: 'derive-summary', runId, root, forkPath,
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const content = await fs.readFile(path.join(tx.forkRoot, 'input.txt'), 'utf8');
const read = graph.record({
  txId: tx.txId, actorId: 'summarizer', dependsOn: [],
  observation: {
    kind: 'observe', call: { tool: 'read', args: { path: 'input.txt' } },
    resultHash: hash(content),
  },
});
await fs.writeFile(path.join(tx.forkRoot, 'summary.txt'), content.toUpperCase());
const edit = graph.record({
  txId: tx.txId, actorId: 'summarizer', dependsOn: [read.seq],
  observation: {
    kind: 'mutate', call: { tool: 'uppercase', args: { from: 'input.txt', to: 'summary.txt' } },
    resultHash: hash('ok'),
  },
  writes: [{ status: 'A', path: 'summary.txt' }],
});
const result = await supervisor.commitWorkspaceTransaction(tx.txId);
if (result.status === 'conflict') {
  await supervisor.abortWorkspaceTransaction(tx.txId);
}
// 即使 fork 已回收，仍能查到 edit 基于哪次观测产生。
const evidence = graph.ancestors(edit.seq); // [read]
// 当宿主在新版本上验证 input 的结果已改变：
const plan = graph.planRecomputation([read.seq]); // invalidated: [read, edit]
const past = graph.nodes(read.seq); // 包含 read，不包含 edit
```

## 查询与重放

- `nodes(atSeq?)`：指定 journal 序号（含）之前的所有节点；默认完整历史。
- `ancestors(seq)`：目标节点的传递上游依赖，不包含目标自身。
- `planRecomputation(changed, atSeq?)`：返回包含种子节点的 `invalidated` 依赖闭包，以及 `unaffected`。两者都按拓扑顺序排列；历史切片之外的种子报错。
- `observationLog(txId, atSeq?)`：提取原有 `ObservationEntry[]` 格式，可传给现有事务提交或 checkpoint 恢复适配器。跨事务上游不会混入单个事务的工具重放日志。

重算计划不改变 journal、不执行工具、不恢复文件、不改变 AgentRuntime 状态，也不推断哪个节点的结果实际发生变化。宿主必须先用新状态上的观测校验确定种子。依赖闭包遍历为 O(V+E)，当前查询会读取 domain journal；大规模历史的索引与分页留待后续。

## 记录契约

在工具成功完成后、事务提交开始前同步调用 `record`。提交中、已提交、冲突或中止的事务不能追加步骤。每个节点都要求非空结果哈希，mutation 返回内容也应纳入哈希。节点记录复用事务生命周期，事务结束不删除历史，也不表示其所有节点的写入已经提交；提交结果需查询原有 TX journal。

宿主负责声明全部数据与控制依赖：如果一次模型决策使用了整个上下文，就应依赖所有相关观测，不能为了缩小重算范围而省略边。`unaffected` 仅表示不在这些种子的显式依赖闭包中，不代表自动获得提交权限或确定性证明。宿主声明的 `writes` 是溯源元数据，现有 OCC 仍从文件差异计算真实写集。

`actorId` 是来源标签，不校验 AgentRuntime 身份；日志工具参数沿用现有宿主数据规范。第一阶段不为外部副作用提供重放保证。

## 验证

`pnpm exec vitest run tests/workspace/causal-graph.test.ts` 覆盖跨 agent 菱形依赖、独立分支保留、历史切片、真实文件提交后溯源、domain 重启后恢复，以及现有观测重放检测文件变化。测试中的节点数量不代表真实 token 或耗时收益。
