# 图表生成技能 (Chart Skill)

## 职责

为 Agent 提供数据可视化能力。输入统一的扁平参数，默认输出**「活图」**（让前端实例化 ECharts 提供 tooltip / dataZoom / legend toggle 等交互，同时带 SVG dataURL 作兜底）或 PNG 位图（`format: 'png'`，服务端 sharp 栅格化，嵌入 Word/PDF/IM 用）。可选保存到 agent-workspace。

底层使用 Apache ECharts v6+ 的服务端 SVG 渲染（`renderer: 'svg', ssr: true`），不依赖 DOM、不依赖 canvas。「活图」走前端 `EChartsCanvas` 组件，把后端 `buildOption` 产出的 ECharts option 直接 `setOption` 到浏览器实例；主题已被 `applyCommon` inline 进 option（backgroundColor / color / textStyle），前后端视觉完全一致。

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
| `candlestick` | `{ categories: string[], values: [[open, close, low, high], ...], volumes?: number[] }` |

## K 线风格（通达信 / 同花顺专业风格）

K 线**整体走专业行情软件视觉**而不是商务图表样式：

| 视觉元素 | 实现 |
|---|---|
| 阳线（cn） | **空心**（`color: 'transparent'`）+ 红色边框，靠 `backgroundColor` 透出形成"红框白心 / 红框黑心"——通达信经典 |
| 阴线（cn） | 实心绿色蜡烛 |
| 阳线 / 阴线（us） | 双实心，绿涨红跌（海外软件惯例） |
| 网格 | **水平实线 + 垂直虚线**（行情软件经典分隔语言）；垂直虚线按数量自适应稀疏到 ~8 条，避免每根 K 线一条的拥挤 |
| 价格轴 | 移到 **右侧**（通达信、同花顺、TradingView、富途都如此） |
| 十字光标 | cn 用**黄色虚线**+黄底反白价格标签（通达信招牌）；us 用灰色虚线 |
| MA 均线 | 默认自动叠加 **MA5 / MA10 / MA20 / MA60**，颜色按通达信经典调色板（dark：白/黄/紫/青；light：深蓝灰/橙/紫/青） |
| 背景 | dark = `#0c0e12`（近黑略蓝灰）；light = `#ffffff` |

### kline_style — 中美差异

- `kline_style: 'cn'`（默认）— 红涨绿跌 + 空心阳线（A 股、港股、国内市场）
- `kline_style: 'us'` — 绿涨红跌 + 双实心蜡烛（美股、欧股、海外市场）

由 AI 根据用户语境（股票代码、市场、币种、媒体来源）选择，无明确上下文时默认 cn。

### kline_ma — MA 均线控制

- 不传 → 默认 `[5, 10, 20, 60]`，按数据长度自动过滤（数据 < N 不画该 MA）
- 传 `[]` → 关闭均线
- 传自定义周期如 `[7, 25, 99]` → 币圈三均线常见配置

实现细节：MA 用收盘价的 SMA（简单移动平均），前 `period - 1` 个数据点用 ECharts 占位符 `'-'`（不连线）；用滑动窗口 O(n) 实现，对全年日 K 也保持线性。

### 双 grid 布局（K 线 + 成交量）

传 `volumes` 时切到双 grid 模式（价格主图 + 成交量副图），按 TradingView / 通达信专业行情图样式拼接成一个统一区域：

