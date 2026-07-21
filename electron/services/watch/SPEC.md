# Watch Service SPEC

> Last verified: 2026-07-21

## 设计目标

### 关切 = 后台执行 + 面板透明 + 需要时找人（2026-07-21）

- **问题**：曾用 `output` 分流「助手 vs 绑 PTY」；silent/local 走 PTY 不推步骤，关切面板假「正在启动」，过程黑盒。PTY 路径并非 CLI 无头设计，而是旧实现残留。
- **成功标准**：
  - 关切 Agent **一律本机助手形态**（`__watch__:${watchId}` / wakeup 用 `__wakeup__`）；需要跑命令时用 `exec` 等工具，**不再为关切创建/绑定专用 PTY**。
  - 执行过程一律进关切面板（`agent:step`）；手动触发必开内心独白。
  - 后台无确认 UI，执行模式为 `free`（避免卡在 dangerous 确认上）。
  - 不进任务面板；需要打扰用户时走 `talk_to_user` → 联络（关切存在的目的）。
  - `output` 只影响对外派发/打扰策略，**不再选择执行形态**。
- **明确不做**：不为 silent 保留 PTY 旁路；不把每次执行灌进任务侧栏。

### 不同 Watch 允许并发（2026-07-21）

- **问题**：EventBus + `handleEvent` 串行 `await`，且曾共用单一 `__watch__` Agent，导致不同关切互相堵。
- **成功标准**：
  - **不同** `watchId` 可并行；**同一** `watchId` 互斥。
  - **wakeup** 自身单实例，可与普通关切并行。
  - 全局并发软上限默认 **5**；超额排队不丢弃。
  - 每关切独立 Agent：`__watch__:${watchId}`；历史 `kind=watch`。
- **明确不做**：不改 companion / 任务并行模型；不无限并发。

## 职责

定时/事件驱动的自动化任务引擎。Watch 是 Agent 的「关注点」：后台用本机助手 Agent 执行 prompt，过程在关切面板可见，需要时经 `talk_to_user` 进联络。旧 Scheduler 已迁移进关切系统。

## 文件 / 规模

多文件，主入口：`electron/services/watch/watch.service.ts`（~1677 行）

| 文件 | 行数 | 说明 |
|------|:---:|------|
| `watch.service.ts` | 1677 | 核心引擎：调度、事件匹配、Agent 执行、结果派发、心跳管理 |
| `store.ts` | 218 | 持久化存储：Watch 定义 + 执行历史 |
| `event-pool.ts` | 256 | 事件池：消抖、批量合并 |
| `templates.ts` | 290 | 预置模板（8 个内置模板） |
| `types.ts` | 24 | 共享类型 |

## 公开 API（WatchService，25 个 public 方法）

### 生命周期 / 注入

| 方法签名 | 用途 |
|---------|------|
| `init(config: WatchServiceConfig): void` | 初始化引擎（注入依赖、加载持久化数据） |
| `async start(): Promise<void>` | 启动调度器与传感器，激活已启用的 Watch |
| `stop(): void` | 停止引擎 |
| `setMainWindow(win: BrowserWindow \| null): void` | 设置主窗口（桌面通知/标签页通道） |

### Watch CRUD

| 方法签名 | 用途 |
|---------|------|
| `create(params: CreateWatchParams): WatchDefinition` | 创建 Watch（**注意**：不是 `createWatch`） |
| `update(id, updates: Partial<CreateWatchParams>): WatchDefinition \| null` | 更新 Watch |
| `delete(id: string): boolean` | 删除 Watch |
| `get(id: string): WatchDefinition \| undefined` | 获取单个 Watch |
| `getAll(): WatchDefinition[]` | 获取全部 Watch |
| `toggle(id: string): WatchDefinition \| null` | 启停切换 |

### 执行 / 状态

| 方法签名 | 用途 |
|---------|------|
| `async triggerWatch(id): Promise<WatchExecutionResult>` | 手动触发一次执行 |
| `isWatchRunning(id: string): boolean` | 单个 Watch 是否在执行 |
| `getRunningWatches(): string[]` | 当前正在执行的 Watch ID 列表 |
| `cancelRunningWatch(id: string): boolean` | 取消正在执行的关切（abort 助手 Agent）；未在跑返回 false |
| `updateWatchState(id, state: Record<string, unknown>): void` | 更新 Watch 自定义状态（Agent 通过 `STATE_UPDATE` 指令调用） |

### 历史

| 方法签名 | 用途 |
|---------|------|
| `getHistory(watchId?, limit?): WatchHistoryRecord[]` | 获取执行历史 |
| `clearHistory(watchId?): void` | 清空历史 |

### 模板

| 方法签名 | 用途 |
|---------|------|
| `getTemplates(): WatchTemplate[]` | 全部模板 |
| `getTemplateCategories(): {id, name, nameEn}[]` | 模板分类列表 |
| `createFromTemplate(templateId, options?): WatchDefinition` | 从模板创建 Watch |

### 关切心跳 / 唤醒

| 方法签名 | 用途 |
|---------|------|
| `ensureWakeup(): boolean` | 确保唤醒态心跳文件存在 |
| `removeWakeup(): void` | 清除唤醒态 |
| `resetHeartbeatFile(): boolean` | 重置心跳文件 |

### 环境查询 / 数据迁移

