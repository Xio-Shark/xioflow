# 因果分支再验证

`validateWorkspaceCausalBranches` 把现有因果图和观测重放接起来：默认在当前文件世界拍一次基线，对每个选定分支创建独立工作区，按因果拓扑顺序重放，返回首次变化对应的节点序号及联合失效闭包。无需在宿主中把观测日志下标手工映射回因果节点。

可选 `baseSnapshotId` 使用调用方已有的同 domain/root 快照；缺失或不匹配时报错，不改抓当前目录。验证不删除显式快照，可将同一 ID 传给 `prepareWorkspaceRepair` / `prepareWorkspaceBranchRepair`，在同版本上准备修复。复用证据、物化输出与最终 OCC 仍须校验。组合 `prepareWorkspaceCausalRefresh` 的修复阶段暂仍另建当前基线，顶层此选项只固定探测。

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

分支在首次变化或错误处立即停止。发生变化的 mutation 可能已经污染自己的 fork，因此所有验证工作区均被丢弃；其他分支从相同不可变基线重新开始，不继承这些效果。成功完成或工具失败后回收临时事务及本次自建基线；基础设施或清理失败抛出异常。验证不创建替代因果节点、不更新 agent checkpoint、不提交文件。

宿主必须声明：每个分支包含在该文件根上重放所需的完整操作前缀和全部依赖，适配器确定性执行，观测无写效果，mutation 仅作用于传入工作区。图结构与结果哈希无法证明这些声明，也不覆盖模型调用或外部系统副作用。互斥策略可分别验证，但只有兼容分支才能一起共享修复。

`plan.unaffected` 只表示不在已发现种子的失效闭包内，**不等于已验证可复用**。分支首次停止之后可能还有独立变化；失败分支的未检查节点也可能在其中。修复器的 `validateReuse` 仍必须检查复用证据。验证期间及验证之后主工作区可能继续变化，`matched` 仅针对本次基线；发布仍须 OCC。完成的验证会写入 `CAUSAL_VALIDATION_COMPLETED`，包括工具失败分支；基础设施或清理失败不会生成完成报告。


## 持久报告与自动修复准备

返回的 `seq` 是报告的 journal 身份；`atSeq` 是源因果图切片。报告保存 `validationId`、`runId`、规范化 `root`、每条分支的 `sourceBranches` heads，以及基线 `SnapshotRef` 的 ID、树指纹、覆盖范围等元数据。默认验证结束回收自建快照和工作区，因此元数据不能承诺重新物化已回收的快照。

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

## 按预计成本选择增量修复或完整重算

刷新入口可选 `costModel`，在探测发现变化后为选中联合视图的每个节点估算执行、复用验证和提交重放成本。内核按共享节点去重，比较两种方案的剩余成本；完整重算严格更便宜才选择 `full`，相等时保留 `incremental`。不提供模型时仍只做增量修复。

```ts
const result = await refreshWorkspaceCausalBranches(supervisor, {
  ...refreshOptions,
  // Example estimates in tool-call units; calibrate against your adapter.
  costModel: node => ({
    execute: 1,
    reuse: node.observation.kind === 'mutate' ? 2 : 1,
    replay: 1,
  }),
});
if (result.status === 'committed' || result.status === 'conflict') {
  console.log(result.decision); // strategy, incremental/full cost breakdowns
  console.log(result.validation.replayedSteps); // actual probe calls already spent
}
```

成本模型必须使用同一单位，返回有限非负数。`execute` 包含重算该节点的全部工作，`reuse` 包含复用证据检查和保留输出的物化，`replay` 包含提交时再次执行该节点的成本。估算器收到节点副本；无变化或探测失败时不会调用估算器。无效值、溢出或估算器异常会在创建修复事务前抛出，已完成的探测报告仍保留。

两种预计总成本分别为 `失效节点执行 + 未失效节点复用 + 全部节点提交重放` 与 `全部节点执行 + 全部节点提交重放`。探测已经发生，不计入剩余成本；相同的事务固定开销也不计入。估算不是实测，当前不避免探测成本、不预测重试或证明耗时 / token 节省。批量复用的非线性成本需要宿主分摊到节点；公开的 `planWorkspaceCausalRefresh(plan, costModel)` 可单独对已有因果计划进行成本分析。

`full` 在新事务中拓扑重算所选 heads 的整个联合祖先视图，不包含未选中的兄弟分支，共享节点仍只执行一次。`validateReuse` 收到空数组；宿主应能处理没有复用结果的情况。分支 heads 和替代关系继续通过既有修复 journal 保存；原始探测的 `changed` 仍仅表示实际发现的变化。两种策略发布时都完整重放观测并执行 OCC。

