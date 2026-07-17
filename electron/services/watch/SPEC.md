# Watch Service SPEC

> Last verified: 2026-07-17

## 职责

定时/事件驱动的自动化任务引擎。Watch 是 Agent 的"关注点"配置，按 cron 或事件触发器执行 prompt（assistant 模式）或 PTY 命令（pty 模式），结果通过桌面通知/终端标签页/IM 渠道派发。新版废弃了独立 Scheduler，旧 Scheduler 数据通过 `migrateFromScheduler` 迁移。

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
| `cancelRunningWatch(id: string): boolean` | 取消正在执行的关切（abort Agent/PTY）；未在跑返回 false |
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
| `getSshSessions(): SshSession[]` | 获取可用 SSH 会话（创建 PTY 模式 Watch 时选目标） |
| `migrateFromScheduler(schedulerStore): {migrated, skipped, errors[]}` | 从废弃的 Scheduler 一次性迁移数据（启动时自动调用） |

## 核心类型 / 接口

```ts
interface WatchServiceConfig {
  ptyService: PtyService; sshService: SshService
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
| `PtyService` | **必需** | PTY 模式执行命令 |
| `SshService` | **必需** | 远程 SSH 会话执行 |
| `ConfigService` | **必需** | 持久化设置 |
| `AgentService` | **必需** | Assistant 模式调用 Agent |
| `AiService` | **必需** | Agent 内部依赖（间接） |
| `SensorService` | **必需** | 传感器事件源 |
| `HistoryService` | 可选 | 对话上下文召回 |
| `IMService`（`getIMService()`） | 可选 | 结果推送 IM 渠道 |
| `EventBus` | 可选 | 全局事件广播 |

## 关键行为 / 数据流

**Watch 执行生命周期**：
1. cron/事件触发 → `EventPool` 消抖合并 → `handleEvent(event)`
2. → `findMatchingWatches(event)` → 命中的 Watch 列表
3. → 对每个 Watch 调用 `executeWatch(watch, event)` → 按 mode 分支：
   - **assistant**：`executeWithAssistantAgent` → Agent 用 `__watch__` 守护 ID 执行
   - **pty**：`executeWithPtyAgent` → 在指定 PTY/SSH 会话执行命令
4. → `WatchExecutionResult` → `deliverOutput(watch, result, silent)` 派发（**极窄兜底，用户可见消息走 `talk_to_user`**）：
   - `silent`（唤醒 / desktop 自动触发）或已调 `talk_to_user` → **不派发**
   - `output.type === 'im'` 且未调 `talk_to_user` → **不派发**（无「已完成」类通知）
   - 仅非静默 + 手动触发 + 应用不在前台：`desktop` / `notification` 可走 IM / 系统通知
   - 执行失败走 `notifyFailure`，不经 `deliverOutput`

**事件消抖**：`EventPool` 在静默窗口内合并同类型事件，触发后清空。

**心跳机制**：`HEARTBEAT_FILENAME` 是所有 Watch 共享的执行节流锁，防止并发执行；`ensureWakeup` / `removeWakeup` 控制"唤醒态"——AI 主动询问用户后等待回复时不再执行新触发。

**联络上下文注入**：`buildEnhancedPrompt` 在**所有** Watch（含内置 `__wakeup__` 心跳）执行前，经 `Companion.formatRecentTurnsForWatchPrompt()` 从 `__companion__` 合并视图取最近 **50 条** user↔AI 纯文本（完整原文，不截断；合并最多 50 条 companion record），注入 prompt（10s TTL 缓存；`talk_to_user` 落盘后调用 `invalidateCompanionContextCache()` 失效）。**优先读 merged steps**（含 `__proactive__` 的 `proactive_notice`）；`mergedMessages` 排除 proactive record，不可作为唯一数据源。无 steps 时回退 messages（老记录）。联络 tab 展示仍用 `RECENT_RECORDS_LIMIT = 10`，与心跳注入范围分离。

## 关键约束

- **方法名遵循 store 风格**（`create` / `update` / `get` / `getAll` / `delete` / `toggle`），**不是** `createWatch`/`updateWatch`/...
- **assistant 模式必须使用 `__watch__` agentId**——不污染用户对话历史
- **`init()` 必须在 `start()` 之前调用**——依赖在 init 时冻结，运行时不可改
- **PTY 模式输出受 `MAX_OUTPUT_LENGTH` 截断**——`HistoryStore` 也对单条记录有上限
- **EventPool 消抖时间不得硬编码**——必须从 Watch 定义读取
- **心跳文件由 `HEARTBEAT_FILENAME` 唯一管理**——禁止任何代码自建心跳锁
- **`migrateFromScheduler` 是一次性操作**——重复调用以现存 Watch 为准（去重）
- **`updateWatchState` 是 Agent 状态更新接口**——禁止外部直接调用，必须经 Agent 的 `STATE_UPDATE` 指令
