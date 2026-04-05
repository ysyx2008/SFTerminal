# Agent 子系统 SPEC

> Last verified: 2026-03-09

## 职责

AI Agent 的核心执行引擎。接收用户自然语言指令，通过 ReAct 循环（思考→工具调用→观察）自主完成任务。支持本地终端、SSH 远程、无终端助手三种模式。

## 架构概览

```
AgentService (index.ts)          — 工厂 + 生命周期管理，按 agentId 复用实例
  └── SailFish (sailfish.ts)     — Agent 实现（工具列表、系统提示）
        └── Agent (agent.ts)     — 抽象基类（执行循环、会话追踪、持久化）
              ├── PromptBuilder  — 系统提示构建
              ├── TaskMemoryStore — L1 任务记忆（工作记忆）
              ├── ContextBuilder — 分层压缩上下文（L0-L4 渐进式降级）
              ├── RiskAssessor   — 命令风险评估
              ├── ToolExecutor   — 工具执行（tools/ 目录）
              └── SkillSession   — 技能动态加载
```

## 关键类

### AgentService (`index.ts`)

工厂和生命周期管理器。Agent 实例按 `agentId` 存储在 `Map<string, SailFish>` 中。

- 终端 Agent：`agentId = ptyId`，通过 `getOrCreateAgent(ptyId)` 创建
- 助手 Agent：通过 `createAssistantAgent(agentId)` 创建，无终端绑定
- 固定实例：`__companion__`（IM/桌面助手）、`__watch__`（关切系统）

### Agent (`agent.ts`) — 抽象基类

核心执行逻辑，~2400 行。子类实现 3 个抽象方法：
- `getAvailableTools()` — 返回工具列表
- `buildSystemPrompt()` — 构建系统提示
- `getAgentId()` — 返回标识

**执行流程**：`run()` → `initializeRun()` → `buildContext()` → `executeLoop()` → `finalizeRun()`

### SailFish (`sailfish.ts`) — Agent 实现

继承 Agent，实现具体行为。绑定终端时自动加载 `terminal` 技能，诞生引导时自动加载 `personality` 技能。

## 执行流程

```
run(message, context, options)
  │
  ├── initializeRun()        创建 AgentRun，初始化会话追踪
  │     ├── 从 HistoryService 恢复 TaskMemory（跨会话）
  │     ├── 添加 user_task 步骤
  │     └── 设置终端输出监听器
  │
  ├── buildContext()          构建执行上下文
  │     ├── 加载知识库上下文（L2 知识文档 + 向量检索）
  │     ├── 构建任务历史（L1 TaskMemory → ContextBuilder 分层压缩）
  │     ├── L3 auto-recall（语义检索历史对话）
  │     ├── 加载关切列表、羁绊上下文
  │     └── 调用 buildSystemPrompt() 组装系统提示
  │
  ├── executeLoop()           主执行循环
  │     └── while (running && !aborted)
  │           ├── processPendingUserMessages()
  │           ├── executeStep()
  │           │     ├── updateContextPressure() — 注入上下文状态
  │           │     ├── StreamingToolExecutor   — 创建流式工具执行器
  │           │     ├── callAiWithStreaming()   — 调用 AI API（流式中提前执行就绪的只读工具）
  │           │     ├── 处理 finish_reason=length（截断重试）
  │           │     ├── 风险评估 + 用户确认
  │           │     └── executeToolCallsWithStreaming() — 收集预执行结果 + 执行剩余工具
  │           ├── saveCheckpoint()  — 每轮工具调用后增量写盘
  │           └── checkPlanProgress()
  │
  └── finalizeRun()           完成运行
        ├── 保存任务到 TaskMemory
        ├── 保存会话到 HistoryService
        ├── L2: 异步更新知识文档
        └── L3: 异步索引对话到向量库
```

## 会话与持久化

- **会话追踪**：`_sessionId`、`_sessionSteps`、`_sessionMessages` 跨多次 `run` 累积
- **增量检查点**：每完成一轮工具调用自动写盘（`saveCheckpoint`）
- **跨会话恢复**：通过 `sessionId` 从 HistoryService 加载，`restoreFromHistory()` 重建 TaskMemory
- **生命周期**：`cleanupAgent()` 销毁实例，`resetSession()` 重置会话但保留实例

## 工具系统

### 内置工具 (`tools.ts`)

通过 `getAgentTools(mode, remoteChannel)` 按模式过滤。见 `tools.ts` 中的完整定义。

### 工具执行 (`tools/`)

| 文件 | 职责 |
|---|---|
| `index.ts` | `executeTool()` 主入口，switch 分发 |
| `command.ts` | 终端命令执行 |
| `exec.ts` | 直接命令执行（无终端） |
| `terminal.ts` | 终端状态查询、控制键 |
| `file.ts` | 文件读写、搜索 |
| `knowledge.ts` | 知识库操作 |
| `plan.ts` | 执行计划/待办 |
| `memory.ts` | 任务记忆检索 |
| `context.ts` | 上下文压缩/恢复 |
| `misc.ts` | 等待、提问、MCP、技能 |
| `sub-agent.ts` | 并行子 Agent（dispatch_agents 工具） |

### 并行子 Agent (`tools/sub-agent.ts`)

主 Agent 通过 `dispatch_agents` 工具分派轻量子任务并行执行。

**Fork 模式**（参考 Claude Code）：子 Agent 继承父 Agent 的完整上下文（system prompt + 消息历史 + 工具列表），最大化 Anthropic/DeepSeek 前缀缓存命中。父 Agent 尚未完成的 tool_result 用固定占位符替代，子任务指令作为追加的 user 消息。所有子 Agent 共享同一消息前缀（byte-exact 一致），仅追加部分因任务而异。当父上下文不可用时自动 fallback 到独立模式。

