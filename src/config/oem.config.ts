/**
 * OEM 配置 re-export（前端入口）
 *
 * 类型与 defaults：`@shared/oem-types` / `@shared/oem-defaults`
 * 开关查询：`@shared/oem-features`
 * 运行时：`@shared/oem-runtime`（有 oem.config.ts 用覆盖，否则用 defaults）
 */
export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from '@shared/oem-types'
export { OEM_FEATURE_DEFAULTS } from '@shared/oem-types'
export { isOemFeatureEnabled } from '@shared/oem-features'
export { oemConfig } from '@shared/oem-runtime'
