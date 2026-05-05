# 图表生成技能 (Chart Skill)

## 职责

为 Agent 提供数据可视化能力。输入统一的扁平参数，输出 SVG 矢量图（base64 data URL），直接作为 `ToolResult.images` 展示给用户、可选保存到 agent-workspace。

底层使用 Apache ECharts v6+ 的服务端 SVG 渲染（`renderer: 'svg', ssr: true`），不依赖 DOM、不依赖 canvas。

## 工具

- `generate_chart` — 傻瓜路径，结构化 DSL，AI 不用懂 ECharts。参数 `type` + `data` + 可选样式
- `render_echarts_option` — 高级路径，AI 直接传完整 ECharts option（v6+）。用于 `generate_chart` 表达不出来的场景（sankey/gauge/funnel/graph/dataZoom/visualMap 等）

两个工具的关系是 **DSL ↔ raw**——90% 高频图用前者（有数据校验和容错），后者是 escape hatch。判断准则在 `tools.ts` 的 `chartSkillContent` 文档里给 AI 写明了。

`generate_chart` 支持 8 种 `type`：

| type | 数据格式 |
|---|---|
| `bar` / `line` / `area` | `{ categories: string[], series: [{ name?, data: number[] }] }` |
| `pie` | `[{ name: string, value: number }]`（顶层数组；亦容错 `{data\|items\|series\|values: [...]}` 嵌套写法和 `label\|category\|title` / `amount\|count\|v` 字段别名） |
| `scatter` | `number[][]`（`[[x,y],...]`）或 `{ series: [{ name?, data: number[][] }] }` |
| `radar` | `{ indicators: [{ name, max }], series: [{ name?, value: number[] }] }` |
| `heatmap` | `{ x_categories: string[], y_categories: string[], values: [[x_idx, y_idx, value], ...] }` |
| `candlestick` | `{ categories: string[], values: [[open, close, low, high], ...] }` |

## K 线中美差异

- `kline_style: 'cn'`（默认）— 红涨绿跌（A 股、港股、国内市场惯例）
- `kline_style: 'us'` — 绿涨红跌（美股、欧股、海外市场惯例）

由 AI 根据用户语境（股票代码、市场、币种、媒体来源）选择，无明确上下文时默认 cn。

## 文件结构

| 文件 | 职责 |
|------|------|
| `presets.ts` | 主题（light/dark）、K 线 cn/us 配色 |
| `render.ts` | `buildOption(input)` —— 把统一参数转换成 ECharts option，含数据校验 |
| `ssr.ts` | `loadEcharts()` 懒加载 + `renderToSvg(option, size)` SSR 渲染 |
| `tools.ts` | `chartTools` 工具定义（generate_chart + render_echarts_option）+ `chartSkillContent` 技能说明文档 |
| `executor.ts` | `executeChartTool` 执行入口，分发到 `generateChart`（DSL）或 `renderEchartsOption`（自由路径），参数归一化、SVG → data URL、可选写盘 |
| `index.ts` | 技能注册（id=`chart`），init 时预热 echarts |

## 输出与图片投递契约

| 通道 | 是否带 SVG | 给谁看 | 原因 |
|---|---|---|---|
| `step.images` | ✅ 带 | **用户** | 前端 `AiPanel.vue` / `Awaken.vue` / `tool-display.ts` 从 `step.images` 读图渲染 `<img>` |
| `ToolResult.images` | ❌ 不带 | ~~AI~~ | 此通道经 `flushPendingToolImages` 注入到 user 消息当视觉输入，但主流多模态模型（OpenAI/Anthropic/Gemini）不识别 SVG 格式，发过去要么被拒、要么静默丢，还会让 AI 误以为「我看过图了」从而脑补图的内容 |

**与 PDF skill 的区别**：PDF skill 反过来——它的图首要目标是「给 AI 视觉分析扫描件」，所以走 ToolResult.images；chart 的图首要目标是「给用户看可视化」，所以走 step.images。两个 skill 设计目标不同，**不能照搬代码**。

`save_to_workspace: true` 时同时落到 `{userData}/agent-workspace/charts/{type}-{timestamp}.svg`，`output` 中带相对路径，可被后续 `read_file` 引用。

## 依赖

- `echarts` v6+ —— 服务端 SVG 渲染
- `i18n.ts` —— `chart.*` 翻译键
- `tools/misc.ts` —— `generate_chart` 工具名路由
- `skills/index.ts` —— 技能注册入口

## 约束

- 仅返回 SVG，不输出 PNG（IM 渠道转发等需要 PNG 的场景未来用 sharp 转）
- 图片宽高 clamp 到 `[100, 7680]`（8K 上限，足以容纳全年日 K ~250 根 / 全天分时 ~240 点）；默认 1280×800（两个工具共用同一组常量）
- **画布尺寸应由 AI 按内容规模主动决策**：默认值仅作兜底，AI 看见 200+ 数据点时应主动拉到 3840+。`tools.ts` 中 `chartSkillContent` 给出明确的规模 → 尺寸映射表。字号是绝对像素（不随尺寸缩放），所以画大画布的意义是「容纳更多数据点」而非「字变大」
- `generate_chart` 数据校验失败抛 Error，由 executor 捕获返回 `success: false` + 友好错误，不让 echarts 内部报错暴露给 AI
- `render_echarts_option` 反过来：**故意**把 ECharts 的原始报错（含字段路径）原样返给 AI，让 AI 能定位问题（自由路径下 AI 直接写 option，最有价值的反馈就是 ECharts 自己的诊断信息）
- `_meta.parallelizable: true`、`contextBudget.toolResult: 'clearable'` —— 多张图可并行生成、图片返回后允许清理
- 不限制 `supportedModes` —— 本地终端、SSH、独立助手三种模式都能用（图表生成跟目标机器无关，纯本地计算）
- echarts 包约 1MB，在 skill `init()` 中懒加载预热，不污染 Electron 冷启动
