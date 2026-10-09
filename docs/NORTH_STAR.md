# xioflow 北极星：让 agent 的成果跟得上变化的世界

> 本文定义目标形态与产品取舍，不是现有 API 承诺。
> 本轮依据目录、最近 80 条提交及愿景、因果、基准文档作判断；未审阅源码、未运行测试。下列 API 与指标是设计和验收目标，不代表已实现或已达标。

## 1. 第一性原理：缺少的是成果有效性的执行契约

Agent 的推理和工具调用依赖一个会变化的世界；保存对话、重试任务和隔离进程，都不能回答旧成果现在还能否使用。

**一句话：xioflow 让 agent 在世界变化后，凭可检查的依赖证据复用仍有效的成果、重算受影响部分，并安全提交变更。**

## 2. 理想形态：可嵌入的执行内核

**首发 TypeScript 库**，嵌入现有 agent 宿主：模型、工具与上下文已经由宿主管理，同进程接入最容易明确证据和资源的责任归属，也便于逐步替换现有组合入口。

首批只承诺单机、单个 Git 工作区内的文件世界：覆盖清单、版本、工具读写及验收由适配器显式声明。未覆盖文件、网络读取和不可逆外部写入不能获得自动复用或重放保证；覆盖不足必须返回 `unknown`。

CLI 随库提供可复现演示和历史解释，复用同一契约；守护进程延后，直到跨进程共享世界的需求足以承担认证、租约和远程故障语义的成本。

### 最小接入契约

以下是拟议 API；`fileAdapter` 提供文件覆盖、观测与验收契约，`agent` 接入宿主模型与工具，示例仓库已有报价输入。

```ts
import { openWorld } from '@xioflow/kernel';
import { writeFile } from 'node:fs/promises';
import { fileAdapter, agent } from './host.js';
const world = await openWorld({ root: './repo', adapter: fileAdapter });
try {
  const step = await world.runAgentStep(agent, { task: '按 pricing.json 生成 quote.md' });
  await writeFile('./repo/pricing.json', '{"unitPrice":120}\n'); // perturb：外部改价
  const refreshed = await world.refresh(step, { onUnknown: 'recompute' });
  console.log(await world.explain(refreshed));
  const result = await world.commit(refreshed, { validation: 'strict', key: refreshed.id });
  if (result.status !== 'committed') throw new Error(result.reason);
} finally { await world.close(); }
```

`runAgentStep` 在隔离分支记录观测、上下文依赖与输出；外部写入制造真实扰动。`refresh` 只准备候选，不发布；`explain` 返回变化源、依赖路径、复用与重算节点。

`commit` 重验当前证据、输出和宿主验收，并以 OCC 发布；刷新后再次变化必须冲突。证据未知时可完整重算，仍无法建立覆盖则拒绝提交；同一 key 重试返回同一发布结果。

稳定入口收敛为 `openWorld` 与上述句柄方法；探测、共享修复、checkpoint 绑定和重试由内部状态机组合。宿主仍定义工具语义与业务验收，内核统一核验契约、推进状态和记录失败；成本预测只能选路径，不能放宽提交条件。

世界句柄持有临时事务与快照，`close` 清理已确定终态的资源；提交结果未知时保留恢复证据并返回可查询身份，不把清理成功当作提交成功。

## 3. 核心抽象与不可破坏的不变式

| 抽象 | 边界与必须成立的条件 |
| --- | --- |
| 世界状态 | 可版本化的观测范围，不是整个现实世界的副本。 |
| 因果图 | 记录结果为何成立；依赖完整性必须显式表达。 |
| 事务 / OCC | 隔离计算与受控发布；检查失败不得发布旧成果。 |
| 重放 | 区分历史展示、证据再验证与重新执行。 |
| 验证 | 检查版本、依赖、输出和任务验收；各层保证不能互相替代。 |

### 内核与插件

内核负责可验证状态转换；工具、模型、存储后端和成本策略通过明确契约接入。

