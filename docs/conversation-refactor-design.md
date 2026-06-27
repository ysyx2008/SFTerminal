# 会话领域模型重构设计文档

> **目标**：解决会话逻辑散落、耦合度高、"改一处牵动一片"的问题。
>
> **核心动作（一句话）**：把今天散在 `Agent` 上的 `_session*` 一族字段 + `buildContext`/`finalizeRun`/`checkpoint`/`restore*` 这套机器，整体收进一个 **`Conversation` 聚合根**；`Agent` 退化为**无状态推理引擎**。这是「会话漫游」语义（同一条会话被不同 Agent 先后接管）逼出来的必然结构——记忆只能归会话所有。

## 一、为什么要做（痛点与根因）

### 1.1 现状（已核对代码，修正早期误判）

```
AgentService（agent/index.ts）
  └── Agent 实例池：getOrCreateAgent(ptyId) / createAssistantAgent(agentId)
  └── 会话方法只是薄转发：resetSession/startNewSession → agent.xxx()
Agent（基类，agent.ts，~3800 行，职责过重）
  ├── ReAct 执行循环、工具调用、风险控制（本职）
  └── ⚠️ 会话/记忆机器（散落的 private 字段 + 多方法手动维护不变量）：
      _sessionId / _sessionStartTime / _sessionMessages / _sessionSteps /
      _previousRunMessages / _sessionTokenUsage / _lastPromptTokens /
      _lastCacheHitRate / _terminalMeta / _suppressSessionSeed /
      _persistentNamedAgent / taskMemory
      buildContext（cache path vs 冷启动）/ finalizeRun / checkpoint /
      restoreFromHistory / restoreFromSessionRecord / restoreRecentTaskMemory
HistoryService（history.service.ts，~1400 行，职责过重）
  ├── JSON 文件读写
  ├── 内存索引维护 / 重建
  ├── 搜索 / 过滤 / 分页 / token 统计
  └── 导入 / 清理
前端 Store/组件
  └── 直接操作 AgentRecord 原始字段
```

> **早期文档的两处事实错误（已修正）**：
> 1. 会话生命周期方法（`startNewSession`/`resetSession`）**在 `Agent` 基类上**，`AgentService` 只是薄转发——不是"AgentService 管会话"。脆弱点在 Agent 自己身上。
> 2. `AgentRecord` **已经是会话粒度**（`record.id` 即 sessionId，累积跨 run 的 `_sessionMessages`），不是"单次任务记录"。它只缺一个 `kind` 字段（形态用已有的 `terminalType` 表达；`title` 按需再加）。**因此不该另起平行的 `ConversationRecord` 类型。**

### 1.2 核心痛点

| 痛点 | 表现 |
|------|------|
| **职责不清** | HistoryService 既存又查；Agent 既管思考又管记忆 |
| **逻辑散落** | 会话状态是一堆 `_session*` 私有字段，由 `buildContext`/`finalizeRun`/`checkpoint`/`restore*` 等多个方法**手动维护彼此间的不变量**，漏一处就出 bug |
| **耦合度高** | 改存储格式影响查询；改会话状态可能误伤 Agent 思考逻辑 |
| **难以测试** | 会话/记忆逻辑嵌在 Agent 的 run 循环里，依赖 Electron/服务，无法单独测试 |
| **前端耦合** | 组件直接改 record 原始字段，后端结构一变就炸前端 |

### 1.3 根因

"改一处崩一片"的真正来源**不是存储层**，而是 §1.1 标 ⚠️ 的那套会话/记忆机器：它把**一份本应是单一真相源的东西（对话全过程）拆成多份独立状态散在 Agent 上手动同步**。`agent.ts` 里那些血泪注释——"联络裂成两条 session""屏幕合并展示看得见 AI 记不住""split 同毫秒碰撞丢任务"——每一条都是一次此类事故。OOP 的解法是：**把这份真相源 + 它的派生投影封进一个有不变量、可单测的聚合根。**

