# 查询失效原因与证据路径

`WorkspaceCausalGraph.explainRecomputation(changed, atSeq?, heads?)` 在原有重算计划上增加逐节点原因，回答“哪个 agent 的哪个结果，因哪条上游证据路径需要重做”。这是只读 journal 查询，可用于修复预览与历史调试。

```ts
import { WorkspaceCausalGraph } from '@xioflow/kernel';

const graph = new WorkspaceCausalGraph(supervisor.getDomain());
// changed 来自宿主已确认的变化，或 validateWorkspaceCausalBranches 的 changed。
// 使用当前 checkpoint 的 heads，避免混入其他候选和旧修复分支。
const report = graph.explainRecomputation(changed, checkpointSeq, causalHeads);
const nodes = new Map([...report.invalidated, ...report.unaffected]
  .map(node => [node.seq, node]));
for (const explanation of report.explanations) {
  const result = nodes.get(explanation.nodeSeq)!;
  console.log(result.actorId, result.txId, result.observation.call, result.writes);
  for (const cause of explanation.causes) {
    console.log('changed evidence', cause.changedSeq,
      cause.path.map(seq => ({ seq, actorId: nodes.get(seq)!.actorId })));
  }
}
```

`supervisor`、`changed`、`checkpointSeq` 和 `causalHeads` 由宿主提供。可运行测试：

```sh
pnpm exec vitest run tests/workspace/causal-graph.test.ts
```

- `invalidated` / `unaffected` 与 `planRecomputation` 完全一致，包含 actor、事务、工具观测及声明写集。`explanations` 按 journal 顺序包含所有失效节点。
- 每个节点的 `causes` 列出所有可达的变化源，去重后按序号排序。变化源本身返回 `[changedSeq]`；它仍可同时受到其他上游变化源影响。
- 每个原因只返回一条边数最少的 `path`，包含源和目标。等长路径选序号字典序最小者，不受 `changed` 或 `dependsOn` 参数顺序影响。路径上每一对相邻节点都对应真实声明的依赖边。
- `atSeq` 为含端点历史切片；`heads` 只选择这些结果及其祖先。变化源不在选择范围内时拒绝查询，不静默忽略。空变化集返回空解释，空 heads 仅允许空变化集。
- 查询不追加事件、不创建事务、不执行工具；重开 domain 后同一历史切片得到相同结果。返回值修改不会影响持久历史。

每个变化源进行一次广度优先遍历，避免枚举菱形图的全部路径。遍历与路径输出复杂度为 O(S × (V + E) + P)，另有种子排序开销，其中 S 是去重变化源数，V/E 是所选图的节点/边数，P 是返回路径的总长度；大量源与长链仍可能产生较大报告，调试时应选择具体 heads。

解释表达宿主声明的依赖传播，不证明依赖完整、输出已提交或变化源确实改变，也不授权复用 `unaffected`。发现变化仍由观测验证负责，修复提交仍使用现有 OCC；本查询不自动回滚文件或外部副作用。