| 设计点 | 配置 | 为什么这么做 |
|---|---|---|
| **两 grid 视觉合一** | `priceGrid.bottom='25%'` + `volumeGrid.top='75%'`，边界都在画布 75% 高度处对齐 | 中间无空隙，价格区+成交量区从用户视角看是一个连续区域；旧配置（priceGrid bottom=32% / volumeGrid top=74% 留 6% 空隙）是因为 priceGrid 底部要放 xAxis label 才需要留缝，下条解决了 label 占位问题之后空隙就可以彻底消除 |
| **上下双时间标签** | `xAxis[0].position='top'` + `axisLine/Tick/Label` 全 `show:false` | 把价格 xAxis 整体挪到 priceGrid 顶部（贴近 title/legend 下方）。平时只看见 splitLine（垂直网格虚线），hover 时 axisPointer label 自动在 priceGrid 顶部显示日期，跟 volumeGrid 底部 xAxis 上的日期 axisPointer label 形成"上下双标签"——TradingView 招牌样式 |
| **十字线贯穿 + tooltip 跨 grid 合并** | **顶层** `option.axisPointer = { link: [{ xAxisIndex: 'all' }] }` | hover 任一 grid 时另一 grid 的 axisPointer 同步移动 → 垂直虚线贯穿全图、tooltip 自动合并价格 OHLC + MA + 成交量同时显示 |
| **yAxis 双侧极值让位** | `priceYAxis.axisLabel.showMinLabel: false` + `volumeYAxis.axisLabel.showMaxLabel: false` | 两 grid 紧贴后 priceGrid 最低值 label 跟 volumeGrid 最高值 label 都落在 75% 交界处会撞（"4500" + "300" 显示成 "3500"+"00" 一团）。行情软件（通达信/同花顺/TradingView）标准做法是两侧极值 label 都不显示，靠 splitLine 网格提供视觉刻度、hover 时 axisPointer label 看精确值——视觉对称、干净 |
| **双 grid 不显示 axis name** | priceYAxis / volumeYAxis 都不带 name | A 股成交量从"300.00万"（3位数+万）到"1500.00万"（4位数+万）label 宽度差 ~20px，4 位数情形会把 axisLabel 推到 axis name 的 nameGap 区间撞名字 → echarts 自动收 grid 给 name 让位 → **上下错位**（实测稳定复现）。legend 已含"价格 MA5 MA10 MA20"足以标识"上面是价格"，下方红绿条形图本身就是成交量惯例——axis name 是冗余信息。**单 grid 模式仍保留** axis name（priceYAxis 占满画布，AI 传 y_label 时显示，跟 K 线副图无关），所以 `priceYAxis` 函数本身不动，只在双 grid yAxis spread 时 override `name:''` |

> ⚠️ **坑**：`axisPointer.link` **必须**放顶层 `option.axisPointer`，写在 `tooltip.axisPointer.link` 里 echarts 不识别——会让 K 线 hover 时价格/成交量 tooltip 拆成两块、十字线只在单 grid 内出现。这是 echarts 文档没明说的属性归属。

## 文件结构

| 文件 | 职责 |
|------|------|
| `presets.ts` | 通用主题（light/dark）+ K 线专业主题 `getKlineProTheme(style, mode)`（含蜡烛配色、十字线、MA 调色板、空心阳线策略） |
| `render.ts` | `buildOption(input)` —— 把统一参数转换成 ECharts option，含数据校验、SMA 计算、MA 周期自动过滤 |
| `ssr.ts` | `loadEcharts()` 懒加载 + `renderToSvg(option, size)` SSR 渲染 + `renderToPng(option, size, { pixelRatio })` 复用 SVG 后用 sharp 栅格化为 PNG（中文走系统字体；通过 sharp `density` 参数控制栅格化 DPI，实现"布局尺寸 / 像素密度"解耦） |
| `tools.ts` | `chartTools` 工具定义（generate_chart + render_echarts_option）+ `chartSkillContent` 技能说明文档 |
| `executor.ts` | `executeChartTool` 执行入口，分发到 `generateChart`（DSL）或 `renderEchartsOption`（自由路径），参数归一化、按 `format` 选 SVG/PNG → data URL、可选写盘（扩展名跟 format 走）；SVG 模式同时投递 `echartsOption` 给前端实例化活图 |
| `ipc-sanitize.ts` | 后端 formatter marker 协议：`tagFormatter(id, fn)` 给 function 挂 Symbol 标签、`sanitizeOptionForIpc(option)` 把 tagged function 替换成 `{ __echartsFn: id }` marker 让 option 过 Electron IPC（详见下文活图协议章节） |
| `../../../../../shared/utils/echarts-formatters.ts` | 跨进程共享的 marker 协议前端侧：`reifyFormattersForRender` 把 marker 还原成 function、`FORMATTER_REGISTRY` 白名单（前后端共维护）、`formatVolume` / `formatKlineTooltip` 内置 formatter |
| `index.ts` | 技能注册（id=`chart`），init 时预热 echarts |