## 二、领域语义（核心前提，其余设计须服从）

> 这一节是整个重构的地基。所有类设计、字段、迁移都必须服从这里定义的语义。

### 2.1 三类会话（kind）——对应 Agent 的三种存在方式

互斥的三种，缺一不可。把这三类讲圆，Agent 才完整：**有内心独白、能独自做事（心跳/Watch），有与用户的持续对话（联络），也能直接接受指令完成工作（任务）。**

| kind | 心智 | agentKey | 用户可见 | 历史 | 是否累积成一条线 |
|---|---|---|---|---|---|
| `task` | 直接接受指令干活，可并行、可隔离 | 当前 tabId（**会变**，见会话漫游） | 是，进任务侧栏 | 主历史 | 否：按需新建，可漫游续聊 |
| `companion` | 与用户的对话——一条长期关系线，多渠道汇流 | 恒为 `__companion__` | 是，独立常驻 tab（按 agentKey 从任务侧栏剔除） | 主历史 | **是：永不 reset 的长期线**（除非用户主动清空，见待办） |
| `watch` | 内心独白 / 独自做事（心跳、Watch） | 恒为 `__watch__` | 不进会话列表/长期记忆，但有独立**执行历史/执行速览**（WatchStore 上限 500 + `history/watch` 正文）供复盘审计 | 独立历史树 | 否：逐次触发、用完即弃 |

- `watch` 是 Agent 的**内心独白**：对话内容不进用户会话列表、不进长期记忆；要主动让用户看见须经 `talk_to_user` 把消息冒泡进**联络**。
- `kind` 对一个固定会话 `id` **稳定**：一条会话不会中途从 `task` 变 `companion`。跨类只能 fork 新建。

### 2.2 会话身份 vs 运行时绑定（关键区分）

- **身份 = `id`(sessionId) + `kind` + `createdAt`，不可变。** 会话「是谁」由它唯一确定。
- **运行时绑定 = `agentKey`（及当前 Agent 实例 / ptyId），可变。** 表示「当前是哪个 tab / 实例在跑这条会话」，随接管者变化。
- **形态属性 = `terminalType`(local/ssh/assistant) + ssh 的 `sshHost`，会话创建时确定、不可变。** 跨形态续聊不走漫游，走「从历史创建任务」（§2.5）——否则会把 ssh 历史里的命令/工具名带进本地形态造成幻觉调用（`restoreFromHistory` 注释已警告过这类事故）。

### 2.3 会话漫游（任务跨形态续聊）—— 采用方案 A

任务类会话历史在 local / ssh / 独立助手间**共享**。用户从「最近对话」点开旧会话续聊时：

- **(A) 会话漫游（限同形态）**：**同一个 `sessionId` 继续**，改由当前 tab 的 Agent 实例来跑；更新 `agentKey`（**形态 `terminalType` 不变**——只在同形态的另一个 tab 续聊，如另一个连同一台 host 的 SSH tab），**会话 id 与历史保持一条连续的线**。
- **跨形态续聊不漫游**：local↔ssh↔assistant 之间"基于历史继续"走 `createTaskFrom`（§2.5），新建匹配当前形态的会话。
- **不自动 fork**；需要另起一聊由**用户手动 fork**。

这正是「记忆必须归 Conversation、不归 Agent」的硬约束来源。

### 2.5 两种 fork 是不同操作（不可合并为一个 `fork()`）

「另开一聊」在两类会话里语义不同，强行用同一个 `fork()` 是会埋 bug 的错误抽象，必须拆成两个操作：

| 操作 | 场景 | 语义 | 种子 |
|---|---|---|---|
| **任务分支** `fork()` | task → task | 同 kind，**从开头到 fork 点完整拷贝** transcript，换条路探索 | 完整历史 |
| **从联络创建任务** `createTaskFrom(seed)` | companion → task | 跨 kind，新建 `kind=task`，本质是**"创建任务"而非"另起一聊"** | **选定的种子上下文**（联络是永不结束的长期线，从开头完整拷贝既太长也没必要） |

