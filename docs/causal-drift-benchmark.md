# 分布漂移下的刷新策略对照

运行：

```sh
pnpm build
node scripts/benchmarks/causal-drift.mjs
# 快速协议检查
node scripts/benchmarks/causal-drift.mjs '{"repetitions":2,"hashRounds":2}'
```

默认每次重复依次执行旧分布 `[false,false,false,true]`、近期分布
`[false,true,true,true]`，冻结两个训练窗口，再验证 `[true,true,true,false]`。
`true` 表示修改输入。三个 schedule 和 repetitions 均在执行前固定；两个训练阶段
都必须包含变化与未变化。每个样本在新 Git 工作区中建立 read→derive 因果链，
执行真实刷新、journal 遥测与强制 OCC 重放；结果与直接计算的文件哈希比较。

全历史预测包含两个训练阶段，近期预测只包含近期阶段。二者共享仅从全部训练数据
估计的每节点 execute/replay 毫秒成本，以隔离预测窗口的影响；本夹具变化时无保留
节点，所以 reuse 成本为零。每次重复从独立 domain 重新训练。策略顺序按样本与
重复编号交替，探测控制先执行，策略结果不混入训练或独立验证集。

报告包含每次重复的冻结序号、预测、验证 Brier 分数、变化率漂移、成本 MAE、
训练开销、逐样本决策与遥测，以及全历史/近期的成功率、回调次数与耗时均值。
`pairedCallbackDeltaMs` 为近期减全历史的成对回调耗时差，负值表示近期更快；
同时列出最小/最大值和样本量，不将它们当作置信区间。callbackCalls 计适配器
回调次数（包括空复用校验），不是文件操作次数或模型 token。

预测窗口不会根据验证结果挑选。近期窗口可能因为样本少或分布再次变化而更差。
默认变化率下，全历史预测概率为 0.5、近期为 0.75；独立验证 Brier 分数分别为
0.25、0.1875，但这不保证耗时下降或策略选择不同。耗时受系统噪声影响；
训练和评估的夹具初始化不计入刷新耗时，训练开销单列。零成本探测预测仅为
采集完整变化标签的控制哨兵。临时 journal 序号只在所属重复内有效。
`modelTokens: null` 明确表示未接入真实模型；此基准不证明生产任务或模型 token 收益。
