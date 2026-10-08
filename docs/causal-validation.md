# 因果分支再验证

`validateWorkspaceCausalBranches` 把现有因果图和观测重放接起来：在当前文件世界拍一次基线，对每个选定分支创建独立工作区，按因果拓扑顺序重放，返回首次变化对应的节点序号及联合失效闭包。无需在宿主中把观测日志下标手工映射回因果节点。

```ts
import { validateWorkspaceCausalBranches, prepareWorkspaceBranchRepair } from '@xioflow/kernel';

const report = await validateWorkspaceCausalBranches(supervisor, {
  txId: 'probe-42', runId, root, forkPath: '/tmp/xio-probe-42',
  atSeq, branches, // [{ id: 'agent-a', heads: [...] }, ...]
  closedWorld: true, replayPolicy: 'deterministic',
  replay: adapter.replay,
});
if (report.branches.some((branch) => branch.status === 'failed')) {
  throw new Error('Resolve replay failures before repairing');
}
if (report.changed.length) {
  const repair = await prepareWorkspaceBranchRepair(supervisor, {
    txId: 'repair-42', runId, root, forkPath: '/tmp/xio-repair-42',
    atSeq: report.atSeq, branches, changed: report.changed,
    validateReuse: adapter.validateReuse,
    execute: adapter.execute,
  });
  // Inspect / bind the prepared result, then use ordinary OCC to publish it.
}
```

每条分支返回 `matched`、`changed` 或 `failed`，以及成功匹配的 `matchedSteps`。后两者携带首次停止的因果节点 `seq`；`failed` 还携带错误。成功执行但哈希不一致才加入去重后的 `changed`。工具异常（包括 mutation 无法应用）不冒充世界变化，也不阻止其他分支再验证。`replayedSteps` 统计实际调用次数，包括失败尝试及跨分支重复执行的共享祖先。

分支在首次变化或错误处立即停止。发生变化的 mutation 可能已经污染自己的 fork，因此所有验证工作区均被丢弃；其他分支从相同不可变基线重新开始，不继承这些效果。成功完成或工具失败后回收临时事务及本次基线；基础设施或清理失败抛出异常。验证不创建替代因果节点、不更新 agent checkpoint、不提交文件。

宿主必须声明：每个分支包含在该文件根上重放所需的完整操作前缀和全部依赖，适配器确定性执行，观测无写效果，mutation 仅作用于传入工作区。图结构与结果哈希无法证明这些声明，也不覆盖模型调用或外部系统副作用。互斥策略可分别验证，但只有兼容分支才能一起共享修复。

`plan.unaffected` 只表示不在已发现种子的失效闭包内，**不等于已验证可复用**。分支首次停止之后可能还有独立变化；失败分支的未检查节点也可能在其中。修复器的 `validateReuse` 仍必须检查复用证据。验证期间及验证之后主工作区可能继续变化，`matched` 仅针对本次基线；发布仍须 OCC。结果只返回给调用方，持久 journal 保留临时事务生命周期，尚不持久化这份验证报告。
