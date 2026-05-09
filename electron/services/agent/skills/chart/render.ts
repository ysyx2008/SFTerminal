/**
 * 把统一的图表参数转换成 ECharts option
 *
 * 设计要点：
 * - 输入采用扁平化、面向 AI 的数据格式（不要求 AI 直接拼 ECharts 复杂结构）
 * - 各 chart 类型的 data 字段 schema 不同，由各自的 build* 函数校验
 * - 出错抛 Error，由调用方捕获返回友好错误
 */

import { getTheme, getKlineProTheme, type ChartTheme, type KlineStyle, type ThemePreset, type KlineProTheme } from './presets'

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
  /**
   * 仅 candlestick 生效。MA 均线周期数组，默认 [5, 10, 20, 60]（数据足够时自动叠加）。
   * 传 `[]` 表示不画均线；传自定义周期如 `[7, 25, 99]`（币圈风格）也支持。
   * 数据长度不足某个周期时，该 MA 自动跳过。
   */
  kline_ma?: number[]
  /** 是否显示图例（默认有 series.name 时显示） */
  legend?: boolean
}

/** 通用 ECharts option（避免引入 ECharts 类型，保持解耦） */
export type EChartsOption = Record<string, unknown>

/**
 * 可选的画布尺寸提示：buildOption 内部不渲染，传进来仅供 build* 函数做字号 / 线宽
 * 等视觉自适应（如 K 线在 4K 大画布下需要更大字号才看得清）。
 * executor 在调用前已经 clamp 过尺寸，这里只取 width 做缩放推断。
 */
export interface BuildHint {
  width?: number
  height?: number
}

// ============================================================================
// 入口
// ============================================================================

export function buildOption(input: ChartInput, hint?: BuildHint): EChartsOption {
  const theme = getTheme(input.theme ?? 'light')
  // 普通图表用 calcFontScale（基准 800）；K 线在 buildCandlestick 里用自己的 calcKlineFontScale
  const scale = calcFontScale(hint?.width)

  let option: EChartsOption
  switch (input.type) {
    case 'bar':         option = buildBar(input, theme, scale); break
    case 'line':        option = buildLine(input, theme, false, scale); break
    case 'area':        option = buildLine(input, theme, true, scale); break
    case 'pie':         option = buildPie(input, theme, scale); break
    case 'scatter':     option = buildScatter(input, theme, scale); break
    case 'radar':       option = buildRadar(input, theme, scale); break
    case 'heatmap':     option = buildHeatmap(input, theme, scale); break
    case 'candlestick': option = buildCandlestick(input, theme, hint); break
    default:
      throw new Error(`Unsupported chart type: ${(input as ChartInput).type}`)
  }

  return applyCommon(option, input, theme, scale)
}

/**
 * K 线专用字号缩放（基准 1280，保留经实测的 K 线视觉手感不动）。
 *
 *   width <= 1280  → 1.0     （14px label）
 *   width 1280-2400 → 线性 → 1.4    （≈19.6px）
 *   width 2400-4800 → 线性 → 2.0    （≈28px）
 *   width >= 4800  → 2.0 上限
 *
 * 1280 基准跟 SVG 活图模式下的"日常显示尺寸"对齐（缩略图 480 / 大图 ~1440），
 * 字号在 14-20px 落在视觉舒适区间。PNG 模式嵌 Word/PDF 时如果 AI 选 4800+，
 * 字号自动拉到 2.0× 上限，对位图静态显示同样合理。普通图表使用更小的基准
 * （见下方 calcFontScale），因为它们的"日常尺寸"本身更接近 800-1280。
 */
function calcKlineFontScale(width: number | undefined): number {
  if (!width || width <= 1280) return 1
  if (width <= 2400) return 1 + (width - 1280) / (2400 - 1280) * 0.4
  if (width <= 4800) return 1.4 + (width - 2400) / (4800 - 2400) * 0.6
  return 2.0
}

/**
 * 普通图表的字号缩放系数（bar/line/area/pie/scatter/radar/heatmap）。
 *
 * 设计前提（实测）：把 echarts SVG 嵌入聊天气泡或 Word 时，画布尺寸越大、
 * 字号绝对像素被缩到的视觉占比就越小。1.0 基准选 800px 是一个经验值——
 * 用户实测在 600-800 画布下硬编码 12-16px 字号刚好"舒服"，再大就开始
 * 显得字小。所以 800 以下不放大（小画布字号自然合适），从 800 起线性
 * 拉伸，让"画布大→字号大"，保留大画布的容量优势同时维持可读性。
 *
 *   width <= 800   → 1.0
 *   800-1600       → 线性 → 1.4
 *   1600-3200      → 线性 → 2.0
 *   width >= 3200  → 2.0 上限
 *
 * K 线另有 calcKlineFontScale；不要混用。
 */
