# XIO-ISA：面向 Agent 的系统操作指令集与内核化路线图

## 文档状态

- **版本**：规划草案 v0.2（执行版）
- **日期**：2026-11-02
- **目标**：把 xioflow 从“多个执行工具和实验能力的集合”收敛为“面向 Agent 的系统操作指令集、执行内核和生态”。
- **范围**：产品定位、ISA 规范、内核边界、驱动、持久化、安全、验证、治理、里程碑和首批工程任务。
- **性质**：这是战略与架构计划及执行清单，不是当前 API 契约。实施前仍应将冻结部分拆成 spec/current-contract.md、ISA schema、RFC 和任务清单；第十九、二十节提供拆分顺序、门禁和验收模板。
- **A-01 状态**：已完成。v1 范围、四层边界和 RFC 队列见 [XIO-ISA v1 scope](../spec/isa-v1/scope.md)；当前实现承诺以 [当前契约](../spec/current-contract.md) 为准。
- **当前基线**：xioflow 目前已经具备进程监督、操作日志、幂等 opId、indeterminate 结果、workspace transaction、reaper/cgroup、MCP、wire proxy 和审计实验；本轮已补齐 ISA v1 scope、schema、registry、统一入口骨架、正式 migration、event envelope 和 intent/finalize 不变量；同时仍受 Node/POSIX、单进程域、操作员流程不完整、缓存隐私和同步 I/O 等限制。
- **基线依据**：[README](../README.md)、[当前契约](../spec/current-contract.md)、[架构说明](../ARCHITECTURE.md)、[路线图](../ROADMAP.md)、[安全说明](../SECURITY.md)、[恢复审计](../audit/reports/recovery-comparison.md)。

## 一、愿景与成功定义

### 1.1 愿景

XIO 的目标不是再做一套 Agent 工具集合，而是定义一种 Agent 能够稳定学习和调用的“系统操作指令集”：

> Agent 只描述要完成的结构化操作程序；XIO 内核负责验证、授权、调度、执行、恢复和报告证据。

对 Agent 暴露一个统一入口：

~~~text
xio.execute(program)
~~~

这个入口可以通过 SDK、MCP、CLI、Unix domain socket 或未来的远程协议访问，但所有入口必须编译到同一个 ISA 和同一个内核语义。MCP 工具、xio wrap、shell shim、模型供应商代理都不拥有自己的执行真相。

### 1.2 “比肩 Linux 内核”的含义

这里的“比肩 Linux 内核”不指代码行数，也不指复制 Linux 的功能范围，而指成为一项长期基础设施工程，具备以下特征：

| 维度 | 目标 |
| --- | --- |
| 最小核心 | 指令、状态、能力、调度和持久化边界小而稳定，实验功能不污染核心 |
| 稳定接口 | ISA、结果语义和错误语义有版本策略，外部实现可以长期依赖 |
| 驱动体系 | 不同 OS、进程监督方式、文件系统和隔离能力通过 driver contract 接入 |
| 失败语义 | 崩溃、超时、失联、部分观察和外部副作用都有明确结果，不靠猜测 |
| 工具生态 | 有 CLI、调试器、trace、测试套件、文档、迁移工具和第三方 adapter |
| 安全模型 | 能力、资源、秘密、审计和数据留存是内核模型的一部分，而不是应用约定 |
| 长期维护 | 有 RFC、maintainer、LTS、兼容性测试、回归数据库和发布纪律 |
| 真实采用 | 至少有多个独立宿主、多个工作负载和多个驱动实现，不依赖单一 reference app |

### 1.3 成功判据

成功不以“功能最多”衡量，而以以下硬指标衡量：

1. **语义稳定**：连续三个 minor release 不破坏已标记为 stable 的 ISA 行为；每个破坏性变更有迁移器和 RFC。
2. **独立实现**：至少两个不依赖 xioflow 内部 TypeScript 实现的外部 adapter 或 driver 能通过 conformance。
3. **独立宿主**：至少三个不同类型的 Agent host 使用统一 execute 入口，包括一个 MCP host、一个 SDK host 和一个黑盒兼容 host。
4. **失败正确**：核心故障注入场景不产生假成功、盲重放、未授权访问、孤儿进程和无主 artifact。
5. **长期运行**：完成 24 小时基线和 7 天压力 soak；journal、artifact、内存和句柄增长有上限或可解释的 retention policy。
6. **安全默认值**：原始 prompt、响应、环境变量和秘密默认不进入持久化 trace；本机控制面必须有可验证的调用凭证。
7. **性能可解释**：批量指令比等价的多次工具调用显著减少网络往返和 Agent 上下文；大型 workspace 的扫描、哈希和日志路径有公开基线。
8. **可维护**：生成式 opcode registry、schema、文档和契约测试保持同步，发布版本、CHANGELOG、npm 内容和源码状态一致。

## 二、问题判断与战略收缩

### 2.1 现有基础值得保留

当前实现最有价值的部分是：

- 把“未知结果”作为一等状态，而不是将未知转换成成功或失败。
- 在产生副作用前记录 intent，并以 opId 做幂等和结果重放。
- 使用 process identity、reaper、cgroup 和 resource lease 处理进程树生命周期。
- 用 workspace snapshot、读写集合和冲突检查表达工作区事务。
- 用审计报告、fault injection、conformance 和 TLA 检查核心语义。

这些能力构成 XIO 内核的第一代实现，应继续作为底层资产。

### 2.2 当前最危险的结构性问题

当前代码同时承担以下职责：

- 执行内核；
- shell 和 wire 兼容层；
- HTTP-304 因果缓存；
- shadow worktree 和多 Agent race；
- trace、fork 和实验性 AgentRuntime；
- MCP server、OTel 和审计工具。

这导致三个直接后果：

1. **产品承诺高于核心边界**：文案容易被理解为通用 Agent 平台，而实际保证依赖 Node/POSIX、Git、驱动能力、宿主观测和单进程域。
2. **公共 API 过宽**：内部 store、schema、gateway 和实验 API 容易被外部依赖，后续很难演进。
3. **安全和运维能力落后于功能数量**：本机 IPC 认证、配置恢复、journal retention 和完整 SecretRef 生命周期还没有成为统一内核能力；migration、event envelope、intent/finalize 不变量、adjudication 和 capability v1 已进入内核。

### 2.3 战略收缩

第一阶段只把 XIO 定义为：

> 面向 Node/POSIX coding-agent 工作负载的本地系统操作内核，提供版本化 ISA、单一执行入口、可证明的失败语义和可恢复的 workspace/process 操作。

以下能力暂时不属于核心：

- LLM provider 协议解析；
- 任意 shell 兼容；
- HTTP-304 cache；
- trace fork 的高级交互；
- 多 Agent 竞赛和合并策略；
- 模型、token、费用和 prompt 策略；
- 通用网络编排；
- 未经证明的跨主机调度。

它们可以作为 adapter、stdlib、插件或独立实验包存在，但不能决定 kernel 的数据模型。

## 三、核心概念与设计原则

### 3.1 单入口、多指令

“单接口”指单一传输和执行语义，不指一个没有类型边界的万能函数。一次请求可以携带一个有依赖关系的 instruction DAG，内核在一次 admission 中校验和调度。

### 3.2 ISA 小而稳定，stdlib 可扩展

核心 ISA 只包含操作系统级原子操作。高阶任务由标准库程序或 adapter 编译为 ISA 指令：

- ISA 是稳定的机器接口；
- stdlib 是可升级的宏和工作流；
- adapter 是外部协议转换；
- kernel 只执行已验证的程序，不解析自然语言，不猜测 shell 语义。

### 3.3 原子性必须显式声明

“原子”只表示在声明的边界内具有可验证的状态转换，不能承诺所有 OS 或网络副作用可回滚。每条 opcode 必须声明其原子性、观察能力、幂等性、回滚语义和资源成本。

### 3.4 事实优先

内核只能输出驱动已经证明的事实：

- 未确认的停止不能变成 succeeded；
- 未观察到的进程不能被当成不存在；
- 未验证的资源峰值不能被当成零；
- 未知 artifact 不能被自动删除；
- 外部副作用不能被自动重放。

### 3.5 能力优先

每条指令必须携带或继承能力引用。能力限制路径、opcode、资源预算、并发度、期限、秘密访问和审计级别。没有 capability 的操作在 admission 阶段拒绝。

### 3.6 引用优先

大文件、日志、秘密、进程输出、workspace 和 snapshot 不直接复制到 Agent 上下文，而通过不可猜测的 ArtifactRef、WorkspaceRef、ProcessRef、SecretRef 传递。Agent 只接收摘要、哈希、状态和可继续操作。

### 3.7 先记录意图，再产生副作用

所有可能产生外部副作用的指令都必须先写入 durable intent。内核崩溃后根据 intent、driver evidence 和 postcondition 决定 succeeded、failed 或 indeterminate，禁止根据进程消失或管道关闭做过度推断。

### 3.8 不把兼容性当核心语义

xio wrap 可以继续存在，但它只是将外部 Agent 的请求翻译成 XIO-ISA。shell、OpenAI、Anthropic、Gemini、OpenCode 等协议的变化不能改变 ISA 的状态机。

## 四、XIO-ISA v1 指令集

### 4.1 指令分类

v1 目标是 18～24 个核心 opcode。首版不追求覆盖所有 OS API，而追求每一条指令都能写出清晰的 contract、driver capability 和故障测试。

| Opcode | 类别 | 作用 | 默认原子性 | 主要结果 |
| --- | --- | --- | --- | --- |
| fs.read | 文件 | 读取文件或受限片段 | pure | ArtifactRef、hash、范围 |
| fs.write | 文件 | 在声明路径写入新内容 | local_atomic | 新版本 hash |
| fs.patch | 文件 | 按结构化 patch 修改文件 | local_atomic | diff、hash |
| fs.move | 文件 | 在同一工作区移动文件 | local_atomic | 新旧路径 |
| fs.delete | 文件 | 删除声明范围内文件 | compensatable | 删除清单 |
| fs.stat | 观察 | 获取文件属性和指纹 | pure | FileFact |
| workspace.snapshot | 工作区 | 创建可引用的基线 | local_atomic | SnapshotRef |
| workspace.diff | 工作区 | 比较 snapshot、transaction 或当前树 | pure | DiffRef |
| workspace.commit | 工作区 | 校验并提交 transaction | compensatable | commit、冲突 |
| workspace.rollback | 工作区 | 在声明覆盖范围回滚 | compensatable | 覆盖度、残留 |
| proc.spawn | 进程 | 按 argv 启动受监督进程 | external | ProcessRef |
| proc.wait | 进程 | 等待进程终态和树结算 | external | 退出、输出、树状态 |
| proc.signal | 进程 | 发送停止或信号序列 | external | confirmed/unverified |
| proc.inspect | 观察 | 查询身份、树、资源和 driver 事实 | pure | ProcessFact |
| observe.files | 观察 | 记录文件、目录或符号观测 | sampled | ObservationRef |
| observe.resources | 观察 | 采集 CPU、内存、pids、输出等 | sampled | ResourceSampleRef |
| control.status | 控制 | 查询程序、指令、lease 和 driver 状态 | pure | Status |
| control.health | 控制 | 查询 domain、driver、未完成操作和 lease 健康度 | pure | Health |
| control.cancel | 控制 | 请求取消并等待可证明结果 | external | stopped/indeterminate |
| control.resolve | 控制 | 对 indeterminate lease 做显式裁决 | local_atomic | resolution record |
| control.resume | 控制 | 使用 resume token 继续未完成程序 | external | 新状态或 indeterminate |
| artifact.put | 产物 | 保存受控输入或输出 | local_atomic | ArtifactRef |
| artifact.get | 产物 | 按能力取回有限范围内容 | pure | chunk、hash |
| artifact.stream | 产物 | 通过 cursor 流式读取产物 | pure | cursor、chunk |

