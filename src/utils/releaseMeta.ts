import type { LocaleType } from '../i18n'

export interface ReleaseMeta {
  version: string
  summary: {
    zh: string
    en: string
  }
}

const META_URLS = [
  'https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/releases/release-meta.json',
  'https://github.com/ysyx2008/SailFish/releases/latest/download/release-meta.json',
] as const

let cached: ReleaseMeta | null = null
let fetchPromise: Promise<ReleaseMeta | null> | null = null

export function getLocalizedSummary(meta: ReleaseMeta, locale: LocaleType): string | undefined {
  const text = locale === 'zh-CN' ? meta.summary.zh : meta.summary.en
  const trimmed = text?.replace(/^>\s*/, '').trim()
  return trimmed || undefined
}

export async function fetchReleaseMeta(force = false): Promise<ReleaseMeta | null> {
  if (!force && cached) return cached
  if (!force && fetchPromise) return fetchPromise

  fetchPromise = (async () => {
    for (const url of META_URLS) {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) continue
        const data = (await res.json()) as ReleaseMeta
        if (data?.version && (data.summary?.zh || data.summary?.en)) {
          cached = data
          return data
        }
      } catch {
        // 尝试下一个源
      }
    }
    return null
  })()

  const result = await fetchPromise
  if (!result) {
    fetchPromise = null
  }
  return result
}

export async function getReleaseSummary(version: string, locale: LocaleType): Promise<string | undefined> {
  const meta = await fetchReleaseMeta()
  if (!meta || meta.version !== version) return undefined
  return getLocalizedSummary(meta, locale)
}