function calcFontScale(width: number | undefined): number {
  if (!width || width <= 800) return 1
  if (width <= 1600) return 1 + (width - 800) / (1600 - 800) * 0.4
  if (width <= 3200) return 1.4 + (width - 1600) / (3200 - 1600) * 0.6
  return 2.0
}

/** 字号缩放并取整：所有 fontSize 统一走这里，避免分散的 Math.round */
function fs(base: number, scale: number): number {
  return Math.round(base * scale)
}

/**
 * 注入背景色、标题、调色板等通用配置；坐标轴样式由各 build 函数自己处理
 * （不同 chart 类型对 axis 的需要不同，比如 pie/radar 没有 axis）。
 *
 * 注意：当 build* 函数已自行设置 `option.title`（如 K 线专业主题需要自定义
 * title 颜色）时，applyCommon 不再覆盖，让各 chart 能保留自己的 title 样式。
 */
function applyCommon(option: EChartsOption, input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
  const merged: EChartsOption = {
    backgroundColor: theme.backgroundColor,
    color: theme.palette,
    textStyle: { color: theme.textColor, fontFamily: 'PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif' },
    animation: false,
    ...option
  }
  if ((input.title || input.subtitle) && !option.title) {
    merged.title = {
      text: input.title ?? '',
      subtext: input.subtitle ?? '',
      left: 'center',
      textStyle: { color: theme.textColor, fontSize: fs(16, scale), fontWeight: 'bold' },
      subtextStyle: { color: theme.axisLabelColor, fontSize: fs(12, scale) }
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

function buildAxis(theme: ThemePreset, scale: number, label?: string, isCategory = false): EChartsOption {
  return {
    type: isCategory ? 'category' : 'value',
    name: label,
    nameTextStyle: { color: theme.axisLabelColor, fontSize: fs(12, scale) },
    axisLine: { lineStyle: { color: theme.axisLineColor } },
    // 显式设 fontSize 让 scale 生效；echarts 默认 12px 在 1.0 下不变化
    axisLabel: { color: theme.axisLabelColor, fontSize: fs(12, scale) },
    splitLine: { lineStyle: { color: theme.splitLineColor, type: 'dashed' } }
  }
}

// 默认仅当多 series 且有名字时显示图例（单系列图例多余）；input.legend 可强制覆盖
function shouldShowLegend(input: ChartInput, names: string[]): boolean {
  return input.legend ?? (names.length > 1 && names.some(n => n))
}

// 估算 title 区块的占位高度（含顶部留白和 subtitle 间距），用于布局计算避免重叠。
// ECharts 默认 title 顶部留白约 5px；title 行高 ≈ 字号 * 1.5；subtitle 行高同理。
// scale 参数让 K 线大画布下放大字号时，title 区块也相应增高，避免和正文重叠
// （K 线 title 字号 18 / subtitle 14；这里用接近的 16 / 12 估算够用，留点余量）
function titleBlockHeight(input: ChartInput, scale = 1): number {
  const titleH = Math.round(18 * scale * 1.4)    // ≈ 25px @ scale=1
  const subH = Math.round(14 * scale * 1.4)      // ≈ 20px
  if (input.subtitle) return 5 + titleH + 6 + subH
  if (input.title) return 5 + titleH
  return 0
}

function buildLegend(input: ChartInput, theme: ThemePreset, names: string[], scale: number): EChartsOption | undefined {
  if (!shouldShowLegend(input, names)) return undefined
  const titleH = titleBlockHeight(input, scale)
  return {
    data: names,
    // 无 title 时贴顶 8px；有 title 时在 title 区块下方留 10px 间距
    top: titleH === 0 ? 8 : titleH + 10,
    textStyle: { color: theme.axisLabelColor, fontSize: fs(12, scale) }
  }
}

function buildGrid(input: ChartInput, hasLegend: boolean, scale: number): EChartsOption {
  const titleH = titleBlockHeight(input, scale)
  // legend 单行高度（含间距）：
  //   - 历史固定值 42（32 marker 行高 + 10 间距），scale=1 下保持原布局，避免小画布回归
  //   - scale > 1.7 时按字号放大（fs(12, 1.7) * 1.6 + 10 ≈ 42），避免大画布下 legend 盖住内容
  const legendBlock = hasLegend ? Math.max(42, Math.round(fs(12, scale) * 1.6) + 10) : 0
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

function buildBar(input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
  const { categories, series } = asCategorySeries(input.data, 'bar')
  const names = series.map(s => s.name ?? '')
  const hasLegend = shouldShowLegend(input, names)
  return {
    grid: buildGrid(input, hasLegend, scale),
    legend: buildLegend(input, theme, names, scale),
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { ...buildAxis(theme, scale, input.x_label, true), data: categories },
    yAxis: buildAxis(theme, scale, input.y_label, false),
    series: series.map(s => ({
      type: 'bar',
      name: s.name,
      data: s.data
    }))
  }
}

function buildLine(input: ChartInput, theme: ThemePreset, area: boolean, scale: number): EChartsOption {
  const { categories, series } = asCategorySeries(input.data, area ? 'area' : 'line')
  const names = series.map(s => s.name ?? '')
  const hasLegend = shouldShowLegend(input, names)
  return {
    grid: buildGrid(input, hasLegend, scale),
    legend: buildLegend(input, theme, names, scale),
    tooltip: { trigger: 'axis' },
    xAxis: { ...buildAxis(theme, scale, input.x_label, true), data: categories, boundaryGap: false },
    yAxis: buildAxis(theme, scale, input.y_label, false),
    series: series.map(s => ({
      type: 'line',
      name: s.name,
      data: s.data,
      smooth: true,
      symbol: 'circle',
      // symbolSize 跟字号一起放大，大画布下点位才看得见
      symbolSize: Math.max(6, Math.round(6 * scale)),
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

function buildPie(input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
  const items = asPieItems(input.data)
  return {
    legend: buildLegend(input, theme, items.map(i => i.name), scale),
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: ['40%', '65%'],
      center: ['50%', '55%'],
      data: items,
      label: { color: theme.textColor, fontSize: fs(12, scale) },
      labelLine: { lineStyle: { color: theme.axisLineColor } }
    }]
  }
}

// ============================================================================
// scatter
// ============================================================================

function buildScatter(input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
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
    grid: buildGrid(input, scatterHasLegend, scale),
    legend: buildLegend(input, theme, scatterNames, scale),
    tooltip: { trigger: 'item' },
    xAxis: buildAxis(theme, scale, input.x_label, false),
    yAxis: buildAxis(theme, scale, input.y_label, false),
    series: seriesArr.map(s => ({
      type: 'scatter',
      name: s.name,
      data: s.data,
      symbolSize: Math.max(10, Math.round(10 * scale))
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

function buildRadar(input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
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
    legend: buildLegend(input, theme, validSeries.map(s => s.name), scale),
    tooltip: {},
    radar: {
      indicator: validIndicators,
      axisName: { color: theme.textColor, fontSize: fs(12, scale) },
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

function buildHeatmap(input: ChartInput, theme: ThemePreset, scale: number): EChartsOption {
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
    grid: buildGrid(input, false, scale),
    tooltip: { position: 'top' },
    xAxis: { ...buildAxis(theme, scale, input.x_label, true), data: xCats, splitArea: { show: true } },
    yAxis: { ...buildAxis(theme, scale, input.y_label, true), data: yCats, splitArea: { show: true } },
    visualMap: {
      min: minV,
      max: maxV,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 8,
      textStyle: { color: theme.axisLabelColor, fontSize: fs(11, scale) }
    },
    series: [{
      type: 'heatmap',
      data: points,
      label: { show: true, color: theme.textColor, fontSize: fs(12, scale) }
    }]
  }
}

// ============================================================================
// candlestick (K线) —— 通达信 / 同花顺风格
// ============================================================================

/** 默认 MA 均线周期（A 股软件经典）。数据长度不足某周期时该 MA 自动跳过 */
const DEFAULT_MA_PERIODS = [5, 10, 20, 60] as const
/** legend 中给 K 线主体用的名字 */
const KLINE_SERIES_NAME = '价格'
/** 成交量副图名字 */
const VOLUME_SERIES_NAME = '成交量'

/**
 * 简单移动平均线。前 n-1 个数据点用 ECharts 占位符 '-' 表示空值（不参与连线）。
 * 用滑动窗口避免 O(n²)，对全年日 K 也保持线性。
 */
function calcSMA(closes: number[], period: number): Array<number | '-'> {
  const out: Array<number | '-'> = []
  let sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]
    if (i >= period) sum -= closes[i - period]
    if (i >= period - 1) {
      out.push(+(sum / period).toFixed(4))
    } else {
      out.push('-')
    }
  }
  return out
}

/**
 * 解析 kline_ma 参数为最终生效的周期列表：
 *   - undefined → 默认 [5, 10, 20, 60]
 *   - 空数组   → 关闭 MA
 *   - number[] → 仅保留正整数；按数据长度过滤掉无意义的周期
 */
function resolveMaPeriods(ma: number[] | undefined, dataLen: number): number[] {
  const candidates = ma === undefined
    ? Array.from(DEFAULT_MA_PERIODS)
    : ma.filter(p => Number.isInteger(p) && p > 0)
  return candidates.filter(p => dataLen >= p)
}

/**
 * 计算 categoryAxis 的 axisLabel/splitLine/axisTick 共用 interval，控制垂直虚线数量。
 *
 * 通达信/同花顺习惯里，垂直虚线表示"时间分界"——按月/按周/按整点等节奏稀疏排列，
 * 不会每根 K 线都画一条。完全模拟需要解析 categories 字符串中的日期格式，但
 * AI 传入的 categories 格式不固定（"2024-01-15" / "01-15" / "Q1" / "周一"…），
 * 解析容易脆弱。这里用纯数量驱动：目标虚线总数 ~8 条，按数据长度反推 interval。
 *
 * ECharts 的 interval 语义：N 表示"每 N+1 个数据画一条"，0 表示全画。
 */
function calcCategoryInterval(n: number): number {
  if (n <= 8) return 0   // 数据少，全画
  return Math.max(0, Math.ceil(n / 8) - 1)
}

function buildCandlestick(input: ChartInput, _baseTheme: ThemePreset, hint?: BuildHint): EChartsOption {
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

  const themeMode: ChartTheme = input.theme ?? 'light'
  const pro = getKlineProTheme(input.kline_style ?? 'cn', themeMode)

  // ===== 字号 / 线宽自适应：根据画布宽度缩放，让大画布也有可读字号 =====
  // 基准画布 1280 → scale=1；2400 → scale=1.4；4800+ → scale=2.0（上限）
  // 基础字号选 14（轴 label），刻意比"商务图表"略大，因为 SVG 会被前端缩到
  // 聊天气泡尺寸再显示，原图字号过小会让缩放后看不清"亿"等中文字。
  // K 线专用 calcKlineFontScale，保留经实测的视觉手感；不和普通图表共用。
  const scale = calcKlineFontScale(hint?.width)
  const fontAxisLabel = Math.round(14 * scale)         // 轴 label 基础字号
  const fontAxisName = Math.round(15 * scale)          // 轴名（"成交量"等）
  const fontTitle = Math.round(18 * scale)             // title 主标题
  const fontSubtitle = Math.round(14 * scale)          // subtitle / legend
  const candleBorder = Math.max(1.5, 1.5 * scale)      // 阳线红框宽度
  const maLineWidth = Math.max(1.5, 1.6 * scale)       // MA 线宽

  // ===== MA 均线（基于收盘价 SMA） =====
  const closes = ohlc.map(v => v[1])
  const maPeriods = resolveMaPeriods(input.kline_ma, categories.length)
  // 注意：line series 必须同时设 itemStyle.color，否则 legend marker 会回落到全局
  // palette，导致图上的线和 legend 上的圆点颜色不一致。
  const maSeriesList = maPeriods.map((period, i) => {
    const color = pro.maColors[i % pro.maColors.length]
    return {
      type: 'line' as const,
      name: `MA${period}`,
      data: calcSMA(closes, period),
      smooth: false,
      symbol: 'none' as const,
      lineStyle: { width: maLineWidth, color },
      itemStyle: { color },
      z: 2,
      xAxisIndex: 0,
      yAxisIndex: 0
    }
  })

  // 成交量 bar 颜色随当日涨跌（cn 阳线虽空心，但成交量柱仍用红色实心，符合行情软件惯例）
  const volumeUpColor = input.kline_style === 'us' ? '#22c55e' : '#ef4444'
  const volumeDownColor = input.kline_style === 'us' ? '#ef4444' : '#22c55e'

  // ===== legend：标题正下方居左排列，覆盖 K 线主体 + 各 MA =====
  const klineLegendNames = [KLINE_SERIES_NAME, ...maPeriods.map(p => `MA${p}`)]
  const titleH = titleBlockHeight(input, scale)
  const legendBlock: EChartsOption = {
    data: klineLegendNames,
    top: titleH === 0 ? 8 : titleH + 8,
    left: 16,
    textStyle: { color: pro.axisLabelColor, fontSize: fontSubtitle },
    itemGap: Math.round(14 * scale),
    icon: 'roundRect'
  }
  const legendBlockHeight = klineLegendNames.length > 0 ? Math.round(28 * scale) : 0

  // ===== title：用 K 线专业主题的颜色覆盖 base theme =====
  const titleBlock: EChartsOption | undefined = (input.title || input.subtitle)
    ? {
        text: input.title ?? '',
        subtext: input.subtitle ?? '',
        left: 'center',
        textStyle: { color: pro.textColor, fontSize: fontTitle, fontWeight: 'bold' },
        subtextStyle: { color: pro.axisLabelColor, fontSize: fontSubtitle }
      }
    : undefined

  // ===== K 线专用轴：实线网格 + 右侧价格轴（行情软件惯例） =====
  const priceAxisLabel = { color: pro.axisLabelColor, fontSize: fontAxisLabel }
  const priceAxisLine = { lineStyle: { color: pro.axisLineColor } }
  const priceSplitLine = { show: true, lineStyle: { color: pro.splitLineColor, type: 'solid' as const } }

  // 价格 yAxis：移到右侧（通达信/同花顺/TradingView 都把价格轴放右）
  const priceYAxis = (gridIndex: number): EChartsOption => ({
    type: 'value',
    gridIndex,
    position: 'right',
    scale: true,
    name: input.y_label,
    nameTextStyle: { color: pro.axisLabelColor, fontSize: fontAxisName },
    axisLine: priceAxisLine,
    axisLabel: priceAxisLabel,
    splitLine: priceSplitLine
  })

  // category xAxis：水平方向实线（走 yAxis splitLine），垂直方向稀疏虚线分隔
  // 通达信/同花顺习惯：垂直虚线只在"时间分界"画（月初/周一/整点），不是每根 K 线都画。
  // 这里用纯数量驱动的稀疏策略——目标虚线数 ~8 条，避免依赖日期字符串解析的脆弱性。
  // axisLabel 与 splitLine 共用同一 interval 保证上下对齐（双 grid 时尤其重要）。
  const gridInterval = calcCategoryInterval(categories.length)
  const xAxisBase = (gridIndex: number): EChartsOption => ({
    type: 'category',
    gridIndex,
    data: categories,
    scale: true,
    boundaryGap: true,
    axisLine: priceAxisLine,
    axisLabel: { ...priceAxisLabel, interval: gridInterval },
    splitLine: {
      show: true,
      interval: gridInterval,
      // 自定义 dash 节奏让虚线在缩放后视觉更连续（ECharts 默认 [5,5] 在低 DPI 下断点过多）
      lineStyle: { color: pro.splitLineColor, type: [6, 4] }
    },
    axisTick: { lineStyle: { color: pro.axisLineColor }, interval: gridInterval }
  })

  // 十字光标：黄色虚线 + 反白价格标签（通达信招牌视觉）
  const axisPointerStyle = {
    type: 'cross' as const,
    lineStyle: { color: pro.crosshairColor, type: 'dashed' as const, width: 1 },
    crossStyle: { color: pro.crosshairColor, type: 'dashed' as const, width: 1 },
    label: {
      backgroundColor: pro.crosshairLabelBg,
      color: pro.crosshairLabelText,
      borderWidth: 0,
      fontSize: fontAxisLabel,
      padding: [3, 6, 3, 6]
    }
  }

  // borderWidth 适当加粗：cn 风格阳线是空心红框，太细在大画布上几乎看不见
  const candlestickItemStyle = {
    color: pro.candle.upColor,
    color0: pro.candle.downColor,
    borderColor: pro.candle.upBorderColor,
    borderColor0: pro.candle.downBorderColor,
    borderWidth: candleBorder
  }

  // 共用的 tooltip 配色（黑底浮窗在白底/黑底主题下都清晰）
  const tooltipStyle: EChartsOption = {
    trigger: 'axis',
    axisPointer: axisPointerStyle,
    backgroundColor: themeMode === 'dark' ? '#1f2933' : '#1f2937',
    borderWidth: 0,
    textStyle: { color: '#f3f4f6', fontSize: fontSubtitle }
  }

  // 价格轴留白要够放下"15.00亿"这样最长 label，按 fontAxisLabel 反推。
  // 估算：5 个数字字符（≈ 0.55 字号宽）+ 1 个中文（≈ 1.0 字号宽）≈ 3.75 字号；
  // 加 axisLine offset + 安全余量 buffer，避免 "亿" 字被画布右边界截掉
  const priceAxisRight = Math.round(fontAxisLabel * 4.5 + 14)
  const xAxisBottom = Math.round(fontAxisLabel * 2.5 + 12)

  // ============== 单 grid（无 volume）==============
  if (volumes === undefined) {
    // 正文区域距离顶部 = title + legend 一行
    const topPx = (titleH === 0 ? 8 : titleH + 8) + legendBlockHeight
    return {
      backgroundColor: pro.backgroundColor,
      textStyle: { color: pro.textColor, fontFamily: 'PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif' },
      ...(titleBlock ? { title: titleBlock } : {}),
      legend: legendBlock,
      grid: { left: 24, right: priceAxisRight, top: topPx, bottom: xAxisBottom, containLabel: true },
      tooltip: tooltipStyle,
      xAxis: xAxisBase(0),
      yAxis: priceYAxis(0),
      series: [
        {
          type: 'candlestick',
          name: KLINE_SERIES_NAME,
          data: ohlc,
          itemStyle: candlestickItemStyle,
          z: 1
        },
        ...maSeriesList
      ]
    }
  }

  // ============== 双 grid（K 线 + 成交量）==============
  // 顶部 title + legend，price grid 占 ~58%，间隔 ~4%，volume grid 占 ~22%，底部 ~16% 留 x 轴/标签
  const topPx = (titleH === 0 ? 8 : titleH + 8) + legendBlockHeight
  const priceGrid = { left: 24, right: priceAxisRight, top: topPx, height: '58%', containLabel: false }
  const volumeGrid = { left: 24, right: priceAxisRight, top: '72%', height: '18%', containLabel: false }

  const volumeBars = volumes.map((vol, i) => ({
    value: vol,
    itemStyle: {
      color: ohlc[i][1] >= ohlc[i][0] ? volumeUpColor : volumeDownColor
    }
  }))

  return {
    backgroundColor: pro.backgroundColor,
    textStyle: { color: pro.textColor, fontFamily: 'PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif' },
    ...(titleBlock ? { title: titleBlock } : {}),
    legend: legendBlock,
    grid: [priceGrid, volumeGrid],
    tooltip: {
      ...tooltipStyle,
      axisPointer: { ...axisPointerStyle, link: [{ xAxisIndex: 'all' }] }
    },
    // 上 grid 隐藏 x 标签让两图共用底部轴；下 grid 才显示日期
    xAxis: [
      { ...xAxisBase(0), axisLabel: { show: false }, axisTick: { show: false } },
      { ...xAxisBase(1), name: input.x_label, nameTextStyle: { color: pro.axisLabelColor, fontSize: fontAxisName } }
    ],
    yAxis: [
      priceYAxis(0),
      // 成交量轴：放右侧、splitNumber 2 稀疏网格、不显示 splitLine 让副图紧凑
      {
        type: 'value',
        gridIndex: 1,
        position: 'right',
        scale: true,
        name: VOLUME_SERIES_NAME,
        nameTextStyle: { color: pro.axisLabelColor, fontSize: fontAxisName },
        axisLine: priceAxisLine,
        axisLabel: { ...priceAxisLabel, formatter: formatVolume },
        splitNumber: 2,
        splitLine: { show: false }
      }
    ],
    series: [
      {
        type: 'candlestick',
        name: KLINE_SERIES_NAME,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: ohlc,
        itemStyle: candlestickItemStyle,
        z: 1
      },
      ...maSeriesList,
      {
        type: 'bar',
        name: VOLUME_SERIES_NAME,
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumeBars,
        barWidth: '60%'
      }
    ]
  }
}

/**
 * 成交量轴的简短刻度格式：1.2万 / 3.4亿 / 5.6M。
 * 行情软件标配——避免长 0 数字撑爆右侧轴。
 */
function formatVolume(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + '万'
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(v)
}
