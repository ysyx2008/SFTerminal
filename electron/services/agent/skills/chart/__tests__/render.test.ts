/**
 * Chart skill 单元测试
 *
 * 验证：
 * - 8 种图表类型都能产出有效 SVG
 * - K 线 cn/us 配色被正确应用
 * - 数据校验失败抛出明确错误
 * - dark 主题、标题、自定义尺寸等参数生效
 */
import { describe, it, expect } from 'vitest'
import { buildOption, type ChartInput } from '../render'
import { renderToSvg, renderToPng } from '../ssr'

const SIZE = { width: 600, height: 400 }

async function render(input: ChartInput): Promise<string> {
  const opt = buildOption(input)
  return renderToSvg(opt, SIZE)
}

describe('chart render', () => {
  it('renders bar chart', async () => {
    const svg = await render({
      type: 'bar',
      title: '季度营收',
      data: { categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '营收', data: [120, 200, 150, 180] }] }
    })
    expect(svg).toMatch(/^<svg/)
    expect(svg).toMatch(/<\/svg>$/)
    expect(svg.length).toBeGreaterThan(500)
  })

  it('renders line chart', async () => {
    const svg = await render({
      type: 'line',
      data: { categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'CPU', data: [10, 50, 30] }] }
    })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders area chart with dark theme', async () => {
    const svg = await render({
      type: 'area',
      theme: 'dark',
      data: { categories: ['a', 'b', 'c'], series: [{ name: 'x', data: [1, 2, 3] }] }
    })
    expect(svg).toMatch(/^<svg/)
    // dark 主题背景色 #1f2937 应出现在 SVG 中
    expect(svg.toLowerCase()).toContain('#1f2937')
  })

  it('renders pie chart', async () => {
    const svg = await render({
      type: 'pie',
      data: [{ name: 'A', value: 30 }, { name: 'B', value: 70 }]
    })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders scatter chart from flat array', async () => {
    const svg = await render({ type: 'scatter', data: [[1, 2], [3, 4], [5, 1]] })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders scatter chart from multi-series shape', async () => {
    const svg = await render({
      type: 'scatter',
      data: { series: [{ name: 'g1', data: [[1, 2], [3, 4]] }, { name: 'g2', data: [[2, 5], [4, 6]] }] }
    })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders radar chart', async () => {
    const svg = await render({
      type: 'radar',
      data: {
        indicators: [{ name: '销售', max: 100 }, { name: '管理', max: 100 }, { name: '技术', max: 100 }],
        series: [{ name: '小张', value: [80, 90, 70] }, { name: '小李', value: [60, 75, 95] }]
      }
    })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders heatmap chart', async () => {
    const svg = await render({
      type: 'heatmap',
      data: {
        x_categories: ['M', 'T', 'W'],
        y_categories: ['AM', 'PM'],
        values: [[0, 0, 5], [1, 0, 10], [2, 0, 3], [0, 1, 8], [1, 1, 15], [2, 1, 7]]
      }
    })
    expect(svg).toMatch(/^<svg/)
  })

  it('renders candlestick to valid SVG', async () => {
    const svg = await render({
      type: 'candlestick',
      kline_style: 'cn',
      data: {
        categories: ['10-01', '10-02', '10-03', '10-04'],
        values: [[100, 110, 95, 115], [110, 108, 105, 112], [108, 120, 107, 122], [120, 118, 115, 125]]
      }
    })
    expect(svg).toMatch(/^<svg/)
    expect(svg).toMatch(/<\/svg>$/)
  })
})

describe('candlestick kline style', () => {
  // cn 风格走通达信经典：阳线**空心**（color: 'transparent'）+ 红边框，阴线绿实心。
  // us 风格走海外软件惯例：阳线**实心**绿、阴线红实心。
  // 这是用户明确强调的业务点，不能弄错。
  type CandlestickSeries = {
    itemStyle: {
      color: string
      color0: string
      borderColor: string
      borderColor0: string
    }
  }

  function getCandlestickItemStyle(input: ChartInput): CandlestickSeries['itemStyle'] {
    const opt = buildOption(input)
    const series = (opt.series as CandlestickSeries[])[0]
    return series.itemStyle
  }

  const baseData = {
    categories: ['a', 'b'],
    values: [[100, 110, 95, 115], [110, 108, 105, 112]]
  }

  it('cn style (light, 同花顺白底): 阳线空心红框 / 阴线绿实心', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'cn', data: baseData })
    expect(style.color).toBe('transparent')      // 阳线空心，背景透出
    expect(style.borderColor).toBe('#dc2626')    // 阳线深红框
    expect(style.color0).toBe('#16a34a')         // 阴线深绿实心
    expect(style.borderColor0).toBe('#15803d')   // 阴线更深绿框
  })

  it('cn style (dark, 通达信黑底): 阳线空心 + 鲜艳红框', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'cn', theme: 'dark', data: baseData })
    expect(style.color).toBe('transparent')
    expect(style.borderColor).toBe('#ef4444')    // dark 下用更亮的红
    expect(style.color0).toBe('#22c55e')
    expect(style.borderColor0).toBe('#16a34a')
  })

  it('us style: 阳线绿实心 / 阴线红实心（美股、欧股惯例）', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'us', data: baseData })
    expect(style.color).toBe('#22c55e')          // 阳线绿实心
    expect(style.borderColor).toBe('#16a34a')
    expect(style.color0).toBe('#ef4444')         // 阴线红实心
    expect(style.borderColor0).toBe('#dc2626')
  })

  it('defaults to cn style when kline_style omitted', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', data: baseData })
    expect(style.color).toBe('transparent')
    expect(style.borderColor).toBe('#dc2626')    // light 默认 → 深红
  })
})

