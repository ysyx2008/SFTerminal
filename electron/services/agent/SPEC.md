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
- **重置**：`resetSession()` 清空 `_previousRunMessages`

## 历史任务的注入策略

新会话第一次任务（cold start）时，`buildContext` 通过 `buildTaskHistoryContext` 注入历史任务，**统一以"摘要"形式注入 system prompt**，**不以对话形式（user/assistant/tool）塞进 messages 数组**。

**为什么这样做**：
- 历史任务和当前会话本就**不连续**（尤其新会话第一次任务时，TaskMemory 来自 `restoreFromHistory`，"最近的"任务可能是上一个会话的尾声）
- 如果以原生对话格式注入 messages，LLM 看到的结构上和当前对话完全一样，会误判为"我刚做过的事"，进而：
  1. 重复处理已完成的工作
  2. 模仿历史中的工具调用（包括子 Agent 看不到的父专属工具如 `dispatch_agents`，导致幻觉调用）
  3. 误判任务完成度
- 把它们集中放在 system prompt 的 `# 历史任务` 一节，措辞明确"仅供参考、不属于当前对话"，AI 能清楚区分

**实现细节**：
- `agent.ts` cold start 路径下 `historyOptions` 一律设 `minCompressionLevel: 3`（用户主动 + wakeup 都一致）
- `buildRecentTasksContext` 内部规则：level ≤ 2 进 `recentTaskMessages`（push 进 messages），level ≥ 3 进 `taskSummarySection`（注入 system prompt）。强制 `minCompressionLevel: 3` 即所有任务必走 summary 分支
- `recentTaskMessages` 实际为空数组；agent.ts 中保留对它的 push 仅作向后兼容（将来如重新启用"对话形式注入"，需同时调整 `historyOptions` 与 PromptBuilder 描述）
- `# 历史任务` section 描述明确告知 AI："仅供参考、不属于当前对话…需要详情用 `recall(id)`"
- AI 想看任务详情，主动调用 `recall(id)` 工具按需获取
- Cache path（同会话连续任务）天然不受影响——直接复用上一次的 messages

## 会话与持久化

- **会话追踪**：`_sessionId`、`_sessionSteps`、`_sessionMessages` 跨多次 `run` 累积
- **增量检查点**：每完成一轮工具调用自动写盘（`saveCheckpoint`）
- **跨会话恢复**：通过 `sessionId` 从 HistoryService 加载，`restoreFromHistory()` 重建 TaskMemory
- **生命周期**：`cleanupAgent()` 销毁实例，`resetSession()` 重置会话但保留实例

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
| `idempotencyKey` | 工具白名单/幂等键的字段子集 | 整个 args |
| `lifecycle.marksOnboardingComplete` | 调用此工具表示诞生引导完成 | `false` |
| `lifecycle.blocksUntilUserInput` | 此工具的 tool_call 后阻塞等待用户输入 | `false` |
| `argRole.summaryLine` | 历史摘要中"主命令"字段（task-memory 抽取用） | 不抽取 |
| `contextBudget.toolResult` | 上下文压缩时的处理（`'clearable'` / `'protected'`） | `'clearable'`（即默认可清理） |

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
| 父 Agent 专用尾部 | `write_remote_text_file, remember_info, ask_user, plan, skill, load_user_skill, recall, search_history, dispatch_agents, talk_to_user` | 仅父 Agent 可见 |

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
- 例外：`plan` 工具族用 `plan_created/plan_updated/plan_archived` 三种专用 step type 直接呈现计划卡，不走标准 `tool_call`/`tool_result` 双卡——计划卡本身就是用户可见的，不需要额外通告卡
- 例外：`ask_user` 用 `asking` step type、`wait` 用 `waiting` step type，它们的"卡片即结果"模型自带告知与结果两层语义

**`debugMode` 与持久化解耦**：`debugMode` 只是 **UI 渲染层** 的呈现开关，**不影响后端是否 emit step、不影响是否写入会话历史**。

- 后端永远 emit 完整 step（tool_call + tool_result），永远写入 `run.steps` → `saveCheckpoint` / `finalizeRun` → `HistoryService` 持久化
- `success` 与 `subAgents` 字段也必须随 `AgentStepRecord` 一起持久化（见 `shared/types/history.ts`），否则历史详情面板无法判定"失败步骤始终显示"
- 前端 `src/utils/tool-display.ts` 的 `shouldShowToolResultStep` 才是 UX 决策点：非调试模式下隐藏"成功且无用户必看产出"的信息检索 / 命令类工具结果（如 `read_file`、`execute_command`），失败 / 写入类 / 携带 `images`/`webSearchResults`/`subAgents` 的步骤永远展示
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

### 思考过程折叠时机（UX 承诺）

推理模型（DeepSeek-R1、豆包思考、Claude Thinking 等）的 `reasoning_content` 在流式阶段以 `<details open>...</details>` 的 HTML 块呈现，让用户看到 AI 正在思考。**一旦 reasoning 结束、AI 切换到 content 或 tool_calls 阶段，思考卡必须立刻折叠**；否则用户会误以为"思考还没结束"。

- **检测点**：`callAiWithStreaming` 的 `sendContentUpdate` 里。当 `streamContent` 同时包含 `<details open>` 和 `</details>`（即 reasoning 块已闭合），立即把 `<details open>` 替换为 `<details>`，UI 下次 render 时 details 默认折叠
- **替换幂等**：onDone 里对 `streamContent` 做同样的 replace 作为兜底（纯 reasoning 无 content/tool_calls 的场景、或替换逻辑未被触发时）
- **不能等到整段流结束才折叠**：有长参数工具（如 `write_text_file` 的大 content）时，AI 从"思考完"到"整段流结束"之间可能隔数秒到数十秒，此时思考卡继续展开会给用户"还在思考"的错觉。修复前曾在 commit `4aeabb1a` 引入 tool_call 预卡片后，因 tool_calls 参数流式变长、这个问题才暴露

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
