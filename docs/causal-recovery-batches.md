# 跨 agent 因果恢复批次

`recoverAgentCausalBatch(agents, changed, prepare)` 将跨 agent 失效查询接到已有的
`recoverCausalCheckpoint`：先固定一份影响计划，再按计划顺序为受影响的已停止
agent 调用宿主重建函数，返回每项结果。未受影响和未跟踪的 agent 留在计划中，
不调用重建函数。`changed` 必须是宿主已确认变化的因果节点序号。

以下示例接通真实工作区局部重算。`agents` 和 `supervisor` 属于同一 domain；
宿主事先停止待恢复的 agent，并提供 `execute` 和 `validateReuse` 适配器，契约见
[因果修复](causal-repair.md)。示例上下文仅保存新的证据 heads；应用需据此重建自己的上下文。

```ts
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { recoverAgentCausalBatch, prepareWorkspaceRepair } from '@xioflow/kernel';

const batch = await recoverAgentCausalBatch(agents, changedNodeSeqs, async (impact) => {
  const agent = agents.get(impact.agentId)!;
  const txId = `repair-${randomUUID()}`;
  const repaired = await prepareWorkspaceRepair(supervisor, {
    txId, runId: agent.runId, root: workspaceRoot,
    forkPath: path.join(temporaryRoot, txId),
    atSeq: impact.checkpoint.seq,
    heads: impact.checkpoint.causalHeads!,
    changed: changedNodeSeqs,
    validateReuse,
    execute,
  });
  return {
    checkpoint: { evidence: repaired.heads },
    causalHeads: repaired.heads,
    workspace: repaired.transaction,
    discard: async () => {
      await supervisor.abortWorkspaceTransaction(txId, 'batch recovery not bound');
    },
  };
});

for (const outcome of batch.outcomes) {
  if (outcome.status === 'failed') console.error(outcome.agentId, outcome.error);
  if (outcome.status === 'skipped') console.log(outcome.agentId, outcome.reason);
  // repaired 的 agent 已暂停，绑定了新上下文、heads 与 open transaction。
  // 宿主随后按自己的策略校验、OCC 提交和 resume。
}
```

结果包含原始 `plan` 和与 `plan.affected` 一一对应的 `outcomes`；每项带
`agentId` 和被检查的 `checkpointSeq`：

| status | 含义 |
| --- | --- |
| `repaired` | 已原子绑定新上下文与工作区，附绑定时的 `agent` 状态 |
| `skipped / checkpoint_changed` | 前一项等待期间 checkpoint 已改变，需重新规划 |
| `skipped / not_stopped` | 非 paused / interrupted，包括运行中和终态；不调用宿主 |
| `skipped / not_repaired` | 宿主返回 undefined，或恢复被中断；没有发布新上下文 |
| `failed` | 附原始异常，包括重建、绑定或清理失败；继续处理后续项 |

无效变化序号在规划阶段抛错，此时尚未恢复任何 agent。宿主拿到影响条目的副本，
修改副本不会改写返回的初始计划。每项开始前检查 checkpoint 序号，单项恢复继续
复用 runtime 的独占恢复、中断、shutdown 与失败清理机制；已消耗预算不回退。

批次非原子，不回滚成功项。每项成功以既有 journal `causal_repaired` 事件为准；
批次汇总只在内存中返回，崩溃后通过 checkpoint 历史与重新规划恢复进度。
旧事务、成功的新事务和历史快照由宿主管理；宿主在返回 preparation 前抛错时，
也须自行清理已准备资源。此函数不新增自动停止、恢复调度或事务提交。

