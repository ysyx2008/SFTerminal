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
import { renderToSvg } from '../ssr'

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
  // cn / us 用的是同一组 hex（红 #ef4444 / 绿 #22c55e），只是角色对调。
  // SVG 字符串里两种颜色都会出现，只断言"包含某色"无法区分 cn/us。
  // 必须在 ECharts option 层直接断言 series.itemStyle 的 color / color0 字段，
  // 这才是用户明确强调的业务点：A 股红涨绿跌、美股绿涨红跌。
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

  it('cn style: 阳线红 / 阴线绿（A股、港股惯例）', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'cn', data: baseData })
    expect(style.color).toBe('#ef4444')   // 涨 → 红
    expect(style.color0).toBe('#22c55e')  // 跌 → 绿
  })

  it('us style: 阳线绿 / 阴线红（美股、欧股惯例）', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'us', data: baseData })
    expect(style.color).toBe('#22c55e')   // 涨 → 绿
    expect(style.color0).toBe('#ef4444')  // 跌 → 红
  })

  it('defaults to cn style when kline_style omitted', () => {
    const style = getCandlestickItemStyle({ type: 'candlestick', data: baseData })
    expect(style.color).toBe('#ef4444')
    expect(style.color0).toBe('#22c55e')
  })

  it('borderColor matches color (filled candles)', () => {
    const cn = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'cn', data: baseData })
    expect(cn.borderColor).toBe('#dc2626')
    expect(cn.borderColor0).toBe('#16a34a')
    const us = getCandlestickItemStyle({ type: 'candlestick', kline_style: 'us', data: baseData })
    expect(us.borderColor).toBe('#16a34a')
    expect(us.borderColor0).toBe('#dc2626')
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
