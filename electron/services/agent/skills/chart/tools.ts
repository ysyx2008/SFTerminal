import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

export const chartTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'generate_chart',
      description: `生成数据可视化图表，直接显示在对话流中给**用户**看。默认输出 SVG 矢量图；通过 format=png 可直接生成 PNG 位图（嵌入 Word/PDF/IM 等位图场景用，服务端 sharp 栅格化、自带中文字体）。
支持 9 种类型：bar (柱状)、line (折线)、area (面积)、pie (饼图)、scatter (散点)、radar (雷达)、heatmap (热力)、candlestick (K线)、map (地图)。
map 类型内置世界地图、中国省级地图、各省下辖市级地图、各地级市下辖区县地图（GeoJSON 离线打包，region 传 "world"/"china"/省名/市名/adcode）。
K 线采用通达信/同花顺专业风格——cn 空心阳线 + 实心阴线、实线网格、黄色十字光标、自动叠加 MA5/10/20/60 均线。
K 线必须根据市场选择 kline_style：A 股/港股/国内市场用 'cn' (红涨绿跌)，美股/欧股/海外市场用 'us' (绿涨红跌)，无明确上下文时默认 'cn'。
不同 type 的 data 字段格式不同，详见技能说明文档。

⚠️ AI 重要提示：
1. 你（AI）**看不到**生成的图——工具返回的图只投递到用户的对话界面，不进入你的视觉上下文（无论 SVG 还是 PNG）。请勿在回复中描述「图里能看到 X 颜色 / Y 区域」等视觉细节，那是脑补；只能描述自己传入工具的数据结构。
2. 工具返回 success=true 即代表图已渲染、用户已看到，无需再用 browser/截图等方式去"验证"自己生成的图。
3. 饼图（pie）的 data **必须是顶层数组** [{name,value}, ...]，不要套对象。`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['bar', 'line', 'area', 'pie', 'scatter', 'radar', 'heatmap', 'candlestick', 'map'],
            description: '图表类型'
          },
          title: { type: 'string', description: '图表主标题（可选）' },
          subtitle: { type: 'string', description: '副标题（可选）' },
          data: {
            type: 'object',
            description: `图表数据，根据 type 不同格式不同（对象或数组均可）：
- bar/line/area:  { categories: string[], series: [{ name?: string, data: number[] }] }
- pie:            [{ name: string, value: number }]   // 顶层数组
- scatter:        [[x,y], ...]   // 顶层数组；或 { series: [{ name?: string, data: number[][] }] }
- radar:          { indicators: [{ name: string, max: number }], series: [{ name?: string, value: number[] }] }
- heatmap:        { x_categories: string[], y_categories: string[], values: [[x_idx, y_idx, value], ...] }
- candlestick:    { categories: string[], values: [[open, close, low, high], ...], volumes?: number[] }
                  // volumes 可选；传了会自动渲染"K 线主图 + 成交量副图"双 grid 布局，
                  // 成交量 bar 颜色按当日涨跌（close>=open 用涨色，否则跌色）
- map:            { region: string, values: [{ name: string, value: number }] }
                  // region: "world" | "china" | 省名（如"安徽"）| adcode（如"340000"）
                  // 中国省级地图 name 用全称或简称（如"广东"/"广东省"）；世界地图 name 用英文国名
                  // 市级地图传省名/adcode，values 的 name 用市名（如"合肥"/"合肥市"）`
          },
          x_label: { type: 'string', description: 'X 轴标签（可选，pie/radar 无效）' },
          y_label: { type: 'string', description: 'Y 轴标签（可选，pie/radar 无效）' },
          kline_style: {
            type: 'string',
            enum: ['cn', 'us'],
            description: 'K 线配色风格，仅 candlestick 生效。cn=红涨绿跌（中国市场，空心阳线通达信风），us=绿涨红跌（海外市场，双实心蜡烛）。默认 cn。'
          },
          kline_ma: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
            description: 'K 线均线周期数组，仅 candlestick 生效。不传则自动叠加 [5, 10, 20, 60]（数据长度足够时才显示对应 MA）；传 [] 关闭均线；自定义如 [7, 25, 99]（币圈风格）也可。'
          },
          theme: {
            type: 'string',
            enum: ['light', 'dark'],
            description: '主题，默认 light。深色背景的对话界面可选 dark。'
          },
          width: {
            type: 'number',
            description: '画布宽度（px），默认 1280，上限 7680。**SVG 模式（默认）选 1280-1600 即可**——前端是活图，用户能 dataZoom 缩放看细节，硬拉到 4800+ 只会让字号相对缩略图过大。**只在 PNG 模式（嵌 Word/PDF）需要展示密集数据时**才上 2400-7680（静态位图无法交互，得靠大画布展示完整数据）。时间序列长 → 宽高比拉宽（≥16:7）。'
          },
          height: {
            type: 'number',
            description: '画布高度（px），默认 800，上限 7680。常规 4:3 ~ 16:10；时序图建议 16:7 ~ 16:6 把数据撑开；饼图/雷达建议接近 1:1。字号自适应只看 width 不看 height。'
          },
          legend: { type: 'boolean', description: '是否显示图例（默认有 series.name 时显示）' },
          save_to_workspace: {
            type: 'boolean',
            description: '是否同时保存图表到 agent-workspace/charts/，便于后续引用或转发。默认 false。文件扩展名按 format 决定（.svg / .png）。'
          },
          format: {
            type: 'string',
            enum: ['svg', 'png'],
            description: '输出格式。默认 svg（矢量、对话流展示用）。**嵌入 Word/PDF/IM 等需要位图的场景必须传 png** —— 服务端用 sharp 直接转 PNG（中文字体走 macOS PingFang SC / Windows YaHei / Linux Noto CJK），不要再让 AI 调 ImageMagick / convert / sips 等系统命令二次转换（那会丢中文字体）。'
          },
          pixel_ratio: {
            type: 'number',
            description: '【仅 png 生效】PNG 像素密度倍率（Retina 缩放）。SVG 仍按 width×height 排版（字号/网格不变），但栅格化时按本倍率放大像素，让被 Word/PDF 缩放显示后依旧锐利。默认 2（@2x，足够大多数嵌入场景），打印稿可传 3。范围 1-4，**当 width × ratio 超过 16384 像素时会自动降低 ratio 防爆**（如 width=7680 + ratio=4 会降到 ~2.13）。**重要心智**：要做嵌入，width 选适合字号的逻辑尺寸（580-1000），不要堆到 3000+；像素清晰度交给 pixel_ratio。SVG 格式忽略此参数。'
          }
        },
        required: ['type', 'data']
      }
    },
    _meta: {
      parallelizable: true,
      contextBudget: { toolResult: 'clearable' }
    }
  } as ToolDefinitionWithMeta,

  // ============================================================================
  // 自由路径：直接传完整 ECharts option，让 AI 表达 generate_chart 之外的任意图
  // ============================================================================
  {
    type: 'function',
    function: {
      name: 'render_echarts_option',
      description: `**高级路径**：直接传完整的 ECharts option（v6+）渲染任意图表，输出 SVG 给用户看。
适用于 \`generate_chart\` 表达不出来的复杂场景：
- 生僻图类型：sankey（桑基图）/ gauge（仪表盘）/ funnel（漏斗）/ graph（关系图）/ tree / treemap / sunburst / parallel / themeRiver / boxplot
- 高级特性：dataZoom（数据缩放）/ visualMap（视觉映射）/ markLine/markArea / 自定义 tooltip formatter / 多 grid 联动 / 双 y 轴
- generate_chart 8 类不够用的复杂组合

⚠️ 何时**不要**用本工具，请用 \`generate_chart\`：
- 简单柱/折/饼/雷达/散点/热力/常规 K 线（含成交量）—— generate_chart 更紧凑、有数据校验和容错
- 不熟 ECharts option 时也优先 generate_chart，避免反复改错

⚠️ AI 重要提示：
1. 你（AI）**看不到**生成的图（同 generate_chart）。success=true 即用户已看到，不要再去"验证"。
2. 出错时报错信息会原样返回（含 ECharts 路径信息），按提示修改 option 重试即可。
3. 未在 option 设 \`backgroundColor\` 时，工具按 \`theme\`（默认 light，白底）注入预设背景；dark 风格请设 \`theme: 'dark'\` 或 \`background_color\`，并同步 \`textStyle.color\` 等。`,
      parameters: {
        type: 'object',
        properties: {
          option: {
            type: 'object',
            description: '完整的 ECharts option 对象（v6+ 格式），按 https://echarts.apache.org/zh/option.html 文档结构传。必须包含 series 等业务字段。提示：少数客户端会序列化对象为 JSON 字符串，工具也会自动 parse 容错。'
          },
          title: { type: 'string', description: '步骤卡片显示用的标题（可选，纯展示用，不影响 option）' },
          theme: {
            type: 'string',
            enum: ['light', 'dark'],
            description: '主题，默认 light（白底）。未在 option 设 backgroundColor 时，按 theme 注入预设背景色。'
          },
          background_color: {
            type: 'string',
            description: '画布背景色（CSS 颜色）。可选；优先级高于 option.backgroundColor 和 theme。'
          },
          width: {
            type: 'number',
            description: '画布宽度（px），默认 1280，上限 7680。按数据规模选——同 generate_chart 的尺寸指引。'
          },
          height: {
            type: 'number',
            description: '画布高度（px），默认 800，上限 7680。'
          },
          save_to_workspace: {
            type: 'boolean',
            description: '是否保存图表到 agent-workspace/charts/。默认 false。'
          },
          format: {
            type: 'string',
            enum: ['svg', 'png'],
            description: '输出格式。默认 svg。**嵌入 Word/PDF/IM 等位图场景传 png**，原理同 generate_chart 的 format 参数。'
          },
          pixel_ratio: {
            type: 'number',
            description: '【仅 png 生效】PNG 像素密度倍率（Retina 缩放）。SVG 仍按 width×height 排版（字号/网格不变），栅格化时按本倍率放大像素。默认 2（@2x），范围 1-4；width × ratio 超过 16384 像素时自动降低 ratio。SVG 格式忽略此参数。详细心智模型见 generate_chart 文档。'
          }
        },
        required: ['option']
      }
    },
    _meta: {
      parallelizable: true,
      contextBudget: { toolResult: 'clearable' }
    }
  } as ToolDefinitionWithMeta
]

