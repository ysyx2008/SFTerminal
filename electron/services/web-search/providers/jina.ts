/**
 * Jina 搜索 Provider
 * 搜索: GET https://s.jina.ai/{query}
 * 返回 Markdown 格式结果
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'
const SEARCH_ENDPOINT = 'https://s.jina.ai/'

export class JinaProvider implements WebSearchProvider {
  id = 'jina'
  name = 'Jina'

  constructor(private apiKeyGetter: () => string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('Jina API key is not configured')

    const maxResults = options?.maxResults ?? 5

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'X-Max-Results': String(maxResults),
    }

    const timeout = AbortSignal.timeout(30_000)
    const resp = await fetch(`${SEARCH_ENDPOINT}${encodeURIComponent(query)}`, {
      headers,
      signal: options?.signal ?? timeout,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Jina search failed: ${resp.status} ${text}`)
    }

    const data = await resp.json() as JinaResponse
    return this.mapResults(data, maxResults)
  }

  private mapResults(data: JinaResponse, maxResults: number): WebSearchResult[] {
    if (!Array.isArray(data.data)) return []

    return data.data.slice(0, maxResults).map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.description || '',
      content: item.content || undefined,
    }))
  }
}

interface JinaResponse {
  data: Array<{
    title?: string
    url?: string
    description?: string
    content?: string
  }>
}
