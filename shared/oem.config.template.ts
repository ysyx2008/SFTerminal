/**
 * OEM 配置参考模板（开源主线只提交此文件与 oem-defaults，不提交 `oem.config.ts`）
 *
 * 用法：
 * 1. 开源 / 无定制：不必创建 oem.config.ts，运行时自动用 oem-defaults
 * 2. OEM Fork：复制本文件为同目录 `oem.config.ts` 后按需修改（可 `git add -f` 纳入 Fork）
 * 3. 有 `oem.config.ts` 则启用其中配置；没有则忽略，不强制生成
 */

export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'
export { oemConfig } from './oem-defaults'

// 复制为 oem.config.ts 后，可在 features 中裁剪能力，并按需取消注释 SSO：
// export const oemConfig: OemConfig = {
//   brand: { ... },
//   features: { ...OEM_FEATURE_DEFAULTS, showSponsor: false, sso: true },
//   sso: {
//     issuer: 'https://your-idp.example.com',
//     clientId: '...',
//     redirectUri: 'http://127.0.0.1:8765/sso/callback',
//     scopes: ['openid', 'profile', 'email'],
//     gateMode: 'soft',
//     verifyIdToken: 'claims',
//     enterpriseApiHosts: [],
//   },
// }
