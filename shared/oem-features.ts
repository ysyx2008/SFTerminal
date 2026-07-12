/**
 * OEM 能力开关查询（前后端共用）
 */
import { oemConfig } from './oem.config'
import {
  OEM_FEATURE_DEFAULTS,
  type OemConfig,
  type OemFeatureKey
} from './oem-types'

export type { OemFeatureKey, OemConfig, OemFeatures, OemBrand } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'

/**
 * 查询某能力是否开启。
 * features 缺字段时回退到 OEM_FEATURE_DEFAULTS（兼容旧 oem.config.ts）。
 */
export function isOemFeatureEnabled(
  key: OemFeatureKey,
  config: OemConfig = oemConfig
): boolean {
  const value = config.features[key]
  if (typeof value === 'boolean') return value
  return OEM_FEATURE_DEFAULTS[key]
}
