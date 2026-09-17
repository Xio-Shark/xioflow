# xioflow

> **AI Agent 工作流与 DAG 任务编排引擎**  
> Streamlined AI Agent Workflow & DAG Task Orchestration Engine for Claude Code, Cursor, OpenCode, Codex, Devin, and DSH.

[中文文档](./README_CN.md) | English

---

## 💡 为什么需要 xioflow？

使用 AI 编程助手（如 Claude Code、Cursor、Codex 等）进行中大型复杂项目开发时，开发者普遍面临四个系统性痛点：

1. **上下文漂移 (Context Drift)**：对话轮次一多，模型自动遗忘最初的架构边界与业务约束。
2. **线状盲目执行 (No DAG Scheduling)**：多个相互依赖或并行的模块开发缺乏依赖编排，容易产生互相覆盖和死锁。
3. **跨会话失忆 (Session Amnesia)**：新会话开启后，AI 无法快速召回历史决策上下文与调试经验。
4. **规约与代码脱节 (Spec Desync)**：开发规范写在静态文档里没人看，AI 实现随意发挥。

**xioflow** 将项目级规约、DAG 任务编排与跨会话记忆转化为**工程化基础设施**，通过自动化 Hook、上下文注入与任务状态机，让 AI Agent 在明确的工程轨道上高效运转。

---

## ⚡️ 核心特性

- 🌳 **DAG 任务与波次编排 (DAG Task Orchestration)**
  - 声明式依赖图谱：支持 `depends_on` 跨任务依赖校验与拓扑就绪判定。
  - 环境隔离与并发：提供 `worktree`（独立工作树）与 `shared` 隔离模式，保障多任务安全并行。
  - 严格三阶段生命周期：`Plan (规划) -> Execute (实施) -> Finish (收尾与沉淀)`。

- 📐 **架构规约动态注入 (Spec-Driven Architecture)**
  - 模块化规约体系：按包（Package）和层级（Layer）分级组织规范与检查清单。
  - 按需注入：AI 开工前自动加载对应层级的规约要求，告别凭空猜测与防御性坏味道。

- 🧠 **持久化记忆与决策回溯 (Persistent Memory & Session Journaling)**
  - 开发者独立工作区：按成员自动维护会话日志（Journal）与索引。
  - 跨平台记忆检索：内置 `xioflow mem` 指令，可全文检索与语义提取历史会话决策。

- 🤝 **多 Agent 协作运行时 (Multi-Agent Channel Runtime)**
  - 内置基于共享事件日志的轻量 Channel 运行时，支持 Worker 派生（Spawn）、等待（Wait）、中断（Interrupt）与协同。

- 🔌 **主流宿主全覆盖 (Multi-Platform Native Integration)**
  - 深度支持 **Claude Code**、**Cursor**、**OpenCode**、**Codex**、**Devin**、**DSH**，自动生成原生适配的 Commands、Skills、Hooks 与 Rules。

---

## 📦 架构概览

```text
your-repo/
├── .xioflow/               # 项目核心工作流根目录
│   ├── config.yaml         # 项目级工作流配置
│   ├── spec/               # 领域与架构规范（按 Package/Layer 划分）
│   ├── tasks/              # 活跃任务集合与 DAG 节点
│   │   └── MM-DD-task-name/
│   │       ├── task.json   # 任务状态、依赖(depends_on)、隔离配置
│   │       ├── prd.md      # 需求与验收标准 (Acceptance Criteria)
│   │       ├── design.md   # 技术架构设计与数据流 (复杂任务)
│   │       └── implement.md# 执行计划与验证步骤
│   ├── workspace/          # 开发者私有会话日志与索引
│   └── scripts/            # 状态流转与自动化辅助工具
└── packages/               # 业务代码目录
```

---

## 🚀 快速上手

### 1. 全局安装 CLI

```bash
# 全局安装 xioflow CLI (提供 xioflow 与 xf 双入口)
npm install -g xioflow

# 或通过 pnpm 本地构建安装
pnpm install && pnpm build
```

### 2. 在项目中初始化

进入目标项目根目录执行初始化：

```bash
# 交互式初始化（自动检测已有 AI 平台工具）
xioflow init -u <your-name>

# 显式指定宿主平台
xioflow init --claude --cursor -u <your-name>
```

### 3. 任务生命周期管理

xioflow 通过标准的任务状态机引导 Agent 开发：

```bash
# 1. 创建任务节点（自动生成 MM-DD 前缀）
python3 .xioflow/scripts/task.py create "User Auth Module" --slug auth-module

# 2. 检查当前活跃任务
python3 .xioflow/scripts/task.py current

# 3. 规划完成，启动任务（进入 in_progress 状态）
python3 .xioflow/scripts/task.py start auth-module

# 4. 实施完成，归档任务并沉淀知识
python3 .xioflow/scripts/task.py archive auth-module
```

### 4. 依赖编排与 DAG 定义

在任务的 `task.json` 中声明依赖项：

```json
{
  "id": "payment-api",
  "status": "planning",
  "depends_on": ["09-17-auth-module"],
  "isolation": "worktree",
  "priority": "P1"
}
```

在 `prd.md` 中同步记录：

```markdown
## Dependencies
- depends_on: `09-17-auth-module`
- isolation: `worktree`
```

---

## 🛠 开发与构建

```bash
# 安装依赖
pnpm install

# 构建全量模块 (@xioflow/core + xioflow CLI)
pnpm build

# 运行自动化测试套件
pnpm test

# 静态类型检查
pnpm typecheck
```

---

## 📄 License

AGPL-3.0
