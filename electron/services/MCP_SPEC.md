# MCP Service SPEC

> Last verified: 2026-08-04

## 职责

MCP（Model Context Protocol）客户端。连接和管理外部 MCP 服务器，聚合其提供的工具、资源和提示词，将工具定义转换为旗鱼内部 `ToolDefinition` 格式，供 Agent 发现和调用。

## 设计目标

1. **`whenToUse`**：给模型看的短触发说明，进入 L1 目录；**新保存 / 新启用**必须非空且经用户确认（可改后确认，不可跳过留空）；取消 = 配置失败。内容由短 AI 出草稿，用户确认后才落盘；禁止静默写入未确认文案。
2. **老配置**：缺 `whenToUse` 仍可连接、可 `skill load`；升级时联络 **one-shot** 通知「这块升级了，可让我补或自己去设置」；**无**专用 `migrations/mcp-*.json` marker；防刷屏靠「仅本启跨过 schema v10 时通知一次」，「通知过了」靠联络历史。**通知时机避开启动窗口期**：等窗口首次获得用户焦点后再发出（用户一直不聚焦则超时兜底发出）——应用刚启动就弹系统通知，在 Windows 上会把窗口焦点态打坏，表现为所有输入框点不出光标、只能重启。
3. **skill 化**：已连接 MCP 进入 `skill` 工具目录（id = `mcp:<serverId>`）；用 `skill load/unload` 整包加载/卸载工具 schema；**废弃 `mcp_load`**；有已连接 MCP 时 **始终** defer（取消「≤10 工具全量直灌」）。
4. **目录文案**：有 `whenToUse` 用它作主句；否则回退 name + 工具名清单（兼容旧数据）。
5. **不做**：关键词搜索式 preload；把 MCP 身份硬合并进 Skill 注册表 / `load_user_skill`；未确认静默写 `whenToUse`。

## 文件 / 规模

| 路径 | 说明 |
|------|------|
| `electron/services/mcp.service.ts` | 连接、聚合、schema 转换、server 解析、目录 |
| `electron/services/mcp-progressive-constants.ts` | `mcp:` skill id 前缀等常量 |
| `electron/services/agent/mcp-tool-session.ts` | Agent 侧已 load **server** 的 sticky 集合 |
| `electron/services/mcp-tool-display.ts` | UI 展示名解析 |
| `electron/services/mcp-when-to-use.ts` | whenToUse 短 AI 草稿 |
| `electron/services/agent/mcp-when-to-use-notice.ts` | 升级联络 one-shot 通知 |
| `packages/shared-types/src/mcp.ts` | `McpServerConfig`（含可选 `whenToUse`） |

## 行为契约：工具渐进式披露

### 为什么做

用户常驻多个大型 MCP 时，若每轮把全部 tool schema 塞进上下文：连着 ≠ 在用，低频重武器仍每轮收税；单条描述也可能极长。Skill 已是「目录 → load 整包」；MCP 与之对齐同一心智与同一入口。

### 方案：与 skill 共用 load + 始终按 server 整包

| 已连接 MCP | Agent 看到的 tools |
|------------|-------------------|
| **无** | 核心工具（无 MCP schema） |
| **有** | 核心工具 + `skill`（目录含 `mcp:<id>`）+ 本会话已 load 的 server 下全部 schema（sticky，追加末尾） |

要点：

1. **L1**：`skill` description + system prompt「可用的 MCP 服务器」；有 `whenToUse` 优先，否则 name + 工具名。
2. **L2**：`skill load mcp:<serverId>`（或显示名 / 裸 id，经 `resolveServerRef`）→ 整包 schema。
3. **Sticky 单位是 server**：直到 `resetSession` / `cleanup` / `skill unload`；不设「最多 N 家」逐出。
4. **未 load 却调 `mcp_*`**：自动整包 load，提示下一轮重试。
5. Prompt cache：核心前缀不变；已 load schema 只追加末尾。

### 可发现性

- 目录带 `whenToUse` 或工具名线索；system prompt Tier 2 注入「可用的 MCP 服务器」，指引用 `skill load mcp:…`。
- 核心规则「能力优先」：MCP 与 skill 并列，按对口度择优。
- `web_search` description 提醒先确认专用能力（静态，不随 defer 切换）。

### 与 Skill 的对照

| 层 | Skill | MCP |
|----|-------|-----|
| L1 | 技能 id + description | `mcp:<id>` + whenToUse（或缺省回退） |
| L2 | `skill load` → 工具 + 正文 | `skill load mcp:…` → 该 server 全部工具 schema |
| 执行 | 调技能工具 | 调 `mcp_*` |

## 公开 API（渐进相关）

| 方法 | 用途 |
|------|------|
| `shouldDeferTools()` | 有已连接 MCP → true |
| `getServerCatalogText()` | 目录（优先 whenToUse），defer 时注入 system prompt |
| `resolveServerRef(ref)` | id、`mcp:id` 或显示名 → server |
| `getToolDefinitionsByServerIds(ids)` | 整包 schema |
| `getToolDefinitions()` / `getToolDefinitionsByNames` | 全量 / 按名 |

### McpToolSession

| 方法 | 用途 |
|------|------|
| `loadServer(serverId)` | sticky 整包 |
| `unloadServer(serverId)` | 从 sticky 移除 |
| `isServerLoaded` / `getLoadedServerIds` | 查询 |
| `clear()` | resetSession / cleanup |

## 关键约束

- defer 时不得注入全量 schema——仅目录 + 已 load server 的工具
- 映射表须覆盖全部已连接工具（含未 load 的），保证 `parseToolCallName` / `callTool`
- 已 load 追加在核心工具之后，保护 prompt cache 前缀
- stdio 子进程须清理；工具名冲突靠 `mcp_{serverId}_` 前缀
