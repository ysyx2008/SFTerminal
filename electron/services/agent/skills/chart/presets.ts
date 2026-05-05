/**
 * 图表主题与 K 线配色预设
 *
 * 设计要点：
 * - light / dark 两种主题，控制背景、文字、轴线、网格颜色
 * - 通用调色板（系列颜色），柱/折线/饼默认从这里取色
 * - K 线另有「专业主题」（getKlineProTheme），cn 风格刻意贴近通达信/同花顺：
 *     · 黑底（dark）/ 白底（light）+ 实线网格
 *     · 空心阳线（红框透出背景）+ 实心阴线
 *     · 黄色虚线十字光标 + 反白价格标签
 *     · MA5/10/20/60 经典调色板（白/黄/紫/青）
 *   us 风格保留绿涨红跌的双实心蜡烛（海外软件惯例），其他元素与 cn 同基调。
 */

export type ChartTheme = 'light' | 'dark'
export type KlineStyle = 'cn' | 'us'

export interface ThemePreset {
  /** 画布背景色 */
  backgroundColor: string
  /** 主文字颜色 */
  textColor: string
  /** 轴线颜色 */
  axisLineColor: string
  /** 网格分割线颜色 */
  splitLineColor: string
  /** 坐标轴次要文字颜色 */
  axisLabelColor: string
  /** 系列调色板 */
  palette: string[]
}

/** 浅色主题：白底深字，适合放进 IM、文档 */
const LIGHT_THEME: ThemePreset = {
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  axisLineColor: '#9ca3af',
  splitLineColor: '#e5e7eb',
  axisLabelColor: '#4b5563',
  palette: [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
    '#f97316', '#6366f1'
  ]
}

/** 深色主题：深底浅字，适合在终端配色环境内显示 */
const DARK_THEME: ThemePreset = {
  backgroundColor: '#1f2937',
  textColor: '#f3f4f6',
  axisLineColor: '#6b7280',
  splitLineColor: '#374151',
  axisLabelColor: '#d1d5db',
  palette: [
    '#60a5fa', '#34d399', '#fbbf24', '#f87171',
    '#a78bfa', '#f472b6', '#22d3ee', '#a3e635',
    '#fb923c', '#818cf8'
  ]
}

export function getTheme(theme: ChartTheme): ThemePreset {
  return theme === 'dark' ? DARK_THEME : LIGHT_THEME
}

// ============================================================================
// K 线专业主题（通达信 / 同花顺风格）
// ============================================================================

/**
 * K 线专业主题。除了蜡烛配色外，还约定了背景、网格、十字线、MA 均线等
 * 整体视觉，使 K 线图整体观感贴近行情软件而非"商务图表"。
 *
 * 注意：cn 风格使用 **空心阳线**（candle.upColor === 'transparent'），靠
 * `backgroundColor` 透出来形成"红框白心 / 红框黑心"的经典通达信观感。
 * us 风格保留实心蜡烛（海外软件惯例）。
 */
export interface KlineProTheme {
  /** 画布背景色（覆盖 base theme） */
  backgroundColor: string
  /** 主文字色（含 title） */
  textColor: string
  /** 副文字色（轴 label / subtitle / legend） */
  axisLabelColor: string
  /** 轴线颜色 */
  axisLineColor: string
  /** 网格分割线颜色（K 线图固定用实线） */
  splitLineColor: string
  /** 十字光标（axisPointer）颜色 */
  crosshairColor: string
  /** 十字光标价格标签的背景色（行情软件经典反白底） */
  crosshairLabelBg: string
  /** 十字光标价格标签的文字色 */
  crosshairLabelText: string
  /** 蜡烛配色（cn 阳线 transparent 实现空心） */
  candle: {
    upColor: string
    upBorderColor: string
    downColor: string
    downBorderColor: string
  }
  /** MA 均线调色板，按 [MA5, MA10, MA20, MA60] 顺序循环使用 */
  maColors: string[]
}

/** 通达信经典黑底（cn dark） */
const KLINE_CN_DARK: KlineProTheme = {
  backgroundColor: '#0c0e12',
  textColor: '#d1d5db',
  axisLabelColor: '#9ca3af',
  axisLineColor: '#4a5568',
  splitLineColor: '#323b49',
  crosshairColor: '#fbbf24',
  crosshairLabelBg: '#fbbf24',
  crosshairLabelText: '#0c0e12',
  candle: {
    upColor: 'transparent',
    upBorderColor: '#ef4444',
    downColor: '#22c55e',
    downBorderColor: '#16a34a'
  },
  maColors: ['#ffffff', '#fbbf24', '#c084fc', '#22d3ee']
}

/** 同花顺白底（cn light） */
const KLINE_CN_LIGHT: KlineProTheme = {
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  axisLabelColor: '#4b5563',
  axisLineColor: '#cbd5e1',
  splitLineColor: '#e5e7eb',
  crosshairColor: '#d97706',
  crosshairLabelBg: '#d97706',
  crosshairLabelText: '#ffffff',
  candle: {
    upColor: 'transparent',
    upBorderColor: '#dc2626',
    downColor: '#16a34a',
    downBorderColor: '#15803d'
  },
  maColors: ['#1e293b', '#d97706', '#7c3aed', '#0891b2']
}

/** 海外软件夜间（us dark）：实心蜡烛 + 灰色光标 */
const KLINE_US_DARK: KlineProTheme = {
  backgroundColor: '#0c0e12',
  textColor: '#d1d5db',
  axisLabelColor: '#9ca3af',
  axisLineColor: '#4a5568',
  splitLineColor: '#323b49',
  crosshairColor: '#94a3b8',
  crosshairLabelBg: '#475569',
  crosshairLabelText: '#ffffff',
  candle: {
    upColor: '#22c55e',
    upBorderColor: '#16a34a',
    downColor: '#ef4444',
    downBorderColor: '#dc2626'
  },
  maColors: ['#ffffff', '#fbbf24', '#c084fc', '#22d3ee']
}

/** 海外软件日间（us light） */
const KLINE_US_LIGHT: KlineProTheme = {
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  axisLabelColor: '#4b5563',
  axisLineColor: '#cbd5e1',
  splitLineColor: '#e5e7eb',
  crosshairColor: '#64748b',
  crosshairLabelBg: '#475569',
  crosshairLabelText: '#ffffff',
  candle: {
    upColor: '#22c55e',
    upBorderColor: '#16a34a',
    downColor: '#ef4444',
    downBorderColor: '#dc2626'
  },
  maColors: ['#1e293b', '#d97706', '#7c3aed', '#0891b2']
}

export function getKlineProTheme(style: KlineStyle, mode: ChartTheme): KlineProTheme {
  if (style === 'us') return mode === 'dark' ? KLINE_US_DARK : KLINE_US_LIGHT
  return mode === 'dark' ? KLINE_CN_DARK : KLINE_CN_LIGHT
}