网络访问、MCP service、模型调用等外部操作可以在后续版本以明确的 external opcode 加入，但必须先有秘密管理、审计、重试和不可重放策略。

### 4.2 指令结构

~~~json
{
  "id": "p1",
  "op": "fs.patch",
  "args": {
    "workspace": "workspace:root",
    "path": "src/index.ts",
    "patch": "artifact:patch-123"
  },
  "dependsOn": ["s1"],
  "precondition": [
    { "kind": "file_hash", "path": "src/index.ts", "sha256": "..." }
  ],
  "output": "patch-result"
}
~~~

每条指令的必选字段：

- id：程序内唯一，不能复用；
- op：由 registry 定义的 opcode；
- args：严格 schema，拒绝未知字段；
- dependsOn：形成有向无环图；
- precondition：执行前要满足的事实；
- output：将结果绑定为引用，供后续指令使用。

程序级限制：

- 指令数量、嵌套深度、JSON/CBOR 字节数和 artifact 引用数量有限制；
- 不允许任意循环和任意脚本；
- 条件分支只能使用有限 predicate，且每个分支有预算；
- 依赖图不能有环；
- 未知 opcode 直接拒绝，不能静默降级；
- 同一个 id、opId 或输出引用不能产生歧义。

### 4.3 Opcode registry

每个 opcode 必须在 registry 中定义：

~~~json
{
  "op": "proc.spawn",
  "version": "1.0",
  "inputSchema": "...",
  "outputSchema": "...",
  "requiredCapabilities": ["process.spawn"],
  "atomicity": "external",
  "observation": "driver-dependent",
  "idempotency": "required",
  "rollback": "impossible",
  "resourceCost": ["cpu", "memory", "pids", "output"],
  "drivers": ["node", "reaper", "cgroup"]
}
~~~

registry 是以下内容的唯一来源：

- TypeScript 类型；
- JSON Schema；
- MCP schema；
- CLI 参数；
- conformance contract；
- 文档表格；
- 版本兼容检查；
- 生成式测试骨架。

## 五、统一执行接口

### 5.1 请求模型

~~~json
{
  "isa": "xio/1",
  "requestId": "req-20261102-001",
  "programId": "program-42",
  "mode": "transaction",
  "capability": "cap:agent-7:abc",
  "workspace": "workspace:root",
  "instructions": [
    {
      "id": "s1",
      "op": "workspace.snapshot",
      "args": { "label": "before-edit" }
    },
    {
      "id": "p1",
      "op": "fs.patch",
      "dependsOn": ["s1"],
      "args": {
        "path": "src/example.ts",
        "patch": "artifact:patch-1"
      }
    },
    {
      "id": "t1",
      "op": "proc.spawn",
      "dependsOn": ["p1"],
      "args": {
        "argv": ["pnpm", "test", "tests/example"],
        "cwd": "workspace:root",
        "stdio": "capture"
      }
    },
    {
      "id": "d1",
      "op": "workspace.diff",
      "dependsOn": ["t1"],
      "args": { "from": "s1" }
    }
  ],
  "options": {
    "wait": "until_terminal",
    "maxOutputBytes": 10485760,
    "eventCursor": null
  }
}
~~~

### 5.2 执行模式

| 模式 | 语义 |
| --- | --- |
| plan | 只做 schema、能力、依赖、资源和驱动检查，不产生副作用 |
| transaction | 只允许可回滚或有明确补偿语义的本地操作；遇到不可回滚的 external opcode 默认拒绝 |
| pipeline | 允许混合操作，按依赖执行；失败后返回部分结果和恢复入口 |

transaction 不是“整个操作系统原子提交”，而是“在声明的 local boundary 内保持事务语义”。如果程序需要启动进程或访问网络，必须显式使用 pipeline，并接受外部副作用和 indeterminate。

### 5.3 响应模型

~~~json
{
  "isa": "xio/1",
  "requestId": "req-20261102-001",
  "status": "succeeded",
  "committed": true,
  "results": [
    {
      "id": "s1",
      "status": "succeeded",
      "value": { "snapshot": "snapshot:1" }
    },
    {
      "id": "p1",
      "status": "succeeded",
      "value": {
        "changed": ["src/example.ts"],
        "diff": "artifact:diff-1"
      }
    },
    {
      "id": "t1",
      "status": "succeeded",
      "value": {
        "process": "process:1",
        "exitCode": 0,
        "stdout": "artifact:stdout-1",
        "stderr": "artifact:stderr-1"
      }
    },
    {
      "id": "d1",
      "status": "succeeded",
      "value": { "diff": "artifact:diff-2" }
    }
  ],
  "events": {
    "nextCursor": "event:100",
    "omitted": 0
  }
}
~~~

响应默认只返回摘要和引用，不返回完整日志、文件内容或秘密。Agent 需要更多信息时，继续通过同一个 execute 入口发送 artifact.get。

### 5.4 传输

内核语义与传输解耦：

1. v1 首选进程内 SDK 和 Unix domain socket；
2. MCP adapter 提供一个 execute 工具；
3. CLI 提供 xio execute --program <file>；
4. HTTP/远程协议在有认证、租约、重放保护和多租户模型后再加入；
5. 可选 CBOR/二进制传输只能优化编码，不能改变 ISA 结果。

## 六、原子性、恢复与不确定性语义

### 6.1 原子性分级

| 等级 | 含义 | 例子 |
| --- | --- | --- |
| pure | 无副作用、可重复计算 | fs.stat、workspace.diff |
| local_atomic | 在 kernel 管理的边界内可验证提交或回滚 | fs.patch、snapshot manifest |
| compensatable | 有逆操作，但逆操作本身可能失败 | workspace rollback、artifact cleanup |
| external | 影响内核外部世界，不能保证回滚 | spawn、signal、网络请求 |

每条指令的结果必须同时包含：

- status；
- atomicity；
- observation；
- effects；
- evidence；
- replay；
- rollback。

### 6.2 指令状态机

~~~text
admitted
  -> intent_registered
  -> resources_held
  -> effect_started
  -> effect_observed
  -> committed | failed | indeterminate
~~~

失败路径：

- admission 失败：没有副作用，结果为 rejected；
- intent 写入失败：禁止启动外部效果；
- effect 启动失败且可确认：failed；
- effect 发生但状态不可确认：indeterminate；
- compensate 成功：rolled_back；
- compensate 不完整：partial，保留 lease 和残留清单。

### 6.3 indeterminate 协议

indeterminate 不是异常字符串，而是一个可继续的状态对象：

~~~json
{
  "status": "indeterminate",
  "instructionId": "t1",
  "opId": "op-123",
  "lease": "lease-456",
  "possibleEffects": [
    "process_may_have_started",
    "workspace_may_have_changed"
  ],
  "evidence": "artifact:evidence-1",
  "nextActions": [
    "control.status",
    "control.resolve",
    "control.resume"
  ],
  "resumeToken": "resume-789"
}
~~~

默认规则：

- 不自动重新执行；
- 不自动释放独占 lease；
- 不把缺失进程当成成功停止；
- 不把空 stdout/stderr 当成无输出；
- 不把人工裁决交给模型自动猜测；
- 所有 resolution 都写入不可变审计记录。

### 6.4 幂等和恢复

每个有副作用的指令必须拥有 opId 和 input fingerprint：

- 同一个 opId、同一输入：加入执行、返回已有结果或返回已有 indeterminate；
- 同一个 opId、不同输入：拒绝并报告 fingerprint conflict；
- 崩溃恢复先读取 intent、driver evidence 和 lease；
- 只有满足 launch evidence 和 postcondition 时才允许自动完成；
- 任何不确定外部副作用都需要显式 control.resolve 或新的证据。

## 七、能力、安全与隐私模型

### 7.1 能力对象

~~~json
{
  "id": "cap:agent-7:abc",
  "issuer": "host-policy:v3",
  "policyVersion": "policy-2026-11",
  "reason": "refactor-task-42",
  "scope": {
    "opcodes": ["fs.read", "fs.patch", "proc.spawn", "workspace.diff"],
    "workspaces": ["workspace:root"],
    "paths": ["src/**", "tests/**"],
    "secrets": ["secret:npm-readonly"]
  },
  "limits": {
    "cpuMs": 600000,
    "memoryBytes": 1073741824,
    "outputBytes": 104857600,
    "concurrentOps": 4,
    "processes": 128
  },
  "expiresAt": "2026-11-02T12:00:00Z"
}
~~~

能力要求：

- 默认拒绝；
- 能力只能缩小，不能由 Agent 自行扩大；
- 每次调用绑定域、程序、来源和政策版本；
- 过期、撤销、父能力失效后，子能力全部失效；
- scope、reason、policyVersion 进入审计，但秘密本身不进入审计；
- capability token 不通过 prompt、环境变量或普通日志传递。

### 7.2 本机 IPC

本机服务也不能假设“localhost 就安全”：

- v1 使用 Unix domain socket 或平台等价物；
- 每个 host 启动时生成随机 session key；
- 每次调用使用 capability-bound nonce；
- socket 文件权限限制为 owner；
- proc、exec 等 introspection 端点必须经过同一认证；
- HTTP 只作为 adapter，不成为内核内部信任边界。

### 7.3 秘密和环境变量

内核禁止默认转发完整 process.env。进程只能拿到：

- 明确列出的普通环境变量；
- 通过 SecretRef 在 driver 内部解析的秘密；
- 与 capability、workspace 和 instruction 绑定的临时令牌。

秘密值不得写入 journal、trace、error、artifact manifest 或 OTel 属性。发现疑似秘密时，adapter 应停止转发并报告 secret_policy_violation。

### 7.4 数据生命周期

默认策略：

- 原始 prompt、模型响应、tool call、文件正文和环境变量不落盘；
- trace 只保存事件摘要、hash、引用和可配置的脱敏字段；
- artifact 使用 owner record、TTL、大小上限和显式删除；
- unknown ownership 的文件不得自动清理；
- 用户可以配置本地加密密钥或关闭持久化内容；
- 导出 OTel 时路径、命令、workspace 名称默认采用稳定 hash 或受控白名单。

### 7.5 安全边界

XIO kernel 不是通用 hostile-code sandbox。它可以选择 reaper、cgroup、bubblewrap、sandbox-exec 等 driver，但必须在 capability matrix 中写清：

- 能限制什么；
- 不能限制什么；
- 失败时返回什么；
- 是否需要 host delegation；
- 是否可在 crash recovery 后继续证明。

对恶意代码的隔离仍需要容器、虚拟机、专用用户、系统策略或其他 OS 安全边界。

## 八、内核分层与模块边界

### 8.1 目标结构

~~~mermaid
flowchart TD
  A[Agent / Host] --> B[Adapter]
  B --> C[xio.execute]
  C --> D[Program Validator]
  D --> E[Capability Checker]
  E --> F[DAG Scheduler]
  F --> G[Journal and Lease]
  G --> H[Kernel Executors]
  H --> I[Filesystem Driver]
  H --> J[Process Driver]
  H --> K[Workspace Driver]
  H --> L[Artifact Store]
  G --> M[Recovery and Resolution]
  M --> C
  H --> N[Sanitized Events]
  N --> O[CLI / OTel / Debugger]
~~~

### 8.2 包和依赖

建议目标结构：

