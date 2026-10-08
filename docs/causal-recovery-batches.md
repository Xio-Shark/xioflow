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
