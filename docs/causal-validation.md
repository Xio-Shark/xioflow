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

每条分支返回 `matched`、`changed` 或 `failed`，以及成功匹配的 `matchedSteps`。后两者携带首次停止的因果节点 `seq`；`failed` 还携带错误。成功执行但哈希不一致才加入去重后的 `changed`。工具异常（包括 mutation 无法应用）不冒充世界变化，也不阻止其他分支再验证。`replayedSteps` 统计实际调用次数，包括失败尝试；`reusedSteps` 另计跨分支复用次数，默认不复用。

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


## 自动刷新并提交兼容分支

`refreshWorkspaceCausalBranches(supervisor, options)` 接受与 `prepareWorkspaceCausalRefresh` 相同的参数，将探测、共享重算、完整证据重放与发布连成一次调用：

```ts
import { refreshWorkspaceCausalBranches } from '@xioflow/kernel';

const result = await refreshWorkspaceCausalBranches(supervisor, {
  txId: 'probe-44', runId, root, forkPath: '/tmp/xio-probe-44',
  atSeq, branches, closedWorld: true, replayPolicy: 'deterministic',
  replay: adapter.replay,
  repair: {
    txId: 'publish-44', forkPath: '/tmp/xio-publish-44',
    validateReuse: adapter.validateReuse, execute: adapter.execute,
  },
});
if (result.status === 'committed') {
  // result.repair.branches contains the published causal heads for each branch.
  // result.commit.validation === 'observations'
}
```

无变化或探测失败分别返回 `unchanged` / `failed`，不创建修复。准备成功后，从修复 heads 的联合因果视图按拓扑顺序提取日志，包含复用祖先，共享节点只重放一次；固定使用 `observationPolicy: 'always'`。适配器必须保证**联合视图**也是完整、可确定性重放的操作序列，分支应兼容；该前提比各分支单独可重放更强。

成功返回 `committed`、验证报告、修复结果及提交结果，回收工作分叉和基线。观测失效或 OCC 冲突返回 `conflict` 并中止事务、回收资源，不自动重试。返回事务状态对应 `committed` / `aborted`，其中 fork 和快照路径仅用于追溯，已经不能访问。此入口在一个共享事务中发布所有兼容输出，不分发独立事务，也不更新 agent checkpoint。

通过已有 `CAUSAL_VALIDATION_REPAIR_PREPARED.validationSeq → txId → TX_COMMITTED / TX_CONFLICTED` 查询探测与发布关系。准备成功不代表已经发布；以事务 journal 为准。提交抛错时可能已经写入 `TX_COMMITTING` 或应用文件，入口保留 fork 与基线并抛出带 txId 的错误：检查 journal，若存在 `TX_COMMITTING` 则通过原提交 API 完成恢复；若尚未开始提交则决定重新验证或中止。不要重新调用整个刷新流程来掩盖未知提交状态。已确定提交结果后的清理错误会明确携带该结果，不能据此假定发布被撤销。

端到端成本可用 `pnpm benchmark:refresh` 复现；分别计入探测、重算、复用验证和提交重放，详见 [验证成本基准](causal-refresh-benchmark.md)。


## 同基线观测复用

对纯文件观测适配器，可在上述三个验证 / 刷新入口传入 `replayReuse: 'baseline_observations'`，默认值为 `'none'`。同一次验证内，相同因果节点在多个分支的首次 mutation 之前只实际观测一次，后续分支复用返回的哈希。哈希匹配与不匹配都可共享；工具错误不缓存，其他分支仍独立尝试。不同节点即使工具参数相同也不合并。

```ts
const report = await validateWorkspaceCausalBranches(supervisor, {
  txId: 'probe-shared', runId, root, forkPath: '/tmp/xio-probe-shared',
  atSeq, branches, closedWorld: true, replayPolicy: 'deterministic',
  replayReuse: 'baseline_observations', replay: adapter.replay,
});
console.log({ actualCalls: report.replayedSteps, reusedCalls: report.reusedSteps });
```

启用即声明：观测是纯函数，只依赖工具参数和传入工作区的文件内容，不依赖 fork 的绝对路径、调用次数、时间或适配器内存；后续工具也不依赖观测回调的内存副作用。现有 closed-world / 确定性声明仍然必需。内核不能证明适配器满足该契约。

任一分支执行过 mutation 后，其后所有观测均实际重放，既不读取也不写入缓存；mutation 本身从不跳过。每个分支仍有独立 fork，缓存只属于本次不可变基线，不跨调用、修复基线或提交复用。报告持久记录 `replayReuse` 和 `reusedSteps`；旧报告查询时补为 `'none'` / `0`。刷新发布仍强制完整重放，复用成功不能替代提交校验。

`pnpm benchmark:probe-reuse [branches] [trials]` 对真实文件的共享读取和独立写入进行探测对照，默认四分支、三轮，轮换策略次序，输出 JSON 原始样本、工具次数、耗时与正确性。无变化时实际工具调用为 8→5，共享输入变化时为 4→1；两种策略都保留独立 fork 成本。此基准仅衡量探测，不包含修复 / 提交，不代表端到端加速或模型 token 收益（`modelTokens: null`）。

本轮[原始样本](benchmarks/causal-probe-reuse.sample.json)共 12 次探测全部正确；无变化中位耗时约 94.69→89.55 ms，输入变化约 98.40→93.25 ms。微小耗时差异受环境影响，工具次数是该固定任务下更稳定的指标。