计划顺序是 agent 登记顺序，不是跨 agent 依赖拓扑。宿主必须协调共享依赖和
外部副作用；共享失效祖先可能在多个工作区内分别重算，本接口不声称去重。
兼容分支可先用 [`prepareWorkspaceBranchRepair`](causal-repair.md#多-agent-共享祖先去重)
在同一事务内去重重算并取得各 agent 的新 heads；共享事务的提交、生命周期和
多个 checkpoint 的上下文绑定仍需宿主协调，不能让逐项 discard 回收其他 agent 仍在使用的事务。
`repaired` 表示上下文绑定成功，不证明外部世界有效或所有受影响 agent 已修复。
批次期间新建的 agent 或新变化须再次规划；未跟踪上下文仍不能推断为有效。

## 共享重算、独立绑定

`recoverAgentSharedCausalBatch(agents, changed, { prepare, bind })` 固定影响计划，
只调用一次 `prepare`，再逐项绑定共享修复结果。`prepare` 返回
`prepareWorkspaceBranchRepair` 的结果，分支 id 必须是 agent id，`sourceHeads`
必须与计划 checkpoint 的 heads 集合一致。缺失、重复或不匹配的分支报告逐项失败。
`bind` 负责重建上下文和提供该 agent 独占的 open transaction；新 causal heads
由协调器从分支映射填入。传给回调的计划和结果都是副本。

```ts
const batch = await recoverAgentSharedCausalBatch(agents, changedNodeSeqs, {
  prepare: (plan) => prepareWorkspaceBranchRepair(supervisor, {
    txId: sharedTxId, runId, root: workspaceRoot, forkPath: sharedForkPath,
    changed: plan.changed,
    atSeq: Math.max(...plan.affected.map(({ checkpoint }) => checkpoint.seq)),
    branches: plan.affected.map(({ agentId, checkpoint }) => ({
      id: agentId, heads: checkpoint.causalHeads!,
    })),
    execute, validateReuse,
  }),
  bind: async (impact, repair) => {
    // 宿主适配器建立独立事务，复制该分支需要的输出并验证其观测。
    // 同时重建模型上下文；复制文件本身不能证明上下文或观测有效。
    const prepared = await materializeAgentContext(impact, repair);
    return {
      checkpoint: prepared.context,
      workspace: prepared.transaction,
      discard: () => supervisor.abortWorkspaceTransaction(prepared.transaction.txId),
    };
  },
});
```

共享修复事务始终由宿主持有，返回在 `batch.repair` 中；即使所有绑定失败也不自动
回收。禁止把它直接转移给单个 agent，此错误不会调用可能销毁共享事务的 discard。
正常的逐项失败或中断只调用该项独立资源的 discard。成功项不回滚，仍保持 paused；
宿主负责共享资源和成功事务的 OCC、后续调度与最终回收。不要在 bind 回调内修改
共享文件世界；需要局部修改时使用独立事务。现有单事务单活跃 agent 的规则保留。

prepare 等待期间 agent 可能改变；绑定前重新检查原 checkpoint 序号及停止状态。
没有受影响 agent 时不调用 prepare；prepare 抛错时尚未绑定任何 agent，由其清理
准备资源。共享修复与各次 causal_repaired 分别持久化，批次仍非原子；崩溃恢复时
核对 journal 中的事务和 checkpoint 引用再回收，不能仅凭缺少内存返回值判断失败。
仅协调显式选择的兼容分支，不自动推断依赖完整性或复制文件，也不声称减少模型 token。

## 从观测变化自动恢复选中的 agent

`refreshAgentSharedCausalBatch(agents, supervisor, options)` 接通当前世界探测、
checkpoint 失效解释和共享恢复。`agentIds` 显式选择同一个文件世界内的兼容分支；
内核读取其最新 checkpoint 的 heads，宿主无需手工构造 `changed`。

```ts
import { refreshAgentSharedCausalBatch, prepareWorkspaceBranchRepair } from '@xioflow/kernel';

const result = await refreshAgentSharedCausalBatch(agents, supervisor, {
  agentIds: ['planner', 'reviewer'],
  validation: {
    txId: probeId, runId, root: workspaceRoot, forkPath: probeForkPath,
    closedWorld: true, replayPolicy: 'deterministic', replay,
  },
  prepare: (plan) => prepareWorkspaceBranchRepair(supervisor, {
    txId: sharedTxId, runId, root: workspaceRoot, forkPath: sharedForkPath,
    atSeq: Math.max(...plan.affected.map(({ checkpoint }) => checkpoint.seq)),
    changed: plan.changed,
    branches: plan.affected.map(({ agentId, checkpoint }) => ({
      id: agentId, heads: checkpoint.causalHeads!,
    })),
    execute, validateReuse,
  }),
  bind: async (impact, repair) => {
    const prepared = await materializeAgentContext(impact, repair);
    return { checkpoint: prepared.context, workspace: prepared.transaction,
      discard: () => supervisor.abortWorkspaceTransaction(prepared.transaction.txId) };
  },
});
if (result.status === 'recovered') {
  console.log(result.validation.seq, result.planSeq, result.preview.affected);
  console.log(result.batch.outcomes); // 逐项 repaired / skipped / failed
  // 共享事务在 result.batch.repair，仍由宿主管理。
}
```

以上变量和 `replay`、`execute`、`validateReuse`、`materializeAgentContext` 由宿主提供，
约束与前述共享恢复示例相同。完整可运行集成测试见
`tests/agents/causal-checkpoints.test.ts` 中的 `probes selected agents`。

- 先冻结所有选中 checkpoint 的序号，再在一个当前基线的独立 fork 中重放各跟踪分支。
  未选中 agent 不恢复；新建 agent 不自动加入批次。多个选中分支可以复用共享观测。
- 任一分支工具失败返回 `validation_failed`，即使其他分支发现变化也不准备修复。
  探测期间任一选中 checkpoint 改变返回 `checkpoint_changed` 和对应 agent id；需重新调用。
- 无失效分支返回 `unchanged`，不调用 prepare/bind。未跟踪 agent 单列在 preview.untracked；
  全部未跟踪时返回 `untracked`，不创建探测事务。`unchanged` 不代表未跟踪上下文有效。
- 可恢复结果附 `preview`，包含每个受影响 checkpoint 的最短证据路径。
  `AGENT_CAUSAL_REFRESH_PLANNED` 用 `planSeq` 关联持久验证报告和被检查的 checkpoint 序号；
  该事件表达计划，实际发布以每项 `causal_repaired` 为准。
- 进入共享准备后仍使用同一冻结计划，绑定前检查 checkpoint 版本和停止状态。
  `recovered` 表示已执行恢复批次；必须检查 outcomes，可能全部跳过或部分失败。
- 此入口不提交工作区、不停止或 resume agent。当前世界可能继续变化，观测匹配只是修复种子；
  宿主仍须验证复用、重建上下文和独立文件分支，并通过 OCC 发布文件。
  `prepare` 抛错由宿主清理资源，之后可从 journal 查询探测和计划；不存在跨 agent 原子提交。

## 重开后查询冻结的恢复解释

`listAgentCausalRefreshPlans(domain, { runId?, atSeq? })` 从 journal 查询历史计划，
并按计划引用的 checkpoint 重建与当时 `preview` 相同的上下文、失效节点、最短因果路径
和 `restartFrom` 候选。只需要打开 `ExecutionDomain`，不需要创建 `AgentRuntime`，
不触发工具重放、文件分叉或任何 journal 写入。

```ts
import { listAgentCausalRefreshPlans } from '@xioflow/kernel';

const history = listAgentCausalRefreshPlans(domain, { runId, atSeq: auditSeq });
for (const plan of history) {
  console.log(plan.seq, plan.validationSeq, plan.checkpoints);
  for (const impact of plan.preview.affected) {
    console.log(impact.agentId, impact.checkpoint.seq, impact.recomputation.explanations);
  }
}
```

`atSeq` 是包含边界的 journal 截止序号；`runId` 筛选发起探测的 Run，选中 agent
可以属于其他 Run。后续修复、恢复、运行或新增因果节点不会改写旧计划的解释。
返回值可由调用方修改，不影响持久记录。未知版本和缺失引用会报错，不能伪装成空历史。

这些记录表示**恢复意图**：即使 `prepare` 抛错，已经落盘的计划仍可查询。
例如两个 agent 中一个绑定成功、另一个绑定失败，二者仍在原计划的 `affected` 内；
查询不会把后者变成成功，也不推断事务已经 OCC 提交。逐项发布仍需核对
`AGENT_STATE / causal_repaired` 及其 `checkpointRef`，当前接口不自动关联发布结果。