| 方法签名 | 用途 |
|---------|------|
| `getSshSessions(): SshSession[]` | 获取可用 SSH 会话（兼容旧创建 UI；执行已统一助手，不再绑 SSH PTY） |
| `migrateFromScheduler(schedulerStore): {migrated, skipped, errors[]}` | 从废弃的 Scheduler 一次性迁移数据（启动时自动调用） |

## 核心类型 / 接口

```ts
interface WatchServiceConfig {
  configService: ConfigService; agentService: AgentService
  aiService: AiService; sensorService: SensorService
  historyService?: HistoryService
  mainWindow?: BrowserWindow | null
}

interface WatchTemplate {
  id: string; name: string; nameEn: string
  description: string; descriptionEn: string
  category: string; icon: string
  create: (options?) => CreateWatchParams
}

// WatchDefinition、CreateWatchParams、WatchHistoryRecord、
// WatchExecutionResult、SensorEvent 等定义在 shared/types/watch.ts
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `ConfigService` | **必需** | 持久化设置 / SSH 会话列表（兼容） |
| `AgentService` | **必需** | 本机助手 Agent 执行关切 |
| `AiService` | **必需** | Agent 内部依赖（间接） |
| `SensorService` | **必需** | 传感器事件源 |
| `HistoryService` | 可选 | 对话上下文召回 |
| `IMService`（`getIMService()`） | 可选 | 结果推送 IM 渠道 |
| `EventBus` | 可选 | 全局事件广播 |

## 关键行为 / 数据流

**Watch 执行生命周期**：
1. cron/事件触发 → `EventPool` 消抖合并 → `handleEvent(event)`（派发后即返回，不等执行结束）
2. → `findMatchingWatches(event)` → 命中的 Watch 列表
3. → 调度器按全局并发上限（默认 5）排队/放行 → `executeWatch` → **一律** `executeWithAssistantAgent`（`__watch__:${watchId}` / wakeup 用 `__wakeup__`）；步骤经 `agent:step` 推关切面板
4. → `WatchExecutionResult` → `deliverOutput`（**极窄兜底，用户可见消息走 `talk_to_user`**）：
   - 自动触发 / wakeup / 已调 `talk_to_user` → **不派发完成通知**
   - `output.type === 'im'` 且未调 `talk_to_user` → **不派发**
   - 仅手动触发且应用不在前台时，`desktop` / `notification` 可走 IM / 系统通知兜底
   - 执行失败走 `notifyFailure`

**事件消抖**：`EventPool` 在静默窗口内合并同类型事件，触发后清空。

**并发模型**：不同 `watchId` 可并行；同一 `watchId` 互斥；wakeup 可与普通关切并行；全局软上限默认 5，超额排队不丢弃。

**心跳机制**：`HEARTBEAT_FILENAME` 为 Agent 可读的心跳上下文文件（非全局执行锁）；`ensureWakeup` / `removeWakeup` 控制"唤醒态"。

**联络上下文注入**：`buildEnhancedPrompt` 在**所有** Watch（含内置 `__wakeup__` 心跳）执行前，经 `Companion.formatRecentTurnsForWatchPrompt()` 从 `__companion__` 合并视图取最近 **50 条** user↔AI 纯文本（完整原文，不截断；合并最多 50 条 companion record），注入 prompt（10s TTL 缓存；`talk_to_user` 落盘后调用 `invalidateCompanionContextCache()` 失效）。**优先读 merged steps**（含 `__proactive__` 的 `proactive_notice`）；`mergedMessages` 排除 proactive record，不可作为唯一数据源。无 steps 时回退 messages（老记录）。联络 tab 展示仍用 `RECENT_RECORDS_LIMIT = 10`，与心跳注入范围分离。

## 关键约束

- **方法名遵循 store 风格**（`create` / `update` / `get` / `getAll` / `delete` / `toggle`），**不是** `createWatch`/`updateWatch`/...
- **执行形态**：关切一律本机助手 Agent（`__watch__:${watchId}` / `__wakeup__`）；禁止再为关切创建专用 PTY
- **过程透明**：执行步骤必须推关切面板；`output` 只约束对外打扰，不关掉面板可见性
- **后台执行模式**：`executionMode: 'free'`（面板隐藏 confirm，否则会卡在 dangerous 工具）
- **旧 `execution.type=ssh`**：不再连 SSH PTY，回退本机助手并打 warn；远程巡检需另方案（如 SSH 工具）
- **`init()` 必须在 `start()` 之前调用**——依赖在 init 时冻结，运行时不可改
- **落盘输出受 `MAX_OUTPUT_LENGTH` 截断**——`HistoryStore` 也对单条记录有上限
- **EventPool 消抖时间不得硬编码**——必须从 Watch 定义读取
- **心跳文件由 `HEARTBEAT_FILENAME` 唯一管理**——禁止任何代码自建心跳锁
- **`migrateFromScheduler` 是一次性操作**——重复调用以现存 Watch 为准（去重）
- **`updateWatchState` 是 Agent 状态更新接口**——禁止外部直接调用，必须经 Agent 的 `STATE_UPDATE` 指令
- **同 Watch 不重入**；**全局并发默认上限 5**（超额排队）
- **前端内心独白**：手动触发 / 运行中在关切面板展示过程（与 `output` 类型无关）