describe('candlestick with volumes', () => {
  // 校验「K 线 + 成交量」副图的 option 结构。
  // 关键断言：双 grid、双 xAxis/yAxis、第二个 series 是 bar，
  // 且每根 bar 的 itemStyle.color 跟当日 close vs open 一致。
  type Bar = { value: number; itemStyle: { color: string } }
  type SeriesOut = { type: string; data: Array<number[] | Bar>; xAxisIndex?: number; yAxisIndex?: number }

  const baseDataWithVol = {
    categories: ['d1', 'd2', 'd3'],
    values: [
      [100, 110, 95, 115],   // 阳线（涨）
      [110, 108, 105, 112],  // 阴线（跌）
      [108, 120, 107, 122]   // 阳线（涨）
    ],
    volumes: [12000, 8500, 15300]
  }

  function findBar(series: SeriesOut[]): SeriesOut {
    const bar = series.find(s => s.type === 'bar')
    if (!bar) throw new Error('expected bar series in candlestick output')
    return bar
  }

  it('renders volume sub-grid: 双 grid、bar series 用 xAxisIndex=1', () => {
    const opt = buildOption({ type: 'candlestick', kline_style: 'cn', data: baseDataWithVol })
    const grids = opt.grid as unknown[]
    const xAxes = opt.xAxis as unknown[]
    const yAxes = opt.yAxis as unknown[]
    const series = opt.series as SeriesOut[]

    expect(Array.isArray(grids)).toBe(true)
    expect(grids.length).toBe(2)
    expect(Array.isArray(xAxes)).toBe(true)
    expect(xAxes.length).toBe(2)
    expect(Array.isArray(yAxes)).toBe(true)
    expect(yAxes.length).toBe(2)

    // series 顺序：candlestick → ...MA(line) → volume(bar)
    expect(series[0].type).toBe('candlestick')
    const bar = findBar(series)
    expect(bar.xAxisIndex).toBe(1)
    expect(bar.yAxisIndex).toBe(1)
    expect(bar.data.length).toBe(3)
  })

  it('双 grid 视觉合一（紧贴无间隙）+ xAxis 0 移到 priceGrid 顶部 + 顶层 axisPointer.link 让 hover 跨 grid 联动', () => {
    const opt = buildOption({
      type: 'candlestick',
      kline_style: 'cn',
      data: baseDataWithVol,
      y_label: '价格(元)'
    })
    const grids = opt.grid as Array<{ top: string | number; bottom: string | number }>
    const xAxes = opt.xAxis as Array<{ position?: string; axisLine?: { show?: boolean }; axisTick?: { show?: boolean }; axisLabel?: { show?: boolean } }>
    const yAxes = opt.yAxis as Array<{ name?: string; nameLocation?: string; nameGap?: number }>

    // priceGrid bottom='25%' + volumeGrid top='75%'：两 grid 边界在画布 75% 高度处对齐，
    // 中间无空隙，价格区+成交量区视觉上是一个统一区域（TradingView 风格）。
    expect(grids[0].bottom).toBe('25%')
    expect(grids[1].top).toBe('75%')
    expect(grids[1].bottom).toBe('12%')

    // 价格 xAxis 改 position:'top' 把日期轴整体放到 priceGrid 顶部，axisLine/Tick/Label 全
    // hide——平时只看见 splitLine（垂直网格虚线），hover 时 axisPointer label 自动在上方
    // 显示日期，跟 volumeGrid 底部 xAxis 上的日期 label 形成"上下双标签"。
    expect(xAxes[0].position).toBe('top')
    expect(xAxes[0].axisLine?.show).toBe(false)
    expect(xAxes[0].axisTick?.show).toBe(false)
    expect(xAxes[0].axisLabel?.show).toBe(false)
    // axisTick/axisLabel hide 但 interval 必须保留——否则 echarts splitLine.interval 默认
    // 'auto' 会回退用 axisLabel.interval，priceGrid 跟 volumeGrid 的 splitLine 密度算出来
    // 不一致 → 上下垂直虚线网格错位。
    type AxisIntervalCarrier = { interval?: number | string; show?: boolean }
    type XAxisWithInterval = { axisTick?: AxisIntervalCarrier; axisLabel?: AxisIntervalCarrier }
    const x0 = xAxes[0] as XAxisWithInterval
    const x1 = xAxes[1] as XAxisWithInterval
    expect(x0.axisTick?.interval).toBe(x1.axisTick?.interval)
    expect(x0.axisLabel?.interval).toBe(x1.axisLabel?.interval)
    expect(x0.axisTick?.interval).toBeDefined()

    // 顶层 axisPointer.link 让两 xAxis 联动：hover 任一 grid 时另一 grid 的 axisPointer
    // 同步 → 垂直虚线贯穿全图、tooltip 自动合并价格+成交量。link 必须放顶层，写在
    // tooltip.axisPointer 内 echarts 不识别（这是 K 线 tooltip 拆两块的根因）。
    type OptWithAxisPointer = { axisPointer?: { link?: Array<{ xAxisIndex?: string | number }> } }
    const ap = (opt as OptWithAxisPointer).axisPointer
    expect(ap?.link).toBeDefined()
    expect(ap?.link?.[0]?.xAxisIndex).toBe('all')

    // 双 grid 模式两侧 axis name 都不显示——不同位数的成交量 axisLabel（"300.00万" 跟
    // "1500.00万" 差 ~20px）会跟 axis name 的 nameGap=36 区间撞，echarts 自动收 grid 给
    // name 让位 → 上下错位。legend 已能标识"价格"，红绿条形图本身就是成交量惯例。
    // AI 传了 y_label='价格(元)' 也不显示——双 grid 模式下 axis name 必须 disable。
    expect(yAxes[0].name).toBeFalsy()
    expect(yAxes[1].name).toBeFalsy()

    // priceGrid 最低 label 跟 volumeGrid 最高 label 在交界处（画布 75% 高度）会重叠
    // （比如 "4500" 撞 "300" 看起来像 "3500"+"00"）→ 行情软件（通达信/同花顺/TradingView）
    // 标准做法：两侧极值 label 都不显示，靠 splitLine 网格 + hover axisPointer 看精确值。
    type AxisLabel = { showMinLabel?: boolean; showMaxLabel?: boolean }
    type YAxisWithLabel = { axisLabel?: AxisLabel }
    const priceLabel = (yAxes[0] as YAxisWithLabel).axisLabel
    const volumeLabel = (yAxes[1] as YAxisWithLabel).axisLabel
    expect(priceLabel?.showMinLabel).toBe(false)
    expect(volumeLabel?.showMaxLabel).toBe(false)

    // priceGrid 跟 volumeGrid 的 right 必须**完全相同**——否则一边宽一边窄，整张图水平错位
    // （用户实测：volumeGrid 必有"成交量"name 占用，priceGrid 不一定有 y_label name，
    //  没让 right 兜底到 axis name 占用时下方比上方短一截）。
    type GridRight = { left?: number; right?: number }
    const g0 = grids[0] as GridRight
    const g1 = grids[1] as GridRight
    expect(g0.right).toBe(g1.right)
    expect(g0.left).toBe(g1.left)
  })

  it('单 grid 模式 priceYAxis name 兜底到"价格"，AI 传 y_label 时尊重 AI', () => {
    // 单 grid 模式（无 volumes）priceGrid 占满画布，axis name 在 axis 中央显示，不会撞
    // axisLabel——保留 axis name 作为标识。
    const noY = buildOption({ type: 'candlestick', kline_style: 'cn', data: { ...baseDataWithVol, volumes: undefined } as ChartInput['data'] } as ChartInput)
    expect((noY.yAxis as { name?: string }).name).toBe('价格')

    const withY = buildOption({ type: 'candlestick', kline_style: 'cn', data: { ...baseDataWithVol, volumes: undefined } as ChartInput['data'], y_label: '价格(元)' } as ChartInput)
    expect((withY.yAxis as { name?: string }).name).toBe('价格(元)')
  })

  it('priceAxisRight 容纳 4 位数成交量 label "1500.00万"，避免双 grid 错位', () => {
    // 双 grid 模式：A 股成交量在千万级时 axisLabel 是 "1500.00万" (8 字符)，比 "300.00万"
    // (6 字符) 长 ~20px。旧的 fontAxisLabel*4.5 算法按 "15.00亿" (6 字符) 估算，撑不住
    // "1500.00万" → axisLabel 推到 axis name 的 nameGap 区间撞 name → echarts 收窄 grid。
    // 改为 fontAxisLabel*5.5 后能容纳 "1500.00万" 不撞 name 区间。
    const opt = buildOption({ type: 'candlestick', kline_style: 'cn', data: baseDataWithVol })
    const grids = opt.grid as Array<{ right?: number }>
    // fontAxisLabel=14, scale=1.0：round(14*5.5 + 14) = 91
    expect(grids[0].right).toBeGreaterThanOrEqual(85)
  })

  it('volume bars colored by 涨跌（cn 涨红跌绿）', () => {
    const opt = buildOption({ type: 'candlestick', kline_style: 'cn', data: baseDataWithVol })
    const bars = findBar(opt.series as SeriesOut[]).data as Bar[]
    expect(bars[0].itemStyle.color).toBe('#ef4444') // d1 close>open → 红
    expect(bars[1].itemStyle.color).toBe('#22c55e') // d2 close<open → 绿
    expect(bars[2].itemStyle.color).toBe('#ef4444') // d3 close>open → 红
  })

  it('volume bars 反转: us 涨绿跌红', () => {
    const opt = buildOption({ type: 'candlestick', kline_style: 'us', data: baseDataWithVol })
    const bars = findBar(opt.series as SeriesOut[]).data as Bar[]
    expect(bars[0].itemStyle.color).toBe('#22c55e') // 涨 → 绿
    expect(bars[1].itemStyle.color).toBe('#ef4444') // 跌 → 红
  })

  it('rejects volumes length mismatch', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: { ...baseDataWithVol, volumes: [1, 2] }
    } as ChartInput)).toThrow(/volumes\.length .* must equal categories\.length/)
  })

  it('rejects non-numeric volumes', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: { ...baseDataWithVol, volumes: ['a', 'b', 'c'] }
    } as unknown as ChartInput)).toThrow(/volumes must be number\[\]/)
  })

  it('renders to valid SVG', async () => {
    const svg = await render({ type: 'candlestick', kline_style: 'cn', data: baseDataWithVol })
    expect(svg).toMatch(/^<svg/)
    expect(svg).toMatch(/<\/svg>$/)
    // 副图存在 → SVG 应该比单图更长（更多元素）
    expect(svg.length).toBeGreaterThan(2000)
  })
})

