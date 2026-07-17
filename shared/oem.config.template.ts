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
// import type { OemConfig } from './oem-types'
// import { OEM_FEATURE_DEFAULTS } from './oem-types'
//
// export const oemConfig: OemConfig = {
//   brand: {
//     name: { zh: '贵司助手', en: 'Corp Assistant' },
//     logo: '/assets/logo.png',
//     version: '',
//     copyright: { zh: '© 贵司', en: '© Corp' },
//   },
//   features: {
//     ...OEM_FEATURE_DEFAULTS,
//     /** 觉醒：个性 / 心跳 / 觉醒面板等 */
//     awaken: true,
//     /** 联络：companion 常驻关系线 */
//     companion: true,
//     /** 关切 / Watch */
//     watch: true,
//     /** 羁绊气质 / 俏皮文案：placeholder 分池、任务完成趣味 footer、里程碑 toast、首 token 彩蛋与调侃、prompt 羁绊段 */
//     bond: true,
//     /** 本地终端工作台 */
//     localTerminal: true,
//     /** SSH 终端工作台 */
//     sshTerminal: true,
//     /** 独立助手工作台（含产出物等） */
//     assistantWorkbench: true,
//     /** 赞助 / 社区入口 */
//     showSponsor: false,
//     /** 应用 SSO（OAuth2/OIDC）；开源默认关闭 */
//     sso: true,
//   },
//   sso: {
//     issuer: 'https://your-idp.example.com',
//     clientId: '...',
//     redirectUri: 'http://127.0.0.1:8765/sso/callback',
//     scopes: ['openid', 'profile', 'email'],
//     gateMode: 'soft',              // hard | soft | none
//     verifyIdToken: 'claims',       // claims | jwks
//     enterpriseApiHosts: [],        // 精确 hostname；空 = 永不自动带 Bearer
//   },
// }
