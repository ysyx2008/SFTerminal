import type { LocaleType } from '../i18n'

const WEBSITE_BASE = 'https://www.sfterm.com'

/** 官网语言路径：zh-CN → /zh，en-US → 根路径 */
function websitePathForLocale(locale?: LocaleType): string {
  return locale === 'zh-CN' ? '/zh' : ''
}

/** 官网首页 */
export function getWebsiteUrl(locale?: LocaleType): string {
  const path = websitePathForLocale(locale)
  return path ? `${WEBSITE_BASE}${path}/` : `${WEBSITE_BASE}/`
}

/** 官网下载页（含 GitHub / 阿里云双源切换） */
export function getDownloadPageUrl(locale?: LocaleType): string {
  const path = websitePathForLocale(locale)
  return path ? `${WEBSITE_BASE}${path}/#download` : `${WEBSITE_BASE}/#download`
}
