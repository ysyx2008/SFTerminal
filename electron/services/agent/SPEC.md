# Agent 子系统 SPEC

> Last verified: 2026-07-18（上下文组成树状占比 hover）

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

继承 Agent，实现具体行为。`personality` 技能在诞生引导时自动加载。

**终端工具注入**：`execute_command` 等 PTY 终端工具不再通过技能系统加载，而是由 `getAgentTools(mode)` 按 `context.terminalType` 直接注入（`local`/`ssh` 模式）；assistant 模式注入 `exec` 工具。`getAgentMode()` 从 `currentRun?.context?.terminalType` 读取，而非依赖已废弃的 `ptyId` 字段。

**工作台 prompt**：`context.workbenchPrompt` 由前端通过 `resolveWorkbenchAgentPrompt(kind, tab)` 填充：
- `assistant`：注入产出物面板使用规范（`@sailfish/workbench-assistant` / prompt）
- `local`：注入本地终端操作规范（`src/workbench/local/prompt.ts`）
- `ssh`：注入 SSH 远程终端操作规范（`src/workbench/ssh/prompt.ts`）

**`<sf_workbench>` 标签**：`enhanceUserMessage` 在每条用户消息前注入 `<sf_workbench>{terminalType}</sf_workbench>`，让 AI 在多工作台对话历史中能识别每条消息的运行环境。

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
- **Cache path 差异**：system prompt 不重建（AI 已持有完整对话）；知识检索结果注入到 user 消息而非 system prompt（包裹在 `<sf_knowledge_refs>`，用户真实输入在 `<sf_user_message>`，避免与召回片段混淆）
- **Cold start 降级**：首次任务、唤醒 run（Watch/Sensor）、上下文空间不足时走原有的 TaskMemory 压缩重建路径
- **进程启动时间**：`PromptBuilder` identity 段注入 `软件启动时间`（由 `process.uptime` 推算，进程内稳定，属 Tier 1 前缀，不破坏缓存）
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

### 持久命名 Agent vs 普通 tab Agent（`restoreFromHistory` fallback 边界）

`restoreFromHistory`（仅首次 run、TaskMemory 为空时触发）按 Agent 类型分两条路径：

- **持久命名 Agent**（Companion `__companion__` / Watch `__watch__`）：**无条件**从最近 N 条历史重建工作记忆（`restoreRecentTaskMemory`），**不**因 sessionId 精确命中而短路。原因：重启后前端传回的 sessionId 只是「最新一条」记录，并非用户主动选择恢复某次会话。若只精确恢复这单条，会丢掉同期其它并行会话（典型：联络分裂成两条 session，「继续」落到只含菜单的那条、写文档的内容在另一条里），造成「前端 `getRecentByAgentKey` 合并展示看得见、但 AI 上下文只有单条记不住」。
  - 同时仍 `restoreFromSessionRecord(latest)` 恢复「最新单条」的完整会话状态（`_sessionSteps` / `_sessionMessages`），保证后续 checkpoint 续写到这条记录、不覆盖丢历史；`restoreRecentTaskMemory` 用 `excludeId` 排除这条避免重复。
  - 任务按「最后活跃时间」升序装入（旧在前），保证 `getTasksInOrder` 把刚发生的任务排到 taskIndex 0。
- **普通 tab Agent**（terminal / SSH / 独立助手）：仅 `getAgentRecordById(sessionId)` 精确恢复用户指定的那次会话；找不到则直接返回、TaskMemory 保持空白。新开 tab 的第一次对话本就是新任务，注入历史会让 LLM 误以为是连续对话，沿用历史里的工具名（甚至当前 tab 工具表里没有的工具——例如上次用过 chart 技能里的 `candlestick`，新 tab 第一次说"画个图"，AI 会捏造出 `generate_chart` 而不是先 `load skill`），造成 `Unknown tool` 幻觉调用。

**`restoreRecentTaskMemory` 的数据 scope 按 kind 分流（与前端展示口径对齐）**：

- **companion**：仅取同 agentKey（`__companion__`）的最近 N 条（`getRecentRecordsByAgentKey`），与前端合并视图（`Companion.getMergedViewRecord`，经 IPC `history:getCompanionMergedView` 暴露）用同一个查询——UI 只展示联络线，AI 上下文也只含联络线。联络是独立常驻 tab，若灌入任务 tab 的 transcript 会让 AI 在联络里「串台」（沿用任务里的工具/话题，像在接另一场对话）。多条 companion 线合并的语义仍保留：重启后 sessionId 只是「最新一条」，其它并行 companion 线从同 agentKey 最近历史补齐，避免「屏幕看得见、AI 记不住」。
- **watch**：维持全局 main 树（`getRecentAgentRecords`，排除 wakeup 噪声）。Watch 是 Agent 的「内心独白」，需要参考用户在任意 tab 的最近活动做决策，全局借记忆对 watch 仍成立。
- **task**：本方法不会被调用（`_persistentNamedAgent` 为 false 时不进 fallback）。

