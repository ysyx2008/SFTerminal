/**
 * OEM 配置类型（开源主线提交；与运行时 oem.config.ts 分离，避免 Fork 合版冲突）
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
 * OEM 在 oem.config.ts 中关闭即可裁剪，无需改业务代码。
 */
export interface OemFeatures {
  /** 觉醒（个性 / 心跳 / 觉醒面板等） */
  awaken: boolean
  /** 联络（companion 常驻关系线） */
  companion: boolean
  /** 关切 / Watch */
  watch: boolean
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
}

/** 缺字段时的回退（兼容旧 oem.config.ts） */
export const OEM_FEATURE_DEFAULTS: OemFeatures = {
  awaken: true,
  companion: true,
  watch: true,
  localTerminal: true,
  sshTerminal: true,
  assistantWorkbench: true,
  showSponsor: true,
  sso: false
}
