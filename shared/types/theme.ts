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

/**
 * UI 主题模式：
 * - `manual`：用户固定使用 uiTheme 字段指定的主题
 * - `auto`：跟随系统外观自动在深浅主题之间切换（不影响用户选定的彩色主题，
 *   只是该用户开启 auto 期间会临时覆盖为 AUTO_DARK_THEME / AUTO_LIGHT_THEME）
 */
export type UiThemeMode = 'manual' | 'auto'

/**
 * 默认主题模式：跟随系统外观。
 *
 * 首次启动 / 未配置过的用户会自动获得"系统暗色用 dark、系统亮色用 light"的体验，
 * 符合现代桌面应用预期；想换彩色主题时关闭"跟随系统"开关后再选。
 */
export const DEFAULT_UI_THEME_MODE: UiThemeMode = 'auto'

/** auto 模式下系统为暗色时使用的主题。 */
export const AUTO_DARK_THEME: UiThemeName = 'dark'

/** auto 模式下系统为亮色时使用的主题。 */
export const AUTO_LIGHT_THEME: UiThemeName = 'light'

/** 系统配色（与 CSS prefers-color-scheme 对齐）。 */
export type SystemColorScheme = 'dark' | 'light'

/**
 * 根据当前模式与系统配色计算实际生效的 UI 主题。
 *
 * @param mode 主题模式
 * @param manualTheme 用户在 manual 模式下选定的主题
 * @param systemScheme 系统当前配色（仅在 auto 模式下生效）
 */
export function resolveEffectiveUiTheme(
  mode: UiThemeMode,
  manualTheme: UiThemeName,
  systemScheme: SystemColorScheme
): UiThemeName {
  if (mode === 'auto') {
    return systemScheme === 'dark' ? AUTO_DARK_THEME : AUTO_LIGHT_THEME
  }
  return manualTheme
}
