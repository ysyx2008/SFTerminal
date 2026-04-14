/**
 * Tavily 搜索 Provider
 * AI Agent 搜索首选
 * API: POST https://api.tavily.com/search
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'
const ENDPOINT = 'https://api.tavily.com/search'

export class TavilyProvider implements WebSearchProvider {
  id = 'tavily'
  name = 'Tavily'

  constructor(private apiKeyGetter: () => string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('Tavily API key is not configured')

    const maxResults = options?.maxResults ?? 5

    const timeout = AbortSignal.timeout(30_000)
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: options?.signal ?? timeout,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Tavily search failed: ${resp.status} ${text}`)
    }

    const data = await resp.json() as TavilyResponse
    return this.mapResults(data)
  }

  private mapResults(data: TavilyResponse): WebSearchResult[] {
    if (!Array.isArray(data.results)) return []

    return data.results.map(item => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      content: item.raw_content || undefined,
    }))
  }
}

interface TavilyResponse {
  results: Array<{
    title?: string
    url?: string
    content?: string
    raw_content?: string
  }>
}