/** 技能说明文档（加载技能时注入到 system prompt） */
export const chartSkillContent = `## 图表生成技能（chart）

调用 \`generate_chart\` 工具可生成 9 种数据可视化图表，返回 SVG 矢量图给用户看。

### ⚠️ 关于"谁能看到图"

- **用户**：能直接在对话流里看到图（前端把 SVG 渲染成 \`<img>\`）
- **你（AI）**：**看不到** SVG。SVG 不会进入你的视觉上下文，主流多模态模型也都不识别 SVG。

因此：
- 不要在回复里描述图的视觉细节（"红色区域占主导"/"曲线呈陡峭上升"/"两条线交叉于第三季度"……）——这些都是脑补。
- 只描述你自己传入工具的**数据**（"投资银行 Q3 收入 1.2 亿，最高"），那是你真实知道的。
- 工具返回 \`success: true\` 就说明图已经在用户屏幕上了，**不要**再用 browser/screenshot/read_file 等手段去"验证"自己刚生成的图，那是浪费用户时间。

### 数据格式速查

\`\`\`
bar / line / area:
  data = { categories: ["Q1","Q2","Q3"], series: [{ name:"营收", data:[100,150,200] }] }
  # series[i].data.length 必须等于 categories.length

pie:                                   ← 顶层就是数组，别套对象！
  data = [{ name:"A", value:30 }, { name:"B", value:70 }]

  // ❌ 错误示例（AI 常犯）：
  // data = { items: [{name:"A",value:30}] }
  // data = { series: [{name:"A",value:30}] }
  // 工具会尝试容错（自动剥 data/items/series 字段），但请按规范写顶层数组。

scatter:
  data = [[1.2, 5.6], [2.3, 7.8], ...]                          // 单组
  data = { series: [{ name:"组1", data:[[1,2],[3,4]] }] }        // 多组对比

radar:
  data = {
    indicators: [{ name:"销售", max:100 }, { name:"管理", max:100 }],
    series: [{ name:"小张", value:[80, 90] }, { name:"小李", value:[70, 95] }]
  }
  # series[i].value.length 必须等于 indicators.length

heatmap:
  data = {
    x_categories: ["周一","周二","周三"],
    y_categories: ["上午","下午","晚上"],
    values: [[0,0,10],[1,0,20],[2,0,15], ...]   // [x_idx, y_idx, value]
  }
  # x_idx / y_idx 必须是合法整数索引

candlestick:
  data = {
    categories: ["10-01","10-02","10-03"],
    values: [[100, 110, 95, 115], ...],   // 每条 [open, close, low, high]
    volumes: [12000000, 8500000, 15300000, ...]   // 可选；传了就出"K 线 + 成交量"双图
  }
  # categories.length 必须等于 values.length；如果传 volumes，长度也必须等于 categories.length
  # 成交量 bar 颜色自动按涨跌（close>=open 涨色，否则跌色），无需自己指定
  # MA 均线 (5/10/20/60) 默认自动叠加在主图上；想关闭传 kline_ma: []，自定义传 kline_ma: [7,25,99]
\`\`\`

### 地图（map）必读

内置三级离线地图（无需外部 GeoJSON）：

| region 示例 | 层级 | values[].name 格式 |
|---|---|---|
| \`"world"\` / \`"世界"\` | 世界各国 | **英文国名**（如 China, United States, Japan） |
| \`"china"\` / \`"中国"\` | 中国省级 | 省名全称或简称（如 广东 / 广东省） |
| \`"安徽"\` / \`"340000"\` | 该省下辖市 | 市名（如 合肥 / 合肥市） |
| \`"合肥"\` / \`"340100"\` | 该市下辖区县 | 区县名（如 瑶海区 / 蜀山区） |

\`\`\`
map:
  data = {
    region: "china",
    values: [
      { name: "广东省", value: 1200 },
      { name: "浙江省", value: 980 },
      { name: "江苏省", value: 850 }
    ]
  }

  // 安徽省各市：
  data = { region: "安徽", values: [{ name: "合肥市", value: 100 }, { name: "芜湖市", value: 80 }] }

  // 合肥市区县：
  data = { region: "合肥", values: [{ name: "瑶海区", value: 50 }, { name: "蜀山区", value: 80 }] }
\`\`\`

注意：
- 直辖市（北京/上海/天津/重庆）的区县在省级地图 \`region:"北京"\` 等即可展示，无需再下钻到 \`c110100\`
- 台湾省可在 \`region:"china"\` 国家级地图中展示；**暂无台湾省内市级内置地图**
- 世界地图国名必须用英文（GeoJSON 数据源决定）
- 支持 roam（缩放拖动）；visualMap 可拖拽调整色阶
- **缩放**：地图不在 echarts 内 roam；对话里单击打开大图预览后，用与 PNG/JPG 相同的触控板/滚轮缩放与拖拽（外层 CSS transform）

### K 线必读：中美差异 + 通达信风格

K 线（candlestick）输出**专业行情软件风格**：cn 风格直接照搬通达信/同花顺/东方财富的视觉语言——
**空心阳线 + 实心阴线**、实线网格、右侧价格轴、黄色虚线十字光标、自动叠加 MA5/10/20/60 均线。
你不需要也不应该再用 \`render_echarts_option\` 自己堆 MA / 改样式，generate_chart 已经搞定。

\`kline_style\` 必须根据语境选择：

- **cn（中式，红涨绿跌）**：A 股、港股、国内财经媒体的视觉惯例。**阳线空心**（仅红色边框）、阴线实心绿块——通达信/同花顺 30 年的经典视觉。
- **us（美式，绿涨红跌）**：美股、欧股、国际市场惯例。双实心蜡烛（海外软件惯例）。

判断规则：根据用户语境（提到的股票代码、市场名、币种、新闻来源）选择。无明确上下文时默认 cn。

\`kline_ma\` 行为：
- 默认（不传）→ 自动加 MA5/10/20/60，数据点不足某周期时该 MA 自动跳过
- 传 \`[]\` → 完全关闭均线（看裸 K 时用）
- 传自定义周期如 \`[7, 25, 99]\` → 币圈三均线常见配置

### 按内容规模选画布尺寸（重要）

\`width\` 决定**布局尺寸**——字号绝对值、轴密度、留白比例。前端 SVG 模式下是活图（用户能滚轮 dataZoom 缩放、点开后用大图看细节），**不需要为了"塞下密集数据"硬拉到 4800+**。字号按 width 写死 px 进 option（800px=12px，1600=17px，3200+=24px 上限），width 拉过大反而让缩略图字号相对容器过粗。

请按"输出格式 + 数据规模 → 画布"主动选尺寸：

| 场景 | 数据点数 | SVG 模式（默认，对话流活图） | PNG 模式（嵌入 Word/PDF/IM） |
|---|---|---|---|
| 简单饼图 / 雷达 / 5-10 点折线柱状 | ≤10 | 800-1280 × 600-800 | 同左 |
| 常规分析（多 series 对比、月度数据） | 10-50 | 1280-1600 × 800-1000 | 1600-2400 × 900-1200 |
| 中长期时序（季度日 K、双月数据） | 50-200 | 1600-2000 × 700-900（16:7~16:9） | 2400-3840 × 1000-1500 |
| 长周期数据（半年/全年日 K、全天分时图） | 200+ | 1600-2400 × 700-900（16:7~16:6）| 3840-7680 × 1200-1800 |

宽高比惯例：
- 时序图（K 线、分时、长期趋势）：拉宽，16:7 ~ 16:9
- 普通柱状/折线：4:3 或 16:10
- 饼图、雷达：接近 1:1（如 800×800）

**SVG 模式（默认）的关键认知**：echarts 活图渲染时按容器实际像素 layout（缩略图 480 / 大图 ~1440），后端 width 主要决定字号绝对值。**width 选接近显示尺寸的值（1280-1600）就好**，硬拉到 4800 只会让缩略图字相对画面过大。需要看密集数据细节时用户会滚轮 dataZoom，不靠预生成大画布。

**PNG 模式**是静态位图嵌入文档，没有交互，才需要更大 width 让字号相对画布够大。配 \`format:'png'\` 后默认 \`pixel_ratio:2\` 自动出 Retina @2x，无需手动放大 width。

上限 7680（8K 宽，仅 PNG 打印稿场景）。**举例**：
- 上证指数全年日 K（~250 根）SVG → \`width: 1800, height: 800\`（活图 + dataZoom 看细节足够）
- 上证指数全年日 K 嵌入研报 PDF → \`width: 4800, height: 1500, format: 'png'\`（需要静态展示完整数据）
- 沪深 300 全天分时（~240 分钟）SVG → \`width: 1600, height: 700\`
- Q1 国元各业务线收入对比（5 项 × 3 季度）→ \`width: 1280, height: 800\`（默认即可）
- 嵌入 Word 的 Q1 业务对比图 → \`width: 1000, height: 600, format: 'png'\`（PNG 实际像素 2000×1200，缩到 580px 显示框依旧锐利，**不要**为了"清晰"硬把 width 拉到 3000+）

### 其它建议

- 标题简洁，副标题可放数据来源、统计口径等
- 多 series 对比柱状图建议 ≤4 组，否则视觉拥挤
- 饼图分类 ≤8 个为宜，否则改用柱状图
- K 线建议至少 5 根才有视觉意义
- 需要保留图片供后续引用或转发时传 \`save_to_workspace: true\`，会落到 \`agent-workspace/charts/\`

### 输出

工具返回 \`output\` 文本表示成功状态（含可选落盘绝对路径），渲染好的图走 step.images 直接展示给用户。
如果 \`save_to_workspace: true\`，\`output\` 中带文件绝对路径（界面可点击打开），也可用 \`read_file\` 读取同一路径。

### ⚠️ 嵌入 Word / PDF / IM / 邮件等需要位图的场景：传 \`format: 'png'\`

默认 \`format: 'svg'\` 是矢量图，**对话流里用户能直接看清**（前端把 SVG 渲染成 \`<img>\`），但下游嵌入 Word（\`word_from_markdown\`）、嵌入 IM 消息、转发邮件等场景要求**位图**：

- ✅ **正确**：\`generate_chart({ type:'bar', ..., format:'png', save_to_workspace:true })\` 一步到位，落盘就是 \`.png\`，可直接被 \`![](path)\` 嵌入 Word
- ❌ **不要**：先生成 SVG 落盘 → 再用 \`run_terminal\` 调 \`convert / sips / rsvg-convert\` 转 PNG。ImageMagick 默认不带 librsvg 委托，转中文 SVG 会丢字、变方框、字体降级到无衬线英文，效果远差于 chart 内置 sharp 转换

服务端 PNG 渲染走 sharp + 系统字体（macOS PingFang SC / Windows Microsoft YaHei / Linux Noto Sans CJK），中文与 echarts SVG 显示效果一致。

#### 关键心智：布局尺寸 ≠ 输出像素

\`width\` / \`height\` 控制的是**布局尺寸**（决定字号、网格、留白比例），\`pixel_ratio\` 控制 PNG 的**像素密度**。两者解耦后规则非常简单：

| 你想要 | 怎么做 |
|---|---|
| 字号合适、看着舒服 | \`width\` 选**逻辑显示尺寸**附近的值（嵌 Word 大致 580-1000） |
| PNG 缩放到目标显示尺寸后依旧锐利 | \`format: 'png'\` 即可（默认 \`pixel_ratio: 2\`，已经够锐） |
| 要打印稿级别的清晰度 | \`pixel_ratio: 3\` 或 \`4\` |

**反例（容易踩的坑）**：以为"画布拉到 3000px 字就大了" → 实际 Word 把 3000px 图压回 580px 显示框，字反而被压缩到原来的 1/5。
**正解**：\`width: 800, height: 500, format: 'png'\`，逻辑布局按 800px 设计字号，PNG 自动按 2× 出 1600×1000 像素，被 Word 压回 580px 时依旧锐利、字号正常。

\`pixel_ratio\` 范围 1-4：
- \`1\`：1:1 像素，文件最小，仅在画布本身已经够大时使用
- \`2\`（默认）：Retina @2x，嵌入 Word/PDF/IM 的常用值
- \`3-4\`：打印稿、海报、需要放大查看的场景

---

## 高级路径：\`render_echarts_option\` 工具

当 \`generate_chart\` 表达不出来时（生僻图类型、复杂联动、自定义 tooltip 等），用 \`render_echarts_option\` 直接写完整 ECharts option（v6+）。

### 何时升级

- ✅ **必须用本工具**：sankey / gauge / funnel / graph / tree / treemap / sunburst / parallel / themeRiver / boxplot 等 generate_chart 不支持的图
- ✅ **建议用本工具**：需要 dataZoom / visualMap / markLine / markArea / 自定义 tooltip formatter / 多 grid 复杂联动 / 双 y 轴
- ❌ **优先 generate_chart**：简单柱/折/饼/雷达/散点/热力/常规 K 线（含成交量）—— 那个工具有数据校验和友好错误，不容易出错

### 出错怎么办

工具会把 ECharts 的原始报错原样返给你（包含失败路径，如 \`Invalid series.0.data\`），按提示修改 option 重试即可。**不要乱猜**，错误信息里通常已经写清楚问题在哪。

### 示例：sankey（桑基图，generate_chart 不支持）

\`\`\`json
{
  "option": {
    "series": [{
      "type": "sankey",
      "data": [
        { "name": "公司 A" }, { "name": "部门 1" }, { "name": "项目 X" }
      ],
      "links": [
        { "source": "公司 A", "target": "部门 1", "value": 100 },
        { "source": "部门 1", "target": "项目 X", "value": 60 }
      ]
    }]
  }
}
\`\`\`

### 示例：gauge（仪表盘）

\`\`\`json
{
  "option": {
    "series": [{
      "type": "gauge",
      "data": [{ "value": 75, "name": "完成率" }],
      "axisLine": { "lineStyle": { "width": 30 } }
    }]
  }
}
\`\`\`

### 示例：K 线 + dataZoom（generate_chart 暂不支持的高级特性）

generate_chart 不带 dataZoom；想让用户拖动时间轴时用本工具，option 框架同 ECharts 标准 K 线 + 在顶层加 \`dataZoom: [{ type: 'inside' }]\`。

### 注意

- 不要画 generate_chart 8 类能搞定的图（白白让自己出错）
- option 不要包 \`{ option: {...} }\` 这一层，工具的参数就叫 option，里面直接是 ECharts option 内容
- 如果传字符串 JSON，会自动 parse，但建议直接传对象避免转义问题
- 画布背景：\`render_echarts_option\` 未设 \`backgroundColor\` 时默认 \`theme: light\`（白底）；可用 \`background_color\` / \`theme: 'dark'\` 覆盖，dark 时需同步 \`textStyle.color\` 等
`
