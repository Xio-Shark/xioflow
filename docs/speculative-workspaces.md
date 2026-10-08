# 多策略投机工作区（实验性）

`speculateWorkspace` 将同一任务的多个策略放到共享基线快照的独立事务中并行执行。所有策略完成后，按声明顺序尝试普通事务提交；第一个通过 OCC 的候选成为胜者，其余工作区被回收。策略可以在回调中调用 AgentRuntime、工具或测试，并通过抛错拒绝不合格的结果。

```ts
import { speculateWorkspace, WorkspaceCausalGraph } from '@xioflow/kernel';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// supervisor 已关联一个 domain，runId 指向该 domain 的活动 run。
const graph = new WorkspaceCausalGraph(supervisor.getDomain());
const result = await speculateWorkspace(supervisor, {
  speculationId: 'solve-42', // domain 中唯一；候选事务为 solve-42-0、solve-42-1
  runId,
  root: '/repo',
  forkPath: '/work/solve-42',
  strategies: ['minimal', 'alternative'].map((id) => ({
    id,
    async execute(tx) {
      // 实际宿主在 tx.forkRoot 中运行策略、收集观测并验证结果。
      await writeFile(path.join(tx.forkRoot, 'answer.txt'), id);
      graph.record({
        txId: tx.txId, actorId: id, dependsOn: [],
        observation: {
          kind: 'mutate',
          call: { tool: 'write', args: { path: 'answer.txt', content: id } },
          resultHash: 'ok',
        },
        writes: [{ path: 'answer.txt', status: 'A' }],
      });
      // 若已有完整观测日志，可返回 { observations: { log, closedWorld: true, replay } }。
    },
  })),
});
console.log(result.status, result.winner, result.candidates);
```

## 提交和生命周期

- fork 创建完毕后才同时启动回调，所有候选拥有同一个 `baseSnapshotId`。完成速度不改变优先级；失败或 OCC 冲突会继续尝试后续候选。
- 返回值记录每个候选的 `failed`、`conflict`、`discarded` 或 `committed` 状态，以及实际 `CommitResult`。没有胜者时返回 `no_winner`。`discarded` 表示执行完成但未尝试提交。
- 回调返回的 `CommitOptions` 原样用于已有事务提交，包括观测重放。保留已有 `files` / `observations` / `write_only` 验证语义；获胜表示事务可提交，任务是否正确由策略自身的验证决定。
- 所有回调都必须等到子进程、工具和写入结束后才返回。当前入口不抢先取消策略，也不限制并发数；长时间不结束的回调会阻塞整个选择过程。只在隔离 fork 内执行的文件效果可被自动回收，外部效果仍由宿主管理。
- 正常完成时回收失败、冲突和落选 fork，并释放共享基线快照。journal 中的 `SPECULATION_STARTED`、`SPECULATION_FINISHED` 和既有 TX 事件保留策略与事务映射；回调记录的因果节点也保留。
- 提交抛出异常时，可能已经开始应用文件。入口停止选择其他候选，保留该事务的 fork 与基线，抛出包含事务 ID 的 `AggregateError`。宿主按已有事务恢复协议处理并重试提交；其他候选仍尝试回收。清理错误也会显式抛出。`SPECULATION_FINISHED` 记录选择结果，不代表后续清理已经完成。

## OCC 冲突后的局部修复

策略可提供 `repair(original, conflict)`。它仅在原候选 OCC 冲突时调用一次，返回修复计划或 `undefined`（直接尝试下一个候选）。修复保持该策略的优先级，从当前主工作区创建新事务，调用 `prepareWorkspaceRepair`，随后再次走普通 OCC；第二次冲突则转向下一个候选。