排除 wakeup「内心独白」记录（`userTask` 以 `[当前时间：` 开头且含 `触发事件`）的原因：Watch 自我循环唤醒只是噪声、不应被借作工作记忆（否则会把一堆 `[当前时间…触发事件]` 当成"最近活动"，且 Watch 心跳量极大会挤掉真正的用户活动）。companion 走同 agentKey 路径时不会命中 wakeup（wakeup 走 `__watch__`），过滤逻辑保留是安全兜底。

> **装载量与预算**：`restoreRecentTaskMemory` 按 kind 分流装载——companion 维持紧凑（最多 6 条记录 / 40 个任务进 TaskMemory），watch 放宽到 30 条记录 / 100 个任务（配合 wakeup 的广度优先策略，覆盖最近 1-2 天全部用户活动，含 companion 的 talk_to_user 消息）。watch 的 30 条 record 依据：平均每条 agentRecord 含 3-4 轮用户任务（splitMessagesIntoTasks 拆分），30 条 record 可拆出约 90-120 个 task，配合 MAX_RESTORE_TASKS=100 留有冗余。仅防内存膨胀；真正进上下文的量由 `buildTaskHistoryContext` 按 token 预算动态裁剪（Level 0→4 渐进降级、预算用尽即停），装多少都不会撑爆上下文。

> **wakeup run 的历史装载策略**：`buildContext` 对 wakeup run（心跳/Watch 触发）采用 `{ maxTasks: 100, minCompressionLevel: 4 }`——100 条任务 + minCompressionLevel:4。这是为了让 watch 决策时能看到完整的用户上下文（包括 companion 的 talk_to_user 对外消息），避免旧策略 `maxTasks:5` 时 companion 消息被任务 tab 活动挤掉、watch 看不到自己上次提醒过什么。注意 `buildRecentTasksContext` 的 `level < minLevel && level < 3` 守护只拦 L0-L2，L3/L4 都可放置——系统优先尝试 L3（信息更丰富，保留命令/路径/关键发现），放得下就用 L3 而非 L4。token 成本约 5-8K（L3/L4 单条 50-80 token），远低于 recentTasks 预算（128K 上下文下 40K），且有 `buildRecentTasksContext` 预算兜底自动裁剪。

### sessionId 回种：防止 Companion「裂成两条 session」

Companion 语义是「一条跨重启、多渠道汇流的连续关系线」，但它的 sessionId 此前是「谁先碰谁定」：

- IM / Gateway / 主动消息等入口 `runAssistant('__companion__', ...)` 时 **context 不带 sessionId**；重启后若它们在桌面 tab 把 sessionId 写回后端单例之前先碰到 companion（此时 `_sessionId` 还空），`run()` 旧逻辑会新起一条 `session_${Date.now()}` ——建出与历史**断链的并行记录**，这就是「联络裂成两条 session」的源头。
- **修复**：`run()` 在 `!_sessionId && !context.sessionId` 且 `_persistentNamedAgent` 时，从 `getLatestRecordByAgentKey(agentId)` **回种** sessionId/startTime，让所有入口续写到同一条会话。
- **抑制位 `_suppressSessionSeed`**：`startNewSession()`（Watch 每次执行要独立记录）/ `resetSession()`（用户「清空对话」要全新会话）会置位，使下一次 run **跳过回种**、生成全新 session。consume 后自动清零。这样 Watch 的「每次独立记录」与 Companion 的「连续会话」都成立。

> **配套（前端）**：联络 tab 重启后恢复历史展示时，调 `history.getCompanionMergedView()` 取后端 `Companion.getMergedViewRecord()` 产出的合并视图 record——其 `id` 与 `timestamp` 必须**成对取最新一条**（由后端保证）。旧版前端自拼的「id 取最新、timestamp 取最早」会经 `restoreAgentHistory` 写成错配的 `sessionId/sessionStartTime`，导致 checkpoint 把记录存成「id 最新、timestamp 最早」——是分裂的放大器（两条记录 timestamp 撞成一样）。合并逻辑现已收口在后端 `electron/services/conversation/companion.ts`，前端不再自拼。

**实现**：`Agent._persistentNamedAgent: boolean`（默认 false）。`AgentService.createAssistantAgent(agentId)` 内部根据 `agentId === COMPANION_AGENT_ID || WATCH_AGENT_ID` 自动调 `markAsPersistentNamed()`——调用方（IM service / Watch service）无需感知。`getOrCreateAgent`（终端 Agent）和 createAssistantAgent 的非命名分支默认就是 false。