- **现在定到 API 形状**：两个独立方法；`createTaskFrom` 的种子取法收进一个 `SeedStrategy` 接缝。
- **种子策略待定（择期/可重构后定）**：最近 N 条？摘要？用户勾选？——被隔离在 `SeedStrategy` 后面，晚定不动模型。
- **协同**：默认种子可直接复用 `buildLLMContext`/`taskMemory` 的「越近越完整」投影（§3.3），不另造裁剪逻辑——这也反向验证了 `buildLLMContext` 纯函数接缝的价值（多服务一个调用方）。

### 2.4 唯一真相源：对话全过程

会话的「记忆」就是对话全过程——给模型的 `messages`（`AiMessage[]`）+ 给用户的 `steps`（`AgentStep[]`）。**TaskMemory 的分级压缩、prompt cache 前缀（`_previousRunMessages`）都是从这份全过程派生的投影，不是独立状态**（恢复时由 `splitMessagesIntoTasks` 重建即可证明）。`Conversation` 只需守住这一份真相源，其余皆可重算。

## 三、目标架构（OOP 分解）

### 3.1 对象模型与职责边界

| 对象 | 拥有什么 | 干什么 | 绝不碰 |
|---|---|---|---|
| **Conversation**（聚合根） | 身份(`id`/`kind`/`createdAt`) + 不可变形态(`terminalType`/`sshHost`) + 可变绑定(`agentKey`) + **真相源 transcript**(`messages`+`steps`) + 派生投影(`taskMemory`、`cachePrefix`) + token 账 | 消息增删、token 计数、**上下文组装的纯粹部分**(cache path vs 冷启动重建)、fork、reset、漫游 rebind、序列化、事件 emit | IPC、文件 IO、LLM 调用、KnowledgeService |
| **ConversationManager** | `Map<id, Conversation>` + `policy` 表 + `store` | CRUD、搜索、列表、批量刷盘、IPC 转发、**按 kind 应用生命周期策略**（联络回种、watch 走独立历史树、reset 抑制回种） | LLM、工具执行 |
| **ConversationStore** | dataDir / 索引 | 纯文件读写、索引维护 | 业务语义 |
| **Agent**（重构后） | 仅运行时 `currentRun` | ReAct 循环、工具调用、风险控制；context 的**富化部分**(注入 L2 知识 / L3 检索 / system prompt) | 不再持有任何 `_session*` 状态 |
| **AgentService**（重构后） | Agent 实例池 | 调度者：从 Manager 取 Conversation + 按当前绑定取 Agent，组合 `run`，处理 abort | 会话生命周期（交给 Manager） |

### 3.2 关键接缝：Agent 无状态化

```ts
// Agent 每次 run 把会话当参数借进来，自己不留状态
async run(conv: Conversation, userInput: string, ctx: RunContext): Promise<string> {
  conv.appendUserMessage(userInput)
  const base = conv.buildLLMContext(this.contextBudget())  // 纯：cache 前缀复用 or 冷启动从 taskMemory 重建
  const messages = this.enrichContext(base, ctx)           // 不纯：注入 L2 知识 + L3 检索 + system prompt
  const log = await this.executeLoop(messages, ctx)        // 思考 / 工具 / 风险
  conv.commitRun(log, ctx.tokenUsage)                      // 写回 transcript + 刷新 cachePrefix / taskMemory
  return log.finalResult
}
```

### 3.3 纯 / 不纯边界（设计能否落地的关键）

`Conversation` **保持纯**（不依赖任何 service / Electron），所以能脱离环境单元测试——这正是"加功能不崩"的抓手。`buildContext` 拆成两段：

