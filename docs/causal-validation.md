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


## 提交时强制验证观测

`commitWorkspaceTransaction` 支持 `observationPolicy: 'always'`：即使文件 OCC 没有发现冲突，也在当前工作区的临时分叉中重放完整日志，并从验证通过的分叉提交实际文件差异。适用于无 atime 读取证据的文件系统，以及要求每次提交都重新验证工具结果的共享修复流程。默认值 `on_conflict` 保留原有行为。

```ts
// Continuing the prepared refresh above; graph is a WorkspaceCausalGraph.
if (result.status === 'prepared') {
  const { transaction, heads } = result.repair;
  const committed = await supervisor.commitWorkspaceTransaction(transaction.txId, {
    observationPolicy: 'always',
    observations: {
      closedWorld: true,
      // Include reused ancestors too, not just this repair transaction's new nodes.
      log: graph.view(heads).nodes.map(node => node.observation),
      replay: adapter.replay,
    },
  });
  if (committed.status === 'conflict') {
    // Inspect committed.observation, then abort and plan another refresh.
    await supervisor.abortWorkspaceTransaction(transaction.txId);
  }
}
```

使用这个示例的前提是所选因果视图确实构成可重放的完整操作序列，覆盖所有观测、变更及复用祖先；依赖图本身不能证明该前提。宿主负责确定性工具适配和完整性声明，重放会再次执行工具，但无需再次调用模型。

强制模式要求 `observations`、`closedWorld: true` 及每条 observe 的非空结果哈希；配置无效时抛错，事务仍可修正后提交。运行过不在日志内的受监督进程则返回 `not_closed_world` 冲突；写写冲突仍不允许重放放行。成功始终返回 `validation: 'observations'`。没有文件冲突时也可能发现观测失效，此时 `conflicts` 为空，应检查 `status` 和 `observation`，不能只检查冲突数组长度。

重放期间主工作区变化会返回 `workspace_changed`，不发布修复输出。现有 `TX_COMMITTING` 保存已经验证的提交计划，重启后继续应用该计划，无需再次提交工具日志；它不是一次新的验证。成功或冲突均回收临时重放资源，原事务的基线仍按既有宿主生命周期管理。
