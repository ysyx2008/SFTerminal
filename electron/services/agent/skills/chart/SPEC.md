# 图表生成技能 (Chart Skill)

## 职责

为 Agent 提供数据可视化能力。输入统一的扁平参数，输出 SVG 矢量图（base64 data URL），直接作为 `ToolResult.images` 展示给用户、可选保存到 agent-workspace。

底层使用 Apache ECharts v6+ 的服务端 SVG 渲染（`renderer: 'svg', ssr: true`），不依赖 DOM、不依赖 canvas。

## 工具

- `generate_chart` — 单工具入口，参数 `type` + `data` + 可选样式

支持 8 种 `type`：

| type | 数据格式 |
|---|---|
| `bar` / `line` / `area` | `{ categories: string[], series: [{ name?, data: number[] }] }` |
| `pie` | `[{ name: string, value: number }]` |
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
| `tools.ts` | `chartTools` 工具定义 + `chartSkillContent` 技能说明文档 |
| `executor.ts` | `executeChartTool` 执行入口，参数归一化、SVG → data URL、可选写盘 |
| `index.ts` | 技能注册（id=`chart`），init 时预热 echarts |

## 输出

- `ToolResult.images = ['data:image/svg+xml;base64,...']` —— 前端 `message-image` 直接 `<img :src>` 渲染
- `save_to_workspace: true` 时同时落到 `{userData}/agent-workspace/charts/{type}-{timestamp}.svg`，`output` 中带相对路径，可被后续 `read_file` 引用

## 依赖

- `echarts` v6+ —— 服务端 SVG 渲染
- `i18n.ts` —— `chart.*` 翻译键
- `tools/misc.ts` —— `generate_chart` 工具名路由
- `skills/index.ts` —— 技能注册入口

## 约束

- 仅返回 SVG，不输出 PNG（IM 渠道转发等需要 PNG 的场景未来用 sharp 转）
- 图片宽高 clamp 到 `[100, 4000]`，默认 800×500
- 任何 chart_type 数据校验失败抛 Error，由 executor 捕获返回 `success: false` + 友好错误，不让 echarts 内部报错暴露给 AI
- `_meta.parallelizable: true`、`contextBudget.toolResult: 'clearable'` —— 多张图可并行生成、图片返回后允许清理
- 不限制 `supportedModes` —— 本地终端、SSH、独立助手三种模式都能用（图表生成跟目标机器无关，纯本地计算）
- echarts 包约 1MB，在 skill `init()` 中懒加载预热，不污染 Electron 冷启动
