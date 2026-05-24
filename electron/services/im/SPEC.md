# IM Service SPEC

> Last verified: 2026-05-24

## 职责

多平台即时通讯集成层。统一管理六平台（钉钉/飞书/企业微信/微信/Slack/Telegram）的连接、消息收发、入站消息→Agent 对话、Agent 回复→IM 渠道路由。每个平台有独立的启停 API（因配置和登录方式各异），通用功能通过"当前会话感知"的方法暴露。

## 文件 / 规模

多文件，主入口：`electron/services/im/im.service.ts`（~1607 行）

| 文件 | 行数 | 说明 |
|------|:---:|------|
| `im.service.ts` | 1607 | 核心调度：会话路由、平台生命周期、Agent 桥接、当前会话状态 |
| `types.ts` | 166 | 共享接口：`IMAdapter`、`IMServiceConfig`、`IMIncomingMessage`、`SendFileResult` 等 |
| `dingtalk-adapter.ts` | 608 | 钉钉适配器 |
| `feishu-adapter.ts` | 1088 | 飞书适配器（最大，含完整飞书 SDK 接入） |
| `wecom-adapter.ts` | 368 | 企业微信适配器 |
| `wechat-adapter.ts` | ~650 | 微信适配器（依赖 `wechat/` 子目录） |
| `slack-adapter.ts` | 358 | Slack 适配器 |
| `telegram-adapter.ts` | 407 | Telegram 适配器 |

## 公开 API（IMService，32 个 public 方法）

### 生命周期 / 配置

| 方法签名 | 用途 |
|---------|------|
| `setDependencies(deps: IMServiceDependencies): void` | 注入 agentService、historyService、aiService 等依赖（`main.ts` 启动时调用） |
| `setMainWindow(win): void` | 设置主窗口引用（用于桌面通知/前端事件推送） |
| `setExecutionMode(mode: ExecutionMode): void` | 设置 Agent 执行模式（strict/relaxed/free） |
| `setSendProcessMessages(enabled: boolean): void` | 是否将 Agent 中间过程消息推送到 IM |
| `setSendThinkingProcess(enabled: boolean): void` | 是否推送 Agent reasoning content（思考过程） |
| `registerAdapter(adapter: IMAdapter): void` | 注册自定义适配器（插件扩展点） |

### 钉钉

| 方法签名 | 用途 |
|---------|------|
| `async startDingTalk(config: DingTalkConfig): Promise<{success, error?}>` | 启动钉钉连接 |
| `async stopDingTalk(): Promise<void>` | 断开钉钉 |
| `isDingTalkConnected(): boolean` | 查询钉钉连接状态 |

### 飞书

| 方法签名 | 用途 |
|---------|------|
| `async startFeishu(config: FeishuConfig): Promise<{success, error?}>` | 启动飞书连接 |
| `async stopFeishu(): Promise<void>` | 断开飞书 |
| `isFeishuConnected(): boolean` | 查询飞书连接状态 |

### Slack

| 方法签名 | 用途 |
|---------|------|
| `async startSlack(config: SlackConfig): Promise<{success, error?}>` | 启动 Slack 连接 |
| `async stopSlack(): Promise<void>` | 断开 Slack |
| `isSlackConnected(): boolean` | 查询 Slack 连接状态 |

### Telegram

| 方法签名 | 用途 |
|---------|------|
| `async startTelegram(config: TelegramConfig): Promise<{success, error?}>` | 启动 Telegram 连接 |
| `async stopTelegram(): Promise<void>` | 断开 Telegram |
| `isTelegramConnected(): boolean` | 查询 Telegram 连接状态 |

### 企业微信

| 方法签名 | 用途 |
|---------|------|
| `async startWeCom(config: WeComConfig): Promise<{success, error?}>` | 启动企微连接 |
| `async stopWeCom(): Promise<void>` | 断开企微 |
| `isWeComConnected(): boolean` | 查询企微连接状态 |

### 微信（流程特殊：需先扫码登录）

