# 因果子图局部重算（实验性）

`prepareWorkspaceRepair` 把 `WorkspaceCausalGraph.planRecomputation` 的失效闭包变成可执行的修复事务。它从**当前主工作区**创建 snapshot / fork，按拓扑顺序执行受影响工具，把下游依赖指向新结果，保留独立节点的历史身份。返回的事务仍然打开，宿主可以检查结果，再用现有 OCC 提交。

适用场景：已有输出已落入主工作区，某个输入发生变化，宿主确定失效种子后，只重算依赖该输入的分支。未提交的投机分支输出不会自动出现在新基线；宿主必须先物化可复用输出，或将相关节点也列为失效种子。

```ts
import { prepareWorkspaceRepair, WorkspaceCausalGraph } from '@xioflow/kernel';

const graph = new WorkspaceCausalGraph(supervisor.getDomain());
const history = graph.nodes();
const repair = await prepareWorkspaceRepair(supervisor, {
  txId: 'repair-1', runId, root, forkPath: '/tmp/repair-1',
  changed: [changedObservationSeq],
  heads: [outputSeq, independentOutputSeq], // 保留的结果节点；自动包含它们的全部上游
  atSeq: history.at(-1)!.seq,
  async validateReuse(tx, unaffected) {
    // 宿主验证独立结果、声明依赖的完整性，以及输出在新基线中的存在性。
    // 校验不通过必须抛错。不能仅凭“不在失效闭包”断言结果有效。
    await adapter.validateReusable(unaffected, tx.forkRoot);
  },
  async execute(source, tx, dependencies) {
    // dependencies 中已修复的上游节点携带新 seq 和新 resultHash。
    // 工具可按新依赖重新生成参数；不必机械重放旧参数。
    const result = await adapter.recompute(source, dependencies, tx.forkRoot);
    return {
      actorId: 'repair-agent',
      observation: result.observation, // 实际调用、kind 和非空 resultHash
      writes: result.writes,
    };
  },
});

// 提交证据必须覆盖所有实际读取，包括来自旧节点的复用输入。
// graph.observationLog(repair.transaction.txId) 仅含本次重算，不自动包含复用证据。
const commitOptions = await adapter.commitEvidence(repair);
const commit = await supervisor.commitWorkspaceTransaction(repair.transaction.txId, commitOptions);
if (commit.status === 'conflict') {
  await supervisor.abortWorkspaceTransaction(repair.transaction.txId);
}
await supervisor.pruneSnapshots([repair.transaction.baseSnapshotId], { runId });
```

`adapter` 是宿主提供的工具实现，示例不假定任何特定模型 SDK。可运行的真实文件用例见 `tests/workspace/causal-graph.test.ts`：

```sh
pnpm exec vitest run tests/workspace/causal-graph.test.ts
```

## 生命周期与历史

- `atSeq` 固定源历史，防止执行中新增节点进入当前计划。`heads` 选择结果节点及其全部上游，排除未选中的投机候选和旧版本。省略 `heads` 保持原有整个 domain 历史语义；多轮修复应显式传入。空选择或视图外的失效种子在创建事务前报错。
- 多个失效种子合并为一个闭包，菱形汇合节点只执行一次；未受影响节点不会调用 `execute`。
- `CAUSAL_REPAIR_PREPARED` journal 事件持久记录源节点到替代节点的映射、复用节点、`sourceHeads` 和替代后的 `heads`；原历史不被覆写。该事件表示准备完成，不表示已提交，应结合 TX 生命周期查询。
- 回调必须等待 fork 内的工作全部结束，不自行提交或中止事务；否则无法保证清理时没有后台写入。
- 验证或工具失败时停止执行，abort 并回收本次基线；已经记录的部分节点保留在被中止事务的历史中。清理失败同时报告原错误和清理错误。
- 准备成功后由调用方管理事务、提交冲突和 snapshot 回收。提交抛错可能已进入应用阶段，此时保留 fork 和基线，并按既有事务恢复协议处理，不能直接回收。

## 验证边界

本入口不自动发现变化、不证明宿主依赖完整、不恢复 AgentRuntime 上下文，也不自动回滚旧工具的副作用。新基线上的重算工具必须能够替换旧输出；例如追加操作不能直接当成覆盖操作重跑。外部副作用需由宿主适配器处理。

这一步实现了文件世界中的局部重算与来源关联；OCC 的校验强度仍由已有读集与观测重放决定。测试证明独立分支不执行、下游使用新证据、文件隔离和冲突保持，不构成模型 token、耗时或成功率的基准结论。

