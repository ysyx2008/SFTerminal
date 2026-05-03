# Agent 子系统 SPEC

> Last verified: 2026-04-25（工具元数据驱动模型：抽象层完全去除按工具名 switch / 硬编码工具名集合的 OOP 违反，所有差异化行为通过 `ToolDefinition._meta` 声明，由 `tool-metadata.ts` 的 helper 集中查询；机械护栏 `__tests__/oop-boundary.test.ts` 防止回退）

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

工厂和生命周期管理器。Agent 实例按 `agentKey` 存储在 `Map<string, SailFish>` 中。

**概念模型（v2，2026-05-02 起）**：一个 tab = 一个 Agent + N 个终端窗格。

- **终端 Agent**：`agentKey = tabId`（前端 `tab.id`，跨多个窗格稳定）
- **助手 Agent**：`agentKey = agentId`（前端生成的 UUID）
- **固定 Agent**：`__companion__`（IM/桌面助手）、`__watch__`（关切系统）
- **Worker Agent**：`agentKey = workerPtyId`（智能巡检 worker，与 worker 终端 1:1 绑定）

**重要：Agent 与底层 PTY/SSH 生命周期解耦**

- `pty:dispose` / `ssh:disconnect` IPC handler **不再**调用 `cleanupAgent`
- 关闭一个窗格 ≠ 销毁 Agent；分屏 tab 内任何单个窗格关闭，Agent 都继续存活
- 仅在以下场景调用 `cleanupAgent`：
  - 用户关闭 tab：前端 `closeTab` 显式调 `agent.cleanup(tab.id)` 触发
  - Worker Agent 任务完成：worker 终端关闭时一并清理（worker = pty 1:1）
  - IM/Web 会话彻底结束

Agent 实例自身**没有强绑定 ptyId 字段**——每次 `run()` 通过 `context.ptyId` 知道当前操作哪个窗格。窗格切换、分屏、focus_pane 都不影响 Agent 实例本身的存在。

**形参兼容**：旧 API 参数名 `ptyId` 保留以兼容现有调用，但新代码语义上传 `agentKey`。

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
  ├── buildContext()          构建执行上下文（双路径）
  │     ├─ [Cache path] 沿用上一个任务的完整 messages + 追加新 user 消息
  │     │    └── 知识检索结果注入 user 消息（而非 system prompt）
  │     └─ [Cold start] 从零构建（首次任务 / 唤醒 run / 上下文超限）
  │          ├── 加载知识库上下文（L2 知识文档 + 向量检索）
  │          ├── 构建任务历史（L1 TaskMemory → ContextBuilder 分层压缩）
  │          ├── L3 auto-recall（语义检索历史对话）
  │          ├── 加载关切列表、羁绊上下文
  │          └── 调用 buildSystemPrompt() 组装系统提示
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
        ├── 保存 messages 快照到 _previousRunMessages（供下次 cache path）
        ├── 保存会话到 HistoryService
        ├── L2: 异步更新知识文档
        └── L3: 异步索引对话到向量库
