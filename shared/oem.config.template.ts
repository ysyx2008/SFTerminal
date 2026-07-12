/**
 * OEM 配置模板（开源主线提交此文件，不提交 `oem.config.ts`）
 *
 * 用法：
 * 1. 复制本文件为同目录 `oem.config.ts`（`npm install` / `postinstall` 会自动确保存在）
 * 2. OEM Fork：编辑自己的 `oem.config.ts`（可 `git add -f` 纳入 Fork 仓库；上游无同名文件，合版不冲突）
 * 3. 勿改模板冒充运行时配置——运行时只读 `oem.config.ts`
 */

export interface OemConfig {
  brand: {
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
  features: {
    showSponsor: boolean
  }
}

/** 开源默认：旗鱼品牌；OEM 在 oem.config.ts 中覆盖 */
export const oemConfig: OemConfig = {
  brand: {
    name: { zh: '旗鱼', en: 'SailFish' },
    logo: '/assets/logo.png',
    version: '',
    copyright: { zh: '© 2026 旗鱼', en: '© 2026 SailFish' }
  },
  features: {
    showSponsor: true
  }
}