~~~text
packages/
  isa/          opcode registry、schema、类型、结果联合体、版本
  kernel/       validator、capability、scheduler、journal、lease、recovery
  store/        SQLite/WAL、migration、artifact manifest、retention
  drivers/      node、reaper、cgroup、filesystem、workspace
  stdlib/       常用高阶程序和宏
  adapters/     mcp、cli、wire-proxy、shell-shim、sdk
  audit/        sanitized trace、OTel、conformance、fault harness
~~~

依赖规则：

- isa 不依赖 kernel、gateway、模型供应商或具体 OS；
- kernel 只能依赖 isa、抽象 store 和 driver contract；
- driver 不依赖 adapter；
- adapter 不修改 kernel 状态机；
- stdlib 可以使用 opcode，但不能绕过 capability 和 journal；
- gateway cache、time-fork、race 和 experimental AgentRuntime 不得进入核心包的默认导出；
- 根入口只导出 stable ISA、execute、capability 类型和受支持的 driver contract。

### 8.3 现有代码迁移原则

迁移时不先重写全部实现，而是先建立 façade：

1. 现有 executeProcess 编译成 proc.spawn + proc.wait；
2. 现有 snapshot/rollback 编译成 workspace opcode；
3. 现有 MCP tools 编译成单个 Program；
4. 现有 xio wrap 只负责请求翻译；
5. 现有 SQLite store 先承载新 event envelope，再逐步拆 schema；
6. 旧 API 标记为 compatibility layer，禁止新增核心语义。

## 九、调度、性能与资源治理

### 9.1 执行流水线

一次 execute 调用依次经过：

1. 解码和版本协商；
2. schema 验证；
3. opcode registry 检查；
4. capability 和路径检查；
5. 依赖图和循环检查；
6. driver capability 匹配；
7. 资源预算和冲突预测；
8. intent 批量持久化；
9. DAG 调度；
10. effect、observation、commit；
11. 结果压缩和 artifact 引用；
12. journal finalize。

### 9.2 并发和公平

调度器应支持：

- workspace、path、port、process-tree、artifact 等资源的读写锁；
- 人工恢复 lane，优先于普通 Agent 任务；
- foreground、background、maintenance 三类队列；
- 单域并发上限；
- 每个 capability 的 CPU、memory、pids、output 和 wall-time 预算；
- 同一 workspace 的冲突预判和可解释等待原因；
- 禁止无界 FIFO 队列和无界重试。

### 9.3 性能目标

首版目标是可测量而不是夸张：

| 场景 | 目标 |
| --- | --- |
| plan 本地程序 | 绝大多数请求在 10 ms 级完成，且不触碰 workspace |
| 多指令批处理 | 比等价的逐工具调用减少至少一半的协议往返 |
| 小文件读写 | 不因 journal 和 JSON 序列化产生数量级额外延迟 |
| 大输出 | 主 event loop 不执行逐块同步写盘 |
| 大 workspace | 有增量索引、哈希缓存和扫描成本报告 |
| 重复验证 | 命中 fingerprint/cache 时不重新启动相同进程 |
| 长运行 | 内存、句柄、journal 和 artifact 增长符合 retention 上限 |

性能结论必须同时报告：

- workspace 大小；
- 文件数量；
- 输出量；
- CPU 核数；
- driver；
- 是否冷启动；
- 是否包含 journal/WAL；
- 失败和 indeterminate 比例。

### 9.4 热路径原则

- journal append 使用异步批量写入，但在外部副作用前必须达到声明的 durability level；
- stdout/stderr 进入专用异步 writer；
- 大文件和日志使用 artifact stream，不复制到内存和模型上下文；
- workspace 使用 manifest、目录指纹和增量 hash；
- 任何同步 I/O 进入 hot path 前必须有基准和理由；
- 无法证明扫描完整时返回 observation: unknown，不能用性能优化掩盖语义缺失。

## 十、工作区、进程与产物模型

### 10.1 WorkspaceRef

workspace 不是裸绝对路径，而是经过能力绑定的对象：

~~~text
WorkspaceRef {
  id
  rootIdentity
  declaredRoots
  driver
  snapshot
  mutationPolicy
  observationPolicy
}
~~~

所有文件 opcode 使用 workspace-relative path。绝对路径只在 host 侧解析，不能由 Agent 直接绕过 declared roots。

### 10.2 文件和工作区事务

事务必须区分：

- write set；
- read set；
- discovery set；
- ignored/unmanaged set；
- external writer；
- rollback coverage；
- observation confidence。

coverage: complete 只有在驱动和 manifest 真正覆盖所有相关路径时才能返回。否则必须返回 declared_roots、non_ignored 或 unknown，并列出原因。

### 10.3 ProcessRef

proc.spawn 返回的不是 PID 字符串，而是：

~~~text
ProcessRef {
  id
  opId
  pid
  startTime
  bootId
  driver
  containment
  processGroup
  cgroup
}
~~~

进程事实必须区分：

- identity known；
- tree observed；
- tree empty；
- stop requested；
- stop confirmed；
- residual unknown；
- output pipe settlement；
- resource sample confidence。

### 10.4 ArtifactRef

artifact 必须有：

- owner operation；
- creating instruction；
- content hash；
- media type；
- byte length；
- creation time；
- TTL；
- sensitivity；
- encryption state；
- deletion state；
- unknown-owner保护。

artifact 创建不能覆盖未知现有文件；清理必须由 journaled ownership 证明支持。

## 十一、适配器与兼容性策略

### 11.1 MCP

MCP 只暴露一个稳定工具：

~~~text
execute(program)
~~~

为降低迁移成本，可以暂时保留 run_command、snapshot_workspace 等兼容工具，但它们必须内部生成 ISA 程序，并标记为 deprecated。新功能不能只加在兼容工具上。

### 11.2 CLI

建议命令：

~~~text
xio execute --program program.json
xio plan --program program.json
xio status --request request-id
xio artifact get artifact-id
xio resolve lease-id --decision failed
xio inspect --domain domain-path
~~~

这些命令最终都只是构造 control.* 或 artifact.* 指令，避免 CLI 产生第二套状态机。

### 11.3 xio wrap

xio wrap 的职责收缩为：

1. 识别外部 Agent 的受支持协议；
2. 将请求和 tool call 转换成标准 instruction；
3. 将 kernel 的结果和 artifact 引用转换回原协议；
4. 记录兼容层自己的失败，不改变 kernel 语义。

它不能默认：

- 解析任意 shell；
- 复制完整环境变量；
- 修改用户真实配置文件；
- 把 heuristic file extraction 当成完整因果证明；
- 把 HTTP cache 命中当成操作成功。

### 11.4 SDK

SDK 只需要：

~~~ts
execute(program: Program, options?: ExecuteOptions): Promise<ExecutionResult>
~~~

所有高级 helper 都是 stdlib：

~~~ts
runTests(...)
applyPatchAndVerify(...)
snapshotAndRun(...)
~~~

这些 helper 必须可展开为可审计的 ISA 程序，不能成为隐藏的第二内核。

## 十二、持久化、版本与演进

### 12.1 三种版本

必须分开管理：

1. **ISA version**：opcode、输入输出和状态语义；
2. **schema version**：SQLite 表、event payload、artifact manifest；
3. **driver version/capability**：当前主机能证明什么。

它们不能用 package version 互相替代。

### 12.2 Schema migration

SQLite 必须使用：

- PRAGMA user_version；
- 有序 migration；
- migration checksum；
- 可恢复的 half-applied 状态；
- 只读旧 schema 的检测；
- migration 前备份；
- migration 后 conformance；
- 明确的 downgrade policy。

没有 migration 的版本不能标记为稳定 ABI。

### 12.3 Journal

journal event 使用统一 envelope：

~~~json
{
  "seq": 100,
  "schemaVersion": 3,
  "domainId": "domain-1",
  "requestId": "req-1",
  "programId": "program-1",
  "instructionId": "t1",
  "event": "intent_registered",
  "payload": {},
  "sensitivity": "metadata",
  "createdAt": "2026-11-02T08:00:00Z"
}
~~~

必须实现：

- compaction；
- checkpoint；
- retention；
- archive；
- corruption detection；
- replay from checkpoint；
- unknown event preservation；
- 不同 sensitivity 的存储策略。

压缩不能只压缩 JSON 内容而不计入 WAL、fsync 和备份成本。

### 12.4 兼容规则

- stable opcode 只能添加可选字段，不能改变已有字段含义；
- 删除 opcode 前至少经过一个 deprecation cycle；
- 结果联合体只能增加新状态，旧 client 必须能看到 unknown_status 并安全停止；
- 不支持的 driver capability 必须在 plan 阶段拒绝；
- adapter 必须声明自己支持的 ISA minor 范围；
- 每个 release 生成兼容性矩阵和完整 opcode manifest。

## 十三、可观测性与运维控制面

### 13.1 控制面也是 ISA

状态、取消、恢复、裁决、产物和健康检查都通过相同的 execute 入口完成。不存在只有内部 CLI 才能完成、而 MCP/SDK 无法表达的关键状态转移。

最小控制操作：

- control.status；
- control.cancel；
- control.resume；
- control.resolve；
- artifact.get；
- observe.resources；
- observe.processes；
- control.health。

### 13.2 人类操作员体验

一个操作员必须能回答：

1. 这个操作最后一次被证明处于什么状态？
2. 哪些 lease 还被持有？
3. 哪些进程、文件和 artifact 可能受影响？
4. 需要什么证据才能裁决？
5. 裁决后会释放什么资源？
6. 如果裁决错误，能否审计和补偿？

因此必须提供：

- 可读的状态摘要；
- indeterminate resolution 工作流；
- 残留进程和文件清单；
- artifact 和 event 的关联；
- 操作员身份和理由；
- resolution 的不可变记录。

### 13.3 OTel 和 trace

默认 trace 只导出：

- request、program、instruction、opId；
- 状态、延迟、driver、资源摘要；
- hash 和引用；
- 经过白名单和脱敏的命令/路径。

不默认导出：

- 原始 prompt；
- 原始模型响应；
- 秘密；
- 完整环境变量；
- 文件正文；
- 未脱敏绝对路径。

## 十四、验证、基准与证据标准

### 14.1 测试层级

| 层级 | 内容 | 通过条件 |
| --- | --- | --- |
| schema | opcode 输入输出、未知字段、版本 | 100% 稳定契约 |
| unit | validator、capability、scheduler、store | 关键分支全覆盖 |
| property | DAG、幂等、冲突、artifact ownership | 随机输入不产生越权或假成功 |
| fault | crash、SIGKILL、pipe holder、setsid、WAL 中断 | 结果符合 evidence 语义 |
| model | journal/recovery 状态机 | TLA 或等价模型无反例 |
| integration | Node/reaper/cgroup/filesystem/workspace | 各 driver 的 capability contract 通过 |
| adapter | MCP、CLI、wrap、SDK | 全部编译到同一 ISA |
| soak | 24 小时、7 天 | 无无界增长、lease 泄漏和未知 ownership 泄漏 |
| security | IPC、路径穿越、秘密、symlink、权限 | 默认拒绝且事件可追踪 |
| compatibility | 多版本 client、旧 journal、migration | 支持矩阵通过 |

### 14.2 必测故障矩阵

至少覆盖：

- host 在 intent 前崩溃；
- host 在 intent 后、spawn 前崩溃；
- spawn 后、identity 持久化前崩溃；
- root 退出但 daemonized child 存活；
- setsid 逃逸；
- stdout pipe 被未知进程持有；
- cgroup 不可用；
- ps 观察失败；
- workspace 外部写入；
- atime 不可用；
- Git worktree 冲突；
- journal/WAL 写入中断；
- artifact 创建后 host 崩溃；
- cache/trace 持久化失败；
- capability 过期或被撤销；
- resolver 在裁决过程中崩溃。