## 输出与图片投递契约

| 通道 | 内容 | 给谁看 | 原因 |
|---|---|---|---|
| `step.echartsOption` | ECharts option JSON（仅 svg 模式） | **用户**，活图 | 前端 `AiPanel.vue` 用 `EChartsCanvas` 实例化为可交互图表（hover tooltip / 拖 dataZoom / 点击 legend 切换 series / 右键以任意倍率高清复制／另存为）。`Awaken.vue` 暂未支持，自然降级到 `step.images` |
| `step.images` | SVG 或 PNG 的 dataURL | **用户**，静态兜底 | 旧历史会话恢复、Awaken 关切面板等不实例化 echarts 的视图沿用此路径渲染 `<img>`；同时让 `tool-display.ts::hasRichPayload` 这类「按是否带图判断展示」的逻辑在新老路径下行为一致 |
| `ToolResult.images` | ❌ 不带 | ~~AI~~ | 此通道经 `flushPendingToolImages` 注入到 user 消息当视觉输入，但主流多模态模型（OpenAI/Anthropic/Gemini）不识别 SVG 格式，发过去要么被拒、要么静默丢，还会让 AI 误以为「我看过图了」从而脑补图的内容 |

### 为什么 PNG 模式不投递 echartsOption

`format: 'png'` 通常意味着 AI 主动选了「我要导出位图给 word/IM」，下游消费的是落盘的 PNG 文件。这种语义下用户在气泡里看到的应该是**与导出物视觉一致的 PNG 预览**，而非活图——避免出现「气泡里看到的活图能拖 dataZoom，但导出的 PNG 是另一个画面」的认知错位。所以 PNG 模式下只走 `step.images`，活图能力关闭。

### 与 PDF skill 的区别

PDF skill 反过来——它的图首要目标是「给 AI 视觉分析扫描件」，所以走 ToolResult.images；chart 的图首要目标是「给用户看可视化」，所以走 step.echartsOption / step.images。两个 skill 设计目标不同，**不能照搬代码**。

### 持久化与历史恢复

`echartsOption` 同时持久化到 `AgentStepRecord` 中（约束见 `shared/types/history.ts`）。重新打开历史会话或 fork 出新对话时，前端从 `record.steps[*].echartsOption` 恢复活图渲染——所以**历史里的图也是活的**。option JSON 体积通常 5-30KB，比同等画面的 SVG base64（80KB+）小，整体让历史文件略微变小。版本兼容：旧历史无 `echartsOption` 字段时，前端自动 fallback 到 `step.images` 渲染 `<img>`。

`save_to_workspace: true` 时同时落到 `{userData}/agent-workspace/charts/{type}-{timestamp}.svg`，`output` 中带**绝对路径**（前端可点击打开；`read_file` 也可用同一路径）。

## 活图（echartsOption）协议

`step.echartsOption` 由前端 `EChartsCanvas` 实例化为可交互 ECharts 图表。两条工具路径行为不同：

| 路径 | 何时投递 echartsOption |
|---|---|
| `generate_chart`（DSL） | SVG 模式总投——formatter 走 marker 协议（见下） |
| `render_echarts_option`（自由路径） | SVG 模式 + option **IPC-safe** 时投递；含 untagged function 时静默降级到 SVG-only |

### Formatter Marker 协议

ECharts option 含 function formatter（如 `axisLabel.formatter` / `tooltip.formatter`）时**无法过 Electron IPC**——`structuredClone` 抛 `DataCloneError`，整个 step 投递失败。约定一套 marker 协议跨进程递送 function：

1. 后端 `buildOption` 用 `tagFormatter('volume', formatVolume)` 给 function 挂上 Symbol id 标签（标签存对象自身的 Symbol 属性，不污染 echarts 行为）
2. 后端投 IPC 前用 `sanitizeOptionForIpc(option)` 递归遍历，把 tagged function 替换成 `{ __echartsFn: id }` 占位符；untagged function **静默丢弃**（让 echarts 走默认 formatter）
3. 前端 `EChartsCanvas` `setOption` 前用 `reifyFormattersForRender(option)` 按 id 查 `FORMATTER_REGISTRY` 还原 function

