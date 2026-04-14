/**
 * Bing Web Search Provider
 * Microsoft Azure Cognitive Services
 * API: GET https://api.bing.microsoft.com/v7.0/search
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'
const ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'

export class BingProvider implements WebSearchProvider {
  id = 'bing'
  name = 'Bing Web Search'

  constructor(private apiKeyGetter: () => string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('Bing API key is not configured')

    const maxResults = options?.maxResults ?? 5

    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
      responseFilter: 'Webpages',
    })
    if (options?.language) {
      params.set('mkt', options.language)
    }

    const timeout = AbortSignal.timeout(30_000)
    const resp = await fetch(`${ENDPOINT}?${params}`, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      signal: options?.signal ?? timeout,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Bing search failed: ${resp.status} ${text}`)
    }

    const data = await resp.json() as BingResponse
    return this.mapResults(data)
  }

  private mapResults(data: BingResponse): WebSearchResult[] {
    const pages = data.webPages?.value
    if (!Array.isArray(pages)) return []

    return pages.map(page => ({
      title: page.name || '',
      url: page.url || '',
      snippet: page.snippet || '',
    }))
  }
}

interface BingResponse {
  webPages?: {
    value: Array<{
      name?: string
      url?: string
      snippet?: string
    }>
  }
}