```ts
const strategy = {
  id: 'incremental',
  execute: executeCandidate,
  async repair(original, conflict) {
    // adapter 是宿主实现；路径冲突不自动等价于某个因果节点失效。
    const changed = await adapter.findChanged(candidateHeads, conflict, root);
    return {
      changed,
      heads: candidateHeads, // 必填，包含本候选所有要保留的独立输出
      atSeq: graph.nodes().at(-1)!.seq,
      async validateReuse(tx, unaffected) {
        // 原候选 fork 尚未回收；验证依赖后，将缺失的独立输出物化到新 fork。
        await adapter.validateAndMaterialize(unaffected, original.forkRoot, tx.forkRoot);
      },
      async execute(source, tx, dependencies) {
        return adapter.recompute(source, dependencies, tx.forkRoot);
      },
      async commitOptions(prepared) {
        // 重算完成后收集提交证据；必须覆盖复用输入。
        return adapter.commitEvidence(prepared);
      },
    };
  },
};
```

修复事务 ID 为 `${原候选 txId}-repair`，fork 路径为 `${forkPath}-${index}-repair`，由入口管理创建、提交和回收；回调不能自行提交或中止事务。`heads` 和 `changed` 仍由宿主声明，不自动推断依赖或复制整个旧 fork。复用验证不通过应抛错；缺失的独立输出也可列入失效种子重算。

`candidate.commit` 保留原提交冲突；`candidate.repair` 记录新事务 ID、替代后的 heads 和第二次提交结果。`candidate.status` 表示最终候选状态，只有修复提交成功后才能把新 heads 当作当前工作区分支。`SPECULATION_REPAIR_PREPARED` 将策略、原事务、新事务和 heads 关联；节点替代关系继续由 `CAUSAL_REPAIR_PREPARED` 记录。

正常结束会回收原候选、修复 fork 和所有本轮基线。修复计划、验证、工具或证据回调抛错时终止本轮并回收尚未提交的事务，错误通过 `AggregateError` 上报；修复提交抛错时停止选择后续候选，保留该修复事务及基线供恢复。与原有异常清理一致，存在未回收事务时保守保留本轮快照。

真实文件用例见 `tests/workspace/speculation.test.ts`：局部重算、独立输出复用、兄弟分支隔离、二次冲突回退、工具错误与不确定提交。多胜者模式见下文；不恢复模型上下文，也不声称节省 token。

## 多 agent 兼容结果合并

同一任务的替代策略使用默认 `commitPolicy: 'first_valid'`；多个 agent 分工产生需要共同保留的结果时，显式设置 `commitPolicy: 'all_valid'`：

```ts
const merged = await speculateWorkspace(supervisor, {
  speculationId: 'team-42', runId, root: '/repo', forkPath: '/work/team-42',
  commitPolicy: 'all_valid',
  strategies: [
    { id: 'docs', execute: updateDocs },
    { id: 'tests', execute: updateTests },
    { id: 'implementation', execute: updateImplementation, repair: repairImplementation },
  ],
});
console.log(merged.winners); // 实际提交成功的 agent，按提交顺序排列
```

所有回调仍基于同一快照并行执行。提交按声明顺序进行，后续候选通过已有 OCC 检查先前胜者造成的变化：不相交的写集可以合并，但读取已被改变的文件仍会冲突；原有观测重放与一次局部修复同样适用。失败或冲突不妨碍后续独立候选提交，不会尝试求最大兼容集合，也不进行文本级自动合并。读集不可观测时仍明确返回 `write_only`，不能据此宣称观测有效。

`winners` 在两种模式中都返回全部胜者（无胜者为 `[]`），`winner` 保持为第一个胜者。`status: 'committed'` 表示至少一个候选成功，逐候选状态解释其余结果。`SPECULATION_STARTED` 记录策略，新增 `SPECULATION_CANDIDATE_COMMITTED` 逐次记录策略 ID、实际提交事务 ID（可能为修复事务）与累计胜者；`SPECULATION_FINISHED` 记录完整结果。

**批次不是原子事务。** 后续回调、提交或清理抛错时，先前提交仍然保留；提交异常立即停止后续提交，保留不确定事务供恢复，并尝试回收其余 fork。宿主可查询 TX journal 与逐候选提交事件恢复已完成进度；TX journal 是实际提交事实的依据（进程可能在提交完成与投机事件写入之间中断）。本入口不自动回滚已提交胜者，也不自动恢复中断批次。
