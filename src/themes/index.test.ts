/**
 * 浅色终端主题：ANSI white / brightWhite 必须和背景拉开对比。
 * 端口号等数字常被 shell 高亮成这两档色，对比不够就会淡到看不见。
 */
import { describe, it, expect } from 'vitest'
import { getIntegratedTheme } from './index'
import { uiThemes, type UiThemeName } from './ui-themes'

function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace('#', '')
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
  ]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT_THEMES = (Object.keys(uiThemes) as UiThemeName[]).filter(
  name => uiThemes[name].colorScheme === 'light'
)

describe('getIntegratedTheme light contrast', () => {
  it('ANSI white / brightWhite stay readable on light backgrounds', () => {
    for (const name of LIGHT_THEMES) {
      const theme = getIntegratedTheme(name)
      expect(theme.white, `${name} white`).toBeTruthy()
      expect(theme.brightWhite, `${name} brightWhite`).toBeTruthy()
      expect(theme.background, `${name} background`).toBeTruthy()
      expect(contrastRatio(theme.white!, theme.background!), `${name} white`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.brightWhite!, theme.background!), `${name} brightWhite`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