### 14.3 性能和真实模型证据

所有 benchmark 必须区分：

- deterministic fixture；
- scripted agent；
- real-model pilot；
- production workload。

真实模型实验至少采用：

- counterbalanced arms；
- 多个任务；
- 多个模型；
- 多个 host；
- 预注册预算；
- negative control；
- request、token、wall time、CPU、memory、spawn count 同时记录。

当前审计中的 E8 和 wrap benchmark 只能证明方向可行，不能直接升级为普遍成本或速度承诺。

### 14.4 当前基线的处理

现有 conformance 目录中“编号契约数”和实际可运行测试数必须分成：

- contract catalog；
- runnable contracts；
- archived contracts；
- planned contracts。

发布报告不得把目录数量写成执行数量。README、spec、CHANGELOG、package version 和 audit date 必须在 release gate 中交叉检查。

## 十五、阶段路线图与退出条件

时间窗口是参考，不是承诺；每个阶段以退出条件而不是日期为准。

### 阶段 0：方向冻结

**目标**：确定 XIO 是 ISA/Kernel 项目，而不是无限扩展的 Agent 工具集合。

交付：

- 本计划评审；
- XIO-ISA v1 RFC；
- opcode registry 草案；
- capability 和 result contract；
- 核心/stdlib/adapter/research 边界；
- 反目标清单；
- 现有 API compatibility strategy。

退出条件：

- 核心 maintainer 对稳定边界达成一致；
- 新功能必须能回答“它属于哪条 opcode 或哪一层”；
- 暂停向核心添加 gateway、模型和实验性功能。

### 阶段 1：ISA 和单入口内核

**目标**：实现 execute(Program)，不重写全部底层 driver。

交付：

- isa registry；
- schema validator；
- Program DAG；
- plan 模式；
- pipeline 模式；
- 统一 result union；
- 现有 process/workspace API 的 compiler；
- 一个进程内 SDK。

退出条件：

- run_command、snapshot、rollback 可以完全编译为 ISA；
- 旧入口和新入口对同一故障返回一致语义；
- 不再新增只存在于旧工具层的核心状态。

### 阶段 2：持久化、能力和恢复

**目标**：把安全和恢复变成统一内核能力。

交付：

- capability v1；
- IPC authentication；
- schema migration；
- event envelope；
- journal compaction/retention；
- control.resolve、control.resume；
- artifact ownership 和 TTL；
- secret ref；
- config overlay。

退出条件：

- indeterminate 场景都有一等恢复路径；
- 24 小时 soak 无无界增长；
- 原始秘密不进入默认 journal、trace 和 OTel；
- migration 在旧数据库上可恢复。

### 阶段 3：驱动和性能

**目标**：让 ISA 不依赖单一 Node/POSIX 实现。

交付：

- Node driver contract；
- native reaper contract；
- Linux cgroup contract；
- macOS driver contract；
- filesystem/workspace driver；
- async output/artifact writer；
- workspace incremental index；
- driver capability matrix。

退出条件：

- 每个 driver 明确支持、拒绝和 unknown 的能力；
- 大 workspace、长输出和高并发有基线；
- 不再用同步热路径掩盖规模问题；
- driver 失败不会产生假成功。

### 阶段 4：适配器迁移

**目标**：让 Agent 生态只感知一个接口。

交付：

- 单工具 MCP execute；
- xio execute、xio status、xio resolve、xio artifact；
- SDK；
- xio wrap adapter；
- 旧 MCP tools 的兼容编译层；
- adapter conformance；
- 迁移文档和示例。

退出条件：

- MCP、CLI、SDK、wrap 的同一程序返回结构等价结果；
- adapter 不能绕过 capability、journal 和 result semantics；
- 兼容层明确标记 deprecated。

### 阶段 5：稳定内核 1.0

**目标**：形成可长期依赖的 stable ABI。

交付：

- 至少三个独立宿主；
- 至少两个独立 adapter/driver；
- 三个 minor release 的兼容记录；
- 24 小时和 7 天 soak；
- security review；
- 可重现的性能报告；
- 完整文档、迁移器和 release checklist；
- LTS 策略。

退出条件：

- 稳定 ISA 通过独立实现；
- 没有未解释的 journal、lease、artifact 或 memory 增长；
- 所有 critical fault case 有确定结果或有解释的 indeterminate；
- package、docs、CHANGELOG、conformance 和 git tag 一致。

### 阶段 6：生态与跨平台

**目标**：从 Node/POSIX 内核发展成多实现系统。

候选方向：

- Rust、Go 或 Python client；
- daemon 和跨进程 arbiter；
- Windows driver；
- remote execution；
- 分布式 artifact；
- external event reactivation；
- 多租户 policy；
- 第三方 opcode/driver registry。

这些方向只有在 stable v1 的边界和运维基础完成后才能进入主线。

## 十六、团队、治理与发布机制

### 16.1 子系统维护

参考 Linux 的维护方式，但保持小团队可执行：

- ISA maintainer：opcode、schema、结果语义；
- kernel maintainer：journal、scheduler、recovery；
- driver maintainer：Node、reaper、cgroup、filesystem；
- adapter maintainer：MCP、CLI、wrap、SDK；
- security maintainer：capability、IPC、secret、data lifecycle；
- conformance maintainer：fault、model、compatibility、soak。

核心 API 变更必须由对应子系统 maintainer 审核，跨子系统变更需要 RFC。

### 16.2 RFC 机制

每个 RFC 至少包含：

- 问题和反目标；
- 影响的 opcode；
- atomicity、observation、rollback；
- capability 和隐私影响；
- migration；
- driver capability；
- 故障矩阵；
- 性能预算；
- 可撤销方案；
- 退出和废弃策略。

### 16.3 发布通道

- experimental：允许变化，但不能承诺稳定；
- preview：有 schema 和迁移说明；
- stable：遵守兼容策略；
- LTS：只接收安全、数据一致性和关键回归修复。

package version、ISA version、schema version、driver version 和 conformance report 必须在 release CI 中互相验证。

## 十七、风险清单与反目标

### 17.1 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| ISA 过大 | 失去稳定性，变成新 shell | 首版严格限制 opcode，复杂能力放 stdlib |
| 单入口变成万能函数 | schema、错误和权限失控 | registry、严格 schema、程序大小上限 |
| 原子性承诺过度 | 发生不可逆副作用后错误重放 | explicit atomicity + indeterminate |
| 兼容层污染核心 | provider/shell 变化拖垮内核 | adapter 依赖单向约束 |
| journal 无限增长 | 长运行和隐私风险 | checkpoint、compaction、TTL、archive |
| 本机 IPC 被滥用 | 同机越权执行 | UDS、nonce、capability、权限 |
| workspace 观测不完整 | 错误回滚或错误 cache hit | unknown/coverage 语义，拒绝伪造完整性 |
| driver 差异过大 | 跨平台行为不一致 | capability matrix 和 driver-specific tests |
| 团队过小 | 核心和生态同时失控 | 先冻结边界，减少并行产品线 |
| 过早追求分布式 | 引入不可逆复杂度 | 先完成单机稳定 ISA |

### 17.2 明确反目标

XIO-ISA v1 不做：

- 任意自然语言转 shell；
- 任意代码作为指令执行；
- 隐式重试外部副作用；
- 把 localhost 当成安全边界；
- 把所有 OS 都抽象成同一强保证；
- 把模型 token、费用和策略塞进 kernel；
- 默认保存原始 Agent 对话；
- 没有 migration 的稳定 ABI；
- 通过增加 feature 数量证明成熟；
- 用 benchmark 单个样本宣称普遍收益。

## 十八、首批工程任务

### P0：契约和仓库结构

1. 创建 spec/isa-v1/registry.json、源 schema、spec/result-semantics.md，并由生成器产出 spec/protocol/v1/ 与 spec/schema/。
2. 建立 opcode registry 的机器可读格式。
3. 定义 Program、Instruction、CapabilityRef、ExecutionResult、ArtifactRef。
4. 标记现有 API 的 stable、preview、experimental、deprecated。
5. 将 src/index.ts 的公共导出收缩为稳定入口。
6. 把 gateway、shell shim、time-fork、race、AgentRuntime 的定位写入 package boundary。

### P1：统一执行入口

7. 实现 execute(program) 的 plan validator。
8. 实现 DAG 依赖检查、循环拒绝和指令大小限制。
9. 将 executeProcess 编译为 proc.spawn/proc.wait。
10. 将 snapshot、diff、rollback 编译为 workspace opcode。
11. 为所有结果补齐 atomicity、observation、evidence 和 rollback 字段。
12. 添加程序级 requestId、programId 和指令级 opId。

### P2：恢复、安全和存储

13. 建立 event envelope 和 schemaVersion。
14. 实现 PRAGMA user_version migration。
15. 实现 control.status、control.cancel、control.resolve、control.resume、control.health。
16. 实现 capability v1，包括 policyVersion、reason、limits 和 attenuation。
17. 将本机 IPC 改为认证的 Unix domain socket。
18. 将完整环境变量替换为显式 allowlist 和 SecretRef。
19. 将配置改写替换为临时 overlay/copy-on-write。
20. 实现 artifact owner、TTL、敏感级别和 retention。

### P3：性能和驱动

21. 将输出 spill、cache、journal 和 artifact 写入移出同步热路径。
22. 为 workspace 建立增量 manifest/index。
23. 为 Node、reaper、cgroup 和 filesystem driver 生成 capability matrix。
24. 增加大仓库、大输出、长进程和高并发基准。
25. 增加 24 小时 soak 和资源泄漏检查。

### P4：适配器迁移

26. 实现 MCP 单工具 execute。
27. 实现 xio execute、xio status、xio resolve、xio artifact。
28. 让 xio wrap 只生成 ISA 程序，不直接拥有独立恢复逻辑。
29. 为旧 MCP tools 提供兼容编译器和迁移告警。
30. 为 SDK、CLI、MCP、wrap 添加相同程序的等价性测试。

### P5：质量门禁

31. 将 contract catalog、可运行条目、archived、planned、unsupported 分开生成，数量由脚本输出而不是文档常量决定。
32. 为每个 opcode 添加 crash、权限、重复提交和 driver failure 测试。
33. 增加 property-based program fuzzing。
34. 增加 schema、migration、artifact ownership 和 capability 的安全测试。
35. 形成 release checklist：源码、包、文档、CHANGELOG、版本、tag、conformance、audit 必须一致。

## 十九、执行版 TODO 与完整执行路径

本节把路线图变成可跟踪的工程计划。所有任务默认在当前 TypeScript/Node.js 单宿主内核上完成。

### 19.1 状态标记与当前基线

- [x]：仓库中已有实现，并有测试或规范证据。
- [~]：已有部分实现，但还没有收口为 ISA v1 契约。
- [ ]：尚未完成。
- [!]：明确延后，除非满足复活条件，否则不进入主线。

