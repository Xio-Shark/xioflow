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

`plan.unaffected` 只表示不在已发现种子的失效闭包内，**不等于已验证可复用**。分支首次停止之后可能还有独立变化；失败分支的未检查节点也可能在其中。修复器的 `validateReuse` 仍必须检查复用证据。验证期间及验证之后主工作区可能继续变化，`matched` 仅针对本次基线；发布仍须 OCC。完成的验证会写入 `CAUSAL_VALIDATION_COMPLETED`，包括工具失败分支；基础设施或清理失败不会生成完成报告。


## 持久报告与自动修复准备

返回的 `seq` 是报告的 journal 身份；`atSeq` 是源因果图切片。报告保存 `validationId`、`runId`、规范化 `root`、每条分支的 `sourceBranches` heads，以及基线 `SnapshotRef` 的 ID、树指纹、覆盖范围等元数据。验证结束仍回收快照和工作区，因此这些元数据用于追溯，不能承诺重新物化已回收的快照。

`listWorkspaceCausalValidations(domain, { runId?, atSeq? })` 在 domain 重开后仍可查询。查询的 `atSeq` 截止于报告事件序号；每份报告的失效计划从其自身冻结的源图重新构建。返回副本，修改查询结果不改变 journal。

兼容的多 agent 分支可以直接从探测进入共享修复，无需手动搬运失效种子：

```ts
import { prepareWorkspaceCausalRefresh } from '@xioflow/kernel';

const result = await prepareWorkspaceCausalRefresh(supervisor, {
  txId: 'probe-43', runId, root, forkPath: '/tmp/xio-probe-43',
  atSeq, branches,
  closedWorld: true, replayPolicy: 'deterministic', replay: adapter.replay,
  repair: {
    txId: 'repair-43', forkPath: '/tmp/xio-repair-43',
    validateReuse: adapter.validateReuse,
    execute: adapter.execute,
  },
});
if (result.status === 'prepared') {
  const { transaction, branches: repairedBranches } = result.repair;
  // Inspect outputs, bind contexts if needed, and publish through ordinary OCC.
  // Host owns this open transaction and its baseline cleanup.
}
```

结果为 `unchanged`、`failed` 或 `prepared`，均附持久 `validation`。任一分支工具失败就返回 `failed`，即使其他分支发现了变化也不分配修复事务；无变化返回 `unchanged`。其余情况自动按报告中的分支与种子准备共享修复，通过 `CAUSAL_VALIDATION_REPAIR_PREPARED` 将 `validationSeq` 关联到修复 `txId`，再由原有 `CAUSAL_REPAIR_PREPARED` 追溯替代节点。修复或关联持久化失败会抛出异常并回收修复资源，验证报告保留。进程崩溃可能留下已准备但尚未关联的修复，不能将缺少关联理解成从未执行。

修复使用新拍摄的当前基线，可能与探测基线不同；`validateReuse` 仍必需，`unchanged` 也不代表之后的世界未改变。这个入口不自动提交、不绑定 agent checkpoint，不把验证报告当成 OCC 证书，也不合并互斥策略。