**回归保护**：`__tests__/agent.test.ts` 六条用例锁定边界——① "should NOT restore global recent history for normal agent ..."（普通 tab 不借历史）；② "should restore companion recent history for persistent named agent when sessionId record missing"（companion 找不到 record 时从同 agentKey 最近历史借记忆，不走全局）；③ "should merge companion recent records into memory even when sessionId record is found"（companion 即便精确命中 latest 也合并同 agentKey 的其它并行线）；④ "should NOT load task tab records into companion working memory (isolation)"（companion 工作记忆里不含 task tab 的 transcript，防串台）；⑤ "should seed sessionId from latest record ... when context has no sessionId"（无 sessionId 入口回种、防分裂）；⑥ "should NOT seed sessionId after startNewSession (suppressed) ..."（Watch/清空对话 抑制回种）。新增类似的固定 ID Agent 时记得在 `isPersistentNamedAgentId` 里登记。

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
| `idempotencyKey` | 工具白名单/幂等键的字段子集（「本次允许」会话内存） | 全 args 参与生成 key |
| `lifecycle.marksOnboardingComplete` | 调用此工具表示诞生引导完成 | `false` |
| `lifecycle.blocksUntilUserInput` | 此工具的 tool_call 后阻塞等待用户输入 | `false` |
| `argRole.summaryLine` | 历史摘要中"主命令"字段（task-memory 抽取用） | 不抽取 |

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

- `agent.ts`、`streaming-tool-executor.ts`、`tool-output-budget.ts`、`task-memory.ts`、`context-builder.ts`、`tool-metadata.ts`

### 机械护栏

`__tests__/oop-boundary.test.ts`：动态枚举所有内置工具与技能工具的名字，断言上述抽象层文件源码不含任何一个字面量。一旦后续重构（包括 AI 顺手加的代码）违反原则，CI 阶段立刻失败。

`.cursor/rules/agent-oop-boundary.mdc`：在 AI 编辑这些文件时给 LLM 上下文加上 OOP 边界规则，防止"看到 switch 已有 case 就照葫芦画瓢加新 case"的模仿大于架构反模式。

### 工具 output 预算（`tool-output-budget.ts`）

在工具结果**写入 `run.messages` 前**，按模型 `contextLength` 与当前已用量计算单次 output 字符/行上限，防止「最后一读把窗口撑爆」。旧 tool 结果不再做每步微压缩（曾用 `tool-result-budget`，会提前丢信息并破坏 prompt cache）；上下文紧张时统一走下方 compress 体系。

- **计算**：`computeToolOutputBudget({ contextLength, currentTokens })` → `{ maxChars, maxLines, critical, usagePercent }`；档位上限 × 压力系数（70%/85%）与 `remaining − reserve` 取 min；reserve 为窗口 15%（最少 4K token）。
- **注入**：`ToolExecutorConfig.getToolOutputBudget` 由 `agent.ts` 在 `createToolExecutorConfig` 提供；子 Agent 继承父配置。
- **并行 batch**：`executeToolBatchParallel` 与流式预执行 `StreamingToolExecutor` 均通过 `applyParallelShare(budget, N)` 分摊预算，避免 N 个只读工具各拿满额。
- **消费方（v1）**：`tools/file.ts` 的 `read_file` / 文档解析结果在返回前按预算截断；`maxChars ≤ 0` 时仅返回摘要与 `compress_context` 指引。
- **消费方（v2）**：`tools/exec.ts` 的 `formatTaskOutput` 与 `tools/command.ts` 的 `applyCommandOutputBudget`（execute_command 主路径 + sudo 路径）均接入动态预算，上下文紧张时自动收紧输出（与 16KB 上限取 min）；`executeTimedCommand` / `executeFireAndForget` 因已有固定 500/300 字符截断且输出量小，暂不接入。

### 上下文超限自动压缩兜底

`ContextWindowManager.emergencyCompress` 是「API 自然报错」的最终兜底（SPEC 第 116 行注释承诺过、本节实现）：

- **触发**：`executeLoop` 的 catch 检测到上下文超限（通过 `ContextWindowManager.isContextLimitError`）。识别范围：
  - `ai.service.ts` 统一翻译后的 `t('error.context_length_exceeded')` 中/英文案
  - 原始错误码 `context_length_exceeded`
  - 火山方舟豆包等稳定业务文案 `exceed max message tokens`（code 常为空，`ai.service` 也会先翻译成上述统一文案）
- **流程**：先 `fixIncompleteToolCalls` 修复悬空 tool_calls → `emergencyCompress`（先 keepRecent=2，若压缩后仍 >90% 再 keepRecent=1）→ 注入 `_systemInjected` 提示让 AI 知道发生了什么 → `continue executionLoop` 重试当前请求。
- **重试上限**：`MAX_CONTEXT_OVERFLOW_RETRIES = 1`，防死循环。仅压缩成功时消耗配额（压缩失败不消耗，避免下次循环跳过本可救的请求）。
- **压缩失败**（如无 user 消息可压缩）：注入失败提示后正常抛错到 `handleError`。

