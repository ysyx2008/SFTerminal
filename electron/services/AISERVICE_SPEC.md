# AiService SPEC

> Last verified: 2026-08-17

## 职责

AI API 的统一调用层。封装 OpenAI 兼容协议的 HTTP 请求，提供同步/流式、纯对话/工具调用四种模式。处理代理、超时、重试、中止、多模态降级等底层复杂性，上层服务只需传入消息和工具定义。

## 设计目标

### 发给视觉接口的图必须是接口认的格式

请求里的图片若不是常见位图（png / jpeg / gif / webp / bmp），不要发出去——文档抽图应已先转成位图，这里挡住残留。若接口仍因图片格式拒收（例如「Invalid base64 image_url」），剥掉图片用正文重试，不得让整次任务失败。

### 单次输出上限不要让用户猜

用户不必知道该填多少。没填时按三万二——现在主流模型都吃得下，也够一次思考再写一大段。拉模型列表时，如果对方告诉了这款模型的输出上限，选中就按这个数用，不要丢掉。用户自己填了的仍然听用户的。不为每家模型维护一份手写上限表。

### 自动重试要对用户说清楚

网络抖动、接口限流、服务端临时出错时会自动再试，但再试本身也可能再等很久（连不上、模型一直不回）。用户不能只看到「几秒后重试」然后干等、以为卡住了。

成功标准：
- 开始等重试间隔时，说清原因、第几次、还要等几秒；秒数要倒数，不能写死一个数字干等
- 间隔一过、请求已经发出去，立刻改成「正在重试、等待模型」
- 这一轮结束（成功、再试下一次、或彻底失败），卡片收成「已重试第几次」
- 彻底失败时，错误本身也要说已经自动重试过，不要只丢一句超时

明确不做：不把内部超时秒数摊给用户；不让用户配置重试次数。

## 文件

单文件：`electron/services/ai.service.ts`（~2316 行）

## 公开 API

| 方法 | 用途 | 调用方 |
|---|---|---|
| `constructor(configService?)` | 注入与主进程/CLI **同一** `ConfigService` 单例（禁止再 `new ConfigService()`） | `main.ts` / CLI |
| `onProfileFallback(listener)` | 指定 profileId 失效并已回退时回调；返回取消订阅 | `main.ts`（toast）、Agent（步骤提示） |
| `setPluginProviders(providers: ProviderRegistration[])` | 注入插件 AI provider（启动时调用） | `main.ts` 插件加载阶段 |
| `chat(messages, profileId?)` | 纯文本对话（同步） | 知识文档更新、对话索引等后台任务 |
| `chatStream(messages, onChunk, onDone, onError, profileId?)` | 纯文本对话（流式） | 前端 AI 对话面板 |
| `chatWithTools(messages, tools, profileId?)` | 工具调用（同步） | Agent 非流式路径（较少使用） |
| `chatWithToolsStream(messages, tools, onChunk, onToolCall, onDone, onError, profileId?, onToolCallProgress?, requestId?, onRetry?, onToolCallReady?)` | 工具调用（流式）。`onToolCallProgress(id, name, partialArgs)` 在 tool_call 参数流式片段到达时回调，`partialArgs` 为截至当前的完整 JSON 前缀，Agent 据此在"生成参数"阶段即可显示该工具卡片的实时命令文本。`onRetry(retryInfo?)` 在网络错误 / 429 / 5xx 触发自动重试前调用，`retryInfo` 包含 `{ attempt, max, delayMs, reason, statusCode? }`，用于在 UI 上展示「正在重试 N/M」避免用户误以为应用卡死；同时承担"重置已流出脏内容"职责（提供 onRetry 时上层 onChunk 不再收到 `⚠️ 重试中` 文本，由调用方自行渲染）。视觉降级等内部重试不传 `retryInfo`。 | Agent 主执行路径 |
| `abort(requestId?)` | 中止请求 | Agent.abort()、用户取消 |
| `dispose()` | 释放 keep-alive HTTP/HTTPS Agent；CLI 退出前调用避免进程空转 | `electron/cli/index.ts` agent:run finally |
| `static getExplainCommandPrompt(command)` | 命令解释 prompt 模板 | 前端命令解释功能 |
| `static getDiagnoseErrorPrompt(error, context?)` | 错误诊断 prompt 模板 | 前端错误诊断功能 |
| `static getNaturalToCommandPrompt(description, os?)` | 自然语言→命令 prompt 模板 | 前端命令生成功能 |

## 核心类型 / 接口

| 类型 | 说明 |
|------|------|
| `AiMessage` | 消息格式（role + content + 可选 images/tool_calls/reasoning_content/tool_call_id） |
| `ToolDefinition` | Function Calling 工具定义（name + description + parameters schema） |
| `ToolCall` | AI 返回的工具调用（id + name + arguments JSON） |
| `ChatWithToolsResult` | 工具调用结果（content + tool_calls + finish_reason + usage + aborted） |
| `ApiRequestError` | API 请求错误（statusCode + retryAfter + apiErrorCode） |
| `RetryInfo` | 重试信息（attempt + max + delayMs + reason + statusCode） |
| `TokenUsageInfo` | Token 消耗统计（prompt + completion + total + cache_hit/miss） |
| `AnthropicStreamDelta` | Anthropic 流式增量（content/reasoning_content/tool_calls/finish_reason/usage） |
| `AiContentPart` | 多模态内容块（text \| image_url） |