describe('candlestick 通达信风格 + MA 均线', () => {
  // 业务点：cn K 线必须呈现"通达信/同花顺"专业感——空心阳线、实线网格、自动 MA、
  // 黄色十字光标、右侧价格轴。这些在 ECharts option 层都能直接断言。
  type LineSeries = { type: 'line'; name: string; data: Array<number | '-'>; lineStyle?: { color: string } }
  type AnySeries = { type: string; name?: string; data: unknown[]; xAxisIndex?: number; yAxisIndex?: number }

  function buildLong(n: number) {
    const cats = Array.from({ length: n }, (_, i) => `d${i + 1}`)
    const vals = Array.from({ length: n }, (_, i) => {
      const open = 100 + (i % 5)
      const close = open + (i % 2 === 0 ? 2 : -2)
      return [open, close, Math.min(open, close) - 1, Math.max(open, close) + 1]
    })
    return { categories: cats, values: vals }
  }

  it('数据 < 5 根时不画 MA（series 只有 1 条 candlestick）', () => {
    const opt = buildOption({ type: 'candlestick', data: buildLong(3) })
    const series = opt.series as AnySeries[]
    expect(series.length).toBe(1)
    expect(series[0].type).toBe('candlestick')
  })

  it('数据 ≥ 60 时自动叠加 MA5/10/20/60（默认行为）', () => {
    const opt = buildOption({ type: 'candlestick', data: buildLong(80) })
    const series = opt.series as AnySeries[]
    const lineNames = series.filter(s => s.type === 'line').map(s => s.name)
    expect(lineNames).toEqual(['MA5', 'MA10', 'MA20', 'MA60'])
  })

  it('数据 ≥ 10 < 20 时只叠加 MA5/MA10', () => {
    const opt = buildOption({ type: 'candlestick', data: buildLong(15) })
    const series = opt.series as AnySeries[]
    const lineNames = series.filter(s => s.type === 'line').map(s => s.name)
    expect(lineNames).toEqual(['MA5', 'MA10'])
  })

  it('kline_ma: [] 关闭均线', () => {
    const opt = buildOption({ type: 'candlestick', data: buildLong(80), kline_ma: [] })
    const series = opt.series as AnySeries[]
    expect(series.filter(s => s.type === 'line').length).toBe(0)
  })

  it('kline_ma: [7, 25, 99] 自定义周期（币圈风格）', () => {
    const opt = buildOption({ type: 'candlestick', data: buildLong(120), kline_ma: [7, 25, 99] })
    const series = opt.series as AnySeries[]
    const lineNames = series.filter(s => s.type === 'line').map(s => s.name)
    expect(lineNames).toEqual(['MA7', 'MA25', 'MA99'])
  })

  it('SMA 计算正确：前 N-1 根用占位符 -，第 N 根开始为均值', () => {
    const opt = buildOption({
      type: 'candlestick',
      data: { categories: ['a', 'b', 'c', 'd', 'e'], values: [
        [100, 100, 95, 105], // close=100
        [100, 110, 95, 115], // close=110
        [100, 120, 95, 125], // close=120
        [100, 130, 95, 135], // close=130
        [100, 140, 95, 145]  // close=140
      ]},
      kline_ma: [3]
    })
    const series = opt.series as AnySeries[]
    const ma3 = series.find(s => s.type === 'line') as LineSeries | undefined
    expect(ma3).toBeTruthy()
    // 前 2 根占位
    expect(ma3!.data[0]).toBe('-')
    expect(ma3!.data[1]).toBe('-')
    // 第 3 根：(100+110+120)/3 = 110
    expect(ma3!.data[2]).toBe(110)
    // 第 4 根：(110+120+130)/3 = 120
    expect(ma3!.data[3]).toBe(120)
    // 第 5 根：(120+130+140)/3 = 130
    expect(ma3!.data[4]).toBe(130)
  })

  it('cn 风格：黑底专业主题 + 实线 splitLine + 黄色十字光标', () => {
    const opt = buildOption({ type: 'candlestick', kline_style: 'cn', theme: 'dark', data: buildLong(20) })
    expect(opt.backgroundColor).toBe('#0c0e12')
    type YAxis = { position?: string; splitLine?: { lineStyle?: { type?: string } } }
    const yAxis = opt.yAxis as YAxis
    expect(yAxis.position).toBe('right')   // 价格轴在右侧（行情软件惯例）
    expect(yAxis.splitLine?.lineStyle?.type).toBe('solid')   // 实线网格
    type Tooltip = { axisPointer?: { lineStyle?: { color?: string } } }
    const tooltip = opt.tooltip as Tooltip
    expect(tooltip.axisPointer?.lineStyle?.color).toBe('#fbbf24')   // 黄色十字
  })

  it('us 风格：海外软件主题 + 灰色十字光标（不是黄）', () => {
    const opt = buildOption({ type: 'candlestick', kline_style: 'us', theme: 'dark', data: buildLong(20) })
    type Tooltip = { axisPointer?: { lineStyle?: { color?: string } } }
    const tooltip = opt.tooltip as Tooltip
    expect(tooltip.axisPointer?.lineStyle?.color).not.toBe('#fbbf24')
    expect(tooltip.axisPointer?.lineStyle?.color).toBe('#94a3b8')
  })

  it('K 线 + 成交量场景下 MA 也正常叠加（series 顺序：candlestick → MAs → bar）', () => {
    const data = { ...buildLong(30), volumes: Array(30).fill(1000) }
    const opt = buildOption({ type: 'candlestick', data })
    const series = opt.series as AnySeries[]
    expect(series[0].type).toBe('candlestick')
    expect(series[series.length - 1].type).toBe('bar')
    const lineCount = series.filter(s => s.type === 'line').length
    expect(lineCount).toBe(3)   // MA5 / MA10 / MA20（30 不够 60）
  })

  // 通达信/同花顺习惯：垂直虚线代表"时间分界"，不会每根 K 线都画一条；
  // 我们用纯数量驱动 interval 把虚线数量稳定在 ~8 条。
  it('xAxis splitLine 自适应稀疏：N 越大 interval 越大，确保竖虚线总数维持 ~8', () => {
    type XAxis = { splitLine?: { interval?: number }; axisLabel?: { interval?: number } }
    function xAxisOf(n: number): XAxis {
      const opt = buildOption({ type: 'candlestick', data: buildLong(n) })
      // 单 grid 模式下 xAxis 是单对象
      return opt.xAxis as XAxis
    }
    expect(xAxisOf(5).splitLine?.interval).toBe(0)         // 数据少 → 全画
    expect(xAxisOf(8).splitLine?.interval).toBe(0)
    // n=80 时目标 ~8 条 → interval = ceil(80/8)-1 = 9（每 10 根一条）
    expect(xAxisOf(80).splitLine?.interval).toBe(9)
    // n=250 时 → interval = ceil(250/8)-1 = 31（每 32 根一条）
    expect(xAxisOf(250).splitLine?.interval).toBe(31)
    // axisLabel 与 splitLine 共用同一 interval，保证 label 和虚线对齐
    expect(xAxisOf(80).axisLabel?.interval).toBe(xAxisOf(80).splitLine?.interval)
  })

  it('xAxis splitLine interval 在双 grid（K 线 + 成交量）下两轴一致', () => {
    type XAxis = { splitLine?: { interval?: number } }
    const data = { ...buildLong(120), volumes: Array(120).fill(1000) }
    const opt = buildOption({ type: 'candlestick', data })
    const xAxes = opt.xAxis as XAxis[]
    expect(xAxes.length).toBe(2)
    expect(xAxes[0].splitLine?.interval).toBe(xAxes[1].splitLine?.interval)
    expect(xAxes[0].splitLine?.interval).toBeGreaterThan(0)
  })
})