## 连续修复与分支比较

`heads` 是要保留的结果集合，不是某个事务 ID：上游可能来自多个 agent、事务或已提交的旧版本。应包含所有要保留的独立输出；省略某个输出会将它排除在修复范围之外，不会删除它对应的文件。显式选择同时允许查看被中止的候选，不自动证明其输出已物化。

```ts
// 在上面的 OCC 提交成功后，保存修复后的结果集合。
if (commit.status === 'committed') {
  const nextHeads = repair.heads;
  const currentView = graph.view(nextHeads);
  // 当某个当前观测再次变化，使用它的新 seq，而非最初历史中的 seq。
  const nextChanged = await adapter.findChanged(currentView.nodes, root);
  const nextPlan = graph.planRecomputation(
    nextChanged, graph.nodes().at(-1)!.seq, nextHeads,
  );
  // 下一次 prepareWorkspaceRepair 使用 heads: nextHeads、changed: nextChanged。
  // nextPlan 只包含这个分支；其他候选和已替代节点不会混入。
}
const oldView = graph.view([outputSeq, independentOutputSeq]);
const newView = graph.view(repair.heads);
```

视图是 journal 查询，不恢复文件或 agent 上下文。`repair.heads` 在准备成功时返回，只有提交成功后才能将其当作主工作区的当前分支。重启后可从对应 `CAUSAL_REPAIR_PREPARED` 事件的 `heads` 重建视图，并结合该事务的 `TX_COMMITTED` 判断提交状态；旧事件可能没有该字段。不同修复分支互不覆盖，不使用全局“最新替代节点”规则。未指定 heads 的旧调用也会返回源图末端节点替代后的 heads，便于后续切换到显式分支。

## 可复现评测

运行 `pnpm benchmark:causal` 比较相同文件扰动下的完整重跑、局部修复与不校验复用。详见 [指标口径和限制](causal-repair-benchmark.md)，包含变化检测和复用验证开销，不估算模型 token。

## 多 agent 共享祖先去重

`prepareWorkspaceBranchRepair` 接受带唯一 `id` 的 `branches`，在一个新事务中修复所有分支视图的并集。每个失效源节点只执行一次；分支声明顺序不影响执行顺序，下游总是拿到新上游。未选择的兄弟分支不参与，未受影响节点统一验证一次。返回 `branches: [{ id, sourceHeads, heads }]`，可按 agent ID 分发因果结果；空分支保持为空，独立分支保留原 heads。

```ts
import { prepareWorkspaceBranchRepair } from '@xioflow/kernel';

const repair = await prepareWorkspaceBranchRepair(supervisor, {
  txId: 'shared-repair', runId, root, forkPath: '/tmp/shared-repair',
  atSeq, changed: [sharedObservationSeq],
  branches: [
    { id: 'agent-a', heads: [agentAOutputSeq] },
    { id: 'agent-b', heads: [agentBOutputSeq] },
  ],
  validateReuse: (tx, nodes) => adapter.validateReusable(nodes, tx.forkRoot),
  async execute(source, tx, dependencies) {
    const result = await adapter.recompute(source, dependencies, tx.forkRoot);
    return { actorId: source.actorId, observation: result.observation, writes: result.writes };
  },
});
const byAgent = new Map(repair.branches.map(branch => [branch.id, branch.heads]));
// 使用覆盖所有分支实际读取的证据，经普通 OCC 提交一次。
const outcome = await supervisor.commitWorkspaceTransaction(
  repair.transaction.txId, await adapter.commitEvidence(repair),
);
// byAgent 只分发证据身份；上下文重建及 checkpoint 版本校验由宿主负责。
```

所有分支必须能在同一文件世界中共同成立；互斥的投机策略应继续使用独立 fork。此 API 不自动合并互相覆盖的语义输出，也不证明依赖声明完整。去重按历史节点 seq，而非工具参数或结果哈希；来自不同历史节点的相同调用不会被误认为可共享。

任一复用验证或工具失败会终止整个准备，回收共享 fork 和本次基线，不分发部分成功结果。失败前的节点仍保留在中止事务的历史中。成功时，分支映射与替代关系写入同一 `CAUSAL_REPAIR_PREPARED` 事件的 `branches` 字段，可在重启后恢复；它不是提交事实，仍需查看 TX 生命周期。准备成功后的资源由宿主统一管理，不能让每个 agent 独立提交或回收同一个事务。文件提交与多个 agent checkpoint 绑定不是一个原子操作。
