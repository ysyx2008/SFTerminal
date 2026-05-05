/**
 * 把统一的图表参数转换成 ECharts option
 *
 * 设计要点：
 * - 输入采用扁平化、面向 AI 的数据格式（不要求 AI 直接拼 ECharts 复杂结构）
 * - 各 chart 类型的 data 字段 schema 不同，由各自的 build* 函数校验
 * - 出错抛 Error，由调用方捕获返回友好错误
 */

import { getTheme, getKlineColors, type ChartTheme, type KlineStyle, type ThemePreset } from './presets'

export type ChartType =
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'scatter'
  | 'radar'
  | 'heatmap'
  | 'candlestick'

export interface ChartInput {
  type: ChartType
  title?: string
  subtitle?: string
  data: unknown
  x_label?: string
  y_label?: string
  theme?: ChartTheme
  /** 仅 candlestick 生效，默认 cn */
  kline_style?: KlineStyle
  /** 是否显示图例（默认有 series.name 时显示） */
  legend?: boolean
}

/** 通用 ECharts option（避免引入 ECharts 类型，保持解耦） */
export type EChartsOption = Record<string, unknown>

// ============================================================================
// 入口
// ============================================================================

export function buildOption(input: ChartInput): EChartsOption {
  const theme = getTheme(input.theme ?? 'light')

  let option: EChartsOption
  switch (input.type) {
    case 'bar':         option = buildBar(input, theme); break
    case 'line':        option = buildLine(input, theme, false); break
    case 'area':        option = buildLine(input, theme, true); break
    case 'pie':         option = buildPie(input, theme); break
    case 'scatter':     option = buildScatter(input, theme); break
    case 'radar':       option = buildRadar(input, theme); break
    case 'heatmap':     option = buildHeatmap(input, theme); break
    case 'candlestick': option = buildCandlestick(input, theme); break
    default:
      throw new Error(`Unsupported chart type: ${(input as ChartInput).type}`)
  }

  return applyCommon(option, input, theme)
}

/**
 * 注入背景色、标题、调色板等通用配置；坐标轴样式由各 build 函数自己处理
 * （不同 chart 类型对 axis 的需要不同，比如 pie/radar 没有 axis）
 */
function applyCommon(option: EChartsOption, input: ChartInput, theme: ThemePreset): EChartsOption {
  const merged: EChartsOption = {
    backgroundColor: theme.backgroundColor,
    color: theme.palette,
    textStyle: { color: theme.textColor, fontFamily: 'PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif' },
    animation: false,
    ...option
  }
  if (input.title || input.subtitle) {
    merged.title = {
      text: input.title ?? '',
      subtext: input.subtitle ?? '',
      left: 'center',
      textStyle: { color: theme.textColor, fontSize: 16, fontWeight: 'bold' },
      subtextStyle: { color: theme.axisLabelColor, fontSize: 12 }
    }
  }
  return merged
}

// ============================================================================
// 通用辅助
// ============================================================================

interface CategorySeriesData {
  categories: string[]
  series: Array<{ name?: string; data: number[] }>
}