describe('chart input validation', () => {
  it('rejects bar without categories', () => {
    expect(() => buildOption({ type: 'bar', data: { series: [{ data: [1, 2] }] } } as ChartInput))
      .toThrow(/categories must be string\[\]/)
  })

  it('rejects pie item missing value', () => {
    expect(() => buildOption({ type: 'pie', data: [{ name: 'A' }] } as unknown as ChartInput))
      .toThrow(/missing number field "value"/)
  })

  it('rejects pie item missing name', () => {
    expect(() => buildOption({ type: 'pie', data: [{ value: 30 }] } as unknown as ChartInput))
      .toThrow(/missing string field "name"/)
  })

  it('rejects candlestick when categories and values length mismatch', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: { categories: ['a'], values: [[1, 2, 3, 4], [5, 6, 7, 8]] }
    } as ChartInput)).toThrow(/categories\.length .* must equal values\.length/)
  })

  it('rejects scatter with non-numeric points', () => {
    expect(() => buildOption({ type: 'scatter', data: [['x', 'y']] } as unknown as ChartInput))
      .toThrow(/must be \[x, y\] number pair/)
  })

  it('rejects radar without indicators', () => {
    expect(() => buildOption({ type: 'radar', data: { series: [{ value: [1, 2] }] } } as ChartInput))
      .toThrow(/indicators must be array/)
  })

  it('rejects unknown chart type', () => {
    expect(() => buildOption({ type: 'unknown', data: {} } as unknown as ChartInput))
      .toThrow(/Unsupported chart type/)
  })

  it('rejects heatmap with non-string x_categories', () => {
    expect(() => buildOption({
      type: 'heatmap',
      data: { x_categories: [1, 2], y_categories: ['a'], values: [[0, 0, 1]] }
    } as unknown as ChartInput)).toThrow(/x_categories must be string\[\]/)
  })

  it('rejects bar/line series.data length mismatch with categories', () => {
    expect(() => buildOption({
      type: 'bar',
      data: { categories: ['Q1', 'Q2', 'Q3'], series: [{ data: [1, 2] }] }
    } as ChartInput)).toThrow(/series\[0\]\.data\.length.*must equal categories\.length/)
  })

  it('rejects radar series.value length mismatch with indicators', () => {
    expect(() => buildOption({
      type: 'radar',
      data: {
        indicators: [{ name: 'A', max: 100 }, { name: 'B', max: 100 }, { name: 'C', max: 100 }],
        series: [{ value: [80, 90] }]
      }
    } as ChartInput)).toThrow(/series\[0\]\.value\.length.*must equal indicators\.length/)
  })

  it('rejects heatmap value with out-of-range x index', () => {
    expect(() => buildOption({
      type: 'heatmap',
      data: { x_categories: ['M', 'T'], y_categories: ['AM'], values: [[5, 0, 1]] }
    } as ChartInput)).toThrow(/out of x_categories range/)
  })

  it('rejects heatmap value with out-of-range y index', () => {
    expect(() => buildOption({
      type: 'heatmap',
      data: { x_categories: ['M'], y_categories: ['AM'], values: [[0, 3, 1]] }
    } as ChartInput)).toThrow(/out of y_categories range/)
  })
})