- `Conversation.buildLLMContext(budget)`：**纯**。cache path（复用 `cachePrefix`）vs 冷启动（从 `taskMemory` 做 L0–L4 渐进重建），决策只依赖传入的 budget（含 contextLength），不碰外部。
- `Agent.enrichContext(base, ctx)`：**不纯**。注入 L2 知识文档、L3 向量检索、system prompt——这些需要 `KnowledgeService` 等依赖，留在 Agent。

### 3.4 kind 差异：数据策略表，不用子类

`Conversation` 一个类即可（不需要继承树）。kind 间的行为差异用**数据驱动策略**表达，而非散落 `if (_persistentNamedAgent)` / `if (wakeup)`（遵循 `agent-oop-boundary` 规矩）：

```ts
export type ConversationKind = 'task' | 'companion' | 'watch'

export interface ConversationPolicy {
  accumulates: boolean              // watch=false：不累积成长期线
  seedFromHistoryOnColdStart: boolean // companion=true：冷启动从全局最近 N 条回种工作记忆
  visibleInList: boolean            // watch=false：不进会话列表
  historyTree: 'main' | 'watch'     // watch 独立历史树
}

export const CONVERSATION_POLICY: Record<ConversationKind, ConversationPolicy> = {
  task:      { accumulates: true,  seedFromHistoryOnColdStart: false, visibleInList: true,  historyTree: 'main'  },
  companion: { accumulates: true,  seedFromHistoryOnColdStart: true,  visibleInList: true,  historyTree: 'main'  },
  watch:     { accumulates: false, seedFromHistoryOnColdStart: false, visibleInList: false, historyTree: 'watch' },
}
```

今天的血泪 if-else（`_persistentNamedAgent` 回种 / `_suppressSessionSeed` / wakeup 跳过 cache / watch 独立历史树）全部收敛成 Manager 读这张表决策。`_suppressSessionSeed` 退化为 reset/startNew 时由 Manager 持有的一次性标志。

## 四、类详细设计

### 4.1 Conversation（聚合根）

```ts
// electron/services/conversation/conversation.ts
import { EventEmitter } from 'events'
import type { AiMessage, AgentStep, TokenUsage } from '@shared/types'
import { TaskMemoryStore } from '../agent/task-memory'

export class Conversation extends EventEmitter {
  // ===== 身份（不可变） =====
  readonly id: string
  readonly kind: ConversationKind
  readonly createdAt: number

  // ===== 形态属性（会话创建时确定，不可变） =====
  readonly terminalType: TerminalType  // 'local' | 'ssh' | 'assistant'
  readonly sshHost?: string

  // ===== 运行时绑定（可变，随会话漫游更新当前接管者；仅同形态） =====
  private _agentKey: string          // task=当前tabId；companion=__companion__；watch=__watch__

  // ===== 唯一真相源：对话全过程 =====
  private _messages: AiMessage[]     // 给模型（原 _sessionMessages）
  private _steps: AgentStep[]        // 给用户 UI（原 _sessionSteps）

  // ===== 派生投影（可从真相源重建，不独立持久化为权威） =====
  private _taskMemory: TaskMemoryStore   // L1 工作记忆，L0–L4 压缩
  private _cachePrefix?: AiMessage[]      // prompt cache 前缀（原 _previousRunMessages）

  // ===== token 账 =====
  private _tokenUsage?: TokenUsage
  private _lastPromptTokens?: number
  private _lastCacheHitRate?: number

  private _dirty: boolean
  private _metadata: Record<string, unknown>

  private constructor(/* ... */) { super() }

  // ===== 工厂 / 序列化（复用 shared AgentRecord，不另立类型） =====
  static create(kind: ConversationKind, agentKey: string, terminalType: TerminalType, opts?): Conversation
  static fromRecord(record: AgentRecord): Conversation   // 反序列化：从 messages 重建 taskMemory
  toRecord(): AgentRecord                                 // 序列化：写 messages/steps/kind/...

  // ===== 消息 =====
  appendUserMessage(text: string, attachments?): void
  appendAssistant(msg: AiMessage): void
  getMessages(): readonly AiMessage[]
  getSteps(): readonly AgentStep[]

  // ===== 上下文组装（纯：cache path vs 冷启动重建；不注入 L2/L3） =====
  buildLLMContext(budget: ContextBudget): AiMessage[]

  // ===== run 生命周期 =====
  commitRun(log: TaskMessageLog, tokenUsage?: TokenUsage): void  // 原 finalizeRun + checkpoint 的状态部分

  // ===== 会话操作 =====
  rebind(agentKey: string): void      // 会话漫游：仅换接管 tab/实例，形态不变（限同 terminalType）
  fork(): Conversation                                     // 任务分支：同 kind，完整拷贝到 fork 点（§2.5）
  createTaskFrom(seed: SeedStrategy): Conversation         // 从联络创建任务：跨 kind，种子起头（§2.5，策略待定）
  reset(): void                       // 清空对话（置 suppressSeed 由 Manager 读取）

  // ===== 状态 =====
  get agentKey(): string
  get tokens(): number; get isDirty(): boolean
  markClean(): void

  // ===== 事件（Manager 监听转发 IPC） =====
  // 'message:appended' | 'updated' | 'forked' | 'dirty' | 'reset'
}
```