| 能力面 | 状态 | 当前证据 | 仍需补齐 |
| --- | --- | --- | --- |
| 进程监督、停止确认、树结算 | [x] | src/supervisor、src/driver、tests/supervisor、tests/driver | 将现有结果映射为统一 instruction result |
| SQLite 域、租约、opId 幂等 | [~] | src/store、src/domain.ts、migration v6、event envelope、artifact ownership、intent/finalize 不变量和协调测试 | 完整 ISA 级 replay、跨入口等价性 |
| snapshot、rollback、workspace transaction | [~] | src/snapshot、src/workspace、对应测试 | workspace opcode、read/write/discovery set、coverage |
| capability 与路径检查 | [x] | src/capability、migration v4、capability v1 schema、IPC capability 绑定、配置恢复快照及对应测试（R-06 至 R-10） | 完整 ISA opcode 与各入口的统一准入仍依赖 I-09、AD 组 |
| recovery、indeterminate、adjudication | [~] | src/recovery、fault 测试、current-contract | 统一 control.status/resolve/resume |
| AgentRuntime | [~] | src/agents、spec/agent-runtime.md | 只作为 Program producer，不进入 kernel v1 状态机 |
| MCP、CLI、wrap、OTel | [~] | src/mcp、src/cli.ts、src/gateway、src/otel | 所有入口编译到同一 execute 语义 |
| conformance、fault、soak | [~] | src/testing、spec/conformance.md、tests/fault、scripts/agent-soak.mjs | 自动生成 catalog、报告和 unsupported 证据 |
| execute(Program) | [~] | registry/schema、plan、pipeline、`@xioflow/kernel/isa` preview；持久化桥接支持 snapshot/rollback/status/health | 完整 opcode 执行、transaction、稳定结果 envelope 和四入口迁移 |
| Rust/daemon/远程/Windows | [!] | ARCHITECTURE 与 current-contract 的放弃裁决 | 只保留历史设计和复活条件 |

已有底层能力不等于 ISA 已完成。只有同一 Program 经过 SDK、MCP、CLI 和 wrap 后得到结构等价结果，并通过恢复、权限和故障门禁，才算完成统一入口。

### 19.2 关键路径

~~~mermaid
flowchart LR
  A0[现状盘点与边界冻结] --> A1[Registry 与版本策略]
  A1 --> A2[Program/Result Schema]
  A2 --> A3[严格 Validator]
  A3 --> A4[plan 模式]
  A4 --> A5[pipeline 调度]
  A5 --> B1[Intent/Journal/Migration]
  B1 --> B2[Recovery 与三态结果]
  B2 --> B3[Capability 与 SecretRef]
  B3 --> B4[Control 入口]
  A5 --> C1[Driver contract]
  C1 --> C2[异步输出与采样]
  C2 --> C3[基准与 Soak]
  B4 --> D1[MCP/CLI/SDK/wrap]
  D1 --> D2[适配器等价性]
  C3 --> E1[Fault/Property/Security]
  D2 --> E1
  E1 --> E2[Conformance 与发布门禁]
  E2 --> E3[Preview 采用]
  E3 --> E4[Stable 1.0/LTS]
~~~

关键路径上的依赖不可跳过：没有 registry 就不能冻结 schema；没有 schema 和 validator 就不能开放 pipeline；没有 durable intent 和 recovery 就不能把 external opcode 标为 stable；没有 adapter 等价性和 conformance 证据就不能宣称“统一入口”。

### 19.3 A 组：方向冻结与现状盘点（Gate 0）

- [x] **A-01 冻结 v1 范围**（依赖：无）
  - 在本计划、spec/current-contract.md 和 ROADMAP.md 中统一声明：v1 是单宿主进程内的 Node/POSIX 执行内核。
  - 交付核心、stdlib、adapter、research 四层边界表；无法归类的需求进入 [RFC 队列](../spec/rfc/README.md)。详细边界记录见 [spec/isa-v1/scope.md](../spec/isa-v1/scope.md)。
  - 验收：新增 issue 都能指向 opcode 或层；Rust、daemon、远程和 Windows 不再出现在 v1 关键路径。

- [x] **A-02 盘点公共 API**（依赖：A-01）
  - 盘点 src/index.ts、src/types.ts、src/quick-run.ts、src/cli.ts 的导出，标记 stable、preview、experimental、deprecated。
  - 交付 [spec/api-surface-v1.md](../spec/api-surface-v1.md) 和可被 CI 读取的 [导出清单](../spec/api-surface-v1.json)。

- [x] **A-03 建立基线证据**（依赖：A-02）
  - 将测试按 schema、unit、property、fault、model、integration、adapter、soak、security 分类。
  - 生成 [audit/reports/isa-baseline-2026-11-02.md](../audit/reports/isa-baseline-2026-11-02.md)，记录 Node、平台、driver、命令、exit code 和摘要。

- [x] **A-04 冻结版本术语**（依赖：A-01）
  - 分开定义 ISA version、schema version、driver capability version 和 package version。
  - 写明 [xio/1、xio/1.0、xio/1.1 和未知 minor 的兼容规则](../spec/isa-v1/versioning.md)。

- [x] **A-05 固化 RFC 模板**（依赖：A-01）
  - [spec/rfc/README.md](../spec/rfc/README.md) 的模板包含 opcode、atomicity、observation、rollback、capability、隐私、migration、driver、故障矩阵、性能预算和退出策略。

> **Gate 0 状态：已完成（2026-11-02）**。边界、API 清单、基线报告、版本术语和 RFC 模板均已落地；`pnpm typecheck`、`pnpm conformance` 与完整 Vitest 基线通过，未实现的 property/soak/IPC 能力已在报告中明确列为缺口。

阶段验证：

~~~text
pnpm typecheck
pnpm test
pnpm conformance
rg -n "Rust|daemon|Windows|remote|execute" docs/XIO-ISA-PLAN.md spec/current-contract.md ROADMAP.md
~~~

Gate 0 通过条件：边界文件没有相互矛盾的稳定承诺，基线报告可复现，没有未登记的稳定公共 API。

### 19.4 I 组：ISA registry、schema 与单入口（Gate 1）

- [x] **I-01 建立机器可读 registry**（依赖：A-01、A-04）
  - 创建 [spec/isa-v1/registry.json](../spec/isa-v1/registry.json)，为 24 个 opcode 固定 version、inputSchema、outputSchema、requiredCapabilities、atomicity、observation、idempotency、rollback、resourceCost 和 drivers。
  - registry 是类型、JSON Schema、MCP schema、CLI 参数、文档表和 conformance catalog 的唯一来源；由 `pnpm check:isa-registry` 做结构和目录校验。

- [x] **I-02 定义 Program/Instruction schema**（依赖：I-01）
  - 创建 [program.schema.json](../spec/isa-v1/program.schema.json)、[instruction.schema.json](../spec/isa-v1/instruction.schema.json)、[capability.schema.json](../spec/isa-v1/capability.schema.json)、[result.schema.json](../spec/isa-v1/result.schema.json)。
  - 强制校验 isa、requestId、programId、instructions、dependsOn、precondition、output 和程序大小/深度/引用上限。
  - schema 层拒绝未知字段、重复 dependsOn、非法 id/opId/output 引用格式；跨指令重复 id、重复 output、DAG 环、未知引用由 I-04 admission validator 统一拒绝。
  - 当前源 schema 放在 spec/isa-v1，SQLite DDL 和迁移仍由 src/store 维护；尚未生成 spec/protocol/v1 或 spec/schema，也没有三者逐字段一致性的 CI 门禁。完整生成链与一致性检查留在 Q-01、Q-08。
  - 由 `pnpm check:isa-schemas` 校验四份 schema 的 `$id`、严格对象边界、24 个 opcode 映射、indeterminate 必填证据和程序限制；`pnpm check:isa-registry` 校验 registry 引用闭合。

- [x] **I-03 生成 TypeScript 类型与 codec**（依赖：I-02）
  - 新建 [src/isa](../src/isa)，定义 Program、Instruction、CapabilityRef、ExecutionResult、InstructionResult、Evidence 和 ArtifactRef；opcode union 从 registry 生成到 `opcodes.generated.ts`。
  - 提供 JSON 与标准库 CBOR 子集 codec；codec 拒绝循环、undefined、symbol、非有限数、尾随字节和非对象 Program/Result，编码只改变表示，不改变字段和状态语义。
  - `tests/isa/codec.test.ts` 覆盖 Program/ExecutionResult 的 JSON/CBOR round-trip、canonical JSON、Unicode/整数/小数和非法值 fail-closed。
  - 由 `pnpm generate:isa-opcodes` 从 registry 更新 opcode 类型，`pnpm typecheck` 与 ISA codec 测试作为 I-03 门禁。

- [x] **I-04 实现严格 validator**（依赖：I-02、I-03）
  - 在 [src/isa/validator.ts](../src/isa/validator.ts) 实现 xio/1 minor 协商、registry opcode lookup、严格字段/类型拒绝、重复 id/output/opId、DAG 环检测、instruction/precondition 引用解析、资源预测和 capability scope/limits 预检。
  - `validateProgram` 只返回结构化报告；`assertValidProgram` 才抛出 `ProgramValidationError`。两者均不创建 journal、lease、文件或进程副作用。
  - [tests/isa/validator.test.ts](../tests/isa/validator.test.ts) 覆盖 unsupported minor、未知字段、重复标识、未知依赖、cycle、缺少 opId、capability 越界和资源预测。

- [x] **I-05 实现 plan 模式**（依赖：I-04）
  - [src/isa/plan.ts](../src/isa/plan.ts) 提供 `planProgram`/`executePlan`，只返回 schema、能力、依赖、资源和 driver 检查；不执行 Program。
  - 报告状态区分 `admitted`、`unsupported`、`rejected` 和预留的 `indeterminate`；未知 ISA minor 与缺 driver 归 `unsupported`，字段/DAG/capability 错误归 `rejected`。
  - [tests/isa/plan.test.ts](../tests/isa/plan.test.ts) 覆盖可用/缺失 driver、非法输入和非 plan mode；plan 路径不创建 domain.db、文件、artifact 或进程。

- [x] **I-06 实现 pipeline 调度器**（依赖：I-04、I-05）
  - [src/isa/pipeline.ts](../src/isa/pipeline.ts) 按 DAG 就绪队列调用 executor；`PipelineDomainCoordinator` 在共享实例内协调内存资源标签、带输入指纹的 in-flight opId 和写入提交队列，本身不持久化租约。preview kernel binding 才通过现有 domain/supervisor 复用 core 的持久化执行事实与租约。
  - validator 在 pipeline admission 阶段拒绝循环、未知依赖和未声明条件字段；首版不执行任意循环或脚本。
  - [tests/isa/pipeline.test.ts](../tests/isa/pipeline.test.ts) 覆盖 ready queue、依赖失败传播、写资源串行和同 domain 的 in-flight 合并。

- [x] **I-07 定义统一 result envelope**（依赖：I-02、I-06）
  - [src/isa/result.ts](../src/isa/result.ts) 提供 `createInstructionResult`/`createExecutionResult`；其指令结果 envelope 包含 status、atomicity、observation、effects、evidence、artifactRefs、replay 和 rollback。preview execute 仍返回 `PlanReport`/`PipelineRunResult`，尚未将所有执行路径接到该稳定结果 envelope。
  - indeterminate 结果强制 lease、possibleEffects、evidence 和 nextActions；`replayExecutionResult` 只折叠 journal facts，不重新执行 opcode，并保留 partial、终态和 event cursor。
  - [tests/isa/result.test.ts](../tests/isa/result.test.ts) 覆盖 indeterminate 必填字段、artifactRefs、partial→terminal replay、重复结果和乱序事件拒绝。

- [x] **I-08 编写现有能力 compiler**（依赖：I-06、I-07）
  - [src/isa/compiler.ts](../src/isa/compiler.ts) 将进程编译为 `proc.spawn` + `proc.wait`，snapshot/diff/rollback 编译为 workspace opcode，artifact 读写编译为 artifact opcode。
  - compiler 只组装 Program，不导入 store/driver，也不执行 capability admission；[tests/isa/fixtures/compile-process.json](../tests/isa/fixtures/compile-process.json) 锁定 process golden Program。