| 方法签名 | 用途 |
|---------|------|
| `async loginWeChat(onCredentials?): Promise<{success, qrcodeUrl?, error?}>` | 启动微信扫码登录，回调返回登录凭证 |
| `async startWeChat(config: WeChatConfig): Promise<{success, error?}>` | 用 `loginWeChat` 拿到的凭证启动微信连接 |
| `async stopWeChat(): Promise<void>` | 断开微信 |
| `isWeChatConnected(): boolean` | 查询微信连接状态 |

### 统一操作（基于"当前活跃会话"）

| 方法签名 | 用途 |
|---------|------|
| `async stopAll(): Promise<void>` | 断开所有平台 |
| `getStatus(): IMServiceStatus` | 获取所有平台连接状态 |
| `getLastContact(): IMLastContact \| null` | 获取最近交互的联系人（跨平台） |
| `hasActiveSession(): boolean` | 是否有活跃 IM 会话 |
| `async sendNotification(text, options?): Promise<{success, platform?, error?}>` | 通用通知：自动选择最近联系平台投递 |
| `async sendFileForCurrentSession(filePath, fileName?): Promise<SendFileResult>` | 向当前会话发文件 |
| `async sendImageForCurrentSession(filePath): Promise<SendFileResult>` | 向当前会话发图片 |

## 核心类型 / 接口