### 4.2 ConversationManager

```ts
// electron/services/conversation/manager.ts
export class ConversationManager extends EventEmitter {
  private _conversations: Map<string, Conversation>
  private _store: ConversationStore
  private _suppressSeed: Set<string>   // reset/startNew 的一次性抑制位

  // CRUD
  create(kind: ConversationKind, agentKey: string, terminalType: TerminalType, opts?): Conversation
  get(id: string): Conversation | undefined
  getOrLoad(id: string): Promise<Conversation | undefined>   // 内存没有则从 store 反序列化
  list(filter?: ListFilter): ConversationSummary[]           // 按 policy.visibleInList 过滤 watch
  delete(id: string): boolean
  search(query: SearchQuery): ConversationSummary[]

  // 会话生命周期（从 Agent/AgentService 上移，按 kind policy 决策）
  resolveForRun(opts): Promise<Conversation>   // 取/建会话 + 应用 seed 策略（companion 回种）+ 处理漫游 rebind
  reset(id: string): void                       // 置 suppressSeed
  fork(id: string): Conversation                            // 任务分支（§2.5）
  createTaskFrom(companionId: string, seed: SeedStrategy): Conversation  // 从联络创建任务（§2.5，策略待定）

  // 持久化
  async loadAll(): Promise<void>
  saveDirty(): void                             // 每 5s / 退出时批量，按 policy.historyTree 路由
  async saveOne(id: string): Promise<void>

  // 内部：监听 Conversation 事件 → IPC 推送
  private _wire(conv: Conversation): void
}
```

### 4.3 存储层（已模块化，无需新类）

文件 IO 原语已在 `electron/services/history/agent-storage.ts` 抽成纯函数（`readAgentRecordFile` / `writeAgentRecordFile` / `listAgentDateDirs` / `collectAgentStorageStats` 等），`HistoryService` 组合这些纯函数 + 索引缓存 + `storeForRecord` 的 main/watch 路由。

**结论：保留 `ConversationStore` 作为「薄封装命名类」**（不重新实现 IO，只组合上述纯函数）。理由是 OOP 可理解性 + 边界清晰：让 `ConversationManager` 只跟一个名字达意的 `ConversationStore` 打交道（`save/load/delete/loadIndex/loadAll`，内含 main/watch 树路由），而不是伸手进 `HistoryService` 这个「什么都管」的大类。它就是存储后端的**接缝**——内部委托 `agent-storage.ts` 纯函数（或过渡期直接委托 `HistoryService`），将来要换索引实现/换盘格式只动这一处。

