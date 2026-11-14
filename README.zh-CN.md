# @xioflow/kernel

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Xio-Shark/xioflow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xioflow/kernel.svg)](https://www.npmjs.com/package/@xioflow/kernel)
[![Node](https://img.shields.io/badge/Node.js-22.13%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Docs (EN)](https://img.shields.io/badge/spec-ARCHITECTURE.en.md-informational.svg)](./ARCHITECTURE.en.md)
[![Docs (ZH)](https://img.shields.io/badge/spec-ARCHITECTURE.md-informational.svg)](./ARCHITECTURE.md)

面向 AI Agent 运行时的受监督执行内核（零运行时依赖；详见 [架构与协议规范（中文）](./ARCHITECTURE.md) / [English Spec](./ARCHITECTURE.en.md)）。

内核为独立构建的各类 Agent 产品提供统一执行底座：执行域所有权、操作幂等标识、资源锁仲裁、进程树生命周期管理、工作区事务与可恢复证据链。模型选择、Prompt、应用层工具与授权策略仍归宿主所有；评测重点聚焦于故障条件下的正确性、多任务隔离与可复现恢复。

常规 Agent 运行时往往只调一次 `spawn()`（或 `exec()`）便听天由命：当宿主在工具调用中途崩溃、或取消操作无法确认收尾时，就会留下**孤儿进程**、**重复生效的副作用**以及**说不清真实发生了什么的无头账**。本内核把这些不确定状态提升为一等公民而非静默吞错：结果无法确认的操作会被记为 `indeterminate` 并继续保留其租约；驱动未能确认终止的进程，绝不伪造成功退出。

参考发行版 [xiocode](https://github.com/Xio-Shark/xiocode) 默认把受监督命令运行在本内核上——下述一致性套件正是促成这一切换的安全依据。

除单次命令外，内核还监督长驻服务（MCP stdio server、开发服务器）、基于 `opId` 为持久化引擎（Temporal、LangGraph）提供幂等执行保证，并支持对工作区做快照、回滚与分叉，使 Agent 的文件改动可按步撤销。

你可以直接嵌入 OS Medium（`connectWorkspace`、`KernelMedium`、`@xioflow/kernel/surface`）或底层 `ProcessSupervisor`，也可以启动 MCP 服务（`xioflow mcp`），或者通过 CLI 网关（`xio wrap`）在不修改现有编码 Agent（`claude`、`codex`、`gemini`、`opencode`、`qwen`、`xio`）源码的情况下直接监督它们：

```bash
# 检查宿主环境就绪度（原生 reaper、写入隔离驱动、cgroup v2、git）
npx @xioflow/kernel doctor

# 监督现有 Agent 的子进程树，并在本地缓存 LLM 对话轮次
npx @xioflow/kernel wrap -- claude -p "Refactor subtotal helpers"

# 在隔离的 git-shadow worktree 中运行，仅在测试门禁通过后应用变更
npx @xioflow/kernel wrap --shadow --gate "pnpm test" -- codex exec "Fix failing parser test"

# 在并行 worktree 中运行多个 Agent 并自动合并无冲突改动
npx @xioflow/kernel race --mode merge --gate "pnpm test" -- "claude -p 'task A'" "codex exec 'task B'"

# 查看记录的轮次、快照与进程，或从第 N 步分叉继续执行
npx @xioflow/kernel trace <runId>
npx @xioflow/kernel fork <runId> --at-step 4 -- gemini -p "Continue from step 4"

# 清理过期产物、无引用输出块与孤儿分叉
npx @xioflow/kernel prune
```

根包对外最多导出 **15 个正交运行时符号**（`connectWorkspace`、`KernelMedium`、`SessionView`、`ExecutionDomain`、`ProcessSupervisor`、`RecoveryEngine`、平台/写入隔离驱动以及锁异常类型）。面向模型的工具适配层位于 `@xioflow/kernel/surface`（`run`、`edit`、`inspect`、`branch`）。

## 5 分钟上手路径

XIO-ISA SDK 目前以 **preview** 形态发布于 `@xioflow/kernel/isa`。`xio plan --input program.json`（或 `--input -` 从标准输入读取）可在不获取执行域的前提下校验 Program 结构；在缺少宿主策略时这只是结构规划，而非执行授权。若未显式绑定宿主环境，`xio execute` 与 MCP 的 `execute` 工具对带副作用的指令都会返回 `unsupported`。当前持久绑定已支持 `workspace.snapshot`、`workspace.rollback`、`control.status` 与 `control.health`；其余 opcode 与事务模式暂为 `unsupported`。迁移期间原有工具集与 0.x 宽导出表面仍保留可用，详见[预览适配器验证记录](audit/reports/isa-adapter-preview-2026-11-03.md)。

宿主必须完成执行域/监督器/工作区绑定并提供持久化 capability。`programId` 指向既有 Run；带副作用的操作要求 Run 处于 `running` 状态。适配器不会代签 capability、创建替代 Run 或重新打开已终结 Run。MCP 宿主可传 `isaOnly: true` 启动只暴露 `execute` 的轻量服务（启动时不占用执行域）。取消请求会阻止待派发及后续 ISA 调度；已经派发中的 snapshot 会等待其真实结果返回。独立 CLI 默认不自动绑定副作用执行。

```bash
npm install @xioflow/kernel
```

随后只需一次调用即可监督第一条命令——自带输出上限控制与因果依赖追踪：

```js
import { KernelMedium } from '@xioflow/kernel';

const medium = await KernelMedium.open('/path/to/workspace');
const result = await medium.exec({ cmd: 'npm test' });
console.log(result.status, result.exitCode, result.stdout);
await medium.close();
```

若多个并发客户端或编辑器需要共享同一工作区账本，请改用 `connectWorkspace('/path/to/workspace')`（自动经由工作区 UDS Micro-Arbiter 连接）。集成前可先运行 `npx @xioflow/kernel doctor` 检查宿主的驱动与隔离能力。

接着选择与你场景匹配的集成示例：

[`examples/`](./examples/README.md) 包含 4 个可直接运行的集成示例。每个示例都通过 `file:../../` 链接本内核，测试的是当前工作区源码而非 npm 历史发布包：

| 示例 | 适用场景 | 演示重点 |
|---|---|---|
| [`replace-subprocess-wrapper`](./examples/replace-subprocess-wrapper) | 正在替换自有 `child_process.spawn` 包装层的编码 Agent | 对比朴素 `spawn + timeout` 为什么会泄漏孤儿进程、丢失尾部输出，对比 `KernelMedium.exec` 实测效果 |
| [`temporal-activity`](./examples/temporal-activity) | 带有 OS 副作用 Activity 的 Temporal Worker | 借助 `opId` 在 Worker 崩溃与重试下实现至多一次执行 |
| [`langgraph-node`](./examples/langgraph-node) | 节点会执行外部命令的 LangGraph.js 状态图 | Checkpoint 恢复时不重复执行已经成功的命令节点 |
| [`mcp-stdio-transport`](./examples/mcp-stdio-transport) | 负责管理 stdio 服务的 MCP 客户端 | 在内核之上结合 `startService` 实现自定义 `Transport` |

前置条件：Node.js >= 22.13 且仓库根目录已完成构建（`pnpm install && pnpm build`）。4 个示例均已在 2026-11-14 验证通过（macOS、`KernelMedium.exec`、Node 26.12.0、`@xioflow/kernel` 0.8.0）。各示例的具体契约映射与安装说明（`npm install` vs `pnpm install --ignore-workspace`）见 [examples/README.md](./examples/README.md)。

## 核心保证

| 保证项 | 实现机制 |
| --- | --- |
| 不伪造运行状态 | 先做准入检查，再将操作意图持久化写入 SQLite，最后才 spawn 进程。spawn 失败直接记为 `failed`（退出码 127），绝不呈现为 `running`。 |
| 不盲目重放 | 结果无法确定的操作会被记为 `indeterminate`，继续持有排他租约，重启后绝不自动重试。 |
| 不提前释放租约 | 仅当平台驱动确认整个进程树已退出后，才释放排他资源租约；未能确认停止会保留租约并升级为 `indeterminate`。 |
| 不静默丢弃输出 | 内存输出受 `maxOutputBytes`（默认 10 MiB）限制；每个输出流都会溢出落盘至 `<domain>/artifacts/`、`fsync` 刷盘并计算哈希。ID 为不透明键：普通 ID 保持可读文件名，特殊 ID 编码为安全基础名。截断情况按流汇报（含产物引用、字节数与哈希）；命名冲突或写盘失败通过 `spillError` 明确上报。 |
| 不隐式篡改环境变量 | `envWhiteList` 精确生效：传入什么子进程就只拿到什么，不私自注入 `PATH`。未指定白名单时默认继承 `process.env`，传 `inheritEnv: false` 则获得完全空白的环境。 |
| 诚实汇报进程树收尾 | 终止流程沿进程组按 `SIGINT → SIGTERM → SIGKILL` 逐级升级，随后重新枚举后代进程。若发现逃逸的存活进程，返回 `cannot_determine` 及 `residualPids`；缺少观测依据或管道持有者不明时保留 `indeterminate`。在 Linux 上观测到的僵尸进程会保留在 `unreapedPids` 中：确认停止不代表误报 PID 消失或父进程已成功 `waitpid`。`treeSettlement: 'empty'` 需要驱动确证；兼容字段 `reaped` 仅表示内核做过清理干预，需结合未回收事实一起解读；`unverified` 保留观测边界。 |
| 不盲目重试 | 使用相同 `opId` 与输入指纹再次提交时，会直接加入进行中的执行（in-flight join）或重放已记录结果（`replayed: true`）；`indeterminate` 状态会原样返回而绝不重跑。若 `opId` 相同但输入指纹不同，抛出 `OperationIdConflictError`。 |
| 不越界回滚 | 回滚只重写或删除快照声明根目录下的文件，除非捕获时包含，否则不触动忽略文件，且通过指纹校验结果。仅当快照之后的所有操作均在隔离驱动下运行、且忽略文件也被证明未变或一并恢复时，才声称 `coverage: 'complete'`；否则如实报告 `non_ignored` 或 `declared_roots`，并在 `coverageBasis` 给出依据。 |
| 防止脑裂 | 每个执行域同一时刻只允许一个活跃所有者，通过排他锁文件 + 心跳租约守卫；陈旧所有者由 epoch 计数器挡住，写入直接被拒绝。 |
| 每域单仲裁入口 | 多个监督入口共享进行中操作、读取追踪、服务所有权与工作区提交队列。同 ID 调用并入原执行，取消也沿用原始驱动。 |
| 不臆测产物归属 | 写产物绝不覆盖既有文件；即时清理前会核验创建文件身份；垃圾回收仅处理带 journal 归属记录的文件，对未知文件一律保留。 |
| 不编造进程或资源事实 | 进程观测失败不会伪装成空进程树或确认停止；资源采样失败通过 `resourceSamplingError` 暴露，未知峰值直接留空。软度量阈值丢失观测依据时按 fail-closed 处理；纯观测失败会持续可见但不强行打断命令。 |

崩溃恢复同样依赖持久化启动证据：仅当 `intent_registered` 记录明确带有 `spawnGated: true` 且缺失进程身份时，内核才能证明命令尚未真正放行；未经过门控的启动及缺少该证据的旧记录即便在新版驱动上也只会维持 `indeterminate` 并保留租约。同一 `opId` 再次提交只会重放已记结果而不会重跑。详见[恢复边界与迁移说明](spec/current-contract.md#crash-recovery-and-launch-evidence)。

## 运行要求

- **Node.js >= 22.13**（原生支持无 flag 的 `node:sqlite`）。CI 覆盖 Ubuntu 与 macOS 上的 Node 22.13 与 24。上游 `node:sqlite` 目前仍带 `ExperimentalWarning`，运行时打印该警告属正常现象。
- **Linux 与 macOS**。默认驱动通过 `ps(1)` 枚举后代并向 POSIX 进程组发送信号；可选的原生 reaper 助手直接守住整棵进程树；在 Linux 上，cgroup v2 驱动还能对进程树施加内核级容器隔离与硬内存/进程数上限（见[守住整棵进程树](#守住整棵进程树)）。
- 快照能力依赖 `PATH` 中的 `git` 及一个 Git 工作树。内核写入隔离在启用 `exec({ confinement: true })` 时会使用 `sandbox-exec`（macOS）或 `landlock`、`bubblewrap`、`srt`（Linux）。
- **暂不支持 Windows**。在 Windows 上驱动会诚实汇报 `processGroupKill: false` 与 `descendantEnumeration: 'none'`，绝不假装能够收拢进程树。
- **单写者执行域锁 + 可选 UDS Micro-Arbiter**：`ExecutionDomain.acquire` 强制单域单宿主进程（冲突抛 `DomainLockedError`）。当同一工作区需要被多个 IDE/CLI/子 Agent 客户端无锁争用地共享时，`connectWorkspace()`（默认 `mode: 'auto'`）会自动拉起或附着到一个权限为 `0600` 的本地 UDS Micro-Arbiter（`WorkspaceArbiterServer` / `WorkspaceArbiterClient`），统一协调 `SessionView` 因果读取，并在空闲时自动退出。
- **WSL2**：完整契约套件已在 WSL2 Ubuntu 上验证（2026-10-13，Node 22.23.3，704 通过 / 8 个 cgroup 门控用例跳过）。默认 `NodePlatformDriver` 与原生 reaper 均可正常运行；cgroup v2 驱动需要宿主的 `/sys/fs/cgroup` 已委托给当前用户（WSL2 默认不开启委托，否则抛出 `CgroupUnavailableError` 而不降级）——如需启用，请在 `systemd-run --user --scope -p Delegate=yes` 下运行或使用独立 cgroup 命名空间容器。

## 快速开始

### 1. OS Medium 与 4 个黄金 LLM 原语（`connectWorkspace` / `@xioflow/kernel/surface`）

单宿主嵌入可使用 `KernelMedium.open()`；多客户端通过本地 UDS Micro-Arbiter 共享同一工作区账本时使用 `connectWorkspace()`：

```js
import { connectWorkspace } from '@xioflow/kernel';
import { createSurfaceDispatcher, toOpenAiTools } from '@xioflow/kernel/surface';

const medium = await connectWorkspace('/path/to/workspace');
const dispatch = createSurfaceDispatcher(medium);

// 1. 向任意 LLM 提供商暴露 4 个黄金原语（run, edit, inspect, branch）
const tools = toOpenAiTools();

// 2. 基于幂等 opId 与受限输出溢写监督执行命令
const res = await medium.exec({
  opId: 'workflow-step-42',
  cmd: 'pnpm test',
  confinement: true,
});
if (res.replayed) {
  console.log('命中日志重放，未重复拉起子进程');
}

// 3. 因果校验并执行模型 edit 工具，门禁失败时自动回滚
const out = await dispatch('edit', {
  path: 'src/math.ts',
  oldText: 'return a - b;',
  newText: 'return a + b;',
  gateCmd: 'pnpm test',
});

await medium.close();
```

### 2. 完整底层架构与精细监督

当你需要精细控制 Task、Run、资源锁、实时输出流或多阶段编排时：

```js
import { ExecutionDomain, NodePlatformDriver, ProcessSupervisor } from '@xioflow/kernel';

// 域目录将存放 domain.db、domain.lock 与 artifacts/。
const domain = ExecutionDomain.acquire('/path/to/workspace/.xioflow/kernel', 'my-domain');
const supervisor = new ProcessSupervisor(domain, new NodePlatformDriver());

// 每次操作归属一个 Run，每个 Run 归属一个 Task；执行前先登记：
const store = domain.getStore();
store.saveTask({
  id: 'task-1',
  domainId: domain.domainId,
  name: 'fix failing tests',
  createdAt: new Date().toISOString(),
});
store.saveRun({
  id: 'run-1',
  taskId: 'task-1',
  domainId: domain.domainId,
  owner: 'my-agent-session',
  status: 'running',
  startedAt: new Date().toISOString(),
});

const result = await supervisor.executeProcess({
  runId: 'run-1',
  opId: 'op-1',
  name: 'npm test',
  command: { execPath: 'npm', args: ['test'], cwd: '/path/to/workspace' },
  requiredResources: ['workspace:write:/path/to/workspace'],
  timeoutMs: 120_000,
});

console.log(result.status, result.exitCode, result.isTruncated, result.outputRef);

domain.close(); // 释放所有者租约与域锁
```

`requiredResources` 为任意命名的排他租约 ID。请求同一 ID 的两个操作绝不会并发执行：后者最多等待 `waitTimeoutMs`，超时则抛出带当前持有者信息的 `ResourceConflictError`。

`StructuredCommand` 各字段显式约定子进程 I/O 与环境变量：

| 字段 | 行为 |
| --- | --- |
| `args` | 直接作为 argv 传递，绝不经 shell 拼接 |
| `stdin` | `string \| Uint8Array`，写入一次性管道后立即关闭；子进程未读 stdin 即退出属于正常退出，不视为 spawn 失败 |
| `envWhiteList` | 精确白名单，绝不暗中注入变量（包括 `PATH`） |
| `inheritEnv` | 仅在未提供白名单时生效；`false` 给出全空环境 |

取消操作请调用 `await supervisor.cancelOperation('op-1', graceMs)`，返回 `{ stopped, scope, residualPids? }`。原挂起的 `executeProcess` Promise 随后会解析为 `status: 'cancelled'`；若驱动无法确认进程完全停止，则解析为 `status: 'indeterminate'` 且继续保留资源租约。

> **关于并发加入（In-Flight Join）与取消语义**：
> 当次要调用方带着相同 `opId` 与输入指纹加入正在执行的调用时，向次要调用方传入 `abortSignal` 只会取消该次要调用方自己的等待 Promise，绝不会中止底层进程或主调用方的执行。如需真正终止底层进程，请显式调用 `supervisor.cancelOperation(opId)`。

## 守住整棵进程树

`NodePlatformDriver` 从外部观察进程树，一旦后代进程调用 `setsid()` 脱离父进程关系就可能在停止后继续存活；此时内核会如实返回 `indeterminate` 而不说谎。`ReaperPlatformDriver` 则让每个操作运行在轻量原生助手（随包预编译分发的 `xioflow-reaper`）之下直接守住整棵树：

```js
import { ExecutionDomain, ProcessSupervisor, ReaperPlatformDriver } from '@xioflow/kernel';

const supervisor = new ProcessSupervisor(domain, new ReaperPlatformDriver());
```

| | Linux | macOS |
| --- | --- | --- |
| 进程树保持方式 | `PR_SET_CHILD_SUBREAPER`：孤儿进程自动过继到 helper 名下 | kqueue `NOTE_FORK`、session 归属与微秒级启动时间戳 |
| 停止信号 | 复核启动时间后使用 `pidfd_send_signal` | 复核启动时间后使用 `kill` |
| `confirmed_stopped` 含义 | `waitpid` 返回 `ECHILD`（`scope: 'subreaper_tree'`） | 所有被跟踪进程确认消失（`scope: 'tracked_tree'`） |
| 监督宿主意外死亡 | helper 自动清理整棵进程树 | helper 自动清理整棵进程树 |

`ReaperPlatformDriver.isAvailable()` 用于检查当前平台的原生助手是否可用；若不可用构造函数直接抛错而不会静默降级。可通过 `node scripts/build-native.mjs` 从源码编译，或用 `XIOFLOW_REAPER_PATH` 指定二进制路径。

在 Linux 上，`CgroupPlatformDriver` 会在子进程仍卡在启动门控时将其放入专属 cgroup v2 中，因此它 fork 的一切子孙进程都无法逃逸：

```js
import { CgroupPlatformDriver, ProcessSupervisor } from '@xioflow/kernel';

// 在托管 cgroup 下启动宿主：systemd-run --user --scope -p Delegate=yes node host.js
const supervisor = new ProcessSupervisor(domain, new CgroupPlatformDriver());
await supervisor.executeProcess({ /* ... */, resourceBudget: { enforcement: 'hard', maxMemoryBytes: 512 * 2 ** 20, maxPids: 256 } });
```

- `confirmed_stopped` 表示 `cgroup.events` 报告 `populated 0`（`scope: 'containment_cgroup'`）；停止阶段通过 `cgroup.kill` 收尾。
- `hard` 预算会映射为 `memory.max`（禁用 swap；触发 OOM 会杀掉整棵树并记为 `memory_exceeded`）与 `pids.max`（触达上限以 `pids_exceeded` 终止）。
- cgroup 路径在进程真正放行前即与进程身份绑定入库。宿主崩溃恢复时，即便进程企图逃逸也会连同整个 cgroup 清理干净后再释放租约。
- 需要宿主拥有受委托的 cgroup，否则构造函数抛出带明晰原因的 `CgroupUnavailableError`（`CgroupPlatformDriver.unavailableReason()` 可无副作用检查）。它还会先把当前 cgroup 既有进程迁入 `xioflow-host` 叶子节点，以满足 cgroup v2「只有无进程节点才能向下级委派控制器」的内核约束。

## 包装既有 CLI Agent（`xio wrap`）

无需修改既有编码 Agent 的任何源码，`xio wrap` 通过拦截两层边界即可完成监督：

1. **LLM HTTP 代理（`src/gateway/wire-proxy.ts`）**：按工具重写 `OPENAI_BASE_URL`、`ANTHROPIC_BASE_URL`、`GOOGLE_GEMINI_BASE_URL`、`OPENCODE_CONFIG`、`XIO_CONFIG` 或 `codex -c` 内联参数，把请求路由到本地代理，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Google Gemini SSE 流。
2. **子进程监督（`src/gateway/shell-shim.ts`）**：向 `PATH` 前置 `bash`/`sh`/`zsh` shim，把 Agent 内部发起的工具命令统统路由进 `ProcessSupervisor`（`ReaperPlatformDriver`）并配合跨树看门狗。即便子进程通过 `setsid` 脱离、在后台占用标准输出管道，或在宿主被 `SIGKILL` 后变成孤儿 MCP server，命令结束或主进程死亡时也能被干净清理。

在此双边界之上还构建了三项工作流能力：

- **本地 `304` 前缀缓存与 Early Cutoff**：逐轮记录读取的文件集合、符号切片哈希与目录枚举哈希（`computeSymbolSliceCutoffHash`、`computeDiscoverySetCutoff`）。崩溃恢复或只改了注释等非语义区域后，未失效的前缀轮次可直接命中本地缓存返回（`X-Xio-Cache: HIT-304`），只从首个真正失效的轮次起向上游重发。若会话中途有已读文件被修改，代理会在下一条工具结果中自动注入 `[xioflow stale-read notice]`。
- **Shadow Worktree 与测试门禁（`--shadow --gate "<cmd>"`、`xio race`）**：物化隔离的 `git-shadow` worktree，运行测试门禁命令（相同文件树通过 `computeTreeCommandFingerprint` 自动去重），仅在门禁与冲突校验同时通过后，才经由 `commitWorkspaceTransaction` 将变更原子提交回真实工作区。
- **轨迹追踪与步级分叉（`xio trace`、`xio fork --at-step N`）**：在 SQLite 与 OTLP Span 中串联每轮 LLM 请求/响应、`git-shadow` 快照（`SnapshotRef.journalSeq`）与受监督 `opId`。执行 `xio fork <runId> --at-step N -- <agent>` 即可把工作区树恢复到第 `N` 步，并用本地 `304` 缓存瞬时回放前 `1..N-1` 步。

11 个故障注入场景 × 6 个终端宿主（`claude`、`codex`、`gemini`、`opencode`、`qwen`、`xio`）的实测对比与多文件重构恢复基准详见 [`audit/reports/wrap-before-after.md`](./audit/reports/wrap-before-after.md)。

## 从任意 Agent 接入：MCP Server

安装包内置 `xioflow` 命令通过 stdio 提供 OS Medium 的 MCP 服务，使任意 MCP 客户端都能经 `connectWorkspace` 与工作区 Micro-Arbiter 共享同一份账本：

```json
{
  "mcpServers": {
    "xioflow": { "command": "npx", "args": ["-y", "@xioflow/kernel", "mcp", "--workspace", "/path/to/repo"] }
  }
}
```

默认模式（`--surface v2`）通过工作区 UDS Micro-Arbiter 暴露 **4 个黄金原语**（相比零散工具大幅削减 Tool Schema 的 Token 占用）：

- `run`：前/后台执行、就绪等待（`port_open`、`http_ready`、`output_match`、`file_change`）、确定性进程树终止，以及可选的内核写入隔离（`sandbox-exec` / `landlock` / `bubblewrap` / `srt`）。
- `edit`：单/多文件原子写入与补丁替换，内置 `SessionView` 因果防陈旧读写拒绝与可选 `gateCmd` 自动回滚。
- `inspect`：工作区/Git/进程状态总览、陈旧读取告警、基于 1-based 行号与 AST 符号边界的文件/输出块切片、正则搜索及结构化目录查看。
- `branch`：隔离的 `git-shadow` worktree 推测执行（支持 `dry_run` 差异预览或带 OCC 冲突检查的正式提交）。

如宿主依赖 0.7 旧版工具集，可传入 `--surface legacy`（提供 `run_command`、`operation_status`、`cancel_operation`、`snapshot_workspace`、`rollback_workspace`、`begin_transaction`、`commit_transaction`、`abort_transaction`）。

MCP 客户端特性与内核语义直接映射：

- 带 `progressToken` 的请求会持续推送实时进度通知。
- `notifications/cancelled` 会干净地取消或停止进行中的操作。
- 出现 `indeterminate` 时会显式暴露给调用方以便停止并裁决，绝不隐式重试。

默认面向模型的工具 Schema 故意省略了人工裁决接口。`--driver auto`（默认值）会在原生 reaper 可用时自动启用它。

## OpenTelemetry 可观测性

执行日志可直接无依赖导出为 OTLP/HTTP JSON Traces：

- 每个 Run 对应一条 Trace。
- 每个已终结操作对应一个 Span，状态流转、重放、capability 鉴权与人工裁决作为 Span Events 附着其上。
- 每次工作区事务对应一个 Span。
- `indeterminate` 与 `failed` 标记为 `ERROR`。

Trace/Span ID 均采用确定性派生，对同一日志重复导出两次得到的 Span ID 完全一致。

```bash
xioflow mcp --otlp-endpoint http://localhost:4318            # 服务期间每 5 秒增量导出
xioflow otel-export --otlp-endpoint http://localhost:4318     # 一次性只读导出，可与运行中的服务并存
```

代码调用：`exportJournalToOtlp(domain, { endpoint, fromSeq })` 返回下一次增量导出的游标；`journalToOtlpTraces(...)` 仅构造报文而不实际发送。

## 崩溃恢复

宿主重启后重新获取执行域并运行恢复引擎：

```js
import { ExecutionDomain, NodePlatformDriver, RecoveryEngine } from '@xioflow/kernel';

const domain = ExecutionDomain.acquire('/path/to/workspace/.xioflow/kernel', 'my-domain');
const report = await new RecoveryEngine(domain, new NodePlatformDriver()).recover();
```

针对每条未完成操作，恢复引擎都会把持久化记录的进程身份与操作系统现状逐一核对：

| 观测状态 | 恢复动作 | 租约处理 |
| --- | --- | --- |
| 仅持久化意图，从未放行 spawn | 清理并标记为失败 | 释放 |
| 确认进程已死亡，但未观测到退出码 | 记为 `failed`，原因 `terminationReason: 'exit_unobserved'`（结果未知，切勿换新 `opId` 直接重试） | 释放 |
| 进程仍在运行且身份匹配 | 走完整停止管线收尾 | 释放 |
| 无法确认进程身份 | 保持 `indeterminate` | 继续持有，等待人工裁决 |

内核只记录客观执行事实（状态、输出证据、产物引用），绝不替宿主猜结论。比如测试跑挂后又被修好究竟算不算业务成功，是上层发行版的决策而非内核职责。

`indeterminate` 操作离开内核的唯一合规路径是 `domain.adjudicate(opId, verdict, actor, note)`：它先重新扫描残留进程，在仍有存活后代（或扫描本身失败）时拒绝 `confirmed_stopped` 裁决，并在释放租约前将裁决决定落盘写入日志。

## 长驻服务管理

MCP stdio server、开发服务器与 file watcher 会作为长期服务受监督。每次拉起都会生成带编号的内核操作（`<serviceId>#<n>`），宿主崩溃后恢复引擎仍可追踪并处理它们：

```js
const service = await supervisor.startService({
  serviceId: 'mcp-fs',
  runId: 'run-1',
  command: { execPath: 'node', args: ['server.mjs'], cwd: '/path/to/workspace' },
  readiness: { stdoutLine: /listening/, timeoutMs: 5000 }, // 或 'spawned'
  restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 500 },
  requiredResources: ['port:3000'],
});
await service.ready;          // 未等到就绪行则 reject 并停掉该实例
service.stdin.write('...');   // stdin 保持流式开启（stdinMode: 'stream'）；stdout 透传
await service.stop(2000);
```

服务在重启退避期间依然持有其资源租约。若某次停止无法由驱动确认，该实例会被记为 `indeterminate`、写入 `SERVICE_FAILED { reason: 'stop_unconfirmed' }` 并继续持有租约。宿主崩溃后，`recover()` 会终止仍存活的服务实例，且绝不在恢复期自动拉起它们。结合 MCP SDK 构建自定义 `Transport` 的示例见 [`examples/mcp-stdio-transport`](./examples/mcp-stdio-transport)。

## 快照、回滚与分叉

git-shadow 驱动在不污染用户 Git index、`HEAD` 与当前分支的前提下对声明目录拍快照。普通兼容 ID 锚定在 `refs/xioflow/snapshots/<id>`，其他不透明 ID（包括 ISA `op:...`）使用 `refs/xioflow/encoded-snapshots/<hash>`，对外暴露的快照 ID 保持不变：

```js
const snap = await supervisor.captureSnapshot({ runId: 'run-1', opId: 'snap-1', roots: ['/path/to/workspace/src'] });

// ... Agent 修改文件 ...

const rb = await supervisor.rollback({ runId: 'run-1', opId: 'rb-1', snapshotId: snap.snapshot.id });
console.log(rb.status, rb.coverage, rb.outOfScopeEffects); // 例如 'restored', 'declared_roots', 'possible'

// 将快照物化到独立 worktree，供并行候选方案使用：
await supervisor.materialize(snap.snapshot.id, '/tmp/candidate-a');
await supervisor.dematerialize('/tmp/candidate-a');
```

回滚只改写或删除快照声明根目录内的文件；除非快照时指定了 `includeIgnored: true`，否则不触动 `.gitignore` 等忽略文件。回滚结束后会以快照树指纹核验一致性，并通过 `coverage` 诚实汇报可信边界：

| `coverage` | 含义 |
|---|---|
| `complete` | 快照以来的每一次操作都在隔离驱动下运行，且根目录下的忽略文件也已被完整恢复（`includeIgnored: true`）或被清单证明完全未变。 |
| `non_ignored` | 所有操作都在隔离下运行，根外未曾改动；但忽略文件（`.env`、`node_modules`、构建产物）未进入快照且无证据证明未变。 |
| `declared_roots` | 声明根已恢复，但期间存在未隔离操作可能写了根外文件（`outOfScopeEffects: 'possible'`），或存在部分路径未能恢复（`status: 'partial'`）。 |
| `none` | 校验失败（`status: 'failed'`）。 |

`ignoredFiles`（`restored` / `unchanged_verified` / `not_captured` / `unverified`）标明内核对忽略文件的掌握程度，`coverageBasis` 则列出支撑结论的客观依据（例如 `['all_ops_confined', 'ignored_not_captured']`）。

不拷贝忽略文件的默认快照同样可以达到 `complete`：`captureSnapshot({ ..., trackIgnored: 'manifest' })` 会记录每个忽略文件的大小、mtime、ctime 与权限位（M 系列 Mac 上 2 万文件约 0.2 秒，10 万文件约 0.45 秒）。回滚时重新比对清单：新增、删除或内容变动的忽略文件会降为 `non_ignored` 并列于 `ignoredChanges`；哪怕只有 `ctime` 变化也会列进 `metadataOnly` 并阻止声称 `complete`（因为内核无法证明内容绝对未变）。

使用 `includeIgnored: true` 时，快照后新出现的忽略文件默认保留，并以 `status: 'partial'` 列在 `unrestoredPaths` 中（全新目录合记为一项）；如需一并清理新出现的忽略文件，在 `rollback` 时传 `removeNewIgnored: true`。

要使 `complete` 真正可达，需为操作绑定 capability 并开启隔离执行：

```js
const cap = domain.issueCapability(
  { write: ['/path/to/workspace/src'], exclusive: ['workspace:write:/path/to/workspace/src'] },
  'my-agent-policy',
  10 * 60_000,
);
await supervisor.executeProcess({
  runId: 'run-1',
  opId: 'op-edit',
  name: 'codegen',
  command: { execPath: 'node', args: ['../codegen.mjs'], cwd: '/path/to/workspace/src' },
  // mutation roots 默认为 cwd；如需覆盖其他路径请显式传 mutationRoots
  capabilityId: cap.id,  // 越界资源或路径会在准入阶段直接被拒
  confinement: true,     // 依据可用性自动选择 sandbox-exec / landlock / bubblewrap / srt
});
```

capability 可通过 `domain.attenuate` 进一步缩窄权限，或用 `domain.revokeCapability` 吊销。需要说明的是，此处写入隔离是为了保证回滚覆盖度声明的真实性，本身并非完整安全沙箱边界。

## 并行 Agent：工作区事务

粗粒度锁会让并行 Agent 互相排队；工作区事务借鉴数据库乐观并发控制（OCC），让多个 Agent 在各自 fork 中并发工作，只在提交阶段统一校验冲突：

```js
const tx = await supervisor.beginWorkspaceTransaction({
  txId: 'agent-a-1',
  runId: 'run-a',
  root: '/path/to/repo',
  forkPath: '/tmp/forks/agent-a-1',
});
// Agent 在各自隔离的 fork 目录内作业
await supervisor.executeProcess({ runId: 'run-a', opId: 'a-edit', name: 'edit', command: { execPath: 'node', args: ['edit.mjs'], cwd: tx.forkRoot } });

const res = await supervisor.commitWorkspaceTransaction('agent-a-1');
if (res.status === 'conflict') {
  // 例如 [{ path: 'config.json', kind: 'read_write', otherTxId: 'agent-b-7' }]
  await supervisor.abortWorkspaceTransaction('agent-a-1');
}
```

- **写集合（Write set）**：基础快照与 fork 之间精确的文件级 diff。
- **读集合（Read set）**：无需特权，直接通过访问时间戳（`atime`）观测。fork 内每个条目在启动前先把 `atime` 置早于 `mtime`；文件读取或目录列举会使 `atime >= mtime`（包括同一 Linux 时钟 tick 内的相等情形；重置逻辑亦适配仅在 `atime < mtime` 时更新时间戳的 macOS APFS）。通过真实读探针检验文件系统行为；在 `noatime` 挂载卷上会如实记为 `readTracking: 'unobserved'`、`readSet: null`。
- **冲突校验**：与事务开启后已提交写入同文件冲突时判为 `write_write`；若他人改动了自己读过的文件则判为 `read_write`；曾经列举过的目录仅在增删条目时冲突；绕过事务直接改写工作区文件会触发 `external_write`。
- **事务落盘**：仅通过校验的事务才会应用回主工作区，且应用前先写入 `TX_COMMITTING` 日志；即便提交通途中途崩溃，重启后再次调用仍可幂等收尾。
- **提交证据**：已提交结果明确记录依据的等级：`validation: 'files'`（完整读写集）、`'write_only'`（无法观测读集）或 `'observations'`（见下节）。
- **路径依赖（`pathDependencies`）**：fork 中见过的符号链接会与普通文件读取分开记录；符号链接变化哪怕目标文件没改也按保守冲突处理。若值为 `null`（如旧版事务记录），表示缺少该证据而非不存在路径依赖。

### 减少误判冲突：重放校验 Agent 实际所见

「读过某个文件」往往比 Agent 真正依赖的范围更粗：它常常只依赖文件里的几行或某次搜索的筛选结果。别人改了同一文件的无关段落，文件级校验仍会报 `read_write`。若宿主记录了 Agent 的交互观测日志，可在提交时一并交由内核验证：

```js
const res = await supervisor.commitWorkspaceTransaction('agent-a-1', {
  observations: {
    // 按时间顺序记录：读取/搜索为 { kind: 'observe', call, resultHash, cutoffHash? }，
    //               编辑为 { kind: 'mutate', call }（若编辑返回值也向 Agent 展示了新内容则同带 resultHash）
    log,
    closedWorld: true, // 该日志囊括 Agent 对 fork 的全部观测视野
    // 在新根 `root` 重跑单步操作并返回结果哈希（或 { resultHash, cutoffHash }）；若变更无法应用则抛错
    replay: async (entry, root) => myTools.run(entry.call, root),
    // 可选 Early Cutoff 判定：原始字节 resultHash 不同但语义投影仍一致时放行
    canCutoff: (entry, replayed) => Boolean(entry.cutoffHash && entry.cutoffHash === replayed.cutoffHash),
  },
});
// 提交成功：当确实依靠观测日志消解冲突时，res.validation === 'observations'
// 仍冲突：  res.observation 指明重放第一次出现分歧的步骤，或未能尝试重放的原因
```

内核仅在文件级校验报冲突后才启动观测重放：它会基于当前最新工作区再 fork 一份临时副本，按序请宿主重放每一步；只要每次观测都返回相同哈希（或通过 `cutoffHash` / `canCutoff` 满足 Early Cutoff，如 `computeSymbolSliceCutoffHash` 忽略注释与行号漂移的符号切片哈希、`computeDiscoverySetCutoff` 面向增量目录发现的切片哈希）且每次变更仍可应用，即从该临时 fork 提交成功。若重放期间外部工作区又发生变化则直接放弃应用（`observation.reason: 'workspace_changed'`）。双边同时写过同一文件时不会尝试重放；若 fork 内曾直接跑过外部进程，也不再轻信 `closedWorld`（触发 `TX_VALIDATION_DOWNGRADED`），因为任意进程可能读到日志未记录的文件。观测日志是否完整、哈希是否可复现由宿主负责；与文件级校验一样，这套机制证明的是「Agent 赖以决策的输入未变」，而非直接保证合并后代码语义绝对无误。

### 跨 fork 验证命令去重：`executeWorkspaceCommand`

当多个并发 Agent 在各自工作区 fork 中对字节完全一致的文件树运行同一只读校验命令（`tsc --noEmit`、`pytest`、`eslint`）时，直接调用 `executeProcess` 通常会因 `cwd` 不同（`fork-a` 与 `fork-b`）而被当成两次独立执行。`executeWorkspaceCommand` 将 `opId` 与 `inputFingerprint` 锚定到工作区树内容哈希（`computeTreeCommandFingerprint`）而非目录路径，从而让同树并发分支自动并入同一个正在运行的进程（`reused: 'joined_in_flight'`），后续分支则直接复用已记录终态结果（`reused: 'replayed_recorded'`）：

```js
const verify = await supervisor.executeWorkspaceCommand({
  runId: 'run-a',
  workspaceRoot: tx.forkRoot,
  name: 'typecheck',
  command: { execPath: 'npx', args: ['tsc', '--noEmit'] },
});
// verify.reused: 'executed' | 'joined_in_flight' | 'replayed_recorded'
```

## 带依赖的验证证据：这条测试通过结果还成立吗？

「测试通过」这个断言绑定着当次测试真正依赖的文件状态。想安全复用历史验证结果，宿主必须知道那些文件此刻是否依然未变。`trackReads` 记录命令实际读取集合，`evidenceStatus` 随后给出新鲜度结论：

```js
const res = await supervisor.executeProcess({
  runId, opId: 'verify-1', name: 'pytest',
  command: { execPath: 'pytest', args: ['-q'], cwd: repo },
  trackReads: { roots: [repo] },
});
// ...Agent 继续改动其他文件...
supervisor.evidenceStatus('verify-1');
// { status: 'fresh', basis: 'tree_unchanged' }        根目录下无任何文件发生变化
// { status: 'stale', changed: ['/repo/fixtures/case3.json'], truncated: false }
// { status: 'unknown', reason: 'changed_outside_read_set', changedOutside: ['/repo/src/util.py'], truncated: false }
```

- **记录内容**：根目录下每个被命令实际读取过内容的文件（记录内容哈希）与每个被列举过的目录（记录子项名哈希），沿用与工作区事务相同的 `atime` 机制；同时记录命令结束时根目录下全部文件的大小与 mtime。无需任何语言插桩，适用于任何命令，也能捕捉传统 import-graph 看不到的测试 fixture、JSON、模板等非代码依赖。
- **`stale`**：列出内容发生变化的已读文件，以及条目发生增删的已列举目录。
- **`fresh`**：仅对应以下两种情形之一并标明依据：`tree_unchanged`（根目录下完全无变更）或 `reads_unchanged`（仅读集合之外的文件发生变化，且调用方已声明 `trackReads: { roots, statCaches: 'ruled_out' }`）。
- **`unknown`**：当读集合外文件发生改动且未排除基于 `stat` 校验的缓存时返回该状态（默认值）。这一点非常关键：命中有 `stat` 缓存的工具只会 `stat` 源文件而根本不会打开读取它，因而该源文件不会出现在读集合中。Python 字节码缓存（`.pyc`）就是最典型的例子——实测在默认 `.pyc` 缓存存在时，仅靠读集合选择几乎漏掉所有源码修改；而把缓存指到空临时目录（`PYTHONPYCACHEPREFIX`）后便可百分之百命中。只有调用方确认命令不会受此类缓存欺骗时，才应声明 `ruled_out`。
- **覆盖边界**：不包括根外依赖、环境变量、长驻辅助进程代读的文件，以及命令执行中途他人并发写入的变化。在 `noatime` 文件系统或同根同时存在多个受追踪命令时同样无法得到读集合（记为 `unobserved`），但仍可诚实回答 `fresh / tree_unchanged`，其余情况返回 `unknown`。
- **性能开销**：命令前后各遍历一次根目录并对已读文件做哈希，建议为大仓库传入较窄的 `roots`。重置 `atime` 会顺带更新自上次重置以来曾被读取文件的 `ctime`，若同时开启忽略文件清单（`trackIgnored: 'manifest'`）会被计入 metadata-only 变化。

## 设计与测试说明

### 用同一套契约套件验证你自己的运行时

本包直接对外导出了内核自身所测的全部共享契约测试套件（含产物归属与多监督入口协同语义），供集成方直接验证自己的嵌入运行时：

```js
import { defineContractTestSuite } from '@xioflow/kernel/testing';

defineContractTestSuite('My Agent Runtime', async () => ({
  domain,
  driver,
  supervisor,
  tempDir,
  workflowType: 'memory', // 或 'headless' | 'three_piece'
  cleanup: async () => domain.close(),
}));
```

这套套件与测试框架解耦：在 Vitest 下自动解析全局测试 API；若集成方未装任何测试框架，也能直接通过零依赖的纯 Node 运行器（`@xioflow/kernel/testing/plain`）运行并输出机器可读 JSON 报告。两种运行方式及合规等级（`core` / `workspace` / `experimental`）详见[一致性入口文档](spec/conformance.md)。

仓库自身验证方面，`pnpm test` 会先运行 `tests/` 下的 Vitest 套件，再接着运行 7 个显式本地 `node:test` 研究型测试套件。传入诸如 `--maxWorkers=2` 的参数只作用于 Vitest 阶段；任一阶段失败总退出码即非零。这批原生套件全部采用本地 fixture、依赖 `jq`，且绝不调用付费模型 API。`pnpm conformance:report` 会追加版本、平台、驱动与构建证据，严格区分目录清单、当前可运行项、已归档/规划项与当前平台不支持项，绝不会把不支持的硬限制算作通过，详见[测试编排记录](audit/reports/test-orchestration-2026-11-03.md)。

除契约测试外，仓库还会在每个持久化临界点（存库前后及进程运行中）强杀监督器，在全新进程中恢复并复核不变量（`tests/fault/crash-matrix.test.ts`），同时用 TLA+ 模型检验启动、停止、崩溃与恢复全交错空间下的状态不变量（`spec/tla/`、`pnpm check:tla`）。

- 持久化层采用 SQLite WAL + `synchronous = FULL`，确保已提交事实耐掉电。
- 一个执行域即一份工作区账本加上单一活跃所有者；在放行任何新操作前优先从库中重建隔离态。
- 当根进程退出而仍有后代持有其管道时，监督器会继续执行进程组停止管线并如实上报根进程退出信息与兼容干预标记 `residualProcessesReaped`。被观测到的僵尸进程仍保留在 `unreapedPids` 中，该标记并不承诺父进程已 `waitpid` 回收全部 PID。
- spawn 失败既给出 `status: 'failed'` / `exitCode: 127`，也通过 `spawnFailure` 附上原始系统错误信息，方便宿主区分「根本没启动起来」与「子进程自己返回了 127」。
- `onStreamChunk(stream, chunk)` 在进程运行期间持续回调原始 stdout/stderr 切片，便于宿主做实时终端渲染；回调内部抛出异常不会打断流排空，首次异常记录于 `streamCallbackError`。
- 硬资源请求（`enforcement: 'hard'` 下的 `maxMemoryBytes`、`maxPids`、`maxCpuTimeMs`）在不支持的平台上会在准入阶段直接抛出 `UnsupportedCapabilityError`，绝不静默降级；其余能力标识如实上报供调用方查看，暂不做准入拦截。
- 协议规范：[`ARCHITECTURE.md`](./ARCHITECTURE.md)（中文规范，权威文本）与 [`ARCHITECTURE.en.md`](./ARCHITECTURE.en.md)（英文完整镜像）描述目标设计；分阶段规划与规范-实现差距表见 [`ROADMAP.md`](./ROADMAP.md)。

## 深入阅读

走完 5 分钟路径后建议按以下顺序深入：

1. [当前实现契约](spec/current-contract.md) — **集成选型必读**：列明当下已保证边界、实验特性与崩溃恢复前提。
2. [一致性入口](spec/conformance.md) — 无需 Vitest 在你自己的运行时上跑通契约套件，了解合规分层。
3. [ARCHITECTURE.md](./ARCHITECTURE.md) / [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) — 完整协议规范：域模型、Run/Operation 生命周期、驱动、停止管线、事务、ABI 及 67 条编号契约。
4. [ROADMAP.md](./ROADMAP.md) — 阶段规划、关键决策记录、实现进度表、废弃方向（附录 A）与 1.0 ABI 冻结判据。
5. [`spec/`](./spec/) — 实验性运行时契约与当前契约附录。
6. [`audit/`](./audit/README.md) — 故障注入评测台：如何审计执行层（[`harness-execution-audit.md`](audit/reports/harness-execution-audit.md)）、原生执行 vs `xio wrap` 对比（[`wrap-before-after.md`](audit/reports/wrap-before-after.md)）以及[恢复对比报告](audit/reports/recovery-comparison.md)（E4–E10 确定性测试与带标注真实模型试点）。

## 当前状态

0.8.0 pre-1.0（已包含 `connectWorkspace` UDS Micro-Arbiter、6 个正交 `OsMedium` 系统调用、`@xioflow/kernel/surface` 的 4 个黄金 LLM 原语、`SessionView` 因果防陈旧读写与 AST Early Cutoff 保护、`exec` 跨平台内核写入隔离、`xio doctor` / `xio prune` / `xio status`、`xio wrap` CLI 网关与本地 HTTP-304 前缀缓存、`--shadow --gate` worktree 隔离与 `xio race` 多 Agent 协调、`xio trace` / `xio fork --at-step N`、Linux cgroup v2 硬内存/进程数驱动、原生进程树守护 reaper、基于读集或重放观测日志的工作区事务、带依赖的验证证据状态、考虑忽略文件的诚实回滚覆盖度、MCP Server、OpenTelemetry 导出、崩溃点矩阵以及 TLA+ 模型；变更详见 [`CHANGELOG.md`](./CHANGELOG.md)）。在满足 [ABI v1 冻结判据](./ROADMAP.md#11-abi-v10-冻结判据) 前 API 保持 pre-1.0。距离 1.0 的剩余差距包括硬 CPU 上限、执行域级全局内存预算控制、Schema 迁移（契约 #27）、Windows 原生支持（不在 v1 范围内）与自动存储 GC 触发机制；详见 [`ROADMAP.md`](./ROADMAP.md)。

## 发布流程

发布由 Git Tag 触发。打 Tag 总是创建 GitHub Release；npm 上传开关独立控制，从而确保发布包永远与仓库某次提交严格可追溯：

1. 更新 `package.json` 中的 `version`，提交并 push 到 `main`。
2. 推送匹配的版本 Tag，例如 `git tag v0.3.0 && git push origin v0.3.0`。
3. `.github/workflows/release.yml` 会复跑 typecheck、测试与打包冒烟检查，拒绝与 `package.json` 版本不匹配的 Tag，并创建携带 `.tgz` 产物、`SHA256SUMS` 和构建溯源证明（Build Provenance Attestation）的 GitHub Release；**仅当**仓库变量 `NPM_TRUSTED_PUBLISHING_ENABLED` 为 `true` 时，才会执行 `npm publish --provenance` 并验证证明。

首次配置按此顺序完成：(1) 登录 npmjs.com → Package Settings → Trusted Publisher → GitHub Actions，填入组织 `Xio-Shark`、仓库 `xioflow`、workflow 文件名 `release.yml`、environment 留空；(2) 在仓库设置变量 `NPM_TRUSTED_PUBLISHING_ENABLED=true`。两步未完成前发布 job 会跳过并在 `verify` job 日志中给出原因。npm registry 索引可能比上传延迟数分钟，因此校验步骤会自动轮询，必要时可重跑该 job。

如需为已有 Tag 补传 Release 资产而不触发 npm 发布，可手动运行工作流：`gh workflow run release.yml -f tag=v0.3.0`。已附加同名资产若哈希一致会保留，若不一致则失败报错；已发布资产绝不覆盖。

### 校验发布产物

```bash
gh release download v0.3.0 --repo Xio-Shark/xioflow
shasum -a 256 -c SHA256SUMS
gh attestation verify xioflow-kernel-0.3.0.tgz --repo Xio-Shark/xioflow
npm audit signatures   # 在已安装 npm 版 @xioflow/kernel 的项目中运行
```

## 开源协议

MIT
