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

### 可发现性（2026-07-18 补充）

defer 上线后发现：模型规划任务时"想不到" MCP。根因是 L1 信号太弱——目录只有 server 名 + 工具数（名字不达意的 server 对模型零信息），且只埋在 `mcp_load` 的 tool description 里，system prompt 完全没提 MCP。修正取舍：

1. **目录带能力线索**：`getServerCatalogText()` 每个 server 附一行工具名清单（取 `title || name`，全列不截断）。工具名远短于 schema，不违背"不罗列长描述"。
2. **目录只放一处 = system prompt**：defer 时注入「可用的 MCP 服务器」一节（Tier 2 环境层，随 server 增删变化），规划注意力在 system prompt 而非工具列表深处。`mcp_load` description 不再重复目录，只留机制说明 + 指向该节。
3. **描述保持中性但要有触发力**：陈述机制 + 规划时先对照目录；目录已有覆盖能力时先 load，勿只靠网页搜索。不写「优先使用 MCP」的笼统倾向，但要挡住「永远先 web_search」的默认路径。
4. **加一条独立核心规则「能力优先」（弱模型兜底）**：仅靠「可用的 MCP 服务器」一节的局部引导，弱模型（如 DeepSeek V4 Flash）会整段忽略、径直 `web_search`。故在核心规则加一条独立的「能力优先」（`buildCapabilityRule`）：着手前先盘点专用能力（MCP / 技能），能覆盖就优先用，别用搜索拼凑——MCP 与 skill 并列，模型必读。放核心规则而非 plan 规则（plan 只管建不建计划，与能力选择无关）。该条按是否有已连接 MCP 动态措辞，无 MCP 时只提技能，不指向不存在的段落。
5. **专用能力之间「选最对口的」，不写死 MCP/skill 谁优先**：实测发现弱模型有「先翻熟悉技能、忽略更对口 MCP」的惯性（企业尽调该用企查查 MCP，却先用了快查技能）；但反过来「永远先 MCP」也错（Word/Excel/浏览器场景 skill 才对）。故「能力优先」补一句「有多个可选时选最对口、维度最全的，别停在第一个想到的熟悉工具」——引导按对口度择优，而非规定 MCP 与 skill 的固定优先级。
6. **`web_search` description 加拦截提示（最后一档）**：核心规则「能力优先」后，弱模型问答时能背出目录，但选工具瞬间仍惯性 `web_search`（含其它数据源失败后的 fallback）。工具 description 是选该工具时必读的位置，故在 `web_search` 描述加一句「先确认系统提示中的专用能力是否覆盖，覆盖则用专用工具，本工具仅作通用检索与补充验证」（只给通用原则，不举领域例子——避免把某几类场景焊进通用工具描述、显得只适用那几类）。**静态**注入、不随 defer 切换：子 Agent 工具列表须是父列表 byte-exact 前缀（prompt cache），条件化会使父/子描述分叉；无 MCP/技能时该句自然落空。

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
| `getServerCatalogText()` | 目录（server 名 + 工具名清单），defer 时注入 system prompt |
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
