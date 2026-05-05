import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

export const chartTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'generate_chart',
      description: `生成数据可视化图表，输出 SVG 矢量图直接显示在对话流中给**用户**看。
支持 8 种类型：bar (柱状)、line (折线)、area (面积)、pie (饼图)、scatter (散点)、radar (雷达)、heatmap (热力)、candlestick (K线)。
K 线必须根据市场选择 kline_style：A 股/港股/国内市场用 'cn' (红涨绿跌)，美股/欧股/海外市场用 'us' (绿涨红跌)，无明确上下文时默认 'cn'。
不同 type 的 data 字段格式不同，详见技能说明文档。

⚠️ AI 重要提示：
1. 你（AI）**看不到**生成的图——多模态视觉模型不识别 SVG 格式，工具返回的图只投递到用户的对话界面，不进入你的视觉上下文。请勿在回复中描述「图里能看到 X 颜色 / Y 区域」等视觉细节，那是脑补；只能描述自己传入工具的数据结构。
2. 工具返回 success=true 即代表图已渲染、用户已看到，无需再用 browser/截图等方式去"验证"自己生成的图。
3. 饼图（pie）的 data **必须是顶层数组** [{name,value}, ...]，不要套对象。`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['bar', 'line', 'area', 'pie', 'scatter', 'radar', 'heatmap', 'candlestick'],
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
                  // 成交量 bar 颜色按当日涨跌（close>=open 用涨色，否则跌色）`
          },
          x_label: { type: 'string', description: 'X 轴标签（可选，pie/radar 无效）' },
          y_label: { type: 'string', description: 'Y 轴标签（可选，pie/radar 无效）' },
          kline_style: {
            type: 'string',
            enum: ['cn', 'us'],
            description: 'K 线配色风格，仅 candlestick 生效。cn=红涨绿跌（中国市场），us=绿涨红跌（海外市场）。默认 cn。'
          },
          theme: {
            type: 'string',
            enum: ['light', 'dark'],
            description: '主题，默认 light。深色背景的对话界面可选 dark。'
          },
          width: {
            type: 'number',
            description: '画布宽度（px），默认 1280，上限 7680。**应根据数据规模主动设定**：数据点 ≤ 10 用 800-1280；10-50 用 1600-2400；50-200 用 2400-3840；200+（如半年/全年日 K、全天分时图）用 3840-7680。时间序列长 → 宽高比拉宽（≥16:7）。'
          },
          height: {
            type: 'number',
            description: '画布高度（px），默认 800，上限 7680。常规 4:3 ~ 16:10；时序图建议 16:7 ~ 16:6 把数据撑开；饼图/雷达建议接近 1:1。字号是绝对像素（不随尺寸缩放）——画大画布就能容纳更多数据点。'
          },
          legend: { type: 'boolean', description: '是否显示图例（默认有 series.name 时显示）' },
          save_to_workspace: {
            type: 'boolean',
            description: '是否同时保存 SVG 到 agent-workspace/charts/，便于后续引用或转发。默认 false。'
          }
        },
        required: ['type', 'data']
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

调用 \`generate_chart\` 工具可生成 8 种数据可视化图表，返回 SVG 矢量图给用户看。

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
\`\`\`

### K 线必读：中美差异

K 线（candlestick）必须显式指定 \`kline_style\`：

- **cn（中式，红涨绿跌）**：A 股、港股、国内财经媒体的视觉惯例
- **us（美式，绿涨红跌）**：美股、欧股、国际市场惯例

判断规则：根据用户语境（提到的股票代码、市场名、币种、新闻来源）选择。无明确上下文时默认 cn。

### 按内容规模选画布尺寸（重要）

字号是绝对像素（12-16px），**不**随画布缩放。所以画大画布的意义是「容纳更多数据点」，
不是「字变大」。请根据数据规模主动选尺寸——别全用默认 1280×800：

| 场景 | 数据点数 | 推荐 width × height |
|---|---|---|
| 简单饼图 / 雷达 / 5-10 点折线柱状 | ≤10 | 800-1280 × 600-800 |
| 常规分析（多 series 对比、月度数据） | 10-50 | 1600-2400 × 900-1200 |
| 中长期时序（季度日 K、双月数据） | 50-200 | 2400-3840 × 1000-1500（宽高 16:7） |
| 长周期数据（半年/全年日 K、全天分时图） | 200+ | 3840-7680 × 1200-1800（宽高 16:6） |

宽高比惯例：
- 时序图（K 线、分时、长期趋势）：拉宽，≥ 16:7
- 普通柱状/折线：4:3 或 16:10
- 饼图、雷达：接近 1:1（如 800×800）

上限 7680（8K 宽）。**举例**：
- 上证指数全年日 K（~250 根）→ \`width: 4800, height: 1500\`
- 沪深 300 全天分时（~240 分钟）→ \`width: 4000, height: 1400\`
- Q1 国元各业务线收入对比（5 项 × 3 季度）→ \`width: 1280, height: 800\`（默认即可）

### 其它建议

- 标题简洁，副标题可放数据来源、统计口径等
- 多 series 对比柱状图建议 ≤4 组，否则视觉拥挤
- 饼图分类 ≤8 个为宜，否则改用柱状图
- K 线建议至少 5 根才有视觉意义
- 需要保留图片供后续引用或转发时传 \`save_to_workspace: true\`，会落到 \`agent-workspace/charts/\`

### 输出

工具返回 \`output\` 文本表示成功状态（含可选 workspace 路径），SVG 走 step.images 直接展示给用户。
如果 \`save_to_workspace: true\`，同时返回 workspace 相对路径，可后续通过 \`read_file\` 重新读取该 SVG 文件。
`