describe('chart error message includes received data shape (AI self-correct hint)', () => {
  // 弱模型（豆包 Lite / DeepSeek Flash 等）实测常把 categories 写成方言别名（dates / x /
  // labels / time 等），错误信息只说 "got undefined" 时它无法定位自己实际传的 data 长啥样，
  // 反复用同样的 args 重试。throw 信息附带 "(received data: object(keys=...))" 后缀让
  // 弱模型能从字面看出"哦我用的字段名叫 dates，应该叫 categories"，显著提升自纠正成功率。

  it('candlestick: 把 categories 写成 dates 时错误信息列出 received keys', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: { dates: ['a', 'b'], values: [[1, 2, 3, 4], [5, 6, 7, 8]] }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=dates,values\)/)
  })

  it('candlestick: 把 categories 写成 x 时错误信息列出 received keys', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: { x: ['a', 'b'], y: [[1, 2, 3, 4], [5, 6, 7, 8]] }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=x,y\)/)
  })

  it('candlestick: data 是数组（外层类型搞错）时 received data 描述成 array', () => {
    // AI 偶尔会把整个 data 写成 [[...K线行...]] 这种顶层数组形式（混淆了 scatter 的 schema）。
    // 数组也是 object，会走到 categories 检查，错误后缀显示 "array(len=N)" 让 AI 看出
    // "我把 data 写成了数组，应该写成 { categories, values } 对象"。
    expect(() => buildOption({
      type: 'candlestick',
      data: [['a', 1, 2, 3, 4]]
    } as unknown as ChartInput)).toThrow(/received data: array\(len=1\)/)
  })

  it('candlestick: data 完全不是对象（字符串）时顶层 throw 描述形状', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: 'whatever'
    } as unknown as ChartInput)).toThrow(/got string/)
  })

  it('candlestick: volumes 类型错时也带 received keys', () => {
    expect(() => buildOption({
      type: 'candlestick',
      data: {
        categories: ['a', 'b'],
        values: [[1, 2, 3, 4], [5, 6, 7, 8]],
        volumes: 'not-an-array'
      }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=categories,values,volumes\)/)
  })

  it('bar/line: 把 categories 写成 x_axis 时错误信息列出 received keys', () => {
    expect(() => buildOption({
      type: 'bar',
      data: { x_axis: ['a'], series: [{ data: [1] }] }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=x_axis,series\)/)
  })

  it('heatmap: 把 x_categories 写成 x 时错误信息列出 received keys', () => {
    expect(() => buildOption({
      type: 'heatmap',
      data: { x: ['a'], y: ['b'], values: [[0, 0, 1]] }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=x,y,values\)/)
  })

  it('radar: 把 indicators 写成 dimensions 时错误信息列出 received keys', () => {
    expect(() => buildOption({
      type: 'radar',
      data: { dimensions: [{ name: 'A', max: 100 }], series: [{ value: [50] }] }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=dimensions,series\)/)
  })

  it('对象 keys 数量超过 4 时不被截断（dataShape 不像 describe 那样 slice 4）', () => {
    // describe() 旧 helper 截断 4 个 keys，但 dataShape 用全列出。AI 把 candlestick 数据
    // 写成"完全不像 K 线"的对象时（很多字段都错），列全部 keys 才能让 AI 看清整体结构。
    expect(() => buildOption({
      type: 'candlestick',
      data: { f1: 1, f2: 2, f3: 3, f4: 4, f5: 5, f6: 6 }
    } as unknown as ChartInput)).toThrow(/received data: object\(keys=f1,f2,f3,f4,f5,f6\)/)
  })
})

describe('pie data tolerance', () => {
  // AI 实测高频犯错：把 pie data 套进 {items:[...]} / {data:[...]} / {series:[...]}
  // 工具应当容错并解析出来，避免反复重试。
  type PieSeries = { data: Array<{ name: string; value: number }> }

  function getPieData(input: ChartInput): Array<{ name: string; value: number }> {
    const opt = buildOption(input)
    return (opt.series as PieSeries[])[0].data
  }

  it('accepts top-level array (canonical shape)', () => {
    const data = getPieData({
      type: 'pie',
      data: [{ name: 'A', value: 30 }, { name: 'B', value: 70 }]
    })
    expect(data).toEqual([{ name: 'A', value: 30 }, { name: 'B', value: 70 }])
  })

  it('tolerates { data: [...] } wrapper', () => {
    const data = getPieData({
      type: 'pie',
      data: { data: [{ name: 'A', value: 30 }] }
    } as unknown as ChartInput)
    expect(data).toEqual([{ name: 'A', value: 30 }])
  })

  it('tolerates { items: [...] } wrapper', () => {
    const data = getPieData({
      type: 'pie',
      data: { items: [{ name: 'A', value: 30 }] }
    } as unknown as ChartInput)
    expect(data).toEqual([{ name: 'A', value: 30 }])
  })

  it('tolerates { series: [...] } wrapper', () => {
    const data = getPieData({
      type: 'pie',
      data: { series: [{ name: 'A', value: 30 }] }
    } as unknown as ChartInput)
    expect(data).toEqual([{ name: 'A', value: 30 }])
  })

  it('tolerates { values: [...] } wrapper', () => {
    const data = getPieData({
      type: 'pie',
      data: { values: [{ name: 'A', value: 30 }] }
    } as unknown as ChartInput)
    expect(data).toEqual([{ name: 'A', value: 30 }])
  })

  it('tolerates field aliases (label/category/title for name; amount/count/v for value)', () => {
    const data = getPieData({
      type: 'pie',
      data: [{ label: 'A', amount: 30 }, { category: 'B', count: 70 }]
    } as unknown as ChartInput)
    expect(data).toEqual([{ name: 'A', value: 30 }, { name: 'B', value: 70 }])
  })

  it('rejects object without recognizable list field', () => {
    expect(() => buildOption({
      type: 'pie',
      data: { foo: 'bar' }
    } as unknown as ChartInput)).toThrow(/object without data\/items\/series array field/)
  })

  it('error message contains received type for AI debugging', () => {
    expect(() => buildOption({
      type: 'bar',
      data: 'not an object'
    } as unknown as ChartInput)).toThrow(/got string/)
  })
})

describe('普通图表字号自适应（calcFontScale 基准 800）', () => {
  // 业务点：1280×800 默认画布下硬编码 12-16px 字号实测偏小，原因是缺乏字号自适应。
  // 新策略：普通图表用 calcFontScale，width ≤ 800 时 scale=1.0（小画布字号自然合适），
  // 800-1600 线性 → 1.4×，1600-3200 → 2.0×，3200+ 上限。下面验证关键档位的字号。
  // K 线另走 calcKlineFontScale（基准 1280），单独回归验证。
  type WithFontSize = { fontSize?: number }
  type TitleObj = { textStyle?: WithFontSize; subtextStyle?: WithFontSize }
  type AxisObj = { axisLabel?: WithFontSize; nameTextStyle?: WithFontSize }
  type LegendObj = { textStyle?: WithFontSize }
  type PieSeriesObj = { label?: WithFontSize }

  it('width=800 → scale=1.0：title 16 / subtitle 12 / axisLabel 12（基准值）', () => {
    const opt = buildOption(
      {
        type: 'bar',
        title: 'T',
        subtitle: 'S',
        x_label: 'x',
        data: { categories: ['a'], series: [{ name: 's1', data: [1] }, { name: 's2', data: [2] }] }
      },
      { width: 800, height: 400 }
    )
    const title = opt.title as TitleObj
    expect(title.textStyle?.fontSize).toBe(16)
    expect(title.subtextStyle?.fontSize).toBe(12)
    const xAxis = opt.xAxis as AxisObj
    expect(xAxis.axisLabel?.fontSize).toBe(12)
    expect(xAxis.nameTextStyle?.fontSize).toBe(12)
    const legend = opt.legend as LegendObj
    expect(legend.textStyle?.fontSize).toBe(12)
  })

  it('width=1280 → scale≈1.24：fontSize 按比例放大（不再"和小画布一样小"）', () => {
    const opt = buildOption(
      {
        type: 'bar',
        title: 'T',
        subtitle: 'S',
        data: { categories: ['a'], series: [{ name: 'x', data: [1] }] }
      },
      { width: 1280, height: 800 }
    )
    // scale = 1 + (1280-800)/(1600-800) × 0.4 = 1.24
    const title = opt.title as TitleObj
    expect(title.textStyle?.fontSize).toBe(Math.round(16 * 1.24)) // 20
    expect(title.subtextStyle?.fontSize).toBe(Math.round(12 * 1.24)) // 15
    const xAxis = opt.xAxis as AxisObj
    expect(xAxis.axisLabel?.fontSize).toBe(Math.round(12 * 1.24)) // 15
  })

  it('width≥3200 → scale=2.0 上限：title 32 / axisLabel 24', () => {
    const opt = buildOption(
      { type: 'pie', title: 'T', data: [{ name: 'A', value: 50 }] },
      { width: 3200, height: 1500 }
    )
    const title = opt.title as TitleObj
    expect(title.textStyle?.fontSize).toBe(32)
    const series = opt.series as PieSeriesObj[]
    expect(series[0].label?.fontSize).toBe(24)
  })

  it('width 不传 → scale=1.0 兜底（buildOption 单参数调用不应崩）', () => {
    const opt = buildOption({
      type: 'bar',
      title: 'T',
      data: { categories: ['a'], series: [{ name: 'x', data: [1] }, { name: 'y', data: [2] }] }
    })
    const legend = opt.legend as LegendObj
    expect(legend.textStyle?.fontSize).toBe(12)
  })

  it('heatmap series.label 和 visualMap.textStyle 也带上 scale（不被遗漏）', () => {
    const opt = buildOption(
      {
        type: 'heatmap',
        data: {
          x_categories: ['a'],
          y_categories: ['b'],
          values: [[0, 0, 1]]
        }
      },
      { width: 1600, height: 600 } // scale=1.4
    )
    type HeatmapSeries = { label?: WithFontSize }
    type VisualMap = { textStyle?: WithFontSize }
    const series = opt.series as HeatmapSeries[]
    expect(series[0].label?.fontSize).toBe(Math.round(12 * 1.4))
    const vm = opt.visualMap as VisualMap
    expect(vm.textStyle?.fontSize).toBe(Math.round(11 * 1.4))
  })

  it('radar axisName 字号也带 scale', () => {
    const opt = buildOption(
      {
        type: 'radar',
        data: {
          indicators: [{ name: 'A', max: 100 }],
          series: [{ value: [50] }]
        }
      },
      { width: 2400, height: 1200 } // scale=1.4 + (2400-1600)/(3200-1600)*0.6 = 1.7
    )
    type Radar = { axisName?: WithFontSize }
    const radar = opt.radar as Radar
    expect(radar.axisName?.fontSize).toBe(Math.round(12 * 1.7))
  })
})

describe('K 线字号回归（calcKlineFontScale 基准 1280，与普通图表 calcFontScale 隔离）', () => {
  // K 线视觉手感经过用户实测调过，本次"普通图表加字号自适应"不应改动 K 线。
  // 这两个用例锁住"K 线 1280 = 1.0× / 2400 = 1.4×"的现状，避免后续误共用 scale。
  type WithFontSize = { fontSize?: number }
  type Legend = { textStyle?: WithFontSize }

  const baseData = {
    categories: ['a', 'b'],
    values: [[100, 110, 95, 115], [110, 108, 105, 112]]
  } as const

  it('width=1280 → fontSubtitle = 14 × 1.0 = 14（不会因新 calcFontScale 提前放大）', () => {
    const opt = buildOption(
      { type: 'candlestick', data: baseData },
      { width: 1280, height: 800 }
    )
    expect((opt.legend as Legend).textStyle?.fontSize).toBe(14)
  })

  it('width=2400 → fontSubtitle = 14 × 1.4 ≈ 20（calcKlineFontScale 自有曲线生效）', () => {
    const opt = buildOption(
      { type: 'candlestick', data: baseData },
      { width: 2400, height: 1000 }
    )
    expect((opt.legend as Legend).textStyle?.fontSize).toBe(Math.round(14 * 1.4))
  })
})

describe('renderToPng (sharp 栅格化, 中文字体走系统 PingFang SC)', () => {
  it('renders a chart to PNG buffer with valid PNG magic bytes', async () => {
    const opt = buildOption({
      type: 'bar',
      title: '季度营收',
      data: { categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '营收', data: [120, 200, 150, 180] }] }
    })
    const buf = await renderToPng(opt, SIZE)

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(500)
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4E)
    expect(buf[3]).toBe(0x47)
  })

  it('renders different chart types to PNG without throwing', async () => {
    const cases: ChartInput[] = [
      { type: 'pie', data: [{ name: '投行', value: 30 }, { name: '资管', value: 70 }] },
      { type: 'line', data: { categories: ['一月', '二月', '三月'], series: [{ name: '营收', data: [10, 50, 30] }] } },
      { type: 'radar', data: {
        indicators: [{ name: '盈利能力', max: 100 }, { name: '成长性', max: 100 }],
        series: [{ name: '本期', value: [80, 90] }]
      } }
    ]
    for (const input of cases) {
      const buf = await renderToPng(buildOption(input), SIZE)
      expect(buf.length).toBeGreaterThan(500)
      expect(buf[0]).toBe(0x89)
    }
  })
})