注：`AiProfile` 来自 `@shared/types`，非本文件定义。

## 依赖

- **ConfigService**：获取 AI 配置档案（profiles）、代理设置
- **AiDebugService**：调试日志（请求/响应追踪）

## 关键行为

### 多 Profile 支持

通过 `profileId` 选择使用哪个 AI 配置。未指定时使用 `configService.getActiveAiProfile()` 返回的默认档案。

解析逻辑见导出纯函数 `resolveAiProfile`：
- 列表为空 → 抛/回调 `error.ai_no_config`
- 指定 id 命中 → 使用该配置
- **指定 id 未命中但列表非空** → 回退到 active（再不行则第一个），并 `onProfileFallback` 通知 UI（toast + Agent 步骤流），避免误报「未配置」
- 未指定 id 时 active 失效 → 同样回退到第一个并通知

`AiService` 必须与设置页/Agent 共用同一 `ConfigService` 实例，否则会出现「设置已更新但请求仍读旧列表 / id 对不上」的双缓存问题。

### 代理支持

支持 HTTP/HTTPS/SOCKS5 代理。优先级：Profile 自带代理 > 全局代理设置。

### 超时机制

三层超时保护：
- 连接超时：15s
- 空闲超时：120s（流式数据中断检测）
- 总超时：10min

### 自动重试

| 错误类型 | 最大重试 | 退避策略 |
|---|---|---|
| 网络错误（`err.code`：ECONNRESET / EPROTO / ETIMEDOUT 等；含 TLS 握手中断） | 3 次 | 指数退避 + jitter，基础 2s。判定优先看 Node 系统错误码，不只扫 message（VPN/代理切换时 TLS 断开的 message 常不含错误码字样） |
| Rate Limit (429) | 5 次 | 指数退避 + jitter，基础 5s（优先 `Retry-After` header） |
| 服务端错误 (5xx) | 3 次 | 指数退避 + jitter，基础 3s |

调用方提供 `onRetry` 时可拿到重试信息（第几次、最多几次、还要等几秒、原因；超时会单独标出来）以驱动界面。Agent 路径用一张持续更新的等待卡片：先说「多久后重试」，请求发出后改成「正在重试、等待模型」，结束后收成「已重试第几次」。彻底失败的错误文案也要写明已经自动重试过。

### 多模态降级

请求含图片时，如果 API 返回不支持图片，或因图片本身格式无效而拒收，自动剥离图片用正文重试。不支持的图片格式在发出前就会丢掉，避免无谓打到视觉模型。

### Think 模型支持

支持 DeepSeek-R1 / DeepSeek V3.2+ 等模型的 `reasoning_content` 字段，流式输出时包裹在折叠 HTML 块中。

**DeepSeek V3.2+ 思考模式 + 工具调用的严格规则**（[官方文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)）：带有 `tool_calls` 的 assistant 消息在后续所有请求中必须回传 `reasoning_content` 字段，否则 API 返回 400（`The reasoning_content in the thinking mode must be passed back to the API`）。

`formatMessageForApi` 中对带 `tool_calls` 的 assistant 消息始终输出 `reasoning_content` 字段（缺失时补空串），以同时兼容：

- DeepSeek V3.2+ 思考模式（必须回传）
- DeepSeek R1 / 非思考模式（回传被忽略，无副作用）
- OpenAI 及其他 OpenAI 兼容 API（忽略未知字段）
- Anthropic 原生 API（走 `convertToAnthropicBody` 单独转换，不受影响）

流式收集处用 `hasReasoningOutput` 标志（是否收到过 `delta.reasoning_content`）而非字符串非空作为"是否思考模式"的判定依据，避免空字符串被 `||` 转为 `undefined` 后在后续请求中字段消失。

### 中止机制

每个请求关联一个 `AbortController`，通过 `requestId` 索引。`abort()` 调用时销毁 HTTP 请求，流式回调安全收尾（返回已收到的部分结果）。

## 关键约束

- **API 协议必须保持 OpenAI 兼容**——不得引入厂商专有扩展作为必需路径，Anthropic 格式必须在 `convertToAnthropicBody` 中透明转换
- **并发安全靠 `requestId` → `AbortController` 映射保证**——严禁跨 requestId 共享 AbortController
- **流式完成回调必须幂等**——`complete()` 函数必须只 trigger 一次
- **重试逻辑封装在 `chatWithToolsStream` 内部**——调用方不得自行实现重试
- **Think 模型 reasoning_content 必须回传**——带 `tool_calls` 的消息在后续请求中缺此字段必 400
- **AiService 不得理解消息内容或工具语义**——纯传输层，判断逻辑在上层