**白名单设计**：所有可投递 formatter 必须在 `FORMATTER_REGISTRY` 注册（`shared/utils/echarts-formatters.ts`，前后端共维护），新增一对必须同时更新两边。陌生 marker / 陌生 function 一律丢弃——杜绝 AI 在 `render_echarts_option` 直传 `function(){...}` 字符串触发前端 eval 的 XSS 风险，**前端永远不 eval 任何字符串**。

**两道安全闸门**杜绝 AI 在自由路径绕过白名单：
- 前端 `reifyImpl` 用 `Object.hasOwn(FORMATTER_REGISTRY, name)` 守卫——bracket 索引会命中 `Object.prototype.toString` 等原型链方法（AI 可造 `{__echartsFn:'toString'}` 通得过 `structuredClone`），own-property 检查把命中范围限制在显式登记的内置 formatter
- 后端 `executor.ts` 自由路径投递前调 `stripFormatterMarkers(option)`，递归删除所有 `__echartsFn` plain object（防 AI 造 `{__echartsFn:'klineTooltip'}` 让前端 reify 后把 K 线 tooltip formatter 装到散点图上跑出怪异 tooltip）。marker 协议**仅供后端 generate_chart 路径内部使用**

当前注册的 formatter：

| id | 用途 | 哪里用 |
|---|---|---|
| `volume` | 成交量数字格式化（亿/万/k） | K 线 volumeGrid yAxis label |
| `klineTooltip` | K 线 tooltip 中文化（开盘/收盘/最低/最高）+ 自造实心圆点 marker（修 echarts 默认 marker 拿 `itemStyle.color` 当背景导致 cn 风格阳线 marker 透明的视觉问题） | K 线 tooltip |

新增内置 formatter 流程：
1. 在 `shared/utils/echarts-formatters.ts` 写 function 实现 + 加进 `FORMATTER_REGISTRY`
2. 在后端 `buildOption` 处用 `tagFormatter(id, fn)` 包装后再放进 option
3. 不需要改前端 `EChartsCanvas` —— `reifyFormattersForRender` 自动按 id 查表

### IPC 安全降级（自由路径）

`render_echarts_option` 路径上 AI 直传任意 option，可能含 function 但没经过 `tagFormatter` 标记 → `sanitizeOptionForIpc` 会丢弃，但前端拿没 formatter 的 option 渲染可能视觉错乱（例如 axisLabel 显示成 `[object Object]`）。所以这条路径在投递前用 `isIpcSafeForChart(option)` 探测：**含任何未 tagged function 时直接放弃 echartsOption 投递**，只走 SVG dataURL（前端按图渲染）—— 视觉跟 AI 期望一致，只是失去交互能力。`generate_chart` 不需要这层降级（DSL 自己包的 function 都过 `tagFormatter`，可信）。

### 前端尺寸契约

`EChartsCanvas` 接 `EChartsStepPayload = { option, width, height }`。后端给的 width/height 是**渲染基准尺寸**（决定 option 内部字号、padding、grid 比例），不是组件最终显示尺寸——前端：

- **缩略图模式**：用 CSS `min(${width}px, 720px, 400px*ratio)` 适配气泡宽度，超出后等比缩放，aspect-ratio 锁定不让 echarts 拉伸变形
- **预览模式**：JS 计算 `winSize × maxVw / maxVh` clamp 后填入 inline style，绝对像素避免 CSS `width:80vw` 在嵌套 flex 布局里塌成 0×0

## 依赖

- `echarts` v6+ —— 服务端 SVG 渲染 + 前端活图实例化（前端通过 `src/components/EChartsCanvas.vue` 懒加载）
- `sharp` —— SVG → PNG 栅格化（`format: 'png'` 时使用，librsvg 后端 + fontconfig 系统字体）
- `shared/utils/echarts-formatters.ts` —— 跨进程 formatter marker 协议（前端 `EChartsCanvas` 也 import）
- `i18n.ts` —— `chart.*` 翻译键
- `tools/misc.ts` —— `generate_chart` 工具名路由
- `skills/index.ts` —— 技能注册入口

## 约束

