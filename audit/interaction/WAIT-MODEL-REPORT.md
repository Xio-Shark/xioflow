# 真实进程等待模型对照

2026-11-04，wait-v1，**COMPLETE**（截至请求 1076）。正式矩阵计划 108 次，已尝试 108，提交并通过 106，基础设施失败 2，未尝试 0；pilot 单列 9/9。

| 集合 | 接口 | 通过/尝试 | 模型请求中位数 | 工具错误 | 已知输入 Token | 已知输出 Token | 保守美元 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| dev | agent-poll | 18/18（计划18） | 4 | 0 | 105651 | 10828 | 0.044689 |
| dev | server-poll | 18/18（计划18） | 4.5 | 0 | 140877 | 15162 | 0.060457 |
| dev | event-view | 18/18（计划18） | 4.5 | 0 | 142059 | 14918 | 0.060519 |
| heldout | agent-poll | 17/18（计划18） | 5 | 0 | 105686+ | 10470+ | 0.049912 |
| heldout | server-poll | 18/18（计划18） | 4 | 0 | 133528 | 13144 | 0.055831 |
| heldout | event-view | 17/18（计划18） | 4 | 0 | 130949+ | 13213+ | 0.062908 |

## 失败与边界

- heldout/heldout-04/event-view/0：infrastructure_error；"no_submission"
- heldout/heldout-05/agent-poll/0：infrastructure_error；"no_submission"

请求 880 的[逐笔审计](results/model-20261103/reviews/request-880.json)保留完整预留与失败；恢复规则及源码变化见 [timeout-review.md](results/process-model-v1/timeout-review.md)，该失败 episode 没有重试。

请求 881 的[逐笔审计](results/model-20261103/reviews/request-881.json)保留完整预留与失败；恢复规则及源码变化见 [timeout-review.md](results/process-model-v1/timeout-review.md)，该失败 episode 没有重试。

同一 ClinePass 配置模型、受控真实子进程与合成任务；保留集不是外部盲测。模型必须自行建立观察条件。工具数量及说明不同、缓存不可控、短等待可能在下一次模型响应前结束，不能把某组结果概括为任意 OS 场景优势。正式矩阵已按计划补齐（108/108）；仍有 2 个基础设施失败，组间比较需结合失败与成本边界。

本实验含 pilot 共 533 次请求，保守计入 $0.3600201；所有阶段累计 $0.9129750 / $5。费用含失败预留，不是现金账单；usage 缺失单列，已知 Token 带 + 表示下界。各组缓存量、服务 cost、耗时和具体失败保存在 [summary.json](results/process-model-v1/summary.json)。

源码快照、请求归属和独立清理记录均已核对；原始证据在 results/process-model-v1/。已知输入/输出、缓存、底层扫描、探针、通知与模型调用分别统计。未尝试的矩阵部分不计为通过。
