import { describe, it, expect } from 'vitest'
import {
  formatKlineTooltip,
  formatVolume,
  reifyFormattersForRender
} from '../../../../../../shared/utils/echarts-formatters'

describe('formatVolume', () => {
  it('按数量级输出亿/万/k', () => {
    expect(formatVolume(123456789)).toBe('1.23亿')
    expect(formatVolume(54321)).toBe('5.43万')
    expect(formatVolume(1234)).toBe('1.2k')
    expect(formatVolume(500)).toBe('500')
    expect(formatVolume(-1234567890)).toBe('-12.35亿')
  })
})

describe('formatKlineTooltip', () => {
  it('candlestick row 用 borderColor 自造 marker（涨跌都看得见，不依赖 echarts 的默认 marker）', () => {
    // 阳线（红框透明填充，cn 风格）：echarts 给的 p.marker 会用 color (transparent) → 空白；
    // 我们改用 borderColor (#ec0000 红) 自造圆点 marker，"涨的时候空白" bug 就这么修的。
    const html = formatKlineTooltip([
      {
        seriesName: '价格',
        axisValueLabel: '04-25',
        componentSubType: 'candlestick',
        value: [0, 248, 246.5, 244.8, 249.5],
        marker: '<span style="background:transparent"></span>', // echarts 给的默认 marker（空白）
        color: 'transparent',
        borderColor: '#ec0000'
      }
    ])
    // 不能含 echarts 给的"transparent" marker
    expect(html).not.toContain('background:transparent')
    // 必须有用 borderColor 自造的实心圆点
    expect(html).toContain('background:#ec0000')
    expect(html).toContain('border-radius:50%')
    // 中文 OHLC 标签
    expect(html).toContain('开盘')
    expect(html).toContain('收盘')
    expect(html).toContain('最低')
    expect(html).toContain('最高')
    // 标题（x 轴值）
    expect(html).toContain('04-25')
  })

  it('阴线 marker 用 borderColor (downBorderColor) 渲染绿色', () => {
    const html = formatKlineTooltip([
      {
        seriesName: '价格',
        axisValueLabel: '05-08',
        componentSubType: 'candlestick',
        value: [0, 100, 95, 94, 102], // close < open，跌
        borderColor: '#26a69a',
        color: '#26a69a'
      }
    ])
    expect(html).toContain('background:#26a69a')
  })

  it('成交量 series（bar）用 formatVolume 显示', () => {
    const html = formatKlineTooltip([
      {
        seriesName: '成交量',
        axisValueLabel: '05-08',
        componentSubType: 'bar',
        value: 654321000,
        marker: '<span class="echarts-marker">●</span>'
      }
    ])
    expect(html).toContain('6.54亿')
    expect(html).toContain('成交量')
  })

  it('MA 线（line series）保留两位小数，沿用 echarts 给的 marker', () => {
    const html = formatKlineTooltip([
      {
        seriesName: 'MA5',
        axisValueLabel: '05-08',
        componentSubType: 'line',
        value: 244.123456,
        marker: '<span style="background:#1f2937"></span>'
      }
    ])
    expect(html).toContain('244.12')
    expect(html).toContain('MA5')
    // line 用默认 marker（已经是带颜色的，不是 transparent）
    expect(html).toContain('background:#1f2937')
  })

  it('escapeHtml 防 XSS：恶意 series name 不能注入 HTML', () => {
    const html = formatKlineTooltip([
      {
        seriesName: '<script>alert(1)</script>',
        axisValueLabel: 'normal',
        componentSubType: 'line',
        value: 100
      }
    ])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('borderColor 字段也走 escapeHtml（防 css 注入）', () => {
    const html = formatKlineTooltip([
      {
        seriesName: '价格',
        axisValueLabel: '01-01',
        componentSubType: 'candlestick',
        value: [0, 1, 2, 0, 3],
        borderColor: 'red"</span><script>alert(1)</script>'
      }
    ])
    expect(html).not.toContain('<script>')
  })

  it('空数组 / 单个对象都能处理', () => {
    expect(formatKlineTooltip([])).toBe('')
    const html = formatKlineTooltip({
      seriesName: 'MA5',
      axisValueLabel: 'X',
      componentSubType: 'line',
      value: 50
    })
    expect(html).toContain('MA5')
    expect(html).toContain('50.00')
  })
})

describe('reifyFormattersForRender 安全：only own-property 命中 FORMATTER_REGISTRY', () => {
  // 防御 AI 在 render_echarts_option 自由路径里造 { __echartsFn:'toString' } 这类 marker：
  // 之前 reifyImpl 直接 bracket 索引 FORMATTER_REGISTRY，原型链上的 toString/hasOwnProperty/
  // constructor 等 function 都会命中 → 被装到 echarts 当 formatter，绕过白名单设计意图。
  // 现在 reifyImpl 用 Object.hasOwn 守卫，只显式登记的内置 formatter 命中。
  it('未登记的 marker 名（含原型链方法）一律返回 undefined 让 echarts 走默认 formatter', () => {
    const out1 = reifyFormattersForRender({ axisLabel: { formatter: { __echartsFn: 'toString' } } })
    expect((out1 as { axisLabel: { formatter?: unknown } }).axisLabel.formatter).toBeUndefined()

    const out2 = reifyFormattersForRender({ axisLabel: { formatter: { __echartsFn: 'hasOwnProperty' } } })
    expect((out2 as { axisLabel: { formatter?: unknown } }).axisLabel.formatter).toBeUndefined()

    const out3 = reifyFormattersForRender({ axisLabel: { formatter: { __echartsFn: 'constructor' } } })
    expect((out3 as { axisLabel: { formatter?: unknown } }).axisLabel.formatter).toBeUndefined()

    const out4 = reifyFormattersForRender({ axisLabel: { formatter: { __echartsFn: 'unknownThing' } } })
    expect((out4 as { axisLabel: { formatter?: unknown } }).axisLabel.formatter).toBeUndefined()
  })

  it('登记的 marker 名（volume / klineTooltip）正常还原成 function', () => {
    const out = reifyFormattersForRender({ axisLabel: { formatter: { __echartsFn: 'volume' } } })
    expect(typeof (out as { axisLabel: { formatter?: unknown } }).axisLabel.formatter).toBe('function')
  })
})
