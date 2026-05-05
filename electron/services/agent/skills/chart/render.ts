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

/**
 * 把 unknown 描述成 AI 友好的简短字符串：
 *   "string" / "number" / "null" / "undefined" / "array(len=3)" / "object(keys=foo,bar)"
 * 错误信息里附带 received 类型可以让 AI 第二次尝试时定位错误，而不必猜。
 */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (Array.isArray(v)) return `array(len=${v.length})`
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).slice(0, 4).join(',')
    return `object(keys=${keys})`
  }
  return typeof v
}

function asCategorySeries(raw: unknown, chartType: string): CategorySeriesData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${chartType} data must be object like { categories: string[], series: [{name?, data: number[]}] }, ` +
      `got ${describe(raw)}`
    )
  }
  const obj = raw as Record<string, unknown>
  const categories = obj.categories
  const series = obj.series
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string')) {
    throw new Error(`${chartType} data.categories must be string[], got ${describe(categories)}`)
  }
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(`${chartType} data.series must be a non-empty array, got ${describe(series)}`)
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

// 默认仅当多 series 且有名字时显示图例（单系列图例多余）；input.legend 可强制覆盖
function shouldShowLegend(input: ChartInput, names: string[]): boolean {
  return input.legend ?? (names.length > 1 && names.some(n => n))
}

// 估算 title 区块的占位高度（含顶部留白和 subtitle 间距），用于布局计算避免重叠
// ECharts 默认 title 顶部留白约 5px；title 字号 16 行高 ≈ 24；subtitle 字号 12 行高 ≈ 18
function titleBlockHeight(input: ChartInput): number {
  if (input.subtitle) return 5 + 24 + 6 + 18 // ≈ 53
  if (input.title) return 5 + 24 // ≈ 29
  return 0
}

function buildLegend(input: ChartInput, theme: ThemePreset, names: string[]): EChartsOption | undefined {
  if (!shouldShowLegend(input, names)) return undefined
  const titleH = titleBlockHeight(input)
  return {
    data: names,
    // 无 title 时贴顶 8px；有 title 时在 title 区块下方留 10px 间距
    top: titleH === 0 ? 8 : titleH + 10,
    textStyle: { color: theme.axisLabelColor }
  }
}

function buildGrid(input: ChartInput, hasLegend: boolean): EChartsOption {
  const titleH = titleBlockHeight(input)
  // legend 单行高度（含间距）≈ 32，无 legend 时仅留 title 区块下方 16px
  const legendBlock = hasLegend ? 32 + 10 : 0
  const topBase = titleH === 0 ? (hasLegend ? 8 : 16) : titleH + 10
  return {
    left: 60,
    right: 30,
    bottom: 50,
    top: topBase + legendBlock,
    containLabel: true
  }
}

// ============================================================================
// bar / line / area
// ============================================================================

function buildBar(input: ChartInput, theme: ThemePreset): EChartsOption {
  const { categories, series } = asCategorySeries(input.data, 'bar')
  const names = series.map(s => s.name ?? '')
  const hasLegend = shouldShowLegend(input, names)
  return {
    grid: buildGrid(input, hasLegend),
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
  const hasLegend = shouldShowLegend(input, names)
  return {
    grid: buildGrid(input, hasLegend),
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

/**
 * 把 pie 用的 raw data 收敛成 PieItem[]，对 AI 常见误用做容错：
 *   - 顶层数组：[{ name, value }]
 *   - 嵌套对象：{ data: [...] } / { items: [...] } / { series: [...] }
 *   - 字段别名：name | label | category | title；value | amount | count | v
 * 每条 item 必须能解析出 name 和 value，否则抛友好错误。
 */
function asPieItems(raw: unknown): PieItem[] {
  let arr: unknown[]
  if (Array.isArray(raw)) {
    arr = raw
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const candidate = obj.data ?? obj.items ?? obj.series ?? obj.values
    if (!Array.isArray(candidate)) {
      throw new Error(
        'pie data must be array like [{name:"A",value:30},{name:"B",value:70}]; ' +
        'received an object without data/items/series array field'
      )
    }
    arr = candidate
  } else {
    throw new Error(
      `pie data must be array like [{name:"A",value:30}]; received ${raw === null ? 'null' : typeof raw}`
    )
  }

  return arr.map((d, i) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      throw new Error(`pie data[${i}] must be object like {name,value}, got ${typeof d}`)
    }
    const o = d as Record<string, unknown>
    const name = pickString(o, ['name', 'label', 'category', 'title'])
    const value = pickNumber(o, ['value', 'amount', 'count', 'v'])
    if (name === undefined) {
      throw new Error(`pie data[${i}] missing string field "name" (or label/category/title)`)
    }
    if (value === undefined) {
      throw new Error(`pie data[${i}] missing number field "value" (or amount/count/v)`)
    }
    return { name, value }
  })
}

function pickString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

function pickNumber(o: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function buildPie(input: ChartInput, theme: ThemePreset): EChartsOption {
  const items = asPieItems(input.data)
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
  const scatterNames = seriesArr.map(s => s.name ?? '')
  const scatterHasLegend = shouldShowLegend(input, scatterNames)
  return {
    grid: buildGrid(input, scatterHasLegend),
    legend: buildLegend(input, theme, scatterNames),
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
    grid: buildGrid(input, false),
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
    throw new Error('candlestick data must be { categories, values, volumes? }')
  }
  const obj = raw as Record<string, unknown>
  const categories = obj.categories
  const values = obj.values
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string')) {
    throw new Error(`candlestick data.categories must be string[], got ${describe(categories)}`)
  }
  if (!Array.isArray(values)) {
    throw new Error(`candlestick data.values must be array, got ${describe(values)}`)
  }
  const ohlc: number[][] = values.map((v, i) => {
    if (!Array.isArray(v) || v.length < 4 || !v.every(n => typeof n === 'number')) {
      throw new Error(`candlestick values[${i}] must be [open, close, low, high] number[]`)
    }
    return [v[0], v[1], v[2], v[3]]
  })
  if (categories.length !== ohlc.length) {
    throw new Error(`candlestick categories.length (${categories.length}) must equal values.length (${ohlc.length})`)
  }

  // 可选的成交量数组：传了就走"K 线 + 成交量副图"的双 grid 布局
  let volumes: number[] | undefined
  if (obj.volumes !== undefined) {
    if (!Array.isArray(obj.volumes) || !obj.volumes.every(v => typeof v === 'number')) {
      throw new Error(`candlestick data.volumes must be number[], got ${describe(obj.volumes)}`)
    }
    if (obj.volumes.length !== categories.length) {
      throw new Error(
        `candlestick data.volumes.length (${obj.volumes.length}) must equal categories.length (${categories.length})`
      )
    }
    volumes = obj.volumes as number[]
  }

  const klineColors = getKlineColors(input.kline_style ?? 'cn')

  if (volumes === undefined) {
    return {
      grid: buildGrid(input, false),
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

  // ===== 双 grid 布局：上 K 线 ~62%、间隔 ~3%、下 成交量 ~18%、底部 ~17% 留 x 轴/标签 =====
  // 顶部依旧把 title/legend 算进去，从顶 padding 开始计算上 grid 的 top。
  const titleH = titleBlockHeight(input)
  const topPx = titleH === 0 ? 16 : titleH + 10
  // 价格 grid：占去除顶部留白后的 ~62%；成交量 grid：~18%；中间留 3% 间隔；底部 50px x 轴
  const priceGrid = { left: 60, right: 30, top: topPx, height: '62%' }
  const volumeGrid = { left: 60, right: 30, top: '72%', height: '18%' }

  // 成交量 bar 颜色随 K 线涨跌：close >= open 用涨色，否则跌色
  const volumeBars = volumes.map((vol, i) => ({
    value: vol,
    itemStyle: {
      color: ohlc[i][1] >= ohlc[i][0] ? klineColors.color : klineColors.color0
    }
  }))

  return {
    grid: [priceGrid, volumeGrid],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', link: [{ xAxisIndex: 'all' }] }
    },
    // 共两个 xAxis，都用 categories；上 grid 隐藏 x 标签，下 grid 显示
    xAxis: [
      {
        ...buildAxis(theme, undefined, true),
        gridIndex: 0,
        data: categories,
        scale: true,
        boundaryGap: true,
        axisLabel: { show: false },
        axisTick: { show: false }
      },
      {
        ...buildAxis(theme, input.x_label, true),
        gridIndex: 1,
        data: categories,
        scale: true,
        boundaryGap: true
      }
    ],
    yAxis: [
      // 价格轴
      { ...buildAxis(theme, input.y_label, false), gridIndex: 0, scale: true },
      // 成交量轴：splitNumber 2 让网格更稀疏；不显示 splitLine 让副图更紧凑
      {
        ...buildAxis(theme, '成交量', false),
        gridIndex: 1,
        scale: true,
        splitNumber: 2,
        splitLine: { show: false }
      }
    ],
    series: [
      {
        type: 'candlestick',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: ohlc,
        itemStyle: {
          color: klineColors.color,
          color0: klineColors.color0,
          borderColor: klineColors.borderColor,
          borderColor0: klineColors.borderColor0
        }
      },
      {
        type: 'bar',
        name: '成交量',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumeBars
      }
    ]
  }
}
