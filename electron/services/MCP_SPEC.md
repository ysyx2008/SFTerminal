# MCP Service SPEC

> Last verified: 2026-05-07

## 职责

MCP（Model Context Protocol）客户端。连接和管理外部 MCP 服务器，聚合其提供的工具、资源和提示词，将工具定义转换为旗鱼内部 `ToolDefinition` 格式，供 Agent 发现和调用。

## 文件 / 规模

单文件：`electron/services/mcp.service.ts`（~615 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async connect(config): Promise<void>` | 连接 MCP 服务器（stdio 或 sse） | main.ts, CLI |
| `async disconnect(serverId): Promise<void>` | 断开指定服务器 | main.ts, CLI |
| `async disconnectAll(): Promise<void>` | 断开所有服务器 | 生命周期 |
| `getServerStatuses(): McpServerStatus[]` | 获取所有服务器连接状态 | UI/仪表盘 |
| `getAllTools(): McpTool[]` | 获取所有服务器的工具列表 | agent |
| `getAllResources(): McpResource[]` | 获取所有服务器的资源列表 | agent/knowledge |
| `getAllPrompts(): McpPrompt[]` | 获取所有服务器的提示词列表 | agent |
| `getToolDefinitions(): ToolDefinition[]` | 将工具转换为旗鱼内部工具定义格式 | agent tools registry |
| `async callTool(serverId, toolName, args): Promise<{success, content?, error?}>` | 调用指定服务器的工具 | agent |
| `async readResource(serverId, uri): Promise<{success, content?, mimeType?, error?}>` | 读取资源内容 | agent/knowledge |
| `async getPrompt(serverId, promptName, args?): Promise<{success, messages?, error?}>` | 获取服务器提示词模板 | agent |
| `async testConnection(config): Promise<{success, toolCount?, error?}>` | 测试服务器连接（不持久化） | 添加服务器前 |
| `async refreshServer(serverId): Promise<void>` | 刷新服务器的工具/资源列表 | UI/手动 |
| `isConnected(serverId): boolean` | 查询连接状态 | agent/tools |
| `parseToolCallName(fullName): {serverId, toolName} \| null` | 解析 `serverName__toolName` 格式的工具名 | agent |

## 核心类型 / 接口

```ts
interface McpServerConfig {
  id: string; name: string; enabled: boolean
  transport: "stdio" | "sse"
  command?: string; args?: string[]; env?: Record<string, string>
  cwd?: string; url?: string; headers?: Record<string, string>
}
interface McpTool {
  serverId: string; serverName: string; name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
}
interface McpResource { serverId; serverName; uri; name; description?; mimeType? }
interface McpPrompt { serverId; serverName; name; description?; arguments?: {name, description?, required?}[] }
interface McpServerStatus { id; name; connected: boolean; error?; toolCount; resourceCount; promptCount }
```

内部类型：
```ts
interface McpConnection {
  config: McpServerConfig; client: Client; transport: Transport
  process?: ChildProcess; tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[]
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `AiService` | 可选 | `ToolDefinition` 类型引用（仅类型级别） |

## 关键行为 / 数据流

**服务器连接生命周期**：
1. `connect(config)` → 根据 `transport` 创建 `StdioClientTransport` 或 `SSEClientTransport`
2. 初始化 → `client.listTools()` / `listResources()` / `listPrompts()` → 填充 `McpConnection`
3. 工具命名 → 服务器工具 `toolName` → `generateToolName` → `serverId__toolName`

**Agent 调用路径**：
1. Agent 获取工具列表 → `getToolDefinitions()` 返回 `ToolDefinition[]`
2. Agent 调用工具 → `parseToolCallName(fullName)` 解析 → `callTool(serverId, toolName, args)`
3. 返回 `{success, content}` 注入对话上下文

**断连处理**：客户端 `onerror` → `handleDisconnect` → `emit("disconnected", {serverId, error})`

## 关键约束

- **stdio 传输的子进程必须清理**——`disconnect` 必须 `process.kill()`，不得僵尸残留
- **工具名冲突通过前缀隔离**——`serverId__toolName` 格式，`parseToolCallName` 为唯一解析入口
- **MCP 工具调用超时需有上限**——`callTool` 不得无限等待
- **不在 `connect` 失败时静默**——必须抛出或返回错误信息，通知调用方
