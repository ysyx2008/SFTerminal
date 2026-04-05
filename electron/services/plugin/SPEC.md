# Plugin 子系统 SPEC

> Last verified: 2026-04-03

## 职责

为 SailFish 提供插件扩展机制。插件可注册自定义工具、AI Provider、IM 渠道、Hook 拦截和 HTTP 路由，无需修改宿主源码。Manifest 格式兼容 OpenClaw `openclaw.plugin.json` 规范。

## 公开契约（Breaking Change 需要走 deprecation 流程）

以下接口一旦有插件依赖就不可随意更改：

### Manifest 格式

文件名固定为 `openclaw.plugin.json`，必须包含：

| 字段 | 类型 | 约束 |
|------|------|------|
| `id` | string | 必填，插件唯一标识 |
| `configSchema` | object | 必填，JSON Schema（无配置传 `{}`） |

可选字段：`name`, `description`, `version`, `enabledByDefault`, `channels`, `providers`, `contracts`, `skills`

### 插件入口签名

```typescript
interface PluginEntry {
  id: string
  register(api: PluginRegistrationAPI): void
  onUnload?(): void | Promise<void>
}
```

入口通过 `module.exports.default` 或 `module.exports` 暴露，必须有 `id`（string）和 `register`（function）。

### Registration API

`register(api)` 的 `api` 参数提供以下方法，签名即契约：

```typescript
api.registerTool(def: ToolRegistration, opts?: { optional?: boolean }): void
api.registerProvider(def: ProviderRegistration): void
api.registerChannel(def: ChannelRegistration): void
api.registerHook(event: HookEvent, handler: HookHandler): void
api.registerHttpRoute(method: string, path: string, handler: RouteHandler): void
```

### ToolRegistration 签名

```typescript
{
  name: string
  description: string
  parameters: object                    // JSON Schema
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolExecuteResult>
}
```

### ToolExecuteResult 格式

```typescript
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string }
  >
}
```

### HookEvent 枚举

`'before_tool_call' | 'after_tool_call' | 'before_ai_request' | 'message_sending'`

### HookDecision 返回

```typescript
{ block?: boolean; requireApproval?: boolean; cancel?: boolean }
```

### 工具命名规则

插件工具映射到 Agent 时命名为 `plugin_{sanitizedPluginId}_{sanitizedToolName}`，前缀 `plugin_` 固定。

### 插件发现路径

按优先级递减：配置路径 → `{userData}/plugins/` → `{userData}/plugins/node_modules/` → `~/.openclaw/extensions/`

## 内部实现（可自由重构）

以下为内部实现细节，不构成公开契约：

- `PluginRegistry` 类的内部字段和私有方法
- `PluginLoader` 的扫描策略和 import 实现
- `HookBus` 的 handler 存储结构
- `sdk-shim.js` / `sdk-shim-register.js` 的实现方式
- `installer.ts` 的 npm 命令拼接细节
- 与 `AgentService`、`GatewayService`、`AiService`、`IMService` 的内部对接方式

## 依赖

- 被 `AgentService`（工具注入）、`agent.ts`（Hook 触发）、`GatewayService`（HTTP 路由）、`AiService`（Provider）、`IMService`（Channel）消费
- 依赖 `ConfigService` 获取 allow/deny/entries 配置
- 依赖 `electron-log` 日志

## 类型定义

所有公开类型定义在 `types.ts` 中，导出供插件作者使用。参见 `docs/plugin-dev-guide.md`。

## 测试

`__tests__/plugin-contract.test.ts` — 契约测试，验证公开 API 稳定性。修改插件系统代码后此测试必须通过。