```ts
// electron/services/conversation/storage.ts —— 薄封装，复用 agent-storage.ts 纯函数 + 索引 + watch 路由
export class ConversationStore {
  async save(record: AgentRecord): Promise<void>          // 内部按 kind/agentKey 路由 main/watch 树
  async load(id: string): Promise<AgentRecord | null>
  async delete(id: string): Promise<boolean>
  async loadIndex(): Promise<IndexEntry[]>
  async loadAll(tree?: 'main' | 'watch'): Promise<AgentRecord[]>
}
```

### 4.4 messages.ts（纯函数，保留现有实现）

`getTextContent` / `estimateTokens` / `estimateTotalTokens` / `truncateMessages` / `splitMessagesIntoTasks` 等——已实现，复用，去掉对平行 `ConversationMessage` 的依赖，统一用 `@shared/types` 的 `AiMessage`。

### 4.5 类型方案（复用 shared，禁止平行类型）

`AgentRecord`（`shared/types/history.ts`）**新增可选字段**，由 normalize 补默认：

```ts
export interface AgentRecord {
  // ... 现有字段（含已有的 terminalType / sshHost，表达形态）...
  kind?: ConversationKind        // 默认推断：agentKey==='__companion__'→companion，'__watch__'→watch，否则 task
}
```

- **形态复用现有 `terminalType` + `sshHost`**，不新增 `workbenchType`（重复字段）。
- **不加 `title`**：标题继续从 `userTask` 首句派生（`AgentHistorySummary` 现有做法）；仅当将来要做"用户重命名会话"时再加。

**删除**已建的平行类型 `ConversationRecord` / `ConversationMessage` / `ConversationStep`（违反"共享类型唯一数据源"规则，且基于"AgentRecord 是单任务"的误判）。

## 五、现有代码迁移映射

| 现有代码 | 迁移到 | 说明 |
|---|---|---|
| `HistoryService` 的文件 IO / 索引 | `ConversationStore` | 纯 IO |
| `HistoryService` 的查询 / 搜索 / 列表 | `ConversationManager` | 业务 |
| `HistoryService` 对外接口 | 暂留为适配器，内部转调 Store/Manager | 渐进 |
| `Agent._sessionMessages / _sessionSteps` | `Conversation._messages / _steps` | 真相源 |
| `Agent._previousRunMessages` | `Conversation._cachePrefix` | 派生投影 |
| `Agent.taskMemory` | `Conversation._taskMemory` | 投影，归会话所有 |
| `Agent.buildContext`（cache/冷启动部分） | `Conversation.buildLLMContext`（纯） | L2/L3 富化留 Agent |
| `Agent.finalizeRun` + checkpoint 状态写入 | `Conversation.commitRun` | |
| `Agent.restoreFromHistory / restoreFromSessionRecord` | `Conversation.fromRecord`（重建 taskMemory） | |
| `Agent.restoreRecentTaskMemory`（companion 回种） | `Manager.resolveForRun` 读 `policy.seedFromHistoryOnColdStart` | 去掉 `_persistentNamedAgent` 分支 |
| `_suppressSessionSeed` / `_persistentNamedAgent` | `Manager._suppressSeed` + `CONVERSATION_POLICY` | 数据驱动 |
| `AgentService.startNewSession/resetSession/fork` | `Manager.create/reset/fork` | 生命周期上移 |
| `Agent.run(message, ctx)` | `Agent.run(conversation, message, ctx)` | 无状态化 |

## 六、迁移计划（测试先行 + 逐步替换；**不搞双模型 feature flag**）

> 在 `_session*` + cache + restore 这段最反直觉的代码上重构，没有测试网必然招回老 bug。

