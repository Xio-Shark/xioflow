# M3 报价 demo：可复现输入与独立验收

当前交付输入、扰动、业务 oracle，以及通过内部 `openWorld` 运行的确定性报价宿主；尚未接入真实模型，也没有成本达标结论。后续运行器须复用 `openWorld`、统一报告口径与严格发布，不新增刷新入口。旧基准样本暂保留，不能用本切片替代它们的场景或实测。

```sh
pnpm build
node scripts/benchmarks/quote-fixture.mjs init /tmp/xioflow-quotes
node scripts/benchmarks/quote-fixture.mjs oracle /tmp/xioflow-quotes
# 首次 agent 执行完成、提交前，由独立进程执行：
node scripts/benchmarks/quote-fixture.mjs perturb /tmp/xioflow-quotes local
node scripts/benchmarks/quote-fixture.mjs verify /tmp/xioflow-quotes
```

`init` 只接受尚不存在的目录（父目录须存在），生成 20 个订单、19 个 SKU 价格文件和空报价目录。C01/C02 各买两件 SKU-A；C03–C20 各买两件独立 SKU。所有单价初始为 10000 分，无税费折扣，初始总额 400000 分。订单格式为 `{customer, lines: [{sku, quantity}]}`，价格格式为 `{sku, unitPriceCents}`；数值必须是非负安全整数，数量须大于零。

扰动使用固定目标值，可重复调用；`stable` 不写文件，`local` 将 SKU-A 设为 12000 分，`all` 将全部 SKU 设为 12000 分，`again` 将 SKU-A 设为 13000 分。局部改价后 C01/C02 各为 24000 分，总额 408000 分，其余 18 份正文不变；全改价总额 480000 分。`again` 用于刷新后第二次改价冲突测试。不同场景须从独立的初始目录开始。

`oracle` 从当前磁盘订单和价格独立使用 BigInt 计算，输出 `{files, totalCents}` JSON。`files` 的键是 20 份 `quotes/Cxx.md` 和 `quotes/summary.md`，值是标准 UTF-8 正文；该正文定义固定 Markdown 模板、排序、两位小数和 LF 换行。oracle 不读取候选、因果图、模型响应或刷新报告，不导入被测执行代码。未来 agent 的计算器和渲染器必须独立实现该模板，不能调用 oracle 生成被测产物，也不能向模型提供 oracle 结果。

`verify` 逐字节核对发布目录，输出 `{matched, mismatches}`；缺失、过期或被篡改的输出均不通过并以状态码 1 退出，非法输入或其他 I/O 错误直接报错。可将此函数用于宿主只读业务验收，同时在实际发布后再次核对。

后续 M3 验收仍须实现：每客户独立模型上下文、汇总依赖全部报价；同首次产物和历史分出的增量/全量配对；固定模型参数与轮换顺序；初始化单列、从扰动后检测直到绑定和资源回收的 JSON 成本总账（真实 usage、缓存、工具、字节、失败）；局部/稳定/全部变化各 30 对及二次改价 10 次。正确性和北极星规定的延迟/token 门槛须同时满足。

确定性宿主 `src/testing/quote-host.ts` 独立实现安全整数分计算与模板渲染，不导入 oracle；超出安全整数范围直接失败。每客户仅记录自身订单和所选价格的读取，报价写入依赖这些读取，汇总写入依赖全部 20 个报价节点。工具重放读取当前隔离目录或物化已记录正文，不重新调用生成器；刷新通过统一句柄提供的节点映射跳过未失效客户。`generated` 仅统计生成的客户/汇总，不代表总工具次数或模型 usage。

运行 `pnpm vitest run tests/testing/quote-host.test.ts` 验证无变化、局部改价、全部改价和刷新后二次改价：严格发布前主目录无报价；局部仅生成 C01/C02/汇总，解释包含价格→报价→汇总；二次改价拒绝旧候选，再次刷新后可提交。实际发布由独立 BigInt oracle 逐字节核对。该套件是接线验收，不能替代 M3 的真实模型、配对样本和成本门槛。
