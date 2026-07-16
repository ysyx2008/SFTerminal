import { oemConfig } from './oem-runtime'

const DEFAULT_BRAND_ZH = '旗鱼'
const DEFAULT_BRAND_EN = 'SailFish'

export function isZhLocale(language?: string): boolean {
  return (language ?? 'zh-CN').startsWith('zh')
}

export function getBrandName(language?: string): string {
  return isZhLocale(language) ? oemConfig.brand.name.zh : oemConfig.brand.name.en
}

export function getBrandCopyright(language?: string): string {
  return isZhLocale(language) ? oemConfig.brand.copyright.zh : oemConfig.brand.copyright.en
}

export function getWelcomeTitle(language?: string, steam = false): string {
  const name = getBrandName(language)
  if (steam) {
    return isZhLocale(language) ? `欢迎使用${name}终端` : `Welcome to ${name}`
  }
  return isZhLocale(language) ? `欢迎使用${name}` : `Welcome to ${name}`
}

export function getAppTitle(language?: string, version?: string, steam = false): string {
  const name = steam
    ? (isZhLocale(language) ? '旗鱼终端' : 'SFTerm')
    : getBrandName(language)
  return version ? `${name} v${version}` : name
}

function deepReplaceStrings<T>(obj: T, from: string, to: string): T {
  if (from === to) return obj
  if (typeof obj === 'string') {
    return (obj.includes(from) ? obj.split(from).join(to) : obj) as T
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepReplaceStrings(item, from, to)) as T
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      out[key] = deepReplaceStrings(value, from, to)
    }
    return out as T
  }
  return obj
}

/** 用 OEM 品牌名覆盖 i18n 文案中的默认产品名 */
export function applyOemBranding<T extends Record<string, unknown>>(
  messages: T,
  locale: 'zh-CN' | 'en-US'
): T {
  const from = locale === 'zh-CN' ? DEFAULT_BRAND_ZH : DEFAULT_BRAND_EN
  const to = locale === 'zh-CN' ? oemConfig.brand.name.zh : oemConfig.brand.name.en
  if (from === to) return messages

  const patched = deepReplaceStrings(structuredClone(messages), from, to)

  if (patched.about && typeof patched.about === 'object') {
    const about = patched.about as Record<string, string>
    about.copyright = getBrandCopyright(locale)
  }

  return patched
}
