import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

export const chartTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'generate_chart',
      description: `生成数据可视化图表，返回 SVG 矢量图，直接展示给用户。
支持 8 种类型：bar (柱状)、line (折线)、area (面积)、pie (饼图)、scatter (散点)、radar (雷达)、heatmap (热力)、candlestick (K线)。
K 线必须根据市场选择 kline_style：A 股/港股/国内市场用 'cn' (红涨绿跌)，美股/欧股/海外市场用 'us' (绿涨红跌)，无明确上下文时默认 'cn'。
不同 type 的 data 字段格式不同，详见技能说明文档。
适合金融分析、数据汇报、统计可视化、概念示意场景。`,
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
- candlestick:    { categories: string[], values: [[open, close, low, high], ...] }`
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
          width: { type: 'number', description: '图片宽度（px），默认 800' },
          height: { type: 'number', description: '图片高度（px），默认 500' },
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

调用 \`generate_chart\` 工具可生成 8 种数据可视化图表，返回 SVG 矢量图。

### 数据格式速查

\`\`\`
bar / line / area:
  data = { categories: ["Q1","Q2","Q3"], series: [{ name:"营收", data:[100,150,200] }] }

pie:
  data = [{ name:"A", value:30 }, { name:"B", value:70 }]

scatter:
  data = [[1.2, 5.6], [2.3, 7.8], ...]
  // 或多组：data = { series: [{ name:"组1", data:[[1,2],[3,4]] }] }

radar:
  data = {
    indicators: [{ name:"销售", max:100 }, { name:"管理", max:100 }],
    series: [{ name:"小张", value:[80, 90] }, { name:"小李", value:[70, 95] }]
  }

heatmap:
  data = {
    x_categories: ["周一","周二","周三"],
    y_categories: ["上午","下午","晚上"],
    values: [[0,0,10],[1,0,20],[2,0,15], ...]   // [x_idx, y_idx, value]
  }

candlestick:
  data = {
    categories: ["10-01","10-02","10-03"],
    values: [[100, 110, 95, 115], ...]   // 每条 [open, close, low, high]
  }
\`\`\`

### K 线必读：中美差异

K 线（candlestick）必须显式指定 \`kline_style\`：

- **cn（中式，红涨绿跌）**：A 股、港股、国内财经媒体的视觉惯例
- **us（美式，绿涨红跌）**：美股、欧股、国际市场惯例

判断规则：根据用户语境（提到的股票代码、市场名、币种、新闻来源）选择。无明确上下文时默认 cn。

### 使用建议

- 默认图片 800x500，复杂数据可调大到 1200x700
- 标题简洁，副标题可放数据来源、统计口径等
- 多 series 对比柱状图建议 ≤4 组，否则视觉拥挤
- 饼图分类 ≤8 个为宜，否则改用柱状图
- K 线建议至少 5 根才有视觉意义
- 需要保留图片供后续引用或转发到 IM 时，传 \`save_to_workspace: true\`

### 输出

返回 SVG 矢量图作为附件展示给用户。如果 \`save_to_workspace: true\`，同时返回 workspace 内的相对路径，可在后续对话中通过 read_file 重新查看。
`