准备成功的 `CAUSAL_VALIDATION_REPAIR_PREPARED` 事件新增可选 `decision`，保存所选策略及两种预计成本，可在重开 domain 后沿 `validationSeq → txId` 审计。旧事件无需迁移；未提供成本模型时仍写入原格式。准备失败不会写入该关联事件。

## 跳过探测，直接完整重算并发布

当宿主已决定全部重算（例如已知共享输入失效），可调用 `recomputeWorkspaceCausalBranches`。它不创建探测事务，也不声称发现了哪些观测变化；在一个新事务中重算选中 heads 的联合祖先，共享节点一次，然后强制重放完整新日志并执行 OCC。

```ts
const result = await recomputeWorkspaceCausalBranches(supervisor, {
  txId: 'recompute-all', runId, root, forkPath: '/tmp/xio-recompute-all',
  atSeq, branches, closedWorld: true, replayPolicy: 'deterministic',
  execute: adapter.execute, replay: adapter.replay,
});
console.log(result.status, result.repair.branches);
```

`execute` 沿用共享修复回调，收到源节点、工作事务和已重算的依赖；没有复用节点，因此无需提供 `validateReuse`。来源不能为空且分支身份必须唯一。来源冻结在 `atSeq`，未选中的兄弟节点不执行。联合操作日志仍必须完整且确定性；适配器声明与已有刷新入口相同。

返回 `committed` / `conflict`、`repair`、`commit` 和持久关联事件的 `preparationSeq`，没有探测报告。即使世界未变化也重算，不能返回 `unchanged`。`CAUSAL_RECOMPUTATION_PREPARED` 记录来源分支、历史序号、策略及事务 ID，可沿 `txId` 查询最终提交状态；修复中的全部种子表示计划重算范围，不是探测出的失效证据。冲突回收资源，未知提交错误保留恢复资源，规则与刷新入口一致。不会更新 agent checkpoint。

这是显式策略入口；下方策略包装器可根据宿主预测选择它。省去探测调用不等于保证端到端提速。

## 探测前按预期成本选择执行路径

`refreshWorkspaceCausalBranchesWithPolicy` 在创建工作区前比较探测刷新与直接重算，复用以上两个入口。宿主提供变化概率和条件成本；内核不从历史样本自动学习概率，也不把概率当作观测有效性证据。

```ts
const outcome = await refreshWorkspaceCausalBranchesWithPolicy(supervisor, {
  ...refreshOptions,
  costModel: () => ({ execute: 1, reuse: 1, replay: 1 }),
  // All costs use tool-call units, calibrated for the selected branches and adapter.
  forecast: {
    changeProbability: 0.8, // probability ANY selected branch has changed
    probeUnchanged: 9,      // total probe cost conditional on no change
    probeChanged: 6,        // total probe cost conditional on a change
    refreshChanged: 14,     // remaining repair + reuse validation + commit replay
  },
});
console.log(outcome.policy, outcome.result.status, outcome.decisionSeq);
```

比较公式为 `(1-p) × probeUnchanged + p × (probeChanged + refreshChanged)` 与选中联合祖先的 `Σ(execute + replay)`；共享节点只计一次，相等时选择探测。概率必须在 `[0,1]`，所有成本必须有限非负，拒绝溢出。条件成本需要计入分支重复探测、首差即停与探测缓存；这里不自动推断这些分布。两边应使用同一单位、同一固定开销口径；需要比较事务固定开销时由宿主分摊到相应估算。

返回 `{ strategy, policy, decisionSeq, result }`：`strategy: 'probe'` 的 `result` 是原刷新结果（可为 `unchanged` / `failed`）；`recompute` 则返回原直接重算结果。直接重算使用 `repair.txId` / `repair.forkPath` / `repair.execute`，不会调用 `validateReuse`；探测路径继续使用 `costModel` 做探测后的增量/完整选择。估算器应稳定、无副作用，允许前后两次估算。

`CAUSAL_REFRESH_POLICY_SELECTED` 在执行前记录预测、选择、源分支、历史序号、探测事务前缀和修复事务 ID。日志写入失败时不会分配工作区。该事件仅证明执行意图，不能证明完成；按事务 ID 关联后续验证、准备和提交事件。失败不自动切换另一条路径，资源回收及未知提交保留规则沿用底层入口。

预测错误可能增加成本，但概率为零仍实际探测，概率为一也仍强制重放提交；不会仅因预测返回 `unchanged` 或跳过 OCC。七模式基准已覆盖独立预测与失准场景；当前未测量真实模型 token 收益。

