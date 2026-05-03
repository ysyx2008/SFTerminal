/**
 * UI 主题相关共享类型与常量。
 *
 * 本文件是"系统默认 UI 主题"的唯一数据源（single source of truth）。
 * 前后端各处的默认值兜底（electron-store defaults、Pinia store 初值、
 * localStorage 读取兜底、未知主题降级等）都必须引用这里的 DEFAULT_UI_THEME，
 * 不要再硬编码字面量主题名。
 *
 * 类型 UiThemeName 是 src/themes/ui-themes.ts 的 uiThemes 对象的 key 集合，
 * 修改时两边同步：本文件的字面量联合 + ui-themes.ts 的 uiThemes 对象。
 */

export type UiThemeName =
  | 'dark'
  | 'light'
  | 'blue'
  | 'gruvbox'
  | 'forest'
  | 'ayu-mirage'
  | 'cyberpunk'
  | 'lavender'
  | 'aurora'
  | 'sponsor-gold'
  | 'sponsor-sakura'
  | 'sponsor-rose-pine'

/**
 * 系统默认 UI 主题。
 *
 * 仅在用户**首次启动 / 配置缺失 / 未知主题降级**时使用，
 * 老用户的已选主题不受此值变化影响。
 */
export const DEFAULT_UI_THEME: UiThemeName = 'dark'
