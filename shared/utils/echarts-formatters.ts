/**
 * ECharts option 含 function formatter 时无法通过 Electron IPC（structuredClone）
 * 投递到前端。本模块约定一套 **marker 协议**：
 *
 *   后端 build*Option 时用 tagFormatter 包装 function，挂上 id 标签 →
 *   后端投 IPC 前用 sanitizeOptionForIpc 把 function 替换为 { __echartsFn: id } marker →
 *   前端 setOption 前用 reifyFormattersForRender 把 marker 替换为对应内置 function
 *
 * **whitelist 设计**：内置 formatter 必须在 FORMATTER_REGISTRY 里同时注册前后端实现，
 * 新增时两边都要加。陌生 marker / 陌生 function 会被静默丢弃（让 echarts 走默认 formatter），
 * 不抛错也不允许 eval（对自由路径 AI 直传的任意 function 也不会执行——前端 only reify
 * registry 里的内置项，杜绝 XSS 风险）。
 *
 * 这个文件**不依赖 electron / node-only API**，前后端都能 import。
 */

/** 标记后端投递的"这里要塞 formatter"占位符，前端按 __echartsFn 名字查表还原 */
export interface EChartsFormatterMarker {
  __echartsFn: string
}

export function isFormatterMarker(v: unknown): v is EChartsFormatterMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    '__echartsFn' in v &&
    typeof (v as Record<string, unknown>).__echartsFn === 'string'
  )
}

/**
 * 成交量 formatter：8 位以上转「亿」，4 位转「万」，3 位转「k」。
 * K 线副图 yAxis 用，让 axis label 在常见 A 股成交量量级（千万-亿）下读起来直观。
 */
export function formatVolume(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + '万'
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(v)
}

/** 简易 HTML 转义，K 线 tooltip 输出 HTML 字符串前对动态文案兜底转义 */
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

/** echarts tooltip formatter trigger:axis 时收到的每条 series 描述（仅取我们用到的字段） */
interface KlineTooltipParam {
  seriesName?: string
  axisValueLabel?: string
  value?: number | number[]
  marker?: string
  componentSubType?: string
  /** 当根 K 线的渲染描边色（阳线=upBorderColor 红 / 阴线=downBorderColor 绿）——
   *  echarts 自动按涨跌选好的，candlestick row 的 marker 用它"借色"既能看出涨跌也跟图视觉一致 */
  borderColor?: string
  /** 当根 K 线的渲染填充色（阳线=upColor 通常 transparent / 阴线=downColor 绿） */
  color?: string
}

/**
 * K 线（candlestick + 成交量 + MA 线）的 tooltip formatter。
 * 把 echarts 内置的英文 OHLC 标签（open/close/lowest/highest）换成中文（开盘/收盘/最低/最高），
 * 并把成交量 series 用 formatVolume 显示成「亿/万/k」。MA 线值保留两位小数。
 *
 * trigger:axis 时 params 是按 series 顺序的数组，data 第一项必然带 axisValueLabel。
 */
export function formatKlineTooltip(params: KlineTooltipParam[] | KlineTooltipParam): string {
  const arr = Array.isArray(params) ? params : [params]
  if (arr.length === 0) return ''
  const lines: string[] = []
  const xLabel = arr[0]?.axisValueLabel
  if (xLabel) {
    lines.push(`<div style="font-weight:600;margin-bottom:4px">${escapeHtml(xLabel)}</div>`)
  }
  for (const p of arr) {
    const name = p.seriesName ?? ''
    if (p.componentSubType === 'candlestick' && Array.isArray(p.value) && p.value.length >= 5) {
      const [, open, close, low, high] = p.value as number[]
      // 不直接用 echarts 给的 p.marker：cn 风格阳线 itemStyle.color='transparent'，echarts
      // 默认 marker 拿 color 作背景色 → 阳线 marker 透明（"涨的时候空白"），阴线才看得见绿色。
      // 改用 borderColor 自造实心方块 marker，阳线红、阴线绿，涨跌都明显且跟图上 K 线柱视觉对应。
      const markerColor = p.borderColor || p.color || '#999'
      lines.push(`<div>${candleMarker(markerColor)}${escapeHtml(name)}</div>`)
      lines.push(klineRow('开盘', open))
      lines.push(klineRow('收盘', close))
      lines.push(klineRow('最低', low))
      lines.push(klineRow('最高', high))
      continue
    }
    const marker = p.marker ?? ''
    const numericValue = typeof p.value === 'number' ? p.value : NaN
    if (Number.isNaN(numericValue)) continue
    if (p.componentSubType === 'bar') {
      lines.push(klineRow(`${marker}${escapeHtml(name || '成交量')}`, formatVolume(numericValue), false))
      continue
    }
    lines.push(klineRow(`${marker}${escapeHtml(name)}`, numericValue.toFixed(2), false))
  }
  return lines.join('')
}

/** 自造的 K 线 tooltip marker——10×10 实心圆点，颜色取自当根 K 线的描边色 */
function candleMarker(color: string): string {
  return `<span style="display:inline-block;width:10px;height:10px;background:${escapeHtml(color)};border-radius:50%;margin-right:6px;vertical-align:middle"></span>`
}

function klineRow(label: string, value: string | number, escapeLabel = true): string {
  const lbl = escapeLabel ? escapeHtml(label) : label
  return `<div style="display:flex;justify-content:space-between;gap:24px"><span>${lbl}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`
}

/**
 * 前后端共同维护的 formatter 名 → 实现 映射。
 * 只允许这里登记过的 formatter 通过 IPC 通道，避免 AI 在自由路径 (render_echarts_option)
 * 直传任意 function 被前端 eval 的风险。
 *
 * 注：每个 formatter 的实参类型不同（成交量 fmt 是 number → string，K 线 tooltip 是
 * KlineTooltipParam[] → string），这里用 unknown 兜底——echarts 调用各 formatter 时
 * 传的实参由 echarts 自己保证，前后端 reify 时只关心 marker id 命中即可。
 */
export const FORMATTER_REGISTRY = {
  volume: formatVolume as (v: unknown) => string,
  klineTooltip: formatKlineTooltip as (params: unknown) => string
} as const

export type FormatterId = keyof typeof FORMATTER_REGISTRY

/**
 * 把 option 中的 marker 还原成 function。前端 setOption 前调用。
 * 递归遍历，返回新对象，不修改入参。未识别的 marker 返回 undefined（让 echarts 走默认）。
 */
export function reifyFormattersForRender<T = unknown>(option: T): T {
  return reifyImpl(option) as T
}

function reifyImpl(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(reifyImpl)
  }
  if (isFormatterMarker(node)) {
    // **必须**用 Object.hasOwn 守卫，不能直接 bracket 索引：原型链上 'toString' /
    // 'hasOwnProperty' / 'constructor' 等都是 function，AI 在 render_echarts_option 自由
    // 路径里只要构造 { __echartsFn:'toString' } 这种纯对象 marker（structuredClone 通得过）
    // 就能命中 Object.prototype.toString 装到 echarts 当 formatter——绕过 FORMATTER_REGISTRY
    // 白名单设计意图。Object.hasOwn 把命中范围限制在显式登记的内置 formatter。
    if (!Object.hasOwn(FORMATTER_REGISTRY, node.__echartsFn)) return undefined
    const fn = (FORMATTER_REGISTRY as Record<string, (v: number) => string>)[node.__echartsFn]
    return fn ?? undefined
  }
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(node)) {
      const reified = reifyImpl((node as Record<string, unknown>)[k])
      if (reified !== undefined) out[k] = reified
    }
    return out
  }
  return node
}
