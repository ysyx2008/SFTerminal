/**
 * 开源默认 OEM 配置（始终提交）。
 * 无 `shared/oem.config.ts` 时由 oem-runtime 使用本文件。
 */
import type { OemConfig } from './oem-types'
import { OEM_FEATURE_DEFAULTS } from './oem-types'

export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'

/** 旗鱼品牌 + 秘书能力全开（sso 除外） */
export const oemConfig: OemConfig = {
  brand: {
    name: { zh: '旗鱼', en: 'SailFish' },
    logo: '/assets/logo.png',
    version: '',
    copyright: { zh: '© 2026 旗鱼', en: '© 2026 SailFish' }
  },
  features: { ...OEM_FEATURE_DEFAULTS }
}
