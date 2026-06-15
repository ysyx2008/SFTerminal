/**
 * OEM 配置文件（前后端共享）
 *
 * OEM 版本只需修改此文件即可完成品牌定制。
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
