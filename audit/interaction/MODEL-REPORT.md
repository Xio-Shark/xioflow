# ClinePass 真实模型对照结果

2026-11-03。已执行 108 个正式任务运行，107 个通过独立检查。另有 3 个 pilot 运行，单独保存且不计入正式成功率。

后续进程实验已开始向同一累计账本追加请求。本报告的费用和请求数截至第541次请求，不包含后续实验；不可变账本见 [budget-through-0541.json](results/model-20261103/budget-through-0541.json)，可用 `node audit/interaction/model-report.mjs --historical` 只读核验。

配置模型：`cline-pass/deepseek-v4.1-flash-1017`。服务返回标签：`vmc/deepseek-v4p1-flash-1017-contributor-fallbacks`。三组使用相同模型、指令、temperature=0 和请求上限，各任务重复三次并轮换组顺序。

## 正式结果

| 集合 | 接口 | 正确终局 | 每任务模型请求中位数 | 输入 Token 合计 | 输出 Token 合计 | 工具错误 | 保守折算 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dev | full | 18/18 | 3 | 184738 | 15084 | 0 | $0.073522 |
| dev | jq | 18/18 | 6.5 | 241688 | 18486 | 7 | $0.094690 |
| dev | structured | 18/18 | 5 | 225187 | 18181 | 4 | $0.089373 |
| heldout | full | 17/18 | 3 | ≥205883 | ≥14176 | 0 | $0.090927 |
| heldout | jq | 18/18 | 6 | 274265 | 21043 | 4 | $0.107531 |
| heldout | structured | 18/18 | 4.5 | 207924 | 15255 | 2 | $0.080683 |

成功率以所有计划任务为分母，包括服务失败未完成的任务；它衡量只读答案与当前版本，不是任意 OS 操作成功率。Token 来自实际 usage；含未知用量的组用 ≥ 表示已知下界。模型请求与工具执行次数可能不同。缓存使用和固定任务重复会影响计量，不把单次低成本当作普遍保证。

## 各任务

| 任务 | full | jq | structured |
| --- | ---: | ---: | ---: |
| dev-01 | 3/3 | 3/3 | 3/3 |
| dev-02 | 3/3 | 3/3 | 3/3 |
| dev-03 | 3/3 | 3/3 | 3/3 |
| dev-04 | 3/3 | 3/3 | 3/3 |
| dev-05 | 3/3 | 3/3 | 3/3 |
| dev-06 | 3/3 | 3/3 | 3/3 |
| heldout-01 | 3/3 | 3/3 | 3/3 |
| heldout-02 | 2/3 | 3/3 | 3/3 |
| heldout-03 | 3/3 | 3/3 | 3/3 |
| heldout-04 | 3/3 | 3/3 | 3/3 |
| heldout-05 | 3/3 | 3/3 | 3/3 |
| heldout-06 | 3/3 | 3/3 | 3/3 |

## 失败保留

- heldout-02 / full / repeat 1: provider_empty_response; no terminal submission

## 本轮预算

包括 pilot 共 541 次模型请求，已返回的用量为 1376256 输入 Token、104485 输出 Token；另有 1 次请求用量未知。预算保守计入 **$0.550410 / $5.00**，其中未知用量预留 $0.012151；服务已返回 cost 合计 $0.263620，不包含未知部分。

[ClinePass 是订阅额度制](https://docs.cline.bot/getting-started/clinepass)。这里采用峰值参考价并忽略缓存折扣，服务 cost 也不是核验过的现金账单。逐请求预留和结算在 [budget.json](results/model-20261103/budget.json)。

## 解释边界

语料规模为 12 个任务，除真实 ISA 注册表副本外均为合成数据；保留集不是外部盲测。只验证一个配置模型、可调整结果预算和受控状态更新。尚未测固定预算、跨模型迁移、真实服务等待、订阅发现延迟或系统写操作。返回模型标签稳定不证明权重完全不变。

上游空响应触发过一次协议修订：保存失败，不重试失败任务，保留完整费用预留并继续其他任务。模型、提示、任务数据未变；这次中途修订必须随结果披露。原始源码快照与恢复后哈希均已核验，详见 [runtime-amendment.json](results/model-20261103/runtime-amendment.json)。

所有任务临时目录已清理；未修改或关闭已有本地代理。原始请求、响应、工具轨迹、评分和 manifest 保存在 results/model-20261103；汇总见 [model-summary.json](results/model-summary.json)。