## 4. 向成熟系统借鉴什么

| 系统 | 借鉴 | xioflow 的边界与差异 |
| --- | --- | --- |
| Temporal | 持久执行与恢复 | 补上活动所依据的世界状态是否仍有效。 |
| LangGraph | 图编排与 checkpoint | 绑定上下文、依赖证据和工作区版本。 |
| Dagger / Nix | 隔离、可寻址产物与显式输入 | 处理交互中形成的观测依赖与可提交变更。 |
| Git | 不可变历史与分支 | 合并后还要验证工具成果及决策依据。 |
| 数据库 MVCC | 快照、版本与并发控制 | 将有界世界中的工具执行纳入提交检查。 |
| Bazel | 动态依赖与增量失效 | 将增量计算延伸到 agent 上下文与发布协议。 |

## 5. 诚实审视现状：收敛能力，而非继续堆入口

以下是后续收敛决策，本轮只改本文；路径均相对 `docs/`。合并保留场景和失败语义，删除样本须先由统一报告覆盖，原始实测仍可从 Git 历史追溯。

| 文档 | 处置 | 理由与去向 |
| --- | --- | --- |
| `causal-graph.md` | 保留为内核 | 节点身份、显式依赖与失效闭包是复用和解释共同依赖的事实层。 |
| `causal-explanations.md` | 保留为内核 | 变化源到成果的证据路径必须与执行使用同一图和历史截止点。 |
| `causal-validation.md` | 合并 | 探测、直接重算和提交并入 `refresh/commit` 契约，消除多入口验证语义分叉；预测部分移插件。 |
| `causal-repair.md` | 合并 | 单分支与共享修复归入同一刷新执行器，按节点身份去重并统一资源归属。 |
| `causal-recovery-batches.md` | 合并 | refresh、resume、retry 归入持久状态机，保留逐项 checkpoint 校验与未决资源记录；成本策略移插件。 |
| `causal-refresh-history-windows.md` | 降级为插件或示例 | 窗口选择只影响成本且有选择偏差，不应成为正确性或首次接入的前提。 |
| `causal-repair-benchmark.md` | 合并 | 作为统一基准的局部变化场景，保留独立 oracle，统一计入验证与发布成本。 |
| `causal-refresh-benchmark.md` | 合并 | 作为统一基准的主协议，用相同提交保证比较无变化、局部变化和全量变化。 |
| `shared-repair-benchmark.md` | 合并 | 共享祖先变成场景参数，分发读写和独立事务验证必须进入总账。 |
| `speculative-merge-benchmark.md` | 合并 | OCC 冲突变成场景参数，并继续计入失败投机的执行成本。 |
| `causal-recovery-benchmark.md` | 合并 | 统一覆盖进程死亡、输入变化、输出损坏及 OCC 发布，避免只验证恢复到 checkpoint。 |
| `causal-refresh-history-benchmark.md` | 降级为插件或示例 | 保留策略插件的冻结训练与独立评估协议，不把预测误差当作产品收益。 |
| `causal-drift-benchmark.md` | 降级为插件或示例 | 漂移实验服务于成本策略，Brier 分数改善不构成内核发布门槛。 |
| `checkpoint-forks.md` | 降级为插件或示例 | 历史重建属于调试工具，完整前缀与确定性要求不应扩张最小接入契约。 |
| `checkpoint-comparison.md` | 合并 | 只读证据对照并入 `explain` 文档，需重建文件的对照归入历史调试插件。 |
| `speculative-workspaces.md` | 降级为插件或示例 | 候选调度和胜者策略由宿主选择，首发内核只承诺每次提交的有效性。 |
| `VISION.md` | 合并 | 产品定位和路线以本文为准，原页改作实现索引，避免两个愿景各自增长。 |

样例也逐项收敛；下表的“合并”指迁入同一报告格式，保留配置、环境、原始样本与正确性结果。