- [ ] **I-09 暴露唯一稳定入口**（依赖：I-06、I-07、I-08）
  - src/index.ts 只导出 execute、stable ISA 类型、capability 类型和受支持的 driver contract。
  - gateway cache、time-fork、race 和 AgentRuntime 的内部状态机不能进入根入口。
  - **当前进展**：已新增根入口 `execute` 和 ISA 稳定类型导出；旧根导出仍为兼容面，需 AD 组迁移完成后再收窄，故本项保持未完成。
  - **2026-11-03 增量**：新增枚举式 `@xioflow/kernel/isa` preview 子入口；`ExecuteOptions.kernel` 复用现有 domain/supervisor/capability/journal，支持 snapshot、rollback、status、health，含 opId 输入冲突、前置条件、跨 Run 查询和取消回归。其余 opcode、transaction 与原子外部前置条件仍明确 unsupported，不能据此宣布 I-09 完成。

- [x] **I-10 建立 ISA golden corpus**（依赖：I-07、I-08）
  - 在 [tests/isa/fixtures](../tests/isa/fixtures) 固化最小成功、部分失败、取消、重放、indeterminate、rollback coverage 和 unsupported driver Program/Result。
  - [tests/isa/golden-corpus.test.ts](../tests/isa/golden-corpus.test.ts) 自动校验 fixture admission、driver unsupported 分类和 partial→terminal replay。

阶段验证：

~~~text
pnpm typecheck
pnpm exec vitest run tests/isa tests/supervisor/input-validation.test.ts tests/supervisor/execution-result.test.ts
pnpm test
~~~

Gate 1 通过条件：plan 零副作用；同一 Program 可由进程内 SDK 执行；旧 quickRun、snapshot、rollback 的核心事实与 ISA 入口一致；未知 opcode 和未知字段 fail closed。

### 19.5 R 组：持久化、恢复、能力和隐私（Gate 2）

- [x] **R-01 正式 migration runner**（依赖：I-07）：已将 [src/store/migrations.ts](../src/store/migrations.ts) 接管 `SqliteStore` 的补列逻辑，使用 `PRAGMA user_version`、编号、checksum、事务边界和 half-applied 检测；测试覆盖新库、缺列 0.x 库、失败后检测和 checksum 漂移。
- [x] **R-02 统一 event envelope**（依赖：I-07、R-01）：已在 [src/store/event-envelope.ts](../src/store/event-envelope.ts) 固定 seq、schemaVersion、domainId、requestId、programId、instructionId、opId、event、payload、sensitivity、createdAt，并由 migration v2 加入 journal 列；未知 event 保留，写入边界移除 prompt、环境变量、secret 和文件正文。
- [x] **R-03 收口 intent/effect/finalize 状态机**（依赖：R-02）：`SqliteStore` 在结果和执行期事件写入前校验 durable intent，并在结果写入边界拒绝重复结果；预意图取消以显式 `preIntentCancelled` 例外记录；快照路径移除重复结果事件；资源释放事件补充 `releaseReason`；[scripts/check-invariants.mjs](../scripts/check-invariants.mjs) 新增 intent 顺序、结果意图、释放 envelope、事件 envelope 和敏感键不变量，正反测试见 [tests/store/invariants.test.ts](../tests/store/invariants.test.ts)。
- [x] **R-04 统一 crash recovery**（依赖：R-02、R-03）：新增 `xio/recovery/1.0` 原始 driver/capability、identity、containment、tree、pipe evidence，并由 migration v3 持久化；恢复只按 intent 时的 containment 能力选择 cgroup 语义，legacy/缺少原始 evidence 时 fail closed 为 `indeterminate`；[tests/supervisor/recovery-evidence.test.ts](../tests/supervisor/recovery-evidence.test.ts) 覆盖替换 driver、legacy containment、spawn/identity 前路径，WAL/事务中断由 [tests/fault/crash-matrix.test.ts](../tests/fault/crash-matrix.test.ts) 覆盖。
- [x] **R-05 实现 control 指令**（依赖：R-03、R-04）：新增 `IsaControlPlane`，提供 `control.status`、`control.cancel`、`control.resolve`、`control.resume`、`control.health`；`control.resolve` 复用 durable adjudication，记录操作者、理由、证据、时间和释放的 lease，`control.resume` 只回放 journal facts，不重新执行外部副作用；测试见 [tests/isa/control.test.ts](../tests/isa/control.test.ts)。
- [x] **R-06 落地 capability v1**（依赖：I-02、R-03）：新增 capability migration v4 和 v1 策略/预算字段，统一 opcode、workspace、realpath 后的 paths、SecretRef、并发、期限、epoch、policyVersion；attenuation 只能收窄 scope 或降低 limits，签发/收窄/使用/拒绝均写 journal；兼容旧三参数签发接口；[tests/capability/v1.test.ts](../tests/capability/v1.test.ts) 覆盖持久化、准入拒绝、收窄和预算边界。
- [x] **R-07 认证本机 IPC**（依赖：R-06）：新增 [src/ipc/local-socket.ts](../src/ipc/local-socket.ts)，Unix domain socket 使用随机 session key、capability+epoch-bound nonce、constant-time 校验和 owner-only `0600` 权限；capability 撤销/换代即时拒绝；HTTP 只保留为 adapter；测试见 [tests/ipc/local-socket.test.ts](../tests/ipc/local-socket.test.ts)。
- [x] **R-08 SecretRef 与环境白名单**（依赖：R-06、R-07）：`StructuredCommand` 默认不继承完整 `process.env`，普通变量只能经 `envWhiteList` 进入子进程；`SecretRef` 只在 Node/Reaper/cgroup driver 的 spawn 边界解析，缺少 resolver 时 fail closed；driver 在 stdout/stderr 离开边界前按 chunk 脱敏，解析失败错误不复制 resolver 原文；输入指纹只记录 SecretRef，不记录秘密值；[tests/driver/secret-env.test.ts](../tests/driver/secret-env.test.ts) 覆盖默认环境、显式继承、SecretRef 解析、跨 chunk 脱敏、resolver 失败、journal/operation/OTLP 不泄漏。
- [x] **R-09 artifact ownership 与 retention**（依赖：R-02）：新增 store migration v5 和 `artifacts` ownership manifest，持久化 owner operation、creating instruction、path identity、hash、size、TTL、sensitivity、encryption、deletion state；stdout/stderr spill、read evidence、ignored snapshot manifest 均在 writer 边界登记，retention 只删除已结算且未引用、身份仍匹配且 TTL/age 到期的文件，unknown-owner/unknown-state 文件保留。测试见 [tests/supervisor/artifact-safety.test.ts](../tests/supervisor/artifact-safety.test.ts)、[tests/store/migrations.test.ts](../tests/store/migrations.test.ts) 与 [tests/store/invariants.test.ts](../tests/store/invariants.test.ts)。
- [x] **R-10 配置与恢复快照**（依赖：R-04、R-06）：配置修改使用 overlay/copy-on-write；request 绑定 schema、capability、driver、retention 和 redaction 版本，恢复不依赖当前配置猜测。migration v6 持久化 `runs.config_binding` 与 `operations.config_snapshot`；配置摘要去敏并带 SHA-256，恢复先校验摘要，gateway 配置改写使用私有临时 overlay 且原文件保持不变。测试见 [tests/store/config-snapshots.test.ts](../tests/store/config-snapshots.test.ts)、[tests/gateway/wrap.test.ts](../tests/gateway/wrap.test.ts) 与 [tests/supervisor/recovery-evidence.test.ts](../tests/supervisor/recovery-evidence.test.ts)。

阶段验证：

~~~text
pnpm exec vitest run tests/store tests/fault tests/supervisor/recovery-evidence.test.ts tests/capability
pnpm check:tla
node scripts/check-invariants.mjs <domain.db>
pnpm conformance
~~~

Gate 2 通过条件：所有 indeterminate 都有 status/resolve/resume；旧库可迁移且不丢事件；默认 trace 不含秘密；重复提交不重放外部副作用；每个 lease 释放都有 journal 原因。

### 19.6 D 组：驱动、热路径和规模证据（Gate 3）

**2026-11-03 最新执行状态**：用户要求先取消 xioflow 联动、独立探索 RWKV；实际 24h 长测已于 `19:40:26 Asia/Shanghai` 停止，controller 及子进程无活跃残留，7d 未启动。后文启动与 RUNNING 数据是历史记录，D-07 未通过，不自动恢复；取消证据见 [cancellation.json](../audit/results/w7900d-rwkv-20261103/evidence/cancellation.json)。独立模型服务继续保留。

