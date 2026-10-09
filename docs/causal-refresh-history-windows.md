# 滑动历史窗口与变化率漂移

长期运行的 agent 可能切换工作负载。`estimateWorkspaceCausalRefreshHistory` 支持显式排除
过时的决策，同时保留冻结的训练截止点与独立时间验证集：

```ts
import { estimateWorkspaceCausalRefreshHistory } from '@xioflow/kernel';

const estimate = estimateWorkspaceCausalRefreshHistory(domain, {
  taskKey: 'compile:v2:four-branches:baseline-observations',
  trainingAfterSeq: 800, // 排除 seq <= 800 的决策；省略时为 0
  trainingAtSeq: 1200,  // 训练决策及遥测必须均在此之前完成（含）
  atSeq: 1800,          // 后续独立验证的历史截止点
});
console.log(estimate.excludedDecisions, estimate.training, estimate.heldOut);
console.log(estimate.forecast, estimate.evaluation, estimate.drift);
```

窗口为 `(trainingAfterSeq, trainingAtSeq]`，按**决策序号**选择；旧决策在窗口内完成也不进入训练。
`excludedDecisions` 统计同 taskKey 被起点排除的决策，包括没有遥测的决策。
起点、训练终点、查询终点必须是有序非负安全整数；起点等于训练终点允许空训练集。
省略起点保持原有全历史训练行为。后续验证集仍只包含训练终点之后的决策；
训练决策迟到完成仍记为 missing，不进入验证集。固定三个序号后，重开 domain 可重现查询。

`drift` 仅使用成功且无回调错误的探测样本，分别返回训练/验证样本量和变化率。
`changeProbabilityDelta` 是验证变化率减训练变化率；正值表示验证样本变化更频繁。
`brierScore` 是冻结训练概率 p 对验证标签 y 的平均 `(p - y)²`，范围 0 到 1，越低越好。
例如训练变化率 0.5、验证全变化，差值为 0.5、分数为 0.25。
任一分区没有有效探测时 drift 为 null。仅有一种训练标签时仍可描述概率漂移，
但无法估计另一类别成本，故 forecast 仍为 null。成本 MAE 的原有定义不变。

这些是描述统计，没有显著性阈值，不自动滑动窗口或切换执行策略。
宿主应先固定窗口，再运行独立验证；不能为追求低误差根据验证结果反复挑选同一窗口。
失败、缺失和直接重算没有可靠变化标签，均排除；策略筛选仍会带来选择偏差。
预测不授权结果复用，所有发布仍经过现有 OCC。本 API 不测量 token 或未执行路径的收益。
