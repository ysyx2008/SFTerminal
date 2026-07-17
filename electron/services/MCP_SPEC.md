# MCP Service SPEC

> Last verified: 2026-07-18

## 职责

MCP（Model Context Protocol）客户端。连接和管理外部 MCP 服务器，聚合其提供的工具、资源和提示词，将工具定义转换为旗鱼内部 `ToolDefinition` 格式，供 Agent 发现和调用。

## 文件 / 规模

| 路径 | 说明 |
|------|------|
| `electron/services/mcp.service.ts` | 连接、聚合、schema 转换、server 解析 |
| `electron/services/mcp-progressive-constants.ts` | 渐进披露阈值常量 |
| `electron/services/agent/mcp-tool-session.ts` | Agent 侧已 load **server** 的 sticky LRU |
| `electron/services/mcp-tool-display.ts` | UI 展示名解析 |

## 设计意图：工具渐进式披露（Progressive Disclosure）

### 为什么做

用户常驻多个大型 MCP（典型：企查查拆成 5 个 server + 其它，合计可上百工具）时，若每轮把全部 tool schema 塞进上下文：

- **连着 ≠ 在用**：低频重武器在日常任务里仍每轮收税；
- 单条工具描述也可能极长（适用场景、防幻觉纪律等），全量可达数万 token。

内置核心工具不必 defer。Skill 已是「目录 → load 整包」。MCP 对齐同一心智：**按 server 整包 load**，不用关键词搜索赌命中。

### 方案：统一渐进管道 + 按 server 整包 load + 小规模 preload

| 已连接 MCP 工具总数 | Agent 看到的 tools |
|---------------------|-------------------|
| **≤ `MCP_PRELOAD_THRESHOLD`（10）** | 全量 schema（无 `mcp_load`） |
| **> 10** | 核心工具 + **`mcp_load`**（description 内嵌 **server 目录**）+ 本会话已 load 的 **server 下全部** schema（sticky，追加末尾） |

要点：

1. **L1 = server 目录**（几行），不罗列每个工具的长描述。
2. **`mcp_load(server)`**：按 id 或显示名选定一家 MCP，**整包**加载其全部工具 schema（对齐 `skill load`）。
3. **Sticky 单位是 server**：本会话 load 过的 server 一直保留其全部工具 schema，直到 `resetSession` / `cleanup`；**不设「最多 N 家」逐出**（需要几家留几家，避免任务中途被挤掉）。
4. **不做主路径关键词 search**——搜不准；需要能力时打开相关那一家即可。
5. **未 load 的 server 上直接调 `mcp_*`**：自动整包 load 该 server，返回提示请下一轮重试。
6. Prompt cache：核心前缀不变；已 load schema 只追加末尾。
7. 本期不做：内置工具 defer、插件同构、意图预路由。

### 与 Skill 的类比

| 层 | Skill | MCP（defer） |
|----|-------|----------------|
| L1 | 技能 id + 一句话 | server 目录（在 `mcp_load` description） |
| L2 | `skill load` → 该技能全部工具+正文 | `mcp_load` → 该 server 全部工具 schema |
| 执行 | 调技能工具 | 调 `mcp_*` |

## 公开 API（渐进相关）

| 方法 | 用途 |
|------|------|
| `shouldDeferTools()` | count > 10 |
| `getServerCatalogText()` | 廉价目录 |
| `resolveServerRef(ref)` | id 或显示名 → server |
| `getToolDefinitionsByServerIds(ids)` | 整包 schema |
| `getToolDefinitions()` / `getToolDefinitionsByNames` | 全量 / 按名 |

### McpToolSession

| 方法 | 用途 |
|------|------|
| `loadServer(serverId)` | sticky 整包（本会话保留至 clear） |
| `isServerLoaded` / `getLoadedServerIds` | 查询 |
| `clear()` | resetSession / cleanup |

常量：`MCP_PRELOAD_THRESHOLD = 10`（`mcp-progressive-constants.ts`）。

## 关键约束

- defer 时不得注入全量 schema——仅目录 + 已 load server 的工具
- 映射表须覆盖全部已连接工具（含未 load 的），保证 `parseToolCallName` / `callTool`
- 已 load 追加在核心工具之后，保护 prompt cache 前缀
- stdio 子进程须清理；工具名冲突靠 `mcp_{serverId}_` 前缀