- [x] **D-01 固定 driver contract**（依赖：I-01、R-03）：为 Node、reaper、cgroup、filesystem、workspace、confinement driver 定义 capability、observation、stop、rollback contract，并说明 host crash 后还能证明什么。新增 `xio/driver/1` 机器可读描述器 [src/driver/contract.ts](../src/driver/contract.ts)，统一列出证据、unknown 和崩溃后边界；规范见 [spec/isa-v1/driver-contract.md](../spec/isa-v1/driver-contract.md)，测试见 [tests/driver/contracts.test.ts](../tests/driver/contracts.test.ts)。
- [x] **D-02 生成 capability matrix**（依赖：D-01）：覆盖 Linux Node/reaper/cgroup、macOS Node/reaper、无 cgroup 和 unsupported 平台；每格必须绑定测试或 unsupported 证据。矩阵见 [spec/isa-v1/capability-matrix.md](../spec/isa-v1/capability-matrix.md) 与 [capability-matrix.json](../spec/isa-v1/capability-matrix.json)，检查命令为 `pnpm check:capability-matrix`，运行时绑定测试见 [tests/driver/capability-matrix.test.ts](../tests/driver/capability-matrix.test.ts)。
- [x] **D-03 异步输出与 artifact writer**（依赖：R-09、D-01）：stdout/stderr 使用有界 head+tail、异步 writer、spillError、hash-after-write；管道关闭不等于进程树为空。`src/supervisor/drainer.ts` 使用有界异步写队列并在写入回调后更新 hash，fsync/close/finalize 错误可见；`process-monitor` 仍独立执行 driver tree settlement。测试见 [tests/supervisor/output-honesty.test.ts](../tests/supervisor/output-honesty.test.ts)、[tests/supervisor/artifact-safety.test.ts](../tests/supervisor/artifact-safety.test.ts) 与 [tests/supervisor/single-writer.test.ts](../tests/supervisor/single-writer.test.ts)。
- [x] **D-04 共享进程采样器**（依赖：D-01）：全域一个异步采样周期；观察失败返回 unknown/resourceSamplingError；软限制丢失观测时 fail closed。`src/driver/sampler.ts` 现在集中管理 35ms 异步 watcher cycle，并让多个 `NodePlatformDriver` 共享一次进程表读取；空/畸形快照及存活 root 缺失均报告 `ProcessObservationError`，watcher 在句柄 close 时释放。测试见 [tests/driver/observation-failure.test.ts](../tests/driver/observation-failure.test.ts) 与 [tests/supervisor/budget-observation.test.ts](../tests/supervisor/budget-observation.test.ts)，契约见 [spec/current-contract.md](../spec/current-contract.md)。
- [x] **D-05 workspace 增量 manifest/index**（依赖：I-08、R-09）：分开保存 read set、write set、discovery set、symbol slice、ignored manifest、pathDependencies；无法证明完整时降级 coverage。新增版本化 [WorkspaceIncrementalIndex](../src/workspace/incremental-index.ts)，事务将其 digest 与独立集合写入 `TX_READS`/`TX_COMMITTED`，重复 inspect 增量合并读/发现/路径证据，扫描或 atime 不可用时返回 `coverage: 'unknown'`；测试见 [tests/workspace/incremental-index.test.ts](../tests/workspace/incremental-index.test.ts) 与 [tests/workspace/transactions.test.ts](../tests/workspace/transactions.test.ts)。
- [x] **D-06 可重复 benchmark**（依赖：D-03、D-04、D-05）：覆盖 plan、单/多指令、冷/热启动、小文件、大仓、大输出、并发、replay、failure、indeterminate；报告 p50/p95/p99 和失败率。新增 [scripts/isa-benchmark.mjs](../scripts/isa-benchmark.mjs) 与 [audit/reports/isa-benchmark-2026-11-02.md](../audit/reports/isa-benchmark-2026-11-02.md)，原始样本见 [audit/results/isa-benchmark.json](../audit/results/isa-benchmark.json)；默认 10 次采样全部 `failureRate=0`，failure/indeterminate 场景分别稳定返回预期状态。
- [~] **D-07 soak 与泄漏检查**（依赖：R-09、D-03、D-04）：扩展 [scripts/agent-soak.mjs](../scripts/agent-soak.mjs)，覆盖 ISA pipeline、crash/reopen、prune、lease、journal、RSS、句柄、event-loop p99、残留 PID；支持 `smoke`/`24h`/`7d` profile。早期短跑见 [isa-soak-2026-11-02.md](../audit/reports/isa-soak-2026-11-02.md)；冻结源码 `d7db41251f5551f3` 的真实 24h 于 `2026-11-03 19:07:25 Asia/Shanghai` 启动，启动及独立连接复核证据见 [本轮报告](../audit/reports/rwkv-amd-xioflow-2026-11-03.md)。使用 native reaper、512 MiB V8 old-space、2 GiB RSS 与 2 GiB 数据库/WAL/SHM 观测停止门槛；失败保留 journal/artifacts。24h 只有真实跑满、报告 PASS 且无残留/租约失败后才允许进入 7d，完整增长轨迹仍须审查；截至该启动记录，24h 正在运行，D-07 尚未通过。
- [~] **D-08 固化平台证据**（依赖：D-02、D-06、D-07）：已有 [本轮 Linux 固定源码验证](../audit/reports/rwkv-amd-xioflow-2026-11-03.md)：902 项 Vitest 通过、8 项条件跳过，60 项原生研究测试通过，23 项打包消费者检查通过；conformance 区分 55 个执行通过与 2 个 unsupported 正确拒绝。仍须补齐 D-07 及 Linux/macOS/WSL2/noatime/delegated cgroup 等对应证据，不把单平台 green 外推为跨平台保证。
  - **2026-11-03 增量**：远端 Linux 容器实机发现并修复 zombie 被 `kill(pid,0)` 误判活跃导致的四个停止失败；停止结果保留 `unreapedPids`，不伪称 PID 条目消失。soak 增加 RSS/数据库 stop gate、进度报告与失败 journal 保留；当前容器 cgroup 只读，不具有 delegated hard-limit 证据。24h/7d 仍须真实跑满。

阶段验证：

~~~text
pnpm typecheck
pnpm test
pnpm conformance
XIOFLOW_SOAK_PROFILE=24h node scripts/agent-soak.mjs
XIOFLOW_SOAK_PROFILE=7d node scripts/agent-soak.mjs
~~~

Gate 3 通过条件：大输出无同步写盘阻塞；高并发 event-loop p99 达标；能力矩阵每格有证据；24 小时 soak 无残留 PID、lease、artifact 和未解释的内存/句柄增长。

### 19.7 AD 组：MCP、CLI、SDK 和 wrap 迁移（Gate 4）

- [~] **AD-01 MCP 单工具 execute**（依赖：I-09、R-05、R-07）：已有 preview execute(program)、显式 host binding 和请求取消；`isaOnly` plan 不创建 domain。旧工具全部编译到 ISA 与稳定结果协议仍待完成。
- [~] **AD-02 CLI 控制面**（依赖：R-05、R-09）：已有 `xio plan/execute --input file|-`，无 binding 的副作用保持 unsupported；status、resolve、artifact get、inspect 控制面仍待统一接线。
- [~] **AD-03 Node SDK**（依赖：I-09）：新增 `@xioflow/kernel/isa` 枚举式 preview 入口，干净安装消费者可运行结构化 plan；旧宽根入口暂保留，稳定收窄依赖完整迁移。
- [ ] **AD-04 收缩 xio wrap**（依赖：I-08、R-04）：gateway 只做协议翻译；cache、time-fork、shadow、race、shell shim 不拥有独立 recovery 语义。
- [ ] **AD-05 兼容旧入口**（依赖：AD-01、AD-02）：记录 deprecation warning、映射 Program、ISA minor 范围、废弃版本和替代调用。
- [~] **AD-06 adapter 等价性测试**（依赖：AD-01 至 AD-05）：已验证同一 control.health Program 的 SDK/MCP 事实等价、零副作用 plan 与取消边界；完整 golden corpus 的 SDK/MCP/CLI/wrap 对照仍待完成。
- [~] **AD-07 迁移文档和示例**（依赖：AD-06）：已更新 README、API surface、current-contract、conformance 与 [preview adapter 报告](../audit/reports/isa-adapter-preview-2026-11-03.md)，干净打包检查覆盖 ISA SDK 和 CLI stdin plan；完整迁移示例、英文契约同步与 AD-06 四入口等价性仍未完成。

阶段验证：

~~~text
pnpm test
pnpm conformance
pnpm verify:package
~~~

Gate 4 通过条件：四个入口对同一 Program 返回结构等价事实；兼容入口不绕过 capability/journal；干净安装的 SDK/MCP 示例与仓内结果一致。

### 19.8 Q 组：质量、证据与发布门禁（Gate 5）

- [~] **Q-01 registry 生成测试**（依赖：I-01、I-02）：已有 opcode/schema registry 检查及在临时目录重生成后逐字节比较的回归；完整 MCP schema、CLI 参数、文档表和 catalog 生成链仍待完成。
- [~] **Q-02 unit/property 测试**（依赖：I-04、I-06、R-06）：已有 [ISA validator](../tests/isa/validator.test.ts)、[pipeline](../tests/isa/pipeline.test.ts)、[capability v1](../tests/capability/v1.test.ts)、[路径/symlink](../tests/capability/capability.test.ts)、[artifact safety](../tests/supervisor/artifact-safety.test.ts)、[result](../tests/isa/result.test.ts) 和 [migration](../tests/store/migrations.test.ts) 的示例/unit 回归；尚无 property/fuzz 生成器或 shrinking，真实 ISA kernel bridge 仅覆盖四个 opcode，不能由全仓测试通过推断完整性质覆盖。
- [~] **Q-03 fault matrix**（依赖：R-04、D-01）：已有真实 SIGKILL [crash matrix](../tests/fault/crash-matrix.test.ts)、[spawn evidence](../tests/fault/spawn-evidence.test.ts)、[identity evidence](../tests/driver/identity-evidence.test.ts)、[观测失败](../tests/driver/observation-failure.test.ts) 等进程/legacy 回归；完整 ISA process 链路、resolver/adjudication 崩溃矩阵及逐故障证据映射尚未收口。
- [~] **Q-04 状态模型**（依赖：R-03、R-04）：已有 [OperationRecovery.tla](../spec/tla/OperationRecovery.tla) 和 Node/reaper 两套配置，[本轮报告](../audit/reports/rwkv-amd-xioflow-2026-11-03.md) 保留 TLC 157/139 个 distinct states 的证据。模型仍为单操作抽象，尚未覆盖 epoch fencing、结果事件计数等全部不变量；[check-tla.mjs](../scripts/check-tla.mjs) 清理临时 metadir/trace，尚未实现失败最小反例的持久保存。单操作 TLC 与 Linux 测试汇总均不代表完整 ISA 状态模型通过。
- [~] **Q-05 security regression**（依赖：R-06 至 R-09）：已有 [IPC/nonce](../tests/ipc/local-socket.test.ts)、[capability v1](../tests/capability/v1.test.ts)、[SecretRef/输出脱敏](../tests/driver/secret-env.test.ts)、[artifact safety](../tests/supervisor/artifact-safety.test.ts)、[配置快照](../tests/store/config-snapshots.test.ts)、[gateway copy-on-write 原配置保持不变](../tests/gateway/wrap.test.ts) 与 ISA 跨 Run/取消回归；完整 ISA proc/fs/artifact 执行路径、各 driver 的秘密边界及旧版本原地配置改写的崩溃恢复仍无完整证据，保持部分完成。
- [~] **Q-06 conformance 报告生成**（依赖：Q-01、Q-03）：已实现 `pnpm conformance:report`、JSON schema 与证据边界测试，分列 catalog/runnable/archived/planned/unsupported，记录源码/build hash、版本、日期、平台、driver、Node、命令与 exit；`NOT_RUN` 不算通过。完整生成 catalog 与 fault gate 仍待收口。
- [~] **Q-07 clean package smoke**（依赖：AD-07、Q-01）：已有 npm pack 后独立临时项目的消费者检查，新增 ISA SDK 子入口与 CLI stdin plan；完整迁移示例、plain corpus 与所有 adapter 的打包等价性仍待完成。
- [~] **Q-08 文档结构同步**（依赖：A-04、AD-07）：已有 [scripts/check-doc-sync.mjs](../scripts/check-doc-sync.mjs) 的中英文 ARCHITECTURE 标题树检查；本轮对账 preview、能力模型、测试及长期验证状态。该检查不验证正文语义或其余文件的一致性；README、current-contract、ROADMAP、CHANGELOG、schema、registry、conformance 的完整生成/迁移同步仍依赖 Q-01、AD-07。
- [ ] **Q-09 发布证据包**（依赖：Q-03 至 Q-08）：生成 audit/reports/release-<version>.md，包含源码 commit、版本、ISA/schema/driver、测试、平台、benchmark、soak、conformance、限制和回滚方案。
- [ ] **Q-10 回滚演练**（依赖：Q-09）：演练发布失败、migration 失败、旧 client、artifact retention、indeterminate adjudication；回滚路径必须可重复。

阶段验证：

~~~text
pnpm typecheck
pnpm test
pnpm conformance
pnpm check:tla
pnpm verify:package
node scripts/check-doc-sync.mjs
~~~

Gate 5 通过条件：关键故障没有假成功、盲重放和未解释资源泄漏；打包消费者可用；文档、schema、registry、CHANGELOG 和证据包一致。否则版本保持 preview。

### 19.9 E 组：采用和稳定化（Gate 6）

- [ ] **E-01 发布内部 preview**（依赖：Gate 5）：以 xio/1.0-rc 或等价标识发布，列出 ISA/schema/driver 支持范围和迁移说明；只接收安全、一致性和关键回归修复。
- [ ] **E-02 引入设计伙伴**（依赖：E-01）：至少一个宿主机 Agent 框架通过 SDK 或 MCP execute 实际接入；对方仓库的分支或 PR 才算采用证据。
- [ ] **E-03 获得独立实现证据**（依赖：E-02）：至少两个不依赖内部 TypeScript 状态机的 adapter 或 driver 通过 conformance。
- [ ] **E-04 连续三个 minor 兼容**（依赖：E-01）：旧 Program、旧 journal、旧 client 和 migration 全部通过；破坏性变化必须升主版本并附迁移器。
- [ ] **E-05 发布 stable 1.0/LTS**（依赖：E-02、E-03、E-04）：满足成功判据、Gate 0–5、24 小时/7 天 soak、安全复核、完整文档和可复现发布证据后，才标 stable。

