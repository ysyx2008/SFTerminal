/** Web Search 配置，前后端共享 */

export type WebSearchProviderId = 'tavily' | 'jina' | 'bocha'

export interface WebSearchSettings {
  enabled: boolean
  providerId: WebSearchProviderId
  /** @deprecated 迁移用，新版用 apiKeys */
  apiKey?: string
  /** 每个 provider 独立的 API Key */
  apiKeys: Partial<Record<WebSearchProviderId, string>>
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  enabled: false,
  providerId: 'bocha',
  apiKeys: {},
}

export const WEB_SEARCH_PROVIDERS: { id: WebSearchProviderId; name: string; requiresApiKey: boolean; description: string }[] = [
  { id: 'bocha', name: 'Bocha (博查)', requiresApiKey: true, description: 'AI search engine, best for China users' },
  { id: 'tavily', name: 'Tavily', requiresApiKey: true, description: 'Best AI agent search experience' },
  { id: 'jina', name: 'Jina', requiresApiKey: true, description: 'Search + URL reader, returns Markdown' },
]