**Agent 类型系统**：每个子 Agent 按类型分配**执行时工具白名单**和系统提示：

| 类型 | 用途 | 可执行工具 |
|---|---|---|
| `explore`（默认） | 只读分析 | read_file, file_search, exec, search_knowledge, get_knowledge_doc |
| `edit` | 文件修改 | explore + edit_file, write_text_file |
| `research` | 知识检索归纳 | read_file, file_search, exec, search_knowledge, get_knowledge_doc |

类型通过 `SubAgentType` 接口定义，注册在 `SUB_AGENT_TYPES` 注册表中。Fork 模式下 API 请求使用父 Agent 的完整工具列表（缓存优化），执行时按类型白名单过滤（不在白名单内的调用会被拦截并返回错误提示）。

**执行模式**：
- **同步**（默认）：`dispatchSubAgents` 阻塞等待全部完成
- **异步**（`background: true`）：立即返回，后台执行，完成后通过 `injectPendingMessage` 注入结果

**安全约束**：
- 子 Agent 继承父 Agent 的 `executionMode`，不可递归 `dispatch_agents`
- 工具白名单保障安全（无终端操作等高危工具）
- **确认策略**：子 Agent 不弹确认框（避免阻塞并行执行）。moderate 级操作自动放行，dangerous 级操作自动拒绝并返回错误，子 Agent 可换策略重试或报告给主 Agent 处理

### 流式工具并行执行 (`streaming-tool-executor.ts`)

在 AI 模型流式输出过程中，一旦某个 tool_call 的参数完整（可解析为 JSON），`StreamingToolExecutor` 立即开始执行该工具，无需等待整个 assistant 消息输出完毕。

**并发策略**（与 `PARALLELIZABLE_TOOLS` 一致）：
- 只读工具（read_file、file_search、search_knowledge 等）可并行执行
- 有副作用的工具（execute_command、edit_file 等）独占执行，等前面的全部完成

**流程**：`executeStep` 创建 `StreamingToolExecutor` → 传入 `callAiWithStreaming` → AI 流式输出中 `onToolCallReady` 回调触发 `addTool()` → 流结束后 `executeToolCallsWithStreaming` 收集预执行结果 + 执行剩余工具

**安全约束**：重试（onRetry）和截断（finish_reason=length）时会 abort 执行器；幻觉工具在执行器内部检测并拒绝；结果按原始 tool_calls 顺序写入消息历史。

### 技能系统 (`skills/`)

动态加载的工具集合，通过 `skill` 工具触发。技能会话在 Agent 实例级别持久化。

| 技能 ID | 用途 |
|---|---|
| terminal | 终端交互（绑定终端时自动加载） |
| personality | 人格定制（诞生引导时自动加载） |
| excel | Excel 文件操作 |
| word | Word 文档操作 |
| pdf | PDF 解析 |
| email | 邮件收发（OAuth） |
| calendar | 日历管理 |
| browser | 浏览器操作 |
| feishu | 飞书集成（OAuth） |
| watch | 关切管理 |
| config | Agent 配置 |
| skill-manager | 用户技能管理与市场 |

注册入口：`skills/index.ts`，技能定义接口见 `skills/types.ts` 中的 `Skill`。

## 风险评估

`risk-assessor.ts` 对命令进行分级：

- **safe**：只读命令（ls, cat, pwd...）
- **moderate**：有副作用但可恢复（mkdir, cp, apt install...）
- **dangerous**：不可逆操作（rm -rf, dd, 格式化...）
- **blocked**：交互式编辑器（vim, nano...），有更好的工具替代

处理策略：`allow` / `auto_fix`（如自动加 -y）/ `timed_execution` / `fire_and_forget` / `block`

## 执行模式

- **strict**：所有工具调用需用户确认
- **relaxed**：仅 dangerous 级别需确认
- **free**：全自动，不确认

## 三级记忆

- **L1 TaskMemory**：当前会话的任务记忆，5 级渐进式压缩（见 `context-builder.ts`）
- **L2 知识文档**：按 contextId 组织的持久化知识，每次对话自动注入 system prompt
- **L3 对话记录**：完整历史，通过向量搜索按需检索

## 依赖

见 `types.ts` 中的 `AgentServices` 接口：

- **AiService**：AI API 调用（必需）
- **PtyService**：本地终端（必需）
- **SshService / SftpService**：SSH 远程（可选）
- **UnifiedTerminalService**：统一终端抽象（运行时构建）
- **HostProfileService**：主机画像（可选）
- **McpService**：MCP 工具（可选）
- **ConfigService**：配置管理（可选）
- **HistoryService**：历史记录（可选，延迟注入）

## 关键约束

1. **Steps 只能 append**：`addStep()` 是唯一添加步骤的入口，不能修改或删除已有步骤
2. **taskMessageLog 是 append-only**：与可压缩的 `run.messages` 分离，确保持久化完整性
3. **后端是唯一数据源**：steps 和 messages 由后端生成和管理，前端只渲染
4. **单实例单任务**：`run()` 开始时检查 `isRunning`，不允许并发
5. **技能会话跨 Run**：SkillSession 在 Agent 实例级别持久化，不随单次 Run 结束销毁
6. **唤醒 run 静默**：`context.wakeup = true` 时跳过知识文档更新和对话索引

## 其他组件

- **Orchestrator** (`orchestrator.ts`)：多 Agent 协调器（智能巡检），Master-Worker 模式
- **ProactiveStore** (`proactive-store.ts`)：主动消息上下文存储（IM → Agent）
- **i18n** (`i18n.ts`)：Agent 国际化（中/英）