### 19.10 明确延后的方向

- [ ] **FUTURE-01 Rust/语言绑定**：只有出现真实非 Node 宿主需求、性能瓶颈或独立实现压力，并完成 RFC、维护者和迁移预算后重开。
- [ ] **FUTURE-02 daemon/跨进程仲裁**：只有多个外部框架在同一工作区真实冲突且 worktree 分域无法解决时重开；必须先补 IPC 身份、租约、client_lost 和威胁模型。
- [ ] **FUTURE-03 Windows/远程执行**：先定义平台事实、隔离、artifact/secret 传输和 conformance；不能以 API 形状相同代替能力证明。
- [ ] **FUTURE-04 分布式 opcode/driver 生态**：稳定 ABI、第三方 conformance 和维护治理完成前不建立中心注册表。

## 二十、逐任务执行模板、阶段门禁与验收场景

### 20.1 从需求到发布的固定十步

1. **登记**：创建任务 ID，写清工作包、opcode/adapter、依赖、风险和反目标。
2. **契约先行**：先改 registry、schema、结果语义或 RFC；若不改变契约，写明复用的既有条目。
3. **失败测试**：为正常、拒绝、失败、indeterminate、重放和恢复至少写一个可观察断言。
4. **最小实现**：只改所属模块；adapter 不写 store，driver 不判业务成功，stdlib 不绕过 capability。
5. **本地验证**：先跑受影响测试，再跑 pnpm typecheck；失败保留完整命令和关键输出。
6. **跨入口验证**：同一 Program 至少经 SDK 和一个 adapter；结构化结果、journal 和 artifact 引用做比较。
7. **文档与迁移**：同步 ARCHITECTURE、current-contract、README、CHANGELOG、英文结构和迁移说明。
8. **证据归档**：把测试、benchmark、fault、平台、版本和限制写入 audit/reports。
9. **阶段评审**：满足 Gate 的所有硬条件后才进入下一阶段；任一硬条件失败，版本停留在当前通道。
10. **发布/回滚**：发布前运行 package smoke、conformance 和 release checklist；失败按已演练的 schema/package/文档回滚路径处理。

### 20.2 并行车道

| 车道 | 可并行任务 | 不可越过的前置 |
| --- | --- | --- |
| ISA | I-01 至 I-05、I-07、I-10 | A 组 |
| 持久化/恢复 | R-01 至 R-05 | I-02、I-07 |
| 能力/安全 | R-06 至 R-10、Q-05 | I-02 capability schema |
| 驱动/性能 | D-01 至 D-08 | I-01 driver 元数据、R-03 事件语义 |
| 适配器 | AD-01 至 AD-07 | I-09、R-05 |
| 质量/发布 | Q-01 至 Q-10 | 以上车道提供可运行产物 |

同一文件或同一状态机只能由一个车道负责；跨车道改动必须先更新契约，再由各车道补实现和测试。

### 20.3 端到端验收演练

Gate 4 前必须用一个固定场景贯通所有层：

1. Host 签发只覆盖 src/** 和 tests/** 的 capability。
2. 通过 execute 提交 workspace.snapshot → fs.patch → proc.spawn/pnpm test → workspace.diff 的 DAG。
3. plan 阶段检查 schema、能力、资源和 driver，并确认 domain.db、文件、artifact、进程都未改变。
4. pipeline 阶段先写 intent，再持有 lease，再执行 patch 和测试；stdout/stderr 只返回 ArtifactRef。
5. 测试成功时返回 read/write/discovery set、hash、coverage 和 evidence；host 决定是否 commit。
6. 测试失败时提交 workspace.rollback；coverage 不是 complete 时必须列出 ignored/out-of-scope 影响。
7. spawn 后故意 SIGKILL host，重开 domain；恢复只能根据原 intent 和 driver evidence 返回终态、failed 或 indeterminate，绝不自动重跑。
8. 通过 SDK、MCP、CLI、wrap 重复同一 Program，比较结构化结果和 journal，允许渲染文本不同。
9. 运行 artifact prune、invariant checker、package smoke、conformance，确认没有残留 PID、lease、unknown-owner 文件和秘密。

最小命令集合：

~~~text
pnpm build
pnpm exec vitest run tests/isa tests/fault tests/snapshot tests/workspace tests/mcp
pnpm conformance
node scripts/check-invariants.mjs <domain.db>
pnpm verify:package
~~~

### 20.4 Gate 判定

| Gate | 必须完成 | 必须留下的证据 | 失败处理 |
| --- | --- | --- | --- |
| Gate 0 方向冻结 | A-01 至 A-05 | 边界表、API 清单、基线报告 | 停止新增核心功能，先补契约 |
| Gate 1 ISA alpha | I-01 至 I-10 | registry、schema、golden corpus、plan/pipeline 测试 | 只允许内部 alpha，不接外部 adapter |
| Gate 2 recovery/security | R-01 至 R-10 | migration、fault、脱敏、IPC、ownership 测试 | external opcode 不得标 stable |
| Gate 3 driver/perf | D-01 至 D-08 | capability matrix、benchmark、24h soak | 降低能力声明或暂停扩展 opcode |
| Gate 4 adapter | AD-01 至 AD-07 | 四入口等价性、迁移文档、clean package | 兼容层继续 preview |
| Gate 5 quality/release | Q-01 至 Q-10 | conformance、模型、安全、发布证据包 | 不发 stable，保留当前版本修复 |
| Gate 6 adoption/1.0 | E-01 至 E-05 | 外部采用、独立实现、三 minor 兼容、LTS 规则 | 回到 preview，缩小承诺或暂停生态 |

### 20.5 Definition of Done

任务只有同时满足以下条件才可以勾选：

- 契约已在 registry/schema/RFC 中表达，没有隐藏字段和隐式默认值。
- 实现只位于所属层，没有新增第二状态机或绕过 capability/journal 的快捷路径。
- 正常、拒绝、失败、重放、indeterminate、恢复路径都有测试。
- 没有编造 exit code、signal、树为空、资源峰值、coverage 或 artifact ownership。
- 受影响的 SDK、MCP、CLI、wrap 至少有一个等价性验证，或明确记录不适用。
- 运行了最小充分验证命令，并记录 exit code、Node、平台、driver 和摘要。
- 规范、README、CHANGELOG、迁移说明、英文结构和 generated artifacts 已同步。
- 没有未解释的 lease、process、artifact、journal、memory、handle 或 secret 泄漏。
- 变更可回滚；涉及 schema、结果状态或外部副作用时，已有迁移/裁决/回滚演练。

### 20.6 交付记录格式

将以下内容写入对应 audit/reports/ 报告或 PR 描述：

~~~text
Task: <ID>
Scope: <opcode / adapter / driver / store>
Dependencies: <IDs>
Contract changes: <registry/schema/RFC references>
Files: <changed paths>
Tests:
  - command: <exact command>
    exit: <code>
    result: <summary>
Evidence: <journal / artifact / conformance / benchmark report>
Known limits: <unsupported or unknown facts>
Rollback: <how to revert code, schema, package, or data>
Next gate: <Gate N>
~~~

如果不能填出 Evidence、Known limits 或 Rollback，任务保持未完成；不以“本地能跑”替代阶段出口。

## 附录 A：示例指令程序

### A.1 修改、测试和生成 diff

~~~json
{
  "isa": "xio/1",
  "mode": "transaction",
  "capability": "cap:task-42",
  "instructions": [
    {
      "id": "s1",
      "op": "workspace.snapshot",
      "args": { "label": "before" }
    },
    {
      "id": "p1",
      "op": "fs.patch",
      "dependsOn": ["s1"],
      "args": {
        "workspace": "workspace:root",
        "path": "src/parser.ts",
        "patch": "artifact:patch-42"
      },
      "precondition": [
        {
          "kind": "file_hash",
          "path": "src/parser.ts",
          "sha256": "expected-before-hash"
        }
      ]
    },
    {
      "id": "t1",
      "op": "proc.spawn",
      "dependsOn": ["p1"],
      "args": {
        "argv": ["pnpm", "test", "tests/parser"],
        "cwd": "workspace:root",
        "stdio": "capture"
      }
    },
    {
      "id": "d1",
      "op": "workspace.diff",
      "dependsOn": ["t1"],
      "args": { "from": "s1" }
    }
  ]
}
~~~

如果测试失败，host 可以继续提交 workspace.rollback；如果进程状态无法确认，程序必须返回 indeterminate，不能自动重复测试或自动提交。

### A.2 恢复不确定进程

~~~json
{
  "isa": "xio/1",
  "mode": "pipeline",
  "capability": "cap:operator",
  "instructions": [
    {
      "id": "s1",
      "op": "control.status",
      "args": { "lease": "lease-456" }
    },
    {
      "id": "r1",
      "op": "control.resolve",
      "dependsOn": ["s1"],
      "args": {
        "lease": "lease-456",
        "decision": "failed",
        "reason": "operator confirmed process absent and workspace unchanged"
      }
    }
  ]
}
~~~

裁决必须记录操作者、证据、理由、时间和释放的资源；模型不能代替这个授权过程。

## 附录 B：术语表

- **ISA**：Instruction Set Architecture，指令集及其可观察语义。
- **Opcode**：一条稳定的操作类型，例如 fs.patch 或 proc.spawn。
- **Program**：一组带依赖关系的 instruction DAG。
- **Kernel**：负责验证、授权、调度、journal、lease、恢复和结果语义的核心。
- **Driver**：提供具体 OS、文件系统、进程树或隔离能力的实现。
- **Adapter**：把外部协议转换为 ISA 的入口。
- **Stdlib**：可展开成 ISA 的高阶程序和宏。
- **ArtifactRef**：对文件、日志、输出或证据的受控引用。
- **Capability**：限制 opcode、资源、路径、秘密和期限的授权对象。
- **Evidence**：支持某个状态结论的持久化事实。
- **Indeterminate**：副作用可能发生，但当前证据不足以证明最终状态。
- **Lease**：在结果确定或显式裁决前必须保留的资源占用。
- **Conformance**：某个实现对 ISA、结果、失败和安全契约的符合性。

## 附录 C：现有 xioflow 能力映射

| 当前能力 | 目标位置 | 处理方式 |
| --- | --- | --- |
| quickRun | proc.spawn + proc.wait 的 stdlib helper | 保留易用封装，内部生成 Program |
| ProcessSupervisor | kernel executor + process driver | 拆分调度语义和 OS 实现 |
| SQLite domain/store | store + journal | retention、ISA 级 replay 和跨入口等价性 |
| reaper/cgroup | drivers | 通过 capability matrix 暴露强弱保证 |
| workspace snapshot/rollback | workspace opcode | 统一 coverage、read/write set 和 evidence |
| MCP tools | adapter-mcp | 收敛为单 execute，旧工具只做兼容编译 |
| xio wrap | adapter-wrap | 只做 wire/shell 到 ISA 的转换 |
| HTTP-304 cache | stdlib/adapter | 默认关闭原文持久化，不能进入 kernel TCB |
| shadow worktree/race | stdlib/adapter | 使用 workspace opcode，不维护第二状态机 |
| trace/fork | audit/debugger | 依赖 event/artifact 引用，不复制核心语义 |
| AgentRuntime | experimental stdlib | 先限制为 ISA program producer，不进入 v1 kernel |
| OTLP | audit adapter | 脱敏、路径策略、引用化后导出 |
| conformance suite | generated contract | 从 opcode registry 生成 catalog、测试和报告 |