### 视觉路由与上下文预算对齐

主模型关联 `visionProfileId` 且会话带图时，API 调用切到视觉模型（`resolveEffectiveProfileId`）。**上下文预算必须用同一份 profile**：

- 纯函数 `resolveBudgetProfileId`（`vision-routing.ts`）是唯一真相源
- 有图判定复用既有 `conversationContainsImages`：已组装 messages（或缺省时 `_previousRunMessages`）+ 本轮 `context.images`；不扫 taskMemory（冷启动偶发低估靠下方 emergencyCompress 兜底）
- `ContextWindowManager.getContextLength`（经 deps.getProfileId）/ cache path 70% 门槛 / tool-output-budget / proactiveCompress 均走预算 profile
- 请求启动时 `publishPlannedContextBar`：上轮 API 确认 token/cache + 本轮拟用 model/limit（换模型清 Cache%）
- 会话级 `AgentContextBar` 经 `onContextBar` 推送，与 step 解耦（流式接替 / 重试删 step 不影响状态栏）
- onDone / reportUsage 更新 contextBar；step 上仍写 token 字段供历史落盘
- 本轮 usage 以 API 为唯一真相源：有 cache 明细才写，否则清空

#### 上下文组成占比（Context Composition）

迷你进度条 hover 展示「谁占得多」的树状占比，设计目标：

- **总量**仍以 API 真实 `prompt_tokens` 为准；分类只回答结构占比，**不做 token 估算**。
- 口径统一为发出请求时各块的**字符长度**（messages 文本 / tool_calls 参数 / tools JSON / 图片 data URL）。
- **渐进披露**：默认只露一级三大类（system / tools / messages）；二级细分默认折叠，供 Debug 展开。
- System 二级依赖 PromptBuilder 写入的 section 标记（发 API 前 strip）；无标记时 system 仅一级。
- 图片单独成叶子，避免淹没对话正文占比。
- 仅 live `AgentContextBar.composition` 推送，不写入历史 step 落盘。

否则会出现：按 DeepSeek 1000K 复用 ~260K 前缀 → 实际打到豆包 256K → `exceed max message tokens`。

### 上下文超限本地预测压缩（proactiveCompress）

`ContextWindowManager.proactiveCompress` 是「本地预测触发」的前置压缩，与 `emergencyCompress`（API 报错兜底）分工互补：

- **触发**：`executeStep` 开头，`shouldProactiveCompress` 检测到上一轮 API 返回的真实 `prompt_tokens >= contextLength * 95%`（`PROACTIVE_THRESHOLD = 0.95`，留 5% 余量给本轮新增）。
- **为什么用真实值不用估算**：`estimateTextTokens` 误差 <10% 是均值，单次可能 20%+；用上一轮真实 `prompt_tokens` 预测本轮，精度主要受本轮新增内容影响（单次写入大小由 `tool-output-budget` 限制）。
- **为什么需要它**：DeepSeek 等provider 上下文超限时**默默截断不报错**，`emergencyCompress`（依赖 `context_length_exceeded`）对它们无效。proactiveCompress 在 API 调用前主动压缩，覆盖这类 provider。
- **流程**：`proactiveCompress`（复用 `compressAggressively`：先 keepRecent=2，仍 >90% 降到 1）→ 注入 `_systemInjected` 提示（`agent.context_proactive_compressed`，文案区分"系统主动压缩"vs emergency 的"系统自动压缩"）→ 直接继续 `executeStep`（不重试，压缩后正常调 AI）。
- **同一 run 只压一次**：`_proactiveCompressedThisRun` 标记，避免连续压缩。
- **与 emergencyCompress 的配额关系**：两者独立。proactive 用 `_proactiveCompressedThisRun` 限制 1 次；emergency 用 `MAX_CONTEXT_OVERFLOW_RETRIES = 1` 限制 1 次。最坏情况：先 proactive 压一次，API 仍报错再 emergency 压一次。

### 历史教训

抽象层曾积累多处 OOP 违反（含已移除的 `tool-result-budget` 硬编码白名单等）。一次性重构修完后，机械护栏 + 规则 + 文档三层防护防止再次堆积。

## 工具系统

### 内置工具 (`tools.ts`)

通过 `getAgentTools(mode, remoteChannel)` 按模式过滤。见 `tools.ts` 中的完整定义。返回的工具列表上仍保留 `_meta` 字段供 Agent 抽象层查询；真正发给 LLM 之前由 `stripToolMeta()` 在 `agent.ts` 调用点清理（避免浪费 token）。

### 工具列表顺序约定（Cache 友好）

`builtinTools` 数组的顺序**不是任意的**：子 Agent 工具列表是父 Agent 工具列表的**连续 byte-exact 前缀**，让 Anthropic/DeepSeek/OpenAI 的前缀缓存在工具 schema 部分尽可能命中。

