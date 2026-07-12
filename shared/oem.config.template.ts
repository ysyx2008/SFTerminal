/**
 * OEM 配置模板（开源主线提交此文件，不提交 `oem.config.ts`）
 *
 * 用法：
 * 1. 复制本文件为同目录 `oem.config.ts`（`npm install` / `postinstall` 会自动确保存在）
 * 2. OEM Fork：编辑自己的 `oem.config.ts`（可 `git add -f` 纳入 Fork 仓库；上游无同名文件，合版不冲突）
 * 3. 勿改模板冒充运行时配置——运行时只读 `oem.config.ts`
 */

import type { OemConfig } from './oem-types'

export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'

/** 开源默认：旗鱼品牌 + 秘书能力全开（sso 除外） */
export const oemConfig: OemConfig = {
  brand: {
    name: { zh: '旗鱼', en: 'SailFish' },
    logo: '/assets/logo.png',
    version: '',
    copyright: { zh: '© 2026 旗鱼', en: '© 2026 SailFish' }
  },
  features: {
    awaken: true,
    companion: true,
    watch: true,
    localTerminal: true,
    sshTerminal: true,
    assistantWorkbench: true,
    showSponsor: true,
    sso: false
  }
}