- 默认输出 SVG（对话流展示，矢量清晰、文件小）；`format: 'png'` 时输出 PNG（嵌入 Word/PDF/IM 等位图场景）。**不要让 AI 自己拿 SVG 再用 ImageMagick / convert 转 PNG**，那条路对中文 SVG 文本支持差，会丢字／降级到无衬线字体
- 图片宽高 clamp 到 `[100, 7680]`（8K 上限，仅 PNG 打印稿场景需要）；默认 1280×800（两个工具共用同一组常量）
- **画布尺寸由 AI 按"输出格式 + 内容规模"主动决策**：SVG 模式（活图）用户能 dataZoom 缩放，width 选 1280-1600 即可（字号写死 px 进 option，width 拉过大会让缩略图字相对画面过粗）；PNG 模式（嵌 Word/PDF/IM）是静态位图才需要更大 width 让字号相对画布够大。`tools.ts` 中 `chartSkillContent` 表格按"SVG / PNG"两栏分别给推荐尺寸
- **PNG 像素密度独立于布局尺寸**（`pixel_ratio` 参数）：`width` / `height` 决定布局（字号、网格），`pixel_ratio` 决定栅格化时的像素倍率。用 sharp 的 `density` 参数实现（默认 72 dpi 对应 1:1，144 dpi 对应 2× 像素），高 DPI 路径下字体抗锯齿走 librsvg 渲染，比"先 1:1 出 PNG 再 .resize 放大"清晰得多。
  - **⚠️ 行为变更**：PNG 默认 `pixel_ratio: 2`（之前是 1）。同样调用 `format:'png'` 不传 ratio 时，**输出像素现在 2× width × 2× height，PNG 文件体积约 4×**。理由：嵌入 Word/PDF 的图被缩放显示后依旧锐利是更好的默认体验，无需让 AI 把 `width` 拉到 3000+ 来追"高清"（那反而会让字相对画布显小）。data URL 也变大 ~4×，但 chart 的 PNG 不进 AI 视觉上下文（见图片投递契约），不消耗 AI tokens
  - 范围 `[1, 4]`，并按 size × ratio 反推 `MAX_PIXEL_DIM=16384` 兜底，避免 8K 画布 × 4 倍触发 sharp/libvips 的"Input is too large"。**自动降级是静默的**——AI 传 ratio=4 + width=7680 时会被静默降到 2.13，工具描述里有明确说明
  - 双层默认刻意不同：`ssr.ts` 的 `renderToPng()` 默认 `pixelRatio=1`（中性，对其他直接调用方友好）；`executor.ts` 的 `clampPixelRatio()` 在 PNG 路径默认 2（面向 AI 工具调用的最佳体验）
  - SVG 格式忽略此参数（矢量本身分辨率无关）；`clampPixelRatio` 在 SVG 路径强制返回 1 让上下游一致
- **字号自适应**（按画布宽度缩放，避免大画布下字号相对画布偏小看不清）：
  - 普通图表用 `calcFontScale`：基准 800px=1.0×（小画布字号自然合适，跟历史值一致），800-1600 线性放大到 1.4×，1600-3200 到 2.0×，3200+ 上限。所有硬编码字号（title 16 / subtitle 12 / axis label 12 / legend 12 / pie label 12 / heatmap series label 12 / visualMap 11 / radar axisName 12）都乘 scale
  - K 线另走 `calcKlineFontScale`（基准 1280px=1.0×，2400→1.4×，4800+→2.0×），曲线和经实测的视觉手感一致，**不与普通图表共用**——避免误调改了 K 线字号
- `generate_chart` 数据校验失败抛 Error，由 executor 捕获返回 `success: false` + 友好错误，不让 echarts 内部报错暴露给 AI
- `render_echarts_option` 反过来：**故意**把 ECharts 的原始报错（含字段路径）原样返给 AI，让 AI 能定位问题（自由路径下 AI 直接写 option，最有价值的反馈就是 ECharts 自己的诊断信息）
- `_meta.parallelizable: true`、`contextBudget.toolResult: 'clearable'` —— 多张图可并行生成、图片返回后允许清理
- 不限制 `supportedModes` —— 本地终端、SSH、独立助手三种模式都能用（图表生成跟目标机器无关，纯本地计算）
- echarts 包约 1MB，在 skill `init()` 中懒加载预热，不污染 Electron 冷启动
