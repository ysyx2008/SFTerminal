/**
 * Google Custom Search Provider
 * API: GET https://www.googleapis.com/customsearch/v1
 *
 * 需要两个配置：
 *   - API Key（apiKeys.google）
 *   - cx Search Engine ID（apiExtras.google.cx）
 *
 * 在 https://programmablesearchengine.google.com 创建一个搜索引擎拿到 cx，
 * 在 https://console.cloud.google.com 启用 Custom Search API 拿到 Key。
 *
 * 国内访问需要用户自行解决代理问题。
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1'

export class GoogleProvider implements WebSearchProvider {
  id = 'google'
  name = 'Google Custom Search'

  constructor(
    private apiKeyGetter: () => string,
    private cxGetter: () => string,
  ) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('Google API key is not configured')
    const cx = this.cxGetter()
    if (!cx) throw new Error('Google Search Engine ID (cx) is not configured')

    // Custom Search API 单次最多返回 10 条
    const num = Math.min(Math.max(options?.maxResults ?? 5, 1), 10)

    const url = new URL(ENDPOINT)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('cx', cx)
    url.searchParams.set('q', query)
    url.searchParams.set('num', String(num))
    if (options?.language) {
      // hl 是界面语言偏好，Google 接受 'zh-CN' / 'en' 这类连字符格式
      url.searchParams.set('hl', options.language)
    }

    const timeout = AbortSignal.timeout(30_000)
    const resp = await fetch(url.toString(), {
      method: 'GET',
      signal: options?.signal ?? timeout,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      let detail = text
      try {
        const j = JSON.parse(text) as { error?: { message?: string } }
        if (j.error?.message) detail = j.error.message
      } catch { /* keep raw text */ }
      throw new Error(`Google search failed: ${resp.status} ${detail}`)
    }

    const data = await resp.json() as GoogleResponse
    return this.mapResults(data)
  }

  private mapResults(data: GoogleResponse): WebSearchResult[] {
    if (!Array.isArray(data.items)) return []
    return data.items.map(item => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
    }))
  }
}

interface GoogleResponse {
  items?: Array<{
    title?: string
    link?: string
    snippet?: string
  }>
}
