/**
 * 图表主题与 K 线配色预设
 *
 * 设计要点：
 * - light / dark 两种主题，控制背景、文字、轴线、网格颜色
 * - K 线 cn (红涨绿跌) / us (绿涨红跌) 两种风格
 * - 通用调色板（系列颜色），柱/折线/饼默认从这里取色
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

/**
 * K 线配色
 *
 * cn（中式）: 红涨绿跌——A 股、港股、国内财经媒体的视觉惯例
 * us（美式）: 绿涨红跌——美股、欧股、国际市场惯例
 *
 * `color` 是阳线（涨）的实心色，`color0` 是阴线（跌）的实心色，border 同色
 */
export interface KlineColors {
  color: string
  color0: string
  borderColor: string
  borderColor0: string
}

const KLINE_CN: KlineColors = {
  color: '#ef4444',
  color0: '#22c55e',
  borderColor: '#dc2626',
  borderColor0: '#16a34a'
}

const KLINE_US: KlineColors = {
  color: '#22c55e',
  color0: '#ef4444',
  borderColor: '#16a34a',
  borderColor0: '#dc2626'
}

export function getKlineColors(style: KlineStyle): KlineColors {
  return style === 'us' ? KLINE_US : KLINE_CN
}
