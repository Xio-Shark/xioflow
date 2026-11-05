# Agent如何获取系统事实并完成可核查操作

2026-11-04，截至共享账本请求1076。研究结论为 **PASS WITH CONCERNS**：本地机制和操作环境已验证，P2 模型等待矩阵已完成（108/108 尝试、106 通过、2 个基础设施失败）。后续执行见[NEXT.md](NEXT.md)，完成状态见[任务清单](../../.xiotask/tasks/11-03-agent-system-interaction/todolist.md)。

目前值得继续验证的方向是：让模型表达目标与观察条件，执行层承担机械等待和版本检查，由独立后置条件确认结果。现有实验尚未证明事件订阅或结构化工具能够降低模型完整交互成本。

## 关键发现

1. **系统等待减少通知，但事件视图也有额外成本。** 108次确定性对照均通过200 ms最终状态发现门禁。主动查询、去重轮询、事件视图分别返回200、91、91次通知，扫描200、253、286次。该配置下事件视图比去重轮询扫描更多。
2. **完整开发集没有减少模型请求。** 每组18次均通过；agent-poll共79请求、中位数4，server-poll共84、中位数4.5，event-view共85、中位数4.5。系统等待组耗时中位数较短，但API延迟、说明和缓存等因素未分离。正式矩阵总计尝试108/108、通过106、基础设施失败2、未尝试0；2个失败为请求880/881超时，均保留完整预留、未重试。
3. **停止观察可能有优化空间。** 部分矩阵时点（65条成功轨迹）中62条在首次返回满足终局条件的状态后继续观察，共82次额外观察；P2.4 完成后成功轨迹增至106条，额外观察统计待 P2.5 重算。已有模型首个watch条件在20条可用来源上回放均通过独立检查，4条来源未运行。后见分析和回放不能直接折算为费用节省；v1的身份重绑定缺陷已修复，原失败不归因于模型。
4. **动作回执需要运行态验证。** 24个脚本任务中，12个完成配置变更，12个正确识别退出或reload失败而报告blocked。文件写入、reload接受和实际加载分别记录；blocked不算业务目标完成。模型操作对照尚未运行。
5. **输出预算需要支持完整读取。** 扩大预算后三种参考接口均12/12；固定小上限下，没有继续读取路径的参考调用会停止。jq参考客户端未实现手动分片，不代表jq语言缺少这一能力。完整集合、长文本和原模型full读取更少请求的反例保留。

## 证据索引

| 研究内容 | 报告 | 原始证据 |
| --- | --- | --- |
| 历史启发 | [HISTORY.md](HISTORY.md) | 文中原始资料，只作假设来源 |
| 文件查询机制 | [REPORT.md](REPORT.md) | [mechanism.json](results/mechanism.json) |
| 早期文件状态订阅 | [WATCH-REPORT.md](WATCH-REPORT.md) | [watch.json](results/watch.json)，未匹配发现延迟 |
| 自然语言任务环境 | [TASK-REPORT.md](TASK-REPORT.md) | 正确与故意错误参考客户端验证 |
| 原只读模型107/108 | [MODEL-REPORT.md](MODEL-REPORT.md) | [541请求账本快照](results/model-20261103/budget-through-0541.json)；`model-report.mjs --historical` |
| 真实进程正确性与清理 | [PROCESS-REPORT.md](PROCESS-REPORT.md) | [process-v1.json](results/process-v1.json) |
| 匹配新鲜度的等待机制 | [WAIT-REPORT.md](WAIT-REPORT.md) | [wait-mechanism-v1.json](results/wait-mechanism-v1.json) |
| 模型等待矩阵完成（108/108） | [WAIT-MODEL-REPORT.md](WAIT-MODEL-REPORT.md) | [summary.json](results/process-model-v1/summary.json)，同目录的episode、requests和source-snapshots |
| 受限动作与恢复 | [ACTION-REPORT.md](ACTION-REPORT.md) | [action-mechanism-v1.json](results/action-mechanism-v1.json) |
| 预算、缓存与观察策略 | [ABLATION-REPORT.md](ABLATION-REPORT.md) | [预算v2](results/budget-ablation-v2.json)、[轨迹分析](results/wait-trajectory-analysis.json)、[条件回放v2](results/plan-replay-v2.json) |
| 命令与失败记录 | [verification.md](../../.xiotask/tasks/11-03-agent-system-interaction/verification.md) | exit code、修订与验证输出 |

原只读108次与等待计划108次属于不同实验，不能合并成功率。确定性客户端知道任务语义，验证机制和环境；模型保留集也来自同一合成环境，不是外部盲测。缓存只做描述性分析，跨模型迁移尚未验证。

当前决定是[保留研究层](INTEGRATION.md)，已有opcode映射不代表生产集成完成。[本地演示](README.md#local-commands)分别展示真实模型观察轨迹与确定性客户端的操作闭环，后者的[运行记录](results/demo-live-20261103.jsonl)包含生效、恢复和清理证据。