**分段约定**（assistant 模式下）：

| 段 | 工具 | 用途 |
|---|---|---|
| 子 Agent 通用前缀（前 7 个） | `exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search, web_fetch` | `read` 类型子 Agent 工具列表 = 此段 |
| `write` 类型追加（前 8-9 个） | `edit_file, write_text_file` | `write` 类型子 Agent 工具列表 = 上一段 + 此段 |
| 父 Agent 专用尾部 | `write_remote_text_file, sftp_put, sftp_get, ask_user, plan, skill, load_user_skill, recall, search_history, dispatch_agents, talk_to_user` | 仅父 Agent 可见；`write_remote_text_file` 仅 SSH 模式；`sftp_put/sftp_get` local+ssh 模式（local tab 通过 pane_id 指 SSH 窗格） |

**保持前缀连续的红线**：

1. 新增子 Agent 用的工具时，必须放进对应分段（前 7 / 前 9）的末尾，并同步更新 `SUB_AGENT_TYPES` 白名单
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

**独立模式**：子 Agent 用 `[system, user]` 两条消息开局，**不继承父 Agent 的对话历史**。父 Agent 想让子 Agent 知道的上下文必须显式写在 `task.prompt` 里。

为什么不用 fork 模式：曾经参考 Claude Code 改成 fork（继承父消息历史以最大化 prompt cache），但导致严重的工具幻觉——子 Agent 的 system prompt 是父 Agent 的（描述自己能用 `dispatch_agents` / `talk_to_user` / `plan` 等），对话历史里也有这些工具的调用先例，但实际工具列表里没有这些。LLM 看到这种不一致会反复尝试调用不存在的工具，被运行时拦截后再重试，整体卡死。

切回独立模式后：
- 身份、工具、历史三者彻底一致，根除幻觉源头
- prompt cache 仍正常命中：所有同类型子 Agent 的 system prompt 与工具 schema byte-exact 一致

**子 Agent system prompt 结构**（由 `PromptBuilder.buildSubAgentSystemPrompt` 构建）：

| 段落 | 来源 | 备注 |
|---|---|---|
| 语言规则 | `LANGUAGE_RULE` 常量 | 与父 Agent 共用同一字符串 |
| 运行环境（OS / Shell / CWD / 用户名 / 主目录） | `PromptBuilder.buildHostEnvironment(context, hostProfileService)` | Shell 优先 `context.systemInfo`（来自 PTY 实际 spawn）；为空/`unknown` 时兜底 `profile.shell`。子 Agent `exec` 必须知道当前 OS / Shell、CWD 等 |
| 用户 AI Rules | `executor.getAiRules()` | 项目编码约定（如"用 npm 不用 yarn"），write 类型尤其重要 |
| 类型角色 | `SUB_AGENT_TYPES[type].systemPromptPrefix` | 一两句话区分 read/write |
| 工作契约 | 固定文本：数据真实性 + **失败如实上报**（禁止私自换命令补救） + 结论结构化（做到/没做到/为什么） | byte-exact 常量 |

**不**继承的部分：身份描述（IDENTITY/SOUL/USER）、技能列表、知识文档、对话历史、任务记忆、关切列表、羁绊上下文——这些都是会话级动态状态，子 Agent 是一次性短任务不需要。

**不在 prompt 里点名"哪些工具不能调用"**：schema 不暴露的工具 LLM 一般不会主动捏造，反复点名反而是诱导。

**byte-exact 一致性**：同一父 Agent 内所有子 Agent 共享相同 `context` / `aiRules` / `hostProfileService`，因此 system prompt 跨子 Agent byte-exact 一致；工具 schema 因为顺序约定（见「工具列表顺序约定」一节）天然共享前缀。两者都让 Anthropic/DeepSeek/OpenAI 的前缀缓存正常命中。

**工具列表**：子 Agent 看到的是按类型白名单过滤后的工具列表（**不是父 Agent 的完整工具列表**）。父 Agent 专属工具（`dispatch_agents` / `talk_to_user` / `plan` / `ask_user` / `skill` / `load_user_skill` 等）对子 Agent 完全不可见。父 Agent 的系统提示与 `dispatch_agents` 工具描述会明确告知：依赖技能的子任务（browser/excel/email 等）不得分派给子 Agent。

**Agent 类型系统**：

| 类型 | 用途 | 可用工具 |
|---|---|---|
| `read`（默认） | 只读分析、调研、知识检索 | exec, read_file, file_search, search_knowledge, get_knowledge_doc, web_search, web_fetch |
| `write` | 文件修改 | read + edit_file, write_text_file |

类型通过 `SubAgentType` 接口定义，注册在 `SUB_AGENT_TYPES` 注册表中。白名单顺序与 `tools.ts` 中 `builtinTools` 的前缀严格对齐（见「工具列表顺序约定」），不要随意调整。