### 持久刷新遥测

`refreshWorkspaceCausalBranchesWithPolicy` 现在返回 `telemetrySeq`，并在执行结束或抛错时追加
`CAUSAL_REFRESH_MEASURED`（version 1），通过 `decisionSeq` 关联预测、源分支和事务身份。

```ts
import { listWorkspaceCausalRefreshTelemetry } from '@xioflow/kernel';
const reports = listWorkspaceCausalRefreshTelemetry(domain, { runId: 'run' });
for (const report of reports) {
  console.log(report.decisionSeq, report.status, report.durationMs, report.callbacks);
}
// 可选 atSeq 按遥测事件序号截取历史；不传 runId 可查询同 domain 的多个 Run。
```

`callbacks.probe / reuse / execute / commitReplay` 分别统计实际探测重放、宿主复用校验、
节点重算、OCC 重放的 `calls / errors / durationMs`。计数包括失败尝试，探测缓存命中不计调用；
`reuse.calls` 是批次回调次数，不是内部文件读取或工具次数。每类耗时是回调累计耗时；
顶层 `durationMs` 是决策落盘后到执行及清理结束的单调时钟耗时，包含快照和事务开销，
不含预测计算及遥测自身落盘。它们不能直接与任意单位的 `costModel` 相减，也不代表 token 用量。

`status` 保留 `unchanged / failed / committed / conflict`，抛错记为 `threw` 并重新抛出原异常；
存在验证报告时记录 `validationSeq`。`threw` 可能包含提交结果未知或清理失败，必须沿决策中的
事务 ID 检查 journal，不能据此断言未提交。进程中断可能仅留下决策，没有遥测，缺失不能按零成本统计。
遥测写入失败会抛错并说明已观察到的执行状态、决策和事务 ID；不会重试执行或撤销成功提交；
执行和遥测均失败时用 `AggregateError` 保留两者。记录不包含回调参数、结果或异常文本。
当前只覆盖策略包装器，不自动学习概率，也不测量直接调用其他刷新入口的执行。

### 从历史遥测估计预测与时间验证集

策略入口可选 `taskKey`，持久标记可比较的任务类别，例如
`compile:v2:four-branches:baseline-observations`。宿主应把工具版本、工作量、重放复用策略等
影响成本的特征纳入类别；旧日志没有类别，不参与聚合。空白类别被拒绝。

```ts
import { estimateWorkspaceCausalRefreshHistory } from '@xioflow/kernel';
const estimate = estimateWorkspaceCausalRefreshHistory(domain, {
  taskKey: 'compile:v2:four-branches:baseline-observations',
  trainingAtSeq: 1200, // 固定训练截止点；先固定，再运行后续评估任务
  atSeq: 1800,        // 可选：整个查询的历史截止点
});
console.log(estimate.training, estimate.heldOut, estimate.evaluation);
if (estimate.forecast) {
  // 可传给 refreshWorkspaceCausalBranchesWithPolicy 的 forecast。
  // 同时必须提供以回调毫秒估算 execute/reuse/replay 的 costModel。
  console.log(estimate.forecast);
}
```

`estimateWorkspaceCausalRefreshHistory` 是不创建工作区、不修改策略的纯查询。
训练只使用决策和完成遥测均在 `trainingAtSeq` 之前（含）的成功探测；后续决策为验证集。
截止点前开始、之后完成的任务按训练缺失计数，不能泄漏进任一数据集。
`training / heldOut` 分别统计 changed、unchanged、failed、missing、recompute；
冲突、抛错和回调错误均排除，直接重算没有变化标签，不用于推断概率。
没有同时观察到变化与未变化时 `forecast: null`，没有可评估样本时 `evaluation: null`。

预测单位固定为 `callback_duration_ms`：变化比例来自成功探测，条件成本来自对应样本均值，
变化后成本含复用、重算和提交重放。验证集报告总探测路径成本的预测值、实际均值和平均绝对误差；
后续样本不更新训练预测。固定 `atSeq` 的查询可在重开 domain 后重现。
这不包含快照与清理开销，不估计 token，不提供未执行路径的反事实收益。
策略选择和成功样本筛选存在选择偏差；宿主应保留独立探测评估任务，不能将该比例视为无偏总体概率。
所有预测仍仅影响执行路径，发布必须通过原有 OCC。

需要排除过时样本时，可指定 `trainingAfterSeq`；返回的 `drift` 报告独立验证集的变化率差值和 Brier 分数，见[滑动窗口示例](causal-refresh-history-windows.md)。