```ts
type IMPlatform = "dingtalk" | "feishu" | "slack" | "telegram" | "wecom" | "wechat"
type ExecutionMode = "strict" | "relaxed" | "free"

interface IMAdapter {
  platform: IMPlatform
  start(config): Promise<{ success: boolean; error?: string }>
  stop(): Promise<void>
  isConnected(): boolean
  sendMessage(targetId, content, opts?): Promise<{ success: boolean; error?: string }>
  sendFile?(targetId, filePath, opts?): Promise<SendFileResult>
  onMessage(callback: (msg: IMIncomingMessage) => void): () => void
}

interface IMIncomingMessage {
  platform: IMPlatform
  contactId: string; contactName?: string
  content: string; timestamp: number
  messageId?: string; isGroup?: boolean; groupId?: string
  attachments?: IMAttachment[]
}

interface IMServiceDependencies {
  agentService: AgentService
  historyService?: HistoryService
  aiService?: AiService
  configService?: ConfigService
}

interface IMLastContact {
  platform: IMPlatform; contactId: string; contactName?: string
  isGroup?: boolean; groupId?: string; timestamp: number
}

interface SendFileResult { success: boolean; error?: string; messageId?: string }
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `AgentService` | **必需** | 通过 `IMServiceDependencies` 注入；入站消息进 Agent，Agent 回复出 IM |
| `HistoryService` | 可选 | 通过 `IMServiceDependencies` 注入；记录会话上下文 |
| `AiService` | 可选 | 通过 `IMServiceDependencies` 注入；某些适配器（如飞书图文）需要 |
| `EventBus`（`getEventBus()`） | 可选 | 平台连接事件全局广播 |

## 关键行为 / 数据流

**入站消息 → Agent 对话**：
1. 适配器内部 SDK 收到消息 → `onMessage` 回调
2. → IMService 内部把消息构造为 `IMIncomingMessage`，记录 `lastContact`
3. → 通过 `agentService.run(message, context)` 启动 Agent 任务
4. → Agent 输出（含中间过程，受 `setSendProcessMessages` 控制）通过 `adapter.sendMessage` 发回原平台

**手动发通知（来自 Agent 工具或外部触发）**：
1. `sendNotification(text)` 检查 `lastContact` → 选定目标平台
2. → 调用对应适配器的 `sendMessage(targetId, text)`

**微信登录的两阶段流程**（其它平台单步）：
1. `loginWeChat(onCredentials)` → 启动扫码登录 → 凭证回调
2. → 用户保存凭证后，再调 `startWeChat(config)` 完成连接

**微信适配器（WeChatAdapter）长轮询可靠性设计**：
- `startPolling` 启动时：先立即 `setConnected(true)` + 启动 `pollLoop`，再后台并发发 `notifyStart`（不阻塞接收）。之前 `notifyStart` 串行阻塞时，若请求挂起会导致 `pollLoop` 迟迟不启动，造成"重启后收不到消息"。
- session 过期（`errcode=-14`）：`pauseSession` 暂停 1h 后自动 `continue` 继续轮询（自愈），不再 `break` 导致 loop 永久停止。
- `getUpdatesBuf` 游标持久化到 `~/.openclaw/openclaw-weixin/accounts/<accountKey>.sync.json`，进程重启后恢复，避免漏消息。
- `context_token` 失效 (`errcode=-2`) 自愈（出站侧）：`WeChatAdapter.withSendRetry` 捕捉到 `errcode=-2` 时执行三步——`invalidateUser` 清缓存、`getForUser` 用最新 token 重新注册服务端 session、若有正在运行的 keepalive 则一并重启拉新 `typing_ticket`，然后用新 token 重试一次发送。仍失败则向上抛错，由 `IMService` 通过 `notifyWechatSendFailure` 兜底。
- `context_token` 失效 (`errcode=-2`) 自愈（入站侧）：每条 inbound 消息携带新 `context_token`；若与上次不同，`handleMessage` 立即 `invalidateUser` + `await getForUser` 重新注册（对齐上游 `monitor.ts`），避免下次出站撞 `-2`。
- **`sendTyping` 错误暴露**：通过 `scripts/vendor-wechat-transforms.mjs` 给 vendored `sendTyping` 加 errcode 解析，把响应体的 `errcode/ret != 0` 转成抛错，避免 keepalive "假活"（5 秒一次全是错误响应但调用方一无所知）。
- **`typing keepalive` 自愈**：`startTypingKeepalive` 的 fire 闭包追踪 `consecutiveFailures`，每次失败计数 +1、成功重置 0；连续失败到 `KEEPALIVE_FAIL_THRESHOLD`（=3）时自动调用 `restartTypingKeepalive`——执行 `invalidateUser` + `getForUser` 拿新 ticket 后重启 keepalive，治标 `context_token`/`typing_ticket` 中途失效场景。
- **`typing keepalive` 生命周期**：对齐上游 `createReplyDispatcherWithTyping`——`IMService.runAgentTask` 在任务开始时调 `beginOutboundSession`，`finally` 调 `endOutboundSession`；**不在**每条 `sendText` 时停止 keepalive（否则长任务约 2–3 分钟后出站失败）。同时设有 `TYPING_KEEPALIVE_LEAK_MS`（3h）泄漏保护，避免遗漏 `endOutboundSession` 时永久挂着。
- **微信发送失败的桌面兜底**：`IMService.notifyWechatSendFailure(reason?)` 在 `sendText`/`sendMarkdown`/`sendImage` 失败时调用，做两件事：(a) 尝试再发一条"请再发一条消息恢复对话"提示（错误恰好在 `-2` 重试成功窗口时能送达）；(b) 通过 IPC `im:sendFailure` 推送 `{ platform, userId, userName, reason }` 给桌面前端。整个会话内幂等（`wechatSendFailedNotified` 标志），不会刷屏。
- **IM 投递工具失败必推送到聊天**：`send_file_to_chat` / `send_image_to_chat` / `send_to_chat` 的 `tool_result` 失败会经 `IMService` 发到当前 IM 会话（与 `sendProcessMessages` 无关），避免错误仅出现在桌面 Companion 面板。

**适配器架构**：每个平台一个 `*Adapter`，构造时从 `getEventBus()` 拿事件总线，注册到 IMService 的 `adapters: Map<IMPlatform, IMAdapter>` 中。

## 关键约束

- **每个平台必须实现 `IMAdapter` 接口**——新增平台必须走该接口规范
- **入站消息处理在 IMService 内集中**——适配器只能通过 `onMessage` 回调上报，**严禁**适配器内部直接调 `agentService.run`
- **微信连接必须先 `loginWeChat` 拿凭证**——不得跳过登录直接 `startWeChat`
- **`sendNotification` 依赖 `lastContact`**——无活跃会话（`hasActiveSession()` 返回 false）时返回 `success: false`
- **平台连接失败必须返回 `{success: false, error}`**，不得静默或抛异常
- **不得在 `setDependencies` 之前调任何 `start*` 方法**
