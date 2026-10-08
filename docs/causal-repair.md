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

- `atSeq` 固定源历史，防止执行中新增节点进入当前计划。查询范围是整个 domain 在该序号前的因果图；宿主应使用独立 domain 隔离无关运行。后续多轮修复应基于选定执行分支，当前尚无自动“活跃分支”筛选。
- 多个失效种子合并为一个闭包，菱形汇合节点只执行一次；未受影响节点不会调用 `execute`。
- `CAUSAL_REPAIR_PREPARED` journal 事件持久记录源节点到替代节点的映射和复用节点；原历史不被覆写。该事件表示准备完成，不表示已提交，应结合 TX 生命周期查询。
- 回调必须等待 fork 内的工作全部结束，不自行提交或中止事务；否则无法保证清理时没有后台写入。
- 验证或工具失败时停止执行，abort 并回收本次基线；已经记录的部分节点保留在被中止事务的历史中。清理失败同时报告原错误和清理错误。
- 准备成功后由调用方管理事务、提交冲突和 snapshot 回收。提交抛错可能已进入应用阶段，此时保留 fork 和基线，并按既有事务恢复协议处理，不能直接回收。

## 验证边界

本入口不自动发现变化、不证明宿主依赖完整、不恢复 AgentRuntime 上下文，也不自动回滚旧工具的副作用。新基线上的重算工具必须能够替换旧输出；例如追加操作不能直接当成覆盖操作重跑。外部副作用需由宿主适配器处理。

这一步实现了文件世界中的局部重算与来源关联；OCC 的校验强度仍由已有读集与观测重放决定。测试证明独立分支不执行、下游使用新证据、文件隔离和冲突保持，不构成模型 token、耗时或成功率的基准结论。