`web_search` / `web_fetch` 在 write 白名单里看似冗余（写任务很少联网），但保留是为了让 write 子 Agent 工具列表也是父工具列表的连续前缀（前 9 个）；无害，且 LLM 用不到也不会调。

**向后兼容**：fork 模式时期使用过 `explore` / `research` / `edit` 三种类型，`resolveAgentType` 保留映射（`explore` / `research` → `read`、`edit` → `write`），LLM 凭旧训练习惯传旧值也能 work。

**执行时白名单（Defense in Depth）**：除了通过过滤工具列表让 LLM "看不到"禁用工具，运行时仍保留白名单检查（`allowedTools.has(toolName)`），万一 LLM 通过其它途径生成了禁用工具的调用，也会被运行时拦截并返回错误提示。

**执行模式**：`dispatchSubAgents` 同步阻塞等待全部子任务完成后返回汇总结果。如果需要"边等边做"，主 Agent 应在同一次响应中并行调用其它工具（parallelizable tools），不需要单独的异步分支。

**结果回收（摘要 + 产出物指针）**：子 Agent 最终结果 ≤ 8000 字符时原样回传；超过时**不再静默截断丢信息**——完整正文落盘到 `agent-workspace/scratch/sub-agents/<批次时间戳>/<taskId>.md`，回传「指针 notice（含文件路径与总字符数）+ 尾部截断文本」（结论通常在结尾）。主 Agent 需要细节时用 `read_file` 按需读取，与 L3 记忆「完整保存、按需检索」同构。同一次 dispatch 的所有子任务共享一个批次目录（懒创建，仅在出现超长结果时落盘）；放在 `scratch/` 下受既有过期自动清理管辖。落盘失败时退回纯截断，不影响子任务成功状态。回归用例见 `__tests__/sub-agent.test.ts`「结果回收」一节。

**安全约束**：
- 子 Agent 工具列表中**没有** `dispatch_agents`，物理上不可递归
- 工具白名单保障安全（无终端操作等高危工具）
- **确认策略**：子 Agent 不弹确认框（避免阻塞并行执行）。moderate 级操作自动放行，dangerous 级操作自动拒绝并打印工具参数预览（便于调试），子 Agent 可换策略重试或报告给主 Agent 处理

### 流式工具并行执行 (`streaming-tool-executor.ts`)

在 AI 模型流式输出过程中，一旦某个 tool_call 的参数完整（可解析为 JSON），`StreamingToolExecutor` 立即开始执行该工具，无需等待整个 assistant 消息输出完毕。

**并发策略**（与 `PARALLELIZABLE_TOOLS` 一致）：
- 只读工具（read_file、file_search、search_knowledge 等）可并行执行
- 有副作用的工具（execute_command、edit_file 等）独占执行，等前面的全部完成

**流程**：`executeStep` 创建 `StreamingToolExecutor` → 传入 `callAiWithStreaming` → AI 流式输出中 `onToolCallReady` 回调触发 `addTool()` → 流结束后 `executeToolCallsWithStreaming` 收集预执行结果 + 执行剩余工具

**Output 预算分摊**：启动只读工具时，在将工具标为 `executing` 之前调用 `computeOutputBudgetShare(starting)`：已 executing 的同伴 + 受 `maxConcurrency` 限制的 queued 槽位，避免把尚未启动的排队工具或超限并发算进 share。经 `executeFn({ parallelShare })` 交给 Agent 的 `withParallelToolOutputBudget`。同一 event-loop tick 内连续 `addTool` 会合并到一次 `processQueue`（`queueMicrotask`），避免第一个 read 在后续 read 到达前就拿满额预算。

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
- `success`、`subAgents`、`echartsOption`（chart skill 投递的活图 ECharts option，类型见 `shared/types/agent.ts::EChartsStepPayload`）、`canvasData`（Artifact 面板，类型见 `shared/types/canvas.ts`）等富内容字段都必须随 `AgentStepRecord` 一起持久化（见 `shared/types/history.ts`），否则历史详情面板无法判定"失败步骤始终显示" / 历史里的图无法恢复成活图 / 重开历史时 Artifact 面板为空
- 前端 `src/utils/tool-display.ts` 的 `shouldShowToolResultStep` 才是 UX 决策点（覆盖 `tool_call` 与 `tool_result` 两类）：非调试模式下**成功的 tool_result 默认隐藏**（tool_call 绿条已表达结果）；仅 `ALWAYS_SHOW_RESULT_TOOLS` 例外；用专用 step type 呈现的工具（`TOOLS_WITH_DEDICATED_STEP_TYPE`，如 `plan`）连其 `tool_call` 通告卡也一并隐藏；失败 / 携带 `images`/`echartsOption`/`webSearchResults`/`subAgents` 的步骤永远展示
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

