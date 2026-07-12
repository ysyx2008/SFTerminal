/**
 * OEM 配置 re-export
 *
 * 类型与 defaults：`@shared/oem-types`
 * 开关查询：`@shared/oem-features`
 * 运行时配置：`shared/oem.config.ts`（模板生成，不进开源主线）
 */
export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand } from '@shared/oem-types'
export { OEM_FEATURE_DEFAULTS } from '@shared/oem-types'
export { isOemFeatureEnabled } from '@shared/oem-features'
export { oemConfig } from '@shared/oem.config'