describe('renderToPng pixelRatio (布局尺寸 / 像素密度解耦)', () => {
  // PNG IHDR chunk: bytes 16-19 = width, 20-23 = height（big-endian uint32），
  // 这是 PNG 规范固定布局；用 readUInt32BE 取出来比 sharp.metadata 要快、不必再加 import。
  function pngDims(buf: Buffer): { width: number; height: number } {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    }
  }

  const opt = buildOption({
    type: 'bar',
    data: { categories: ['Q1', 'Q2'], series: [{ name: '营收', data: [10, 20] }] }
  })

  it('默认（不传 pixelRatio）= 1:1 像素，向后兼容', async () => {
    const buf = await renderToPng(opt, { width: 800, height: 500 })
    const { width, height } = pngDims(buf)
    expect(width).toBe(800)
    expect(height).toBe(500)
  })

  it('pixelRatio=2 → 像素 ≈ 2× SVG 尺寸（Retina 缩放）', async () => {
    const buf = await renderToPng(opt, { width: 800, height: 500 }, { pixelRatio: 2 })
    const { width, height } = pngDims(buf)
    // librsvg 在 density=144 下偶尔有 ±1 像素的 floor/ceil 差异，给一格容差
    expect(width).toBeGreaterThanOrEqual(1599)
    expect(width).toBeLessThanOrEqual(1601)
    expect(height).toBeGreaterThanOrEqual(999)
    expect(height).toBeLessThanOrEqual(1001)
  })

  it('pixelRatio=3 → 像素 ≈ 3× SVG 尺寸', async () => {
    const buf = await renderToPng(opt, { width: 600, height: 400 }, { pixelRatio: 3 })
    const { width, height } = pngDims(buf)
    expect(width).toBeGreaterThanOrEqual(1799)
    expect(width).toBeLessThanOrEqual(1801)
    expect(height).toBeGreaterThanOrEqual(1199)
    expect(height).toBeLessThanOrEqual(1201)
  })

  it('pixelRatio=1 显式传入 = 不放大（=同未传）', async () => {
    const buf = await renderToPng(opt, { width: 600, height: 400 }, { pixelRatio: 1 })
    const { width, height } = pngDims(buf)
    expect(width).toBe(600)
    expect(height).toBe(400)
  })

  it('pixelRatio=0.5 / 负数 → 强制兜底到 1（避免 sharp density<72 出怪图）', async () => {
    for (const r of [0.5, 0, -1]) {
      const buf = await renderToPng(opt, { width: 600, height: 400 }, { pixelRatio: r })
      const { width, height } = pngDims(buf)
      expect(width).toBe(600)
      expect(height).toBe(400)
    }
  })

  it('高 ratio 输出像素显著大于 1× 输出（确认 sharp density 路径生效）', async () => {
    const small = await renderToPng(opt, { width: 400, height: 300 }, { pixelRatio: 1 })
    const large = await renderToPng(opt, { width: 400, height: 300 }, { pixelRatio: 3 })
    // 同 SVG 在 1× 和 3× 之间，大图应远大于小图（理论 9 倍像素，PNG 压缩后 ≥3 倍即可）
    expect(large.length).toBeGreaterThan(small.length * 3)
  })
})
