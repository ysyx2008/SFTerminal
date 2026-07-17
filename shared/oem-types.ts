/**
 * OEM 配置类型（开源主线提交）。
 * 可选覆盖文件 `oem.config.ts` 不进仓库；缺省见 `oem-defaults.ts` / `OEM_FEATURE_DEFAULTS`。
 */

export interface OemBrand {
  name: {
    zh: string
    en: string
  }
  logo: string
  version?: string
  copyright: {
    zh: string
    en: string
  }
}

/**
 * 能力开关：开源默认尽量全开；`sso` 默认关。
 * OEM 在可选的 oem.config.ts 中关闭即可裁剪，无需改业务代码。
 */
export interface OemFeatures {
  /** 觉醒（个性 / 心跳 / 觉醒面板等） */
  awaken: boolean
  /** 联络（companion 常驻关系线） */
  companion: boolean
  /** 关切 / Watch */
  watch: boolean
  /**
   * 羁绊气质 / 俏皮文案（placeholder 分池、任务完成趣味 footer、
   * 里程碑 toast、首 token 彩蛋与调侃、prompt 羁绊段等）
   */
  bond: boolean
  /** 本地终端工作台 */
  localTerminal: boolean
  /** SSH 终端工作台 */
  sshTerminal: boolean
  /** 独立助手工作台（含产出物等） */
  assistantWorkbench: boolean
  /** 赞助 / 社区入口 */
  showSponsor: boolean
  /** 应用 SSO（OAuth2/OIDC）；开源默认关闭 */
  sso: boolean
}

export type OemFeatureKey = keyof OemFeatures

export interface OemConfig {
  brand: OemBrand
  features: OemFeatures
  /**
   * 应用 SSO（OAuth2/OIDC）IdP 配置。
   * 仅当 features.sso === true 时生效；开源默认不配。
   */
  sso?: OemSsoConfig
}

/** SSO 登录门控：hard 全屏挡；soft 可进主界面；none 无登录 UI */
export type OemSsoGateMode = 'hard' | 'soft' | 'none'

/** ID Token 校验强度：claims 只验 iss/aud/exp；jwks 再验 RS256 签名 */
export type OemSsoVerifyIdToken = 'claims' | 'jwks'

/** OEM 应用登录 IdP（与邮箱 OAuth 无关） */
export interface OemSsoConfig {
  /** OIDC Issuer，用于发现 /.well-known/openid-configuration */
  issuer: string
  clientId: string
  /** 公共客户端推荐省略，走 PKCE；机密客户端可选 */
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /**
   * 未登录时的门控。缺省 soft。
   * - hard：全屏登录页，进不了主界面
   * - soft：可进主界面，设置/角标可登录
   * - none：无登录 UI（OEM 自接）
   */
  gateMode?: OemSsoGateMode
  /** ID Token 校验；缺省 claims */
  verifyIdToken?: OemSsoVerifyIdToken
  /**
   * 允许后端 HTTP（如 web_fetch）自动注入 Bearer 的精确 hostname 名单。
   * 默认 [] / 未配 → 永不自动注入。不做通配。
   */
  enterpriseApiHosts?: string[]
}

/** 缺字段时的回退（兼容旧/不完整 oem.config） */
export const OEM_FEATURE_DEFAULTS: OemFeatures = {
  awaken: true,
  companion: true,
  watch: true,
  bond: true,
  localTerminal: true,
  sshTerminal: true,
  assistantWorkbench: true,
  showSponsor: true,
  sso: false
}
