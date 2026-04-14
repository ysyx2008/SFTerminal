/**
 * 博查 (Bocha) 搜索 Provider
 * 国内 AI 搜索服务，专为 LLM/Agent 设计
 * API: POST https://api.bochaai.com/v1/web-search
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from '../types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('WebSearch:Bocha')
const ENDPOINT = 'https://api.bochaai.com/v1/web-search'

export class BochaProvider implements WebSearchProvider {
  id = 'bocha'
  name = 'Bocha (博查)'

  constructor(private apiKeyGetter: () => string) {}

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKeyGetter()
    if (!apiKey) throw new Error('Bocha API key is not configured')

    const maxResults = options?.maxResults ?? 5

    const timeout = AbortSignal.timeout(30_000)
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        count: maxResults,
        summary: true,
      }),
      signal: options?.signal ?? timeout,
    }

    const resp = await fetch(ENDPOINT, fetchOptions)

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Bocha search failed: ${resp.status} ${text}`)
    }

    const rawText = await resp.text()
    let json: any
    try {
      json = JSON.parse(rawText)
    } catch {
      throw new Error(`Bocha returned non-JSON response: ${rawText.slice(0, 200)}`)
    }

    // Bocha API wraps the response in a `data` field
    const data = json.data ?? json
    const results = this.mapResults(data)
    if (results.length === 0) {
      log.warn('Empty results. Response keys:', Object.keys(json), 'data keys:', data ? Object.keys(data) : 'N/A')
    }
    return results
  }

  private mapResults(data: BochaResponse): WebSearchResult[] {
    const pages = data.webPages?.value
    if (!Array.isArray(pages)) return []

    return pages.map(page => ({
      title: page.name || '',
      url: page.url || '',
      snippet: page.snippet || '',
      content: page.summary || undefined,
    }))
  }
}

interface BochaWebPages {
  value: Array<{
    name?: string
    url?: string
    snippet?: string
    summary?: string
    siteName?: string
    datePublished?: string
  }>
}

interface BochaResponse {
  webPages?: BochaWebPages
}