| 样例 | 处置 | 理由与去向 |
| --- | --- | --- |
| `benchmarks/causal-repair.sample.json` | 合并 | 保留局部失效与不校验复用的负对照。 |
| `benchmarks/causal-refresh.sample.json` | 合并 | 保留生成次数下降但总成本上升的反例。 |
| `benchmarks/causal-refresh-shared.sample.json` | 合并 | 保留共享祖先对端到端成本的影响。 |
| `benchmarks/shared-repair.sample.json` | 合并 | 保留分发与额外事务抵消去重收益的样本。 |
| `benchmarks/speculative-merge.sample.json` | 合并 | 保留真实冲突及失败投机成本。 |
| `benchmarks/causal-recompute.sample.json` | 合并 | 保留跳过探测的完整重算对照。 |
| `benchmarks/causal-probe-reuse.sample.json` | 删除 | 统一基准以缓存开关覆盖同基线探测复用后，不再维护独立报告。 |
| `benchmarks/causal-refresh-adaptive.sample.json` | 降级为插件或示例 | 估算命中与失准属于策略评估。 |
| `benchmarks/causal-refresh-policy.sample.json` | 降级为插件或示例 | 独立先验只用于比较选路成本。 |
| `benchmarks/causal-refresh-history.sample.json` | 降级为插件或示例 | 保留历史预测的独立验证及训练开销。 |
| `benchmarks/causal-drift.sample.json` | 降级为插件或示例 | 保留窗口漂移实验，限制在该负载解释收益。 |
| `causal-recovery.sample.json` | 删除 | 统一故障场景覆盖后，删除止于绑定恢复、未走文件发布的独立验收样本。 |
| `causal-recovery-occ.sample.json` | 合并 | 恢复成功必须落到实际文件发布与输出核对。 |
| `causal-recovery-crash.sample.json` | 合并 | 保留真实进程死亡区别于回调抛错的故障边界。 |
| `causal-recovery-validation-stable.sample.json` | 合并 | 保留输入稳定时经验证续跑的成本基线。 |
| `causal-recovery-validation-changed.sample.json` | 合并 | 保留输入变化后拒绝旧成果并重算的对照。 |
| `causal-recovery-output-tampered.sample.json` | 合并 | 保留输入未变但持久输出损坏时拒绝续跑的反例。 |
| `causal-recovery-output-scale.sample.json` | 合并 | 保留不同输出规模下的验证、复制字节数与总耗时。 |

**最大的两个结构性问题：**

1. **正确性契约与资源归属没有收口。** 大量组合入口把探测、修复、绑定、OCC 和回收交给宿主拼接；文件提交与多个 checkpoint 绑定并非原子操作。必须收敛到持久状态机，分别记录准备、文件发布、逐项绑定和未知结果，不能以批次成功替代发布事实。
2. **评测按能力切片组织，缺少真实 agent 任务的收益总账。** 现有刷新样本生成调用从 8 降至 2，总调用却从 16 增至 23，中位耗时约 188→296 ms（三轮本机小负载，见 `causal-refresh-benchmark.md`）；哈希任务及 `modelTokens: null` 不能证明模型任务节省。必须统一正确性、总耗时与真实 token 口径，再决定优化方向。

## 6. 通向 v0.1 的可验证里程碑

1. **固定契约与支持范围**：定义入口、状态转换和不支持的行为。
2. **打通单条正确性闭环**：观测 → 执行 → 扰动 → 刷新 → OCC → 可查询结果。
3. **交付对比完整重跑的演示**：用相同输入、扰动与验收比较正确性和总成本。
4. **形成可复用的发布体验**：框架接入、故障恢复、文档与演示命令共同验收。

## 7. 此后每轮自动优化的五条原则

1. 从用户可见的失败或里程碑验收缺口开始。
2. 先保护正确性，再争取复用收益。
3. 优先合并现有能力，新增抽象必须证明必要性。
4. 用公平对照衡量端到端收益。
5. 每轮留下完整、可审查、可验证的结果。