function asCategorySeries(raw: unknown, chartType: string): CategorySeriesData {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${chartType} data must be an object with { categories, series }`)
  }
  const obj = raw as Record<string, unknown>
  const categories = obj.categories
  const series = obj.series
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string')) {
    throw new Error(`${chartType} data.categories must be string[]`)
  }
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(`${chartType} data.series must be a non-empty array`)
  }
  for (const [i, s] of series.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`${chartType} series item must be object`)
    const sObj = s as Record<string, unknown>
    if (!Array.isArray(sObj.data) || !sObj.data.every(d => typeof d === 'number')) {
      throw new Error(`${chartType} series[].data must be number[]`)
    }
    if (sObj.data.length !== categories.length) {
      throw new Error(
        `${chartType} series[${i}].data.length (${sObj.data.length}) must equal categories.length (${categories.length})`
      )
    }
  }
  return { categories, series: series as Array<{ name?: string; data: number[] }> }
}

function buildAxis(theme: ThemePreset, label?: string, isCategory = false): EChartsOption {
  return {
    type: isCategory ? 'category' : 'value',
    name: label,
    nameTextStyle: { color: theme.axisLabelColor, fontSize: 12 },
    axisLine: { lineStyle: { color: theme.axisLineColor } },
    axisLabel: { color: theme.axisLabelColor },
    splitLine: { lineStyle: { color: theme.splitLineColor, type: 'dashed' } }
  }
}

function buildLegend(input: ChartInput, theme: ThemePreset, names: string[]): EChartsOption | undefined {
  // 默认仅当多 series 且有名字时显示图例（单系列图例多余）；input.legend 可强制覆盖
  const wantLegend = input.legend ?? (names.length > 1 && names.some(n => n))
  if (!wantLegend) return undefined
  return {
    data: names,
    top: input.title ? 32 : 8,
    textStyle: { color: theme.axisLabelColor }
  }
}

function buildGrid(input: ChartInput): EChartsOption {
  return {
    left: 60,
    right: 30,
    bottom: 50,
    top: input.title ? (input.subtitle ? 80 : 60) : 50,
    containLabel: true
  }
}

// ============================================================================
// bar / line / area
// ============================================================================

function buildBar(input: ChartInput, theme: ThemePreset): EChartsOption {
  const { categories, series } = asCategorySeries(input.data, 'bar')
  const names = series.map(s => s.name ?? '')
  return {
    grid: buildGrid(input),
    legend: buildLegend(input, theme, names),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { ...buildAxis(theme, input.x_label, true), data: categories },
    yAxis: buildAxis(theme, input.y_label, false),
    series: series.map(s => ({
      type: 'bar',
      name: s.name,
      data: s.data
    }))
  }
}

function buildLine(input: ChartInput, theme: ThemePreset, area: boolean): EChartsOption {
  const { categories, series } = asCategorySeries(input.data, area ? 'area' : 'line')
  const names = series.map(s => s.name ?? '')
  return {
    grid: buildGrid(input),
    legend: buildLegend(input, theme, names),
    tooltip: { trigger: 'axis' },
    xAxis: { ...buildAxis(theme, input.x_label, true), data: categories, boundaryGap: false },
    yAxis: buildAxis(theme, input.y_label, false),
    series: series.map(s => ({
      type: 'line',
      name: s.name,
      data: s.data,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      ...(area ? { areaStyle: { opacity: 0.3 } } : {})
    }))
  }
}

// ============================================================================
// pie
// ============================================================================

interface PieItem { name: string; value: number }

function buildPie(input: ChartInput, theme: ThemePreset): EChartsOption {
  if (!Array.isArray(input.data)) {
    throw new Error('pie data must be array of { name, value }')
  }
  const items: PieItem[] = input.data.map((d, i) => {
    if (!d || typeof d !== 'object') throw new Error(`pie data[${i}] must be object`)
    const o = d as Record<string, unknown>
    if (typeof o.name !== 'string') throw new Error(`pie data[${i}].name must be string`)
    if (typeof o.value !== 'number') throw new Error(`pie data[${i}].value must be number`)
    return { name: o.name, value: o.value }
  })
  return {
    legend: buildLegend(input, theme, items.map(i => i.name)),
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: ['40%', '65%'],
      center: ['50%', '55%'],
      data: items,
      label: { color: theme.textColor },
      labelLine: { lineStyle: { color: theme.axisLineColor } }
    }]
  }
}

// ============================================================================
// scatter
// ============================================================================

function buildScatter(input: ChartInput, theme: ThemePreset): EChartsOption {
  // 接受 [[x, y], ...] 或 { series: [{ name, data: [[x,y],...] }] }
  const raw = input.data
  const seriesArr: Array<{ name?: string; data: number[][] }> = []
  if (Array.isArray(raw)) {
    seriesArr.push({ data: validatePoints(raw, 'scatter') })
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { series?: unknown }).series)) {
    const s = (raw as { series: unknown[] }).series
    for (const item of s) {
      if (!item || typeof item !== 'object') throw new Error('scatter series item must be object')
      const o = item as Record<string, unknown>
      seriesArr.push({
        name: typeof o.name === 'string' ? o.name : undefined,
        data: validatePoints(o.data, 'scatter')
      })
    }
  } else {
    throw new Error('scatter data must be number[][] or { series: [{ name, data }] }')
  }
  return {
    grid: buildGrid(input),
    legend: buildLegend(input, theme, seriesArr.map(s => s.name ?? '')),
    tooltip: { trigger: 'item' },
    xAxis: buildAxis(theme, input.x_label, false),
    yAxis: buildAxis(theme, input.y_label, false),
    series: seriesArr.map(s => ({
      type: 'scatter',
      name: s.name,
      data: s.data,
      symbolSize: 10
    }))
  }
}

function validatePoints(raw: unknown, ctx: string): number[][] {
  if (!Array.isArray(raw)) throw new Error(`${ctx} data must be number[][]`)
  return raw.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
      throw new Error(`${ctx} data[${i}] must be [x, y] number pair`)
    }
    return [p[0], p[1]]
  })
}

// ============================================================================
// radar
// ============================================================================

function buildRadar(input: ChartInput, theme: ThemePreset): EChartsOption {
  const raw = input.data
  if (!raw || typeof raw !== 'object') throw new Error('radar data must be { indicators, series }')
  const obj = raw as Record<string, unknown>
  const indicators = obj.indicators
  const series = obj.series
  if (!Array.isArray(indicators)) throw new Error('radar data.indicators must be array')
  if (!Array.isArray(series) || series.length === 0) throw new Error('radar data.series must be non-empty array')

  const validIndicators = indicators.map((ind, i) => {
    if (!ind || typeof ind !== 'object') throw new Error(`radar indicator[${i}] must be object`)
    const o = ind as Record<string, unknown>
    if (typeof o.name !== 'string') throw new Error(`radar indicator[${i}].name must be string`)
    if (typeof o.max !== 'number') throw new Error(`radar indicator[${i}].max must be number`)
    return { name: o.name, max: o.max }
  })

  const validSeries = series.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`radar series[${i}] must be object`)
    const o = s as Record<string, unknown>
    if (!Array.isArray(o.value) || !o.value.every(v => typeof v === 'number')) {
      throw new Error(`radar series[${i}].value must be number[]`)
    }
    if (o.value.length !== validIndicators.length) {
      throw new Error(
        `radar series[${i}].value.length (${o.value.length}) must equal indicators.length (${validIndicators.length})`
      )
    }
    return { name: typeof o.name === 'string' ? o.name : `Series ${i + 1}`, value: o.value as number[] }
  })

  return {
    legend: buildLegend(input, theme, validSeries.map(s => s.name)),
    tooltip: {},
    radar: {
      indicator: validIndicators,
      axisName: { color: theme.textColor },
      splitLine: { lineStyle: { color: theme.splitLineColor } },
      axisLine: { lineStyle: { color: theme.axisLineColor } },
      splitArea: { areaStyle: { color: ['transparent'] } }
    },
    series: [{
      type: 'radar',
      data: validSeries,
      areaStyle: { opacity: 0.2 }
    }]
  }
}

// ============================================================================
// heatmap
// ============================================================================

function buildHeatmap(input: ChartInput, theme: ThemePreset): EChartsOption {
  const raw = input.data
  if (!raw || typeof raw !== 'object') {
    throw new Error('heatmap data must be { x_categories, y_categories, values }')
  }
  const obj = raw as Record<string, unknown>
  const xCats = obj.x_categories
  const yCats = obj.y_categories
  const values = obj.values
  if (!Array.isArray(xCats) || !xCats.every(c => typeof c === 'string')) {
    throw new Error('heatmap data.x_categories must be string[]')
  }
  if (!Array.isArray(yCats) || !yCats.every(c => typeof c === 'string')) {
    throw new Error('heatmap data.y_categories must be string[]')
  }
  if (!Array.isArray(values)) throw new Error('heatmap data.values must be array')
  const points: number[][] = values.map((v, i) => {
    if (!Array.isArray(v) || v.length < 3 || !v.every(n => typeof n === 'number')) {
      throw new Error(`heatmap values[${i}] must be [x_index, y_index, value]`)
    }
    const [x, y] = v
    if (x < 0 || x >= xCats.length || !Number.isInteger(x)) {
      throw new Error(`heatmap values[${i}][0]=${x} out of x_categories range [0, ${xCats.length - 1}]`)
    }
    if (y < 0 || y >= yCats.length || !Number.isInteger(y)) {
      throw new Error(`heatmap values[${i}][1]=${y} out of y_categories range [0, ${yCats.length - 1}]`)
    }
    return [v[0], v[1], v[2]]
  })
  // 用 reduce 替代 Math.min(...arr)，避免大数组时栈溢出
  let minV = Infinity, maxV = -Infinity
  for (const p of points) {
    if (p[2] < minV) minV = p[2]
    if (p[2] > maxV) maxV = p[2]
  }
  return {
    grid: buildGrid(input),
    tooltip: { position: 'top' },
    xAxis: { ...buildAxis(theme, input.x_label, true), data: xCats, splitArea: { show: true } },
    yAxis: { ...buildAxis(theme, input.y_label, true), data: yCats, splitArea: { show: true } },
    visualMap: {
      min: minV,
      max: maxV,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 8,
      textStyle: { color: theme.axisLabelColor }
    },
    series: [{
      type: 'heatmap',
      data: points,
      label: { show: true, color: theme.textColor }
    }]
  }
}

// ============================================================================
// candlestick (K线)
// ============================================================================

function buildCandlestick(input: ChartInput, theme: ThemePreset): EChartsOption {
  const raw = input.data
  if (!raw || typeof raw !== 'object') {
    throw new Error('candlestick data must be { categories, values }')
  }
  const obj = raw as Record<string, unknown>
  const categories = obj.categories
  const values = obj.values
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string')) {
    throw new Error('candlestick data.categories must be string[]')
  }
  if (!Array.isArray(values)) throw new Error('candlestick data.values must be array')
  const ohlc: number[][] = values.map((v, i) => {
    if (!Array.isArray(v) || v.length < 4 || !v.every(n => typeof n === 'number')) {
      throw new Error(`candlestick values[${i}] must be [open, close, low, high] number[]`)
    }
    return [v[0], v[1], v[2], v[3]]
  })
  if (categories.length !== ohlc.length) {
    throw new Error(`candlestick categories.length (${categories.length}) must equal values.length (${ohlc.length})`)
  }

  const klineColors = getKlineColors(input.kline_style ?? 'cn')

  return {
    grid: buildGrid(input),
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    xAxis: { ...buildAxis(theme, input.x_label, true), data: categories, scale: true, boundaryGap: true },
    yAxis: { ...buildAxis(theme, input.y_label, false), scale: true },
    series: [{
      type: 'candlestick',
      data: ohlc,
      itemStyle: {
        color: klineColors.color,
        color0: klineColors.color0,
        borderColor: klineColors.borderColor,
        borderColor0: klineColors.borderColor0
      }
    }]
  }
}