**前端呈现**：AiPanel 不再用原生 `<details>` 渲染，而是把思考块从 `message.content` 抽出，交给 `<ThinkingBlock>` 组件单行呈现（streaming/done 两态）。这样做的目的是消除虚拟列表的高度抖动——原生 `<details>` 折叠是瞬时无动画的，每次 v-html 重渲染时元素都被重建，导致流式期间反复展开/折叠引发列表项 size 反复重算。

- **拆分入口**：`src/utils/thinking-block.ts` 的 `parseThinking(content)`，按上面两种模板正则匹配
- **size dep 剥离**：`getItemSizeDeps` 中 message step 的 `content` 经过 `parseThinking` 剥离思考块后再作为 size dep，reasoning 文本变化不再触发列表项重算
- **行为约束**：流式中只显示最后一行 reasoning（CSS `text-overflow: ellipsis` 自适应容器宽度，不需要硬编码字符数）；完成后默认收起，仅在用户主动点击时内嵌展开

### 任务完成尾注尺寸恒定（UX 承诺）

`✓ 任务完成` 尾注（`.agent-final-footer`）作为 message step 的尾巴呈现，是 4dad4969 修复"任务完成那一刻整屏上下闪烁"的关键载体。

**承诺**：footer 的虚拟列表 item size 必须**恒定**，与 footer 内任何子元素（`✓` 文字、操作菜单按钮、未来可能新增的尾注内容）的存在与否无关。任何依赖 `isAgentRunning` / `isLoadedFromHistory` / `pendingConfirm` 等运行时状态切换 footer 内子元素 v-if 的改动，都不能引起 footer 高度变化。

- **实现**：`.agent-final-footer { min-height: 22px }`，锁到当前最大子元素（22×22 操作按钮）高度。文字行高 ~17px 在 22px 容器内垂直居中略松，但比尺寸跳变好得多
- **失败案例（commit `9607c2a8`）**：往 footer 里塞了一个高 22px 的 fork 菜单按钮，按钮 v-if 受 `isAgentRunning` 控制——Agent 跑完那一刻按钮整批出现，所有完成 group 的 footer 同时从 17 跳到 22，虚拟列表监测到全部 item size 变化触发整列重排
- **修复（commit `274a2386`）**：min-height 锁底，按钮在/不在 footer 高度恒定
- **回归保护**：未来在 footer 加新元素时高度必须 ≤ 22px；要超过 22px 必须同步把 min-height 抬高到新最大值，并且新元素也不能是基于运行时状态条件渲染的
- **首次入场动画**：footer 第一次显示时（`group.id` 不在 `animatedFooters` Set 中）附加 `agent-final-footer--first-show` class 触发 `agent-final-footer-enter` keyframes（opacity 0→1 + translateY 6→0，320ms iOS spring）；`@animationend` 回调把 `group.id` 写入 Set，后续虚拟滚动 unmount/mount 时 class 不再附加，**绝不会重播动画**——避免"翻历史时一路 footer 滑入闪烁"的回归。动画只用 opacity + transform 这种 compositor 层属性，不影响 box height，不破坏 item size 恒定不变量

### 流式输出跟底跟随（UX 承诺）

流式 chunk 到达时，用户若处于跟底态，新内容应保持贴底可见，不出现"半行先冒出再上挪"或持续跳动。

