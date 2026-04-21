# Web Search Service — 联网搜索服务

> Last verified: 2026-04-21

## 职责

为 AI Agent 的 `web_search` 工具提供统一的联网搜索入口：管理 provider 注册、设置读取、API Key 路由，并把原始搜索结果同时送给 AI（文本摘要）和 UI（结构化列表）。

## 架构

```
Main Process
─────────────
main.ts (startup)
  └── initWebSearch(webSearchSettings)
         └── 注册内置 providers (Bocha / Tavily / Jina)

electron/services/web-search/
  ├── index.ts                provider 注册表 + search() 路由
  ├── types.ts                WebSearchProvider / WebSearchOptions / WebSearchResult
  └── providers/
      ├── bocha.ts            博查（国内 AI 搜索，默认）
      ├── tavily.ts           Tavily（AI Agent 体验最好）
      └── jina.ts             Jina（支持 URL 阅读，返回 Markdown）

Agent Tool
─────────────
electron/services/agent/tools/web-search.ts
  └── executeWebSearch(args)
         ├── search(query, { maxResults })   ← 调用本模块
         ├── addStep({ type: 'tool_result',  ← 附 webSearchResults 给 UI
         │            content: 'Found N results',
         │            webSearchResults: [...] })
         └── return { output: 多行文本 }     → 给 AI 阅读
```

## 公开 API

### 模块级函数（`electron/services/web-search/index.ts`）

| 函数 | 说明 |
|------|------|
| `initWebSearch(settings)` | 启动时调用：迁移旧配置、注册 3 个内置 provider |
| `registerProvider(provider)` | 注册（或替换）一个 provider，插件通过此接口扩展 |
| `removeProvider(id)` | 移除 provider 并 `dispose()` |
| `updateSettings(settings)` | 配置变更（用户在设置页修改时触发） |
| `getSettings()` | 获取当前配置副本 |
| `getProvider(id?)` | 获取 provider，未指定时用当前激活 providerId |
| `getApiKey(providerId?)` | 获取指定 provider 的 API Key |
| `isConfigured()` | 是否可用（已启用 + 当前 provider 已注册 + 必要 Key 已填） |
| `search(query, opts?)` | 执行搜索 → `WebSearchResult[]`，provider 未注册会抛错 |
| `dispose()` | 清空所有 provider |

### `WebSearchProvider` 契约（`types.ts`）

```ts
interface WebSearchProvider {
  id: string
  name: string
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>
  dispose?(): void
}
```

`WebSearchOptions`：`maxResults?`（默认 5）、`language?`、`signal?`。

`WebSearchResult`：`title` / `url` / `snippet` / `content?`（正文，仅部分 provider 支持）。

## Provider 插拔

- 内置 provider 在 `initWebSearch` 里通过动态 import + `registerProvider` 注册，构造函数只接受一个 `() => string` 的懒加载 Key getter，避免 Key 变更后需重建实例。
- 插件可在主进程启动后调用 `registerProvider({ id, name, search })` 注入自定义 provider，id 冲突时会先 dispose 旧的再替换。
- 已下线的 provider id（如 `duckduckgo`/`bing`）在 `initWebSearch` 里自动回退到默认，避免旧配置导致启动失败。

## 配置

存储在 `config.service.ts` 的 `webSearchSettings` key（`@shared/types` 的 `WebSearchSettings`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| enabled | boolean | false | 总开关（`isConfigured()` 依赖） |
| providerId | `WebSearchProviderId` | `'bocha'` | 当前激活 provider |
| apiKeys | `Partial<Record<id, string>>` | `{}` | 每个 provider 独立的 Key |
| apiKey | string? | - | @deprecated，初始化时自动迁移到 apiKeys |

IPC：渲染端通过通用的 `config:get` / `config:set` 读写，无专用 IPC 通道。

## 依赖

- `@shared/types` — `WebSearchSettings` / `WebSearchProviderId` / `WEB_SEARCH_PROVIDERS` 元数据
- `config.service.ts` — 读写 `webSearchSettings`
- `electron/main.ts` — 启动时调用 `initWebSearch`
- 各 provider 自身的第三方 HTTP API（Bocha / Tavily / Jina）

## 与 Agent 集成

`agent/tools/web-search.ts` 是本模块唯一的 agent 消费者。契约：

- `search()` 返回的 `WebSearchResult[]` 会以两种形态进入对话：
  1. 文本 `output`（编号列表 + URL + snippet + content 截断到 500 字）→ 给 AI 阅读。
  2. `executor.addStep({ type: 'tool_result', webSearchResults: [...] })` → 给前端 `AiPanel.vue` 渲染可展开的标题+域名链接列表。
- 字段映射到 `AgentStep.webSearchResults`（见 `shared/types/agent.ts` 的 `WebSearchResultItem`），由 `agent.ts` 的 4 处 step↔record 序列化带入历史记录并恢复。

## 约束

- `search()` 不在本模块做缓存或去重，完全透传给 provider。
- provider 的 `search()` 必须返回可 JSON 序列化的对象（会进入 agent 消息历史和 `AgentStepRecord` 持久化）。
- 若当前 provider 未注册或 Key 缺失，`search()` 会抛错，由调用方（`executeWebSearch`）捕获并回写 `tool_result`，不会导致进程崩溃。
- 设置中禁用（`enabled = false`）只影响 `isConfigured()` 判断，不会阻止已经拿到模块引用的调用方执行 `search()`——启用状态应在工具调度侧判断。