### 阶段 0：织特征测试网（最关键的前置，不改生产代码）✅
- [x] `conversation-characterization.test.ts`（真实 HistoryService 磁盘往返）锁定 8 条不变量：
  - ① cache 前缀复用（同 session 第二轮复用上一轮完整 messages）
  - ② 内心独白隔离（wakeup 不复用上一轮原始对话作前缀）
  - ③ 会话漫游（同形态：同 sessionId 换 Agent 续写、不裂记录）
  - ④ reset 后全新会话（清空工作记忆）
  - ⑤ watch 历史隔离（`__watch__` 进独立树、不污染主索引）
  - ⑥ **reasoning_content 回传**（带 tool_calls 的 assistant 下一轮仍带该字段，空串保留）—— commitRun/finalizeRun 搬迁最易丢
  - ⑦ **任务切分边界**（`_systemInjected` 不构成 user 边界，且经磁盘序列化存活）
  - ⑧ **任务分支 fork 完整拷贝到 fork 点**（`buildForkRecord` 无 untilTaskCount=全拷贝 / 有则截断，源记录不破坏）
- [x] 联络回种（跨重启续上同一条）+ reset 抑制回种由 `companion-restore.integration.test.ts` 覆盖
- 注：`createTaskFrom`（跨 kind 种子起头）是全新操作、无可观测旧行为可钉，留待其实现阶段 TDD（种子策略按 §2.5 延后）。
- **验证**：特征网 8/8 + companion 集成全绿（作为后续重构的红线）

### 阶段 1：模型补字段（存储 IO 已模块化，无需再拆）✅
- [x] 文件 IO 原语**已抽成纯函数** `electron/services/history/agent-storage.ts`（read/write/list/stats）；`ConversationStore` 将作为**薄封装命名类**复用它们 + 索引 + watch 路由（见 §4.3），而非重新实现 IO。
- [x] `shared/types`：加 `ConversationKind` + `COMPANION_AGENT_KEY`/`WATCH_AGENT_KEY` + `inferConversationKind`
- [x] `AgentRecord.kind` / `AgentHistorySummary.kind`（可选），`normalizeAgentRecord` 读盘时按 agentKey 推断补默认（向后兼容；写盘显式 kind 由阶段 2 `Conversation.toRecord` 负责）
- **验证**：history.service / 特征网 / companion 集成 / v6 迁移测试全绿（36/36）

### 阶段 2：抽 Conversation 聚合根（高价值高风险，在测试网下逐字段搬）✅
- [x] **2a** `ConversationStore` 薄封装（`HistoryService` 之上的存储接缝，复用 `agent-storage.ts`，含 watch 路由）
- [x] **2b-1** 把 `_session*` + `commitRun` + `fromRecord/toRecord` + 切分/cache 决策搬进 `Conversation`（数据模型 + 序列化），独立单测覆盖
- [x] **2b-2** Agent 持有/委托一个 `Conversation`：9 个 `_session*` 字段退化为只读委托 getter，唯一真相源归 Conversation
  - finalizeRun→`commitRun`、handleError→`commitFailedRun`、saveSessionToHistory→`toRecord`、restore→`setRestoredTranscript`、reset/startNew/fork→Conversation 生命周期；删除 `accumulateSessionData`
  - taskMemory 仍由 Agent **注入**（共享实例），保留 startNewSession 跨 session 记忆语义；完整所有权转移见阶段 3
  - 关键防回归：restoreRecent + restoreFromSessionRecord 共用 Agent 单调 `_restoreTaskSeq` 防 task id 碰撞；`terminalType` 成不可变形态后 forkAgent 同模式判定改为「undefined 或 'assistant'」
- **验证**：阶段 0 全部不变量保持（agent+conversation 815/815、services/watch 1314、CLI 53/0、真实 agent run 端到端、claude-review 无行为回归）

### 阶段 3：抽 ConversationManager + 策略表
- [ ] 生命周期（create/reset/fork/resolveForRun/list/search）从 Agent/AgentService 上移
- [ ] `_persistentNamedAgent`/`_suppressSessionSeed`/wakeup 分支 → `CONVERSATION_POLICY`
- [ ] Conversation 事件 → Manager → IPC 转发
- **验证**：Manager 正确加载现有会话；侧栏过滤 watch；联络回种走 policy