**实现（2026-07-13 起）**：消息列表使用 [`virtua`](https://github.com/inokawa/virtua) 的 `Virtualizer`。动态高度测量与 scroll position adjustment 由库内置；前端只维护跟底意图与用户上滚检测。

- **跟底意图**：`stickyFollowBottom`（发消息 / 点「新消息」后）或 `isUserNearBottom`；`scrollToBottom` / `doScrollIfNeeded` 在跟底态钉底（`scrollTo(scrollSize)` 或 `scrollTop = scrollHeight`）
- **阅读态**：用户上滚后清除 sticky，只亮「新消息」提示，不越权拽回底部
- **切 tab / 历史恢复**：`aiScrollAnchor`（item id + offset）+ `scrollToIndex`；冷加载用 `isHistoryScrollPending` 淡入
- **已删除**：自建 wrapper `ResizeObserver` / FLIP transform / `suppressFlipUntil` / `aiScrollCache`（见 `src/components/AIPANEL_SPEC.md` 四·补）
- **回归保护**：禁止再给虚拟列表容器加手动 FLIP transform；禁止阅读态调用 `guardAfterAutoScroll`；禁止用关键词匹配推断滚动意图

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
| calendar | 日历管理（含 CalDAV VTODO：`calendar_todo_*`） |
| todo | 本地秘书待办（工作空间 `TODO.json`，工具 `todo_*`；见 `skills/todo/SPEC.md`） |
| browser | 浏览器操作（launch=Playwright 独立窗口；attach=浏览器助手复用用户 Chrome/Edge/Firefox，见 `browser-bridge/SPEC.md`） |
| feishu | 飞书集成（OAuth） |
| chart | 数据可视化（默认输出活图 ECharts，PNG 兜底；详见 `skills/chart/SPEC.md`） |
| watch | 关切管理 |
| config | Agent 配置 |
| skill-manager | 用户技能管理与市场 |

注册入口：`skills/index.ts`，技能定义接口见 `skills/types.ts` 中的 `Skill`。

## 风险评估

命令审计采用**单通道（AST）**架构（`electron/services/agent/command-audit/`）：

| 工具 | 执行方式 | 审计 |
|---|---|---|
| `exec` / `execute_command` | shell 字符串 / PTY | `@questi0nm4rk/shell-ast`（mvdan/sh WASM）拆复合命令 + 白名单 + 路径分区 |

**Fail-Closed + 路径优先**：

- 不在白名单 / AST 解析失败 / 动态命令（`sudo $CMD`、`bash -c $script`）→ `dangerous`
- 未识别且纯只读 → `moderate` + `hasUnknown`（relaxed 仍确认，不 silent 执行）
- 写操作先看**工作区路径分区**（C 方案），再定级：
  - **free**（`scratch/`、`charts/`）：读写删自动放行
  - **protected**（`templates/`、根目录人格 md）：写删需确认
  - **workspace**：工作区内其他写删需确认
  - **outside**：工作区外写删 `dangerous`；系统关键路径写删 `blocked`
- 只读命令（`cat`、`ls`）读系统路径仍为 `safe`
- **未识别命令**：纯只读 → `moderate` + `hasUnknown`（relaxed 仍确认）；有写 redirect / 动态参数 → `dangerous`

`risk-assessor.ts` 对 shell 命令调用 `assessShellRisk()`（async）；Windows 默认 PowerShell 走官方 AST（`extract-pwsh-calls.ts`），cmd 兜底与解析失败时回退 regex（`assessCommandRiskLegacy`）。

风险等级：

- **safe**：只读命令（ls, cat, pwd...）
- **moderate**：有副作用但可恢复（mkdir, cp, apt install...）
- **dangerous**：不可逆操作（rm -rf, dd, 格式化...）
- **blocked**：交互式编辑器（vim, nano...），或系统关键路径写删

处理策略：`allow` / `auto_fix`（如自动加 -y）/ `timed_execution` / `fire_and_forget` / `block`

启动时 `main.ts` 预热 shell-ast WASM（`ensureShellAstReady`），避免首条 shell 命令审计卡顿。

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

### talk_to_user 主动消息与桌面 UI 同步（2026-07-03）

Watch / 任意 Agent 调用 `talk_to_user`（`tools/misc.ts::messageUser`）时，消息路由到 `__companion__` 联络线，但**调用方 Agent 的 steps 仍留在自身上下文**（如 `__watch__`）。

**后端**：
- `addProactiveContext('__companion__', …)` 暂存上下文，用户回复时 `consumeProactiveContext` 注入
- 持久化：`userTask='__proactive__'` + 单条 `proactive_notice` step（`finalResult` 为消息正文）；`userTask` 标记供 conversation 模块过滤，不进 TaskMemory merge

**桌面 UI 注入契约**（`App.vue`）：
- `watch:proactive-message` 到达时：若联络 tab `isRunning` → `markDeferredProactive`，任务完成后再 `flushDeferredProactive`；否则立即 `injectProactiveSteps`
- `injectProactiveSteps` 只追加 `{ type: 'proactive_notice', content }`，**不得**用 `user_task`/`final_result` 配对（会破坏 `agentTaskGroups` 分组，导致进行中任务的后续 step 变 orphan）
- 历史数据里旧的 `user_task __proactive__` + `final_result` 配对仍由前端 `isProactive` 分支渲染

**IM/WebChat 运行信号**（修复 companion tab `isRunning` 不同步）：
- `AgentCallbacks.onStart`：`initializeRun` 在 `user_task` emit 后统一回调 `(agentId, userTask)`
- IM / WebChat / `main.ts` 转发 `agent:running` IPC；`App.vue` 全局 `onRunning` → `setAgentRunning(tabId, true, …)`
- 用户在联络 tab 主动发消息仍走 `useAgentMode.runAgent` 的乐观 `setAgentRunning`，与 `onRunning` 幂等共存

## 其他组件

- **Orchestrator** (`orchestrator.ts`)：多 Agent 协调器（智能巡检），Master-Worker 模式
- **ProactiveStore** (`proactive-store.ts`)：主动消息上下文存储（IM → Agent）；见上文「talk_to_user 主动消息与桌面 UI 同步」
- **i18n** (`i18n.ts`)：Agent 国际化（中/英）
