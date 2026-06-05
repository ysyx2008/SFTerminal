/**
 * 幻灯片主题预设（配色摘自 Anthropic pptx skill 调色表）
 */

export interface PptTheme {
  id: string
  primary: string
  secondary: string
  accent: string
  background: string
  backgroundAlt: string
  text: string
  textMuted: string
  titleFont: string
  bodyFont: string
}

export const PPT_THEMES: Record<string, PptTheme> = {
  midnight: {
    id: 'midnight',
    primary: '1E2761',
    secondary: 'CADCFC',
    accent: 'FFFFFF',
    background: '1E2761',
    backgroundAlt: 'FFFFFF',
    text: 'FFFFFF',
    textMuted: 'CADCFC',
    titleFont: 'Arial',
    bodyFont: 'Calibri',
  },
  forest: {
    id: 'forest',
    primary: '2C5F2D',
    secondary: '97BC62',
    accent: 'F5F5F5',
    background: '2C5F2D',
    backgroundAlt: 'F5F5F5',
    text: 'F5F5F5',
    textMuted: '97BC62',
    titleFont: 'Georgia',
    bodyFont: 'Calibri',
  },
  teal: {
    id: 'teal',
    primary: '028090',
    secondary: '00A896',
    accent: '02C39A',
    background: '028090',
    backgroundAlt: 'FFFFFF',
    text: 'FFFFFF',
    textMuted: '02C39A',
    titleFont: 'Trebuchet MS',
    bodyFont: 'Calibri',
  },
  charcoal: {
    id: 'charcoal',
    primary: '36454F',
    secondary: 'F2F2F2',
    accent: '212121',
    background: '36454F',
    backgroundAlt: 'F2F2F2',
    text: 'F2F2F2',
    textMuted: '36454F',
    titleFont: 'Arial Black',
    bodyFont: 'Calibri',
  },
  coral: {
    id: 'coral',
    primary: 'F96167',
    secondary: 'F9E795',
    accent: '2F3C7E',
    background: 'F96167',
    backgroundAlt: 'FFFFFF',
    text: 'FFFFFF',
    textMuted: '2F3C7E',
    titleFont: 'Arial Black',
    bodyFont: 'Arial',
  },
  simple: {
    id: 'simple',
    primary: '1E293B',
    secondary: '64748B',
    accent: '0D9488',
    background: 'FFFFFF',
    backgroundAlt: 'F8FAFC',
    text: '1E293B',
    textMuted: '64748B',
    titleFont: 'Arial',
    bodyFont: 'Calibri',
  },
}

export const DEFAULT_THEME_ID = 'simple'

export function resolveTheme(themeId?: string, slideTheme?: string | null): PptTheme {
  const id = (slideTheme || themeId || DEFAULT_THEME_ID).toLowerCase()
  return PPT_THEMES[id] ?? PPT_THEMES[DEFAULT_THEME_ID]
}

/** 从 inline style 或 data-theme 解析背景色，否则用主题 */
export function slideBackground(
  theme: PptTheme,
  layout: string,
  inlineBg?: string
): string {
  if (inlineBg) return inlineBg
  if (layout === 'title' || layout === 'closing') return theme.background
  return theme.backgroundAlt
}

/** 浅色内容页用深色字，深色封面/结语用浅色字 */
export function bodyTextColor(
  theme: PptTheme,
  layout: string,
  inlineBg?: string
): string {
  if (layout === 'title' || layout === 'closing') return theme.text
  const bg = slideBackground(theme, layout, inlineBg)
  const light = new Set([
    theme.backgroundAlt,
    'FFFFFF',
    'F8FAFC',
    'F5F5F5',
    'F2F2F2',
    'E7E8D1',
    'FCF6F5',
  ])
  return light.has(bg) ? theme.primary : theme.text
}
