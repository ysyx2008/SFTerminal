/** Web Search 配置，前后端共享 */

export type WebSearchProviderId = 'tavily' | 'jina' | 'bocha' | 'google'

export interface WebSearchSettings {
  enabled: boolean
  providerId: WebSearchProviderId
  /** @deprecated 迁移用，新版用 apiKeys */
  apiKey?: string
  /** 每个 provider 独立的 API Key */
  apiKeys: Partial<Record<WebSearchProviderId, string>>
  /** Provider 额外配置（如 Google 需要的 cx）。key 为 provider 内部字段名 */
  apiExtras?: Partial<Record<WebSearchProviderId, Record<string, string>>>
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  enabled: false,
  providerId: 'bocha',
  apiKeys: {},
  apiExtras: {},
}

/** Provider 元数据中可声明的额外配置字段（除 API Key 之外） */
export interface WebSearchExtraField {
  /** 字段 key，会作为 apiExtras[providerId][key] 存取 */
  key: string
  /** UI 上显示的字段名（英文，与 description 风格一致） */
  label: string
  placeholder?: string
}

export const WEB_SEARCH_PROVIDERS: {
  id: WebSearchProviderId
  name: string
  requiresApiKey: boolean
  description: string
  extraFields?: WebSearchExtraField[]
}[] = [
  { id: 'bocha', name: 'Bocha (博查)', requiresApiKey: true, description: 'AI search engine, best for China users' },
  { id: 'tavily', name: 'Tavily', requiresApiKey: true, description: 'Best AI agent search experience' },
  { id: 'jina', name: 'Jina', requiresApiKey: true, description: 'Search + URL reader, returns Markdown' },
  {
    id: 'google',
    name: 'Google Custom Search',
    requiresApiKey: true,
    description: 'Google official search via Custom Search JSON API. Requires API Key + Search Engine ID (cx). Free 100 queries/day.',
    extraFields: [
      { key: 'cx', label: 'Search Engine ID (cx)', placeholder: 'e.g. 017576662512468239146:omuauf_lfve' },
    ],
  },
]