```

## Prompt Cache 优化

同一 session 内，连续任务复用上一个任务的完整 messages 作为前缀，只追加新 user 消息，使 LLM provider 的前缀缓存跨任务命中。

- **`_previousRunMessages`**：`finalizeRun` 时保存 `run.messages` + 最终 assistant 回复的快照
- **Cache path 条件**：前序快照存在 && 非唤醒 run && token 用量 < 上下文的 70%
- **Cache path 差异**：system prompt 不重建（AI 已持有完整对话）；知识检索结果注入到 user 消息而非 system prompt
- **Cold start 降级**：首次任务、唤醒 run（Watch/Sensor）、上下文空间不足时走原有的 TaskMemory 压缩重建路径
- **Anthropic 缓存断点**：前序消息的最后一条 assistant 上设置 `cache_control`（第 3 个断点），`_cacheBreakpoint` 标记在 `convertToAnthropicBody` 中消费
- **DeepSeek/OpenAI**：自动前缀缓存天然命中，无需额外标记
- **失败任务对称维护**：`handleError` 与 `finalizeRun` 对称，会把 `❌ <错误>` 当作 assistant 回复追加到 `run.messages` 与 `taskMessageLog`，并修复悬空 `tool_calls`（补占位 tool result），最后用更新后的 `run.messages` 覆盖 `_previousRunMessages`。失败前如果 `buildContext` 还没装入 user 消息（半成品状态），则不更新快照，下次任务走 cold start 重建。这是 AI 看到"前面任务失败了"的唯一通道——缺了它，下次任务的 cache path 会沿用上一次成功 run 的快照，把整个失败任务沉默丢弃
- **重置**：`resetSession()` 清空 `_previousRunMessages`

## 会话与持久化

- **会话追踪**：`_sessionId`、`_sessionSteps`、`_sessionMessages` 跨多次 `run` 累积
- **增量检查点**：每完成一轮工具调用自动写盘（`saveCheckpoint`）
- **跨会话恢复**：通过 `sessionId` 从 HistoryService 加载，`restoreFromHistory()` 重建 TaskMemory
- **生命周期**：
  - `cleanupAgent(agentKey)` 销毁实例，仅在用户关闭 tab 时由前端 `closeTab` 显式触发
  - `resetSession(agentKey)` 重置会话但保留实例（"清空对话"功能）
  - PTY/SSH 销毁不触发任何 Agent 清理（生命周期完全独立）

## 工具元数据驱动模型（核心 OOP 边界承诺）

`agent.ts` 是 **Agent 抽象基类**，按 OOP 原则不应知道任何具体子类（具体工具）的名字。所有"按工具名做行为分支"的逻辑——预卡片渲染、并行性判断、执行阶段分配、上下文清理策略、引导完成判断、阻塞等待识别等——都通过 `ToolDefinition._meta`（声明在工具自己的定义里）完成，抽象层只读元数据决策。

### 元数据字段（`ToolMeta`）

定义在 `tools.ts`：

| 字段 | 用途 | 没声明时默认 |
|---|---|---|
| `supportedModes` | 限定工具仅在某些终端模式下出现 | 所有模式 |
| `streamDisplay` | 流式预卡片标题/字段/进度尾缀 | 通用兜底「调用: {toolName}」 |
| `parallelizable` | 是否可与其他工具并行执行 | `false`（串行） |
| `phase` | 执行此工具时的 Agent 阶段 | `'executing_command'` |
| `idempotencyKey` | 工具白名单/幂等键的字段子集 | 全 args 参与生成 key |
| `lifecycle.marksOnboardingComplete` | 调用此工具表示诞生引导完成 | `false` |
| `lifecycle.blocksUntilUserInput` | 此工具的 tool_call 后阻塞等待用户输入 | `false` |
| `argRole.summaryLine` | 历史摘要中"主命令"字段（task-memory 抽取用） | 不抽取 |
| `contextBudget.toolResult` | 上下文压缩时的处理（`'clearable'` / `'protected'`） | `'clearable'`（即默认可清理）⚠️ 见下方说明 |

### 元数据访问层（`tool-metadata.ts`）

提供给抽象层访问元数据的**唯一通道**：

- `getMetaByName(tools, toolName)` —— 从工具列表里按名查 `ToolMeta`
- `formatStreamPreCardFromMeta(meta, args)` —— 流式预卡片完整内容（前缀 + 尾缀）
- `formatToolCallPrefixFromMeta(meta, args)` —— 仅前缀，供执行器 addStep 使用（与 pre-card 共享同一前缀，takeover 时机械保证视觉无跳变）
- `buildPreToolCallDisplay(toolName, partialArgs, meta)` —— 流式回调入口，含 partial JSON 解析与默认兜底
- `tryParsePartialJson(partial)` —— 容错解析流式中尚未结束的 JSON

抽象层中需要"按工具名查行为"的代码，统一通过这些 helper 读 meta，**绝不**用 `if (toolName === 'xxx')` 或 `Set.has(toolName)` 做硬编码分支。

### 抽象层文件清单（边界保护对象）

以下文件构成 Agent 抽象层 / 跨工具横切关注点，**禁止包含具体工具名字符串字面量**：

- `agent.ts`、`streaming-tool-executor.ts`、`tool-result-budget.ts`、`task-memory.ts`、`context-builder.ts`、`tool-metadata.ts`

### 机械护栏

`__tests__/oop-boundary.test.ts`：动态枚举所有内置工具与技能工具的名字，断言上述 6 个抽象层文件源码不含任何一个字面量。一旦后续重构（包括 AI 顺手加的代码）违反原则，CI 阶段立刻失败。

`.cursor/rules/agent-oop-boundary.mdc`：在 AI 编辑这些文件时给 LLM 上下文加上 OOP 边界规则，防止"看到 switch 已有 case 就照葫芦画瓢加新 case"的模仿大于架构反模式。

### 关于 `contextBudget` 默认值的设计选择

`contextBudget.toolResult` 未声明时默认按 **`'clearable'`** 处理（旧实现里"非 CLEARABLE / 非 PROTECTED / 非 mcp_/plugin_ 前缀"会按 false 即"不可清理"对待）。改默认值是**有意的**：

1. 实际场景中"未登记"的工具几乎全是 MCP / plugin / user-skill 工具，它们的输出多为只读查询，可清理
2. 写入类工具都已显式标注 `'protected'`，不会被误清理
3. 若有第三方插件工具确实有副作用且不希望结果被清理，应显式声明 `'protected'` 而非依赖默认行为
4. 默认更激进等于更省 token，符合上下文预算的整体目标

如果有插件作者希望给自己的工具默认改回保护语义，请在 ToolDefinition 上显式声明，不要修改本节的默认值。

### 历史教训

抽象层曾积累 11 处 OOP 违反：`buildPreToolCallDisplay` 的 switch / `PARALLELIZABLE_TOOLS` 的 Set / `setExecutionPhase` 的 if-else / `generateAllowedToolKey` 的三元 / `tool-result-budget` 的两份白名单 + mcp_/plugin_ 前缀启发式 / `task-memory` 的 ask_user 与 execute_command 硬编码 / `personality_craft` 引导判断 / `streaming-tool-executor` 的 CONCURRENCY_SAFE_TOOLS 复制粘贴。每一处都是"看起来很合理"的小妥协，每一次都让抽象与具体的边界往基类里塌一点；一次性重构修完后，机械护栏 + 规则 + 文档三层防护防止再次堆积。

## 工具系统

### 内置工具 (`tools.ts`)

通过 `getAgentTools(mode, remoteChannel)` 按模式过滤。见 `tools.ts` 中的完整定义。返回的工具列表上仍保留 `_meta` 字段供 Agent 抽象层查询；真正发给 LLM 之前由 `stripToolMeta()` 在 `agent.ts` 调用点清理（避免浪费 token）。

### 工具列表顺序约定（Cache 友好）

`builtinTools` 数组的顺序**不是任意的**：子 Agent 工具列表是父 Agent 工具列表的**连续 byte-exact 前缀**，让 Anthropic/DeepSeek/OpenAI 的前缀缓存在工具 schema 部分尽可能命中。

**分段约定**（assistant 模式下）：

| 段 | 工具 | 用途 |
|---|---|---|
| 子 Agent 通用前缀（前 6 个） | `exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search` | explore/research 子 Agent 工具列表 = 此段 |
| edit 子专用追加（前 7-8 个） | `edit_file, write_text_file` | edit 子 Agent 工具列表 = 上一段 + 此段 |
| 父 Agent 专用尾部 | `write_remote_text_file, sftp_put, sftp_get, remember_info, ask_user, plan, skill, load_user_skill, recall, search_history, dispatch_agents, talk_to_user` | 仅父 Agent 可见；`write_remote_text_file` 仅 SSH 模式；`sftp_put/sftp_get` local+ssh 模式（local tab 通过 pane_id 指 SSH 窗格） |

**保持前缀连续的红线**：

1. 新增子 Agent 用的工具时，必须放进对应分段（前 6 / 前 8）的末尾，并同步更新 `SUB_AGENT_TYPES` 白名单
2. 新增父专用工具，只能加在尾部
3. **不要**为子 Agent 重写工具 description（破坏 byte-exact 字节）。如果某些工具描述对子 Agent 无关上下文太多，应通过 `parameters.description` 传入或在 user 指令中说明，不要改 `function.description`
4. `web_search` 是条件性工具（未配置时整体不存在），即使不存在也不破坏前缀关系（子 Agent 同样不会有它，仍是父的连续前缀）
5. 测试 `all sub-agent tool lists should be a contiguous prefix of parent tool list` 是机械护栏

回归保护：`__tests__/sub-agent.test.ts` 中的 "contiguous prefix" 与 "byte-exact tool list across sub-agents of same type" 两条用例固定了此约定。

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

**Fork 模式**（参考 Claude Code）：子 Agent 继承父 Agent 的**消息历史**（system prompt + messages）作为 fork 前缀，最大化 Anthropic/DeepSeek 前缀缓存命中。父 Agent 尚未完成的 tool_result 用固定占位符（`FORK_PLACEHOLDER`）替代，子任务指令作为追加的 user 消息。所有子 Agent 共享同一消息前缀（byte-exact 一致），仅追加部分因任务而异。当父上下文不可用时直接报错（不再 fallback）。

**工具列表**：子 Agent 看到的是按类型白名单过滤后的工具列表（**不是父 Agent 的完整工具列表**）。父 Agent 专属工具（`dispatch_agents`、`talk_to_user`、`plan`、`ask_user`、`remember_info` 等）对子 Agent 完全不可见，避免 LLM 误调用。工具 schema 部分仍因为顺序约定（见上节）共享 byte-exact 前缀，cache 命中不受影响。

**Agent 类型系统**：每个子 Agent 按类型分配工具白名单和系统提示：

| 类型 | 用途 | 可用工具 |
|---|---|---|
| `explore`（默认） | 只读分析 | exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search |
| `edit` | 文件修改 | explore + edit_file, write_text_file |
| `research` | 知识检索归纳 | exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search |

类型通过 `SubAgentType` 接口定义，注册在 `SUB_AGENT_TYPES` 注册表中。白名单顺序与 `tools.ts` 中 `builtinTools` 的前缀严格对齐（见上节"工具列表顺序约定"），不要随意调整。

`web_search` 在 edit 白名单里看似冗余（edit 任务很少联网），但保留它是为了让 edit 子 Agent 工具列表也是父工具列表的连续前缀（前 8 个）；无害，且 LLM 用不到也不会调。

**执行时白名单（Defense in Depth）**：除了通过过滤工具列表让 LLM "看不到"禁用工具，运行时仍保留白名单检查（`allowedTools.has(toolName)`），万一 LLM 通过历史上下文等方式生成了禁用工具的调用，也会被运行时拦截并返回错误提示。

**执行模式**：`dispatchSubAgents` 同步阻塞等待全部子任务完成后返回汇总结果。如果需要"边等边做"，主 Agent 应在同一次响应中并行调用其它工具（parallelizable tools），不需要单独的异步分支。

**安全约束**：
- 子 Agent 继承父 Agent 的 `executionMode`，**工具列表中没有 `dispatch_agents`，物理上不可递归**
- 工具白名单保障安全（无终端操作等高危工具）
- **确认策略**：子 Agent 不弹确认框（避免阻塞并行执行）。moderate 级操作自动放行，dangerous 级操作自动拒绝并打印工具参数预览（便于调试），子 Agent 可换策略重试或报告给主 Agent 处理

### 流式工具并行执行 (`streaming-tool-executor.ts`)

在 AI 模型流式输出过程中，一旦某个 tool_call 的参数完整（可解析为 JSON），`StreamingToolExecutor` 立即开始执行该工具，无需等待整个 assistant 消息输出完毕。

**并发策略**（与 `PARALLELIZABLE_TOOLS` 一致）：
- 只读工具（read_file、file_search、search_knowledge 等）可并行执行
- 有副作用的工具（execute_command、edit_file 等）独占执行，等前面的全部完成

**流程**：`executeStep` 创建 `StreamingToolExecutor` → 传入 `callAiWithStreaming` → AI 流式输出中 `onToolCallReady` 回调触发 `addTool()` → 流结束后 `executeToolCallsWithStreaming` 收集预执行结果 + 执行剩余工具

**安全约束**：重试（onRetry）和截断（finish_reason=length）时会 abort 执行器；幻觉工具在执行器内部检测并拒绝；结果按原始 tool_calls 顺序写入消息历史。

### 工具执行透明原则（UX 承诺）

**Agent 的所有行为对用户必须可见**，分三个阶段呈现，缺一不可：

1. **告知**：进入工具执行前，立即 emit 一张 `tool_call` 卡片，告诉用户"准备做什么"（什么工具、对什么对象——如路径、命令、关键词）
2. **执行**：实际执行工具（IO、网络、子进程等）
3. **结果**：执行完成后 emit `tool_result`（或专用 step 类型如 `plan_*` / `asking` / `waiting`），告诉用户"做完了什么、结果如何"

**实现要求**：

- 每个 `tools/*.ts` 中的工具执行器函数 **必须** 在进入实际工作之前调用一次 `executor.addStep({ type: 'tool_call', ... })`——非调试模式下用户依然需要这层"知情权"
- `tool_result` 也 **必须** 始终由执行器 emit（不要用 `if (config.debugMode)` 等条件门将其隐藏），content 字段简短描述结果（成功/失败 + 关键信息），`toolResult` 字段携带详细 payload。如果执行器忘记 emit，`agent.ts` 的 `ensureToolResultStep` 会兜底加一张通用结果卡（`✅ <toolName>` / `❌ <toolName>` + 200 字截断），但这是最后兜底而非常规路径
- `ensureToolResultStep` 还会**回填** `success` 字段到工具自己 emit 的 tool_result step 上——前端依据 `step.success === false` 决定"失败步骤始终显示"
- **配对粒度**：`tool_call` ↔ `tool_result` 的关联以 `step.toolCallId` 为唯一键（由 `wrapExecutorConfigForToolCall` 在 `addStep` 时统一注入）。`ensureToolResultStep` 的去重和 `success` 回填都按 toolCallId 精准定位；老历史步骤可能没有 toolCallId，此时退化为按 toolName 匹配。**这意味着同一批次出现多次同名工具调用（如 3 个 `execute_command`）时，每个调用都会有独立的 tool_call/tool_result 卡，不会相互覆盖**
- **完成即显示**：并行批次（`executeToolBatchParallel`）和流式预执行（`StreamingToolExecutor.onToolCompleted`）都在每个工具完成的瞬间立即调用 `ensureToolResultStep + finalizeToolCallStep`，不必等整批 await 结束。消息历史（`run.messages`）仍按 toolCalls 原始顺序在最后统一 push，以稳定 OpenAI/Anthropic 协议中 tool 消息序列
- 例外：`plan` 工具族用 `plan_created/plan_updated/plan_archived` 三种专用 step type 直接呈现计划卡。后端依然按通用机制 emit `tool_call`（流式预卡片）和兜底 `tool_result`（持久化完整），但前端 `tool-display.ts::TOOLS_WITH_DEDICATED_STEP_TYPE` 在非调试模式下把它俩一并隐藏，仅保留专用计划卡——避免与计划卡内容重复展示
- 例外：`ask_user` 用 `asking` step type、`wait` 用 `waiting` step type，它们的"卡片即结果"模型自带告知与结果两层语义

**`debugMode` 与持久化解耦**：`debugMode` 只是 **UI 渲染层** 的呈现开关，**不影响后端是否 emit step、不影响是否写入会话历史**。

- 后端永远 emit 完整 step（tool_call + tool_result），永远写入 `run.steps` → `saveCheckpoint` / `finalizeRun` → `HistoryService` 持久化
- `success` 与 `subAgents` 字段也必须随 `AgentStepRecord` 一起持久化（见 `shared/types/history.ts`），否则历史详情面板无法判定"失败步骤始终显示"
- 前端 `src/utils/tool-display.ts` 的 `shouldShowToolResultStep` 才是 UX 决策点（覆盖 `tool_call` 与 `tool_result` 两类）：非调试模式下隐藏"成功且无用户必看产出"的信息检索 / 命令类工具结果（如 `read_file`、`execute_command`）；用专用 step type 呈现的工具（`TOOLS_WITH_DEDICATED_STEP_TYPE`，如 `plan`）连其 `tool_call` 通告卡也一并隐藏，避免和专用卡重复；失败 / 写入类 / 携带 `images`/`webSearchResults`/`subAgents` 的步骤永远展示
- 反例（已修复）：曾在 `tools/exec.ts` / `tools/command.ts` / `tools/terminal.ts` / `tools/misc.ts` 里写过 `if (config.debugMode) executor.addStep({type:'tool_result', ...})`——这导致非调试模式下命令输出**整条 step 都没产生**，既不进 messages、也不进会话历史，事后开调试模式也找不回来。这种耦合是错误的，新增工具时不要重蹈覆辙。

**为什么重要**：用户读 Agent 输出的常见心智是「Agent 当前在干什么」。任何静默执行（卡片只在结束后才出现）都会让用户误以为 Agent 卡住，或对 AI 的实际行为缺乏控制感。这条原则是「不让用户怀疑 Agent 是否还活着」的最基本保障。同时，把"是否展示"与"是否记录"分离，保证调试时能回看任何过去发生过的工具执行。

**回归保护**（待补）：建议增加 `__tests__/transparency.test.ts` 用机械方式遍历所有工具执行器，断言至少 emit 一次 `tool_call` step、且不通过 `config.debugMode` 包住 `tool_result`；目前依赖 review 时人工对照本节执行。

### 流式 tool_call 预创建卡片（UX 承诺）

支持预创建的工具（`write_text_file` / `write_remote_text_file` / `edit_file` / `read_file` / `dispatch_agents` / `execute_command` / `exec` / `word_from_markdown` / `excel_from_markdown`）的 tool_call 参数流式输出可能持续数秒到数十秒。不做特殊处理时，用户在 AI 输出完整个 assistant 消息前什么都看不到，体感像是卡住。

**承诺**：`callAiWithStreaming` 的 `onToolCallProgress` 回调在参数流式阶段就根据已到达的 partial JSON 预创建一张 `tool_call` 卡片，执行器首次 `addStep` 时由 `wrapExecutorConfigForToolCall` 无缝接管。

- **内容格式**由 `buildPreToolCallDisplay(toolName, partialArgs)` 集中决定，必须与执行器最终 `addStep` 的 content 对齐（相同前缀、相同路径/命令/标题），避免接管瞬间视觉跳变
- **工具名命中即显示**：只要 `toolName` 在支持列表中就立即创建卡片，`path` 未到达时用占位符（`生成中…`，i18n key `agent.stream_pending_field`）兜底，path 到达后自动替换。不要求字段齐全才显示——AI 未必按 schema 顺序输出 arguments，先流长字段（如 `old_text` / `content`）、最后才流 `path` 的情况很常见
- **容错 JSON 解析**（`tryParsePartialJson`）：按 LIFO 栈补全未闭合的字符串和括号（嵌套 `[{` 必须先补 `}` 再补 `]`），并从尾部逐字符剥离非法结尾（如 `,` / `:`）重试直到 parse 成功；否则流式中 `tasks` 数组等嵌套结构会永远补全失败、字符数永远不更新
- **path 固定、长内容隐藏的工具**（write_text_file / edit_file / dispatch_agents / word_from_markdown / excel_from_markdown 等）额外追加实时字符数尾缀（如 `· 1234 字符`），累计 content / old_text / new_text / 子任务 prompt / markdown 的长度，让"AI 还在持续输出"这件事可见；命令类工具不追加尾缀（命令文本本身在流式增长）
- **不做字段名模糊匹配**（遵循项目规则）：每个支持的工具显式声明取哪些字段
- **解析失败不回退**：AI 还没流完字段时保留上一次的缓存内容，避免"闪一下就消失"
- **回归保护**：`__tests__/pre-tool-call-display.test.ts` 固定了所有关键契约（预创建范围、字符数阈值、渲染格式、path 占位行为、嵌套数组容错）。本承诺曾在 commit `4aeabb1a` 的重构中丢失，测试是防止再次丢失的机械护栏

### 思考过程呈现（UX 承诺）

推理模型（DeepSeek-R1、豆包思考、Claude Thinking 等）的 `reasoning_content` 由后端 `ai.service.ts` 包装成固定模板的 HTML 块写进 streamContent：

- 流式中：`<details open>\n<summary>🤔 ...</summary>\n\n<blockquote>\n\n[reasoning so far]`（未闭合）
- 完成后：`<details>\n<summary>🤔 ...</summary>\n\n<blockquote>\n\n[reasoning]\n\n</blockquote>\n</details>`（闭合）

后端逻辑保持不变：`callAiWithStreaming` 的 `sendContentUpdate` 里仍然在检测到 `</details>` 闭合后立即把 `<details open>` 替换为 `<details>`，onDone 做同样替换作为兜底。这是后端持久化数据格式的承诺（IM 端、Web 端、历史记录都依赖这个格式）。

**前端呈现**：AiPanel 不再用原生 `<details>` 渲染，而是把思考块从 `message.content` 抽出，交给 `<ThinkingBlock>` 组件单行呈现（streaming/done 两态）。这样做的目的是消除 DynamicScroller 的高度抖动——原生 `<details>` 折叠是瞬时无动画的，每次 v-html 重渲染时元素都被重建，导致流式期间反复展开/折叠引发列表项 size 反复重算。

- **拆分入口**：`src/utils/thinking-block.ts` 的 `parseThinking(content)`，按上面两种模板正则匹配
- **size dep 剥离**：`getItemSizeDeps` 中 message step 的 `content` 经过 `parseThinking` 剥离思考块后再作为 size dep，reasoning 文本变化不再触发列表项重算
- **行为约束**：流式中只显示最后一行 reasoning（CSS `text-overflow: ellipsis` 自适应容器宽度，不需要硬编码字符数）；完成后默认收起，仅在用户主动点击时内嵌展开

### 任务完成尾注尺寸恒定（UX 承诺）

`✓ 任务完成` 尾注（`.agent-final-footer`）作为 message step 的尾巴呈现，是 4dad4969 修复"任务完成那一刻整屏上下闪烁"的关键载体。

**承诺**：footer 的 DynamicScroller item size 必须**恒定**，与 footer 内任何子元素（`✓` 文字、操作菜单按钮、未来可能新增的尾注内容）的存在与否无关。任何依赖 `isAgentRunning` / `isLoadedFromHistory` / `pendingConfirm` 等运行时状态切换 footer 内子元素 v-if 的改动，都不能引起 footer 高度变化。

- **实现**：`.agent-final-footer { min-height: 22px }`，锁到当前最大子元素（22×22 操作按钮）高度。文字行高 ~17px 在 22px 容器内垂直居中略松，但比尺寸跳变好得多
- **失败案例（commit `9607c2a8`）**：往 footer 里塞了一个高 22px 的 fork 菜单按钮，按钮 v-if 受 `isAgentRunning` 控制——Agent 跑完那一刻按钮整批出现，所有完成 group 的 footer 同时从 17 跳到 22，DynamicScroller 监测到全部 item size 变化触发整列重排
- **修复（commit `274a2386`）**：min-height 锁底，按钮在/不在 footer 高度恒定
- **回归保护**：未来在 footer 加新元素时高度必须 ≤ 22px；要超过 22px 必须同步把 min-height 抬高到新最大值，并且新元素也不能是基于运行时状态条件渲染的

### 流式输出同帧贴底跟随（UX 承诺）

流式 chunk 到达时，新内容必须**在浏览器 paint 之前**完成贴底滚动，用户视觉上感受不到任何"半行先冒出再上挪"的过渡。

**承诺**：`useAgentMode` 内挂 `ResizeObserver` 直接监听 DynamicScroller 的内容容器 `.vue-recycle-scroller__item-wrapper` 自身高度变化。该 wrapper 高度即虚拟列表的 totalSize；ResizeObserver 回调时机在 layout 之后、paint 之前，那一刻把 `scrollTop` 钉到最新 `scrollHeight`，浏览器同帧合成出来的画面已经是贴底状态。

- **触发条件**：`isUserNearBottom === true`（用户视觉处于底部）或 `skipScrollUpdate` 期间（强制贴底窗口内）；用户主动滚走后 `isUserNearBottom = false`，ResizeObserver 不会越权强行贴底
- **失败案例（修复前）**：`doScrollIfNeeded` 仅在 `nextTick` 后调一次 `scrollTop = scrollHeight`，但 DynamicScroller 的 totalSize 是 item 的 ResizeObserver 异步上报的，nextTick 时 totalSize 还是旧值，于是滚到的是"旧底"；浏览器 paint 出新内容、半行裸露在视区底外，下一波 chunk 才补上去
- **修复（commit `274a2386`）**：在 `useAgentMode` 内 `installContentResizeObserver` 直接观察 wrapper 高度；`doScrollIfNeeded` 等粗粒度滚动入口保留，作为新 step 加入瞬间的初始贴底兜底
- **回归保护**：禁止把 ResizeObserver 改成基于 step.content 长度等内容驱动的判断（脆弱，且重新引入"vue-virtual-scroller 内部 size 测量异步"的根本问题）；禁止改成 setTimeout/setInterval 轮询（错过 paint 窗口）
- **`skipScrollUpdate` 语义陷阱**：该标志同时承担两件事——① 屏蔽强制贴底窗口内的 scroll 事件以免覆盖 `isUserNearBottom`；② 告诉 ResizeObserver "现在请跟随尺寸变化贴底"。**任何"决定不滚"的分支都不得置位 `skipScrollUpdate`**，否则用户向上滚阅读时，新 step 引发的 ResizeObserver 回调会被误解读为"请跟随贴底"，把用户从阅读位拽回最底（曾经的回归 bug）。`doScrollIfNeeded` 必须把 `skipScrollUpdate = true / setTimeout(... = false)` 收进 `if (isUserNearBottom)` 分支内

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
