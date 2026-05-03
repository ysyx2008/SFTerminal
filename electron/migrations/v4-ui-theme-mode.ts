/**
 * Migration v4: 给老用户补写 uiThemeMode 字段。
 *
 * 背景：跟随系统外观（uiThemeMode='auto'）作为新版默认行为引入。
 * 但老用户磁盘上没有 uiThemeMode 字段，靠 defaults 兜底会被解读为 'auto'，
 * 导致原本选了彩色主题（如 cyberpunk / aurora）的老用户启动后突然变成系统对应
 * 的 dark/light 主题——行为意外。
 *
 * 策略：
 * - 已有 uiThemeMode 字段（新用户、已经迁移过）→ 跳过
 * - uiTheme 为 'dark' / 'light'（深浅色，跟随系统等价或更好）→ 写入 'auto'
 * - 其他主题（彩色 / 老默认 'blue'）→ 写入 'manual'，保留用户感知
 *
 * 幂等：通过 ConfigService.has 区分磁盘真值 vs defaults，避免重复迁移。
 * Phase: early（仅依赖 ConfigService，不需要其他服务）。
 */

import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v4')

// 与 shared/types/theme.ts 中 AUTO_DARK_THEME / AUTO_LIGHT_THEME 一致；
// migration 仅依赖具体字面量值，不直接 import 共享常量以保持迁移代码自包含
// （未来即使常量改名也不影响历史迁移行为）。
const SCHEMES_WORTH_FOLLOWING_SYSTEM = ['dark', 'light']

export const migrationV4: Migration = {
  version: 4,
  name: 'ui-theme-mode',
  phase: 'early',

  async migrate({ configService }) {
    if (configService.has('uiThemeMode')) {
      log.info('uiThemeMode already exists on disk, skipping')
      return
    }

    const currentTheme = configService.get('uiTheme')
    const shouldFollowSystem = typeof currentTheme === 'string'
      && SCHEMES_WORTH_FOLLOWING_SYSTEM.includes(currentTheme)

    const mode = shouldFollowSystem ? 'auto' : 'manual'
    configService.set('uiThemeMode', mode)

    log.info(
      `Migrated existing user's uiThemeMode → '${mode}' ` +
      `(based on uiTheme='${currentTheme}')`
    )
  },
}