### 阶段 4：Agent 去状态化
- [ ] 删除 Agent 上已迁空的 `_session*` 字段，`run(conversation, …)`
- **验证**：全量回归

### 阶段 5：前端收尾
- [ ] IPC 仍是 plain object（AgentRecord），前端不感知 Conversation 类
- [ ] 逐步将"前端直接改 record"改为调 IPC 方法

## 七、文件结构

```
electron/services/conversation/
├── index.ts          # 公共导出
├── conversation.ts   # Conversation 聚合根
├── manager.ts        # ConversationManager
├── storage.ts        # ConversationStore（纯 IO）
├── policy.ts         # ConversationKind + CONVERSATION_POLICY
├── messages.ts       # 消息纯函数（复用 @shared/types）
└── __tests__/
    ├── characterization.test.ts  # 阶段 0 特征测试网
    ├── conversation.test.ts
    ├── manager.test.ts
    └── storage.test.ts
```

## 八、风险与红线

1. **红线①：不搞"新旧双模型 + feature flag 在同一份磁盘数据上并行跑"**——`cachePrefix` 等内存态切不干净。改用"测试网 + 逐步替换"。
2. **红线②：`agent.ts` 抽象层不得留 kind / 工具名字面量分支**——一律走 `CONVERSATION_POLICY` / `_meta` 元数据（见 `agent-oop-boundary.mdc`）。
3. **红线③：禁止平行类型**——`Conversation` 复用 `@shared/types` 的 `AgentRecord`/`AiMessage`/`AgentStep`。
4. **数据兼容**：`fromRecord` 必须容忍旧记录缺 `kind`（按 agentKey 推断默认）。
7. **形态不可变**：`terminalType`/`sshHost` 会话创建时确定，漫游不改；跨形态续聊走 `createTaskFrom`（避免历史工具名幻觉）。
5. **并发**：Agent 执行中用户 fork/reset——commit 与 fork 加简单序列化或快照。
6. **Conversation 纯度**：不引入任何 service/Electron 依赖，否则丧失可测性这一核心收益。

## 九、实现状态与待办

### 已建文件（现状）
早期基于"AgentRecord 是单任务"误判的平行脚手架（`ConversationRecord`/扁平 messages、`manager.ts`/`messages.ts`）**已删除并重写**。当前 `electron/services/conversation/` 下：
- `conversation.ts` —— §4.1 聚合根：真实 transcript（`_messages`/`_steps`）+ taskMemory（可注入）+ cachePrefix + token 账；`terminalType`/`sshHost` 不可变形态、`agentKey` 可变；`create`/`fromRecord`/`loadFromRecord`/`setRestoredTranscript`/`toRecord`/`commitRun`/`commitFailedRun`/`shouldReuseCachePrefix`/`reset`/`rebind`
- `storage.ts` —— §4.3 薄封装 `ConversationStore`（委托 `HistoryService`，含 main/watch 路由，**不重新实现 IO**）
- `index.ts` —— 导出 `Conversation`/`ConversationStore` + 类型
- `__tests__/conversation.test.ts`、`__tests__/storage.test.ts`
- **待建（阶段 3）**：`manager.ts`（ConversationManager）、`policy.ts`（kind + `CONVERSATION_POLICY`，承接 `_persistentNamedAgent`/`_suppressSessionSeed`/wakeup 分支 + taskMemory 所有权）

### 待办（非本次重构强约束，择期）
- [ ] **移除联络（companion）的"清空对话"功能**：让用户轻易清空长期关系线是设计失误且危险。至少应提高操作门槛或取消。改动点：`AiPanel.vue` 的清空按钮在 companion 入口的可见性（`CompanionWorkbench` 内嵌 `AiPanel`，按钮当前无条件渲染于 header）。
