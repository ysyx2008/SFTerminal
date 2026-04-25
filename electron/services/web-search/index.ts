/**
 * Web Search 服务
 * 管理搜索 Provider 注册、选择、代理设置
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResult } from './types'
import type { WebSearchSettings, WebSearchProviderId } from '@shared/types'
import { DEFAULT_WEB_SEARCH_SETTINGS, WEB_SEARCH_PROVIDERS } from '@shared/types'
import { createLogger } from '../../utils/logger'
import { BochaProvider } from './providers/bocha'
import { JinaProvider } from './providers/jina'
import { TavilyProvider } from './providers/tavily'
import { GoogleProvider } from './providers/google'

const log = createLogger('WebSearch')

const providers = new Map<string, WebSearchProvider>()
let currentSettings: WebSearchSettings = { ...DEFAULT_WEB_SEARCH_SETTINGS }

export function registerProvider(provider: WebSearchProvider): void {
  const old = providers.get(provider.id)
  if (old) {
    old.dispose?.()
  }
  providers.set(provider.id, provider)
  log.info(`Registered provider: ${provider.id}`)
}

export function removeProvider(id: string): void {
  const p = providers.get(id)
  if (p) {
    p.dispose?.()
    providers.delete(id)
  }
}

export function getProvider(id?: string): WebSearchProvider | undefined {
  return providers.get(id || currentSettings.providerId)
}

export function updateSettings(settings: WebSearchSettings): void {
  currentSettings = { ...settings }
}

export function getSettings(): WebSearchSettings {
  return { ...currentSettings }
}

/** 获取指定 provider 的 API Key */
export function getApiKey(providerId?: string): string {
  const id = providerId || currentSettings.providerId
  return currentSettings.apiKeys?.[id as WebSearchProviderId] || ''
}

/** 获取指定 provider 的额外配置字段（如 Google 的 cx） */
export function getApiExtra(providerId: string, key: string): string {
  return currentSettings.apiExtras?.[providerId as WebSearchProviderId]?.[key] || ''
}

export function isConfigured(): boolean {
  if (!currentSettings.enabled) return false
  const providerMeta = WEB_SEARCH_PROVIDERS.find(p => p.id === currentSettings.providerId)
  if (!providerMeta) return false
  if (providerMeta.requiresApiKey && !getApiKey()) return false
  if (providerMeta.extraFields) {
    for (const f of providerMeta.extraFields) {
      if (!getApiExtra(currentSettings.providerId, f.key)) return false
    }
  }
  return providers.has(currentSettings.providerId)
}

/**
 * 执行搜索
 */
export async function search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
  const provider = providers.get(currentSettings.providerId)
  if (!provider) {
    throw new Error(`Web search provider "${currentSettings.providerId}" not found`)
  }
  return provider.search(query, options)
}

/**
 * 初始化内置 provider
 */
export async function initWebSearch(settings: WebSearchSettings): Promise<void> {
  // Migrate removed providers to default
  const removed = ['duckduckgo', 'bing']
  if (removed.includes(settings.providerId as string)) {
    settings = { ...settings, providerId: DEFAULT_WEB_SEARCH_SETTINGS.providerId }
  }
  // Migrate legacy single apiKey → per-provider apiKeys
  if (settings.apiKey && (!settings.apiKeys || Object.keys(settings.apiKeys).length === 0)) {
    settings = { ...settings, apiKeys: { [settings.providerId]: settings.apiKey }, apiKey: undefined }
  }
  if (!settings.apiExtras) {
    settings = { ...settings, apiExtras: {} }
  }
  updateSettings(settings)

  registerProvider(new BochaProvider(() => getApiKey('bocha')))
  registerProvider(new JinaProvider(() => getApiKey('jina')))
  registerProvider(new TavilyProvider(() => getApiKey('tavily')))
  registerProvider(new GoogleProvider(
    () => getApiKey('google'),
    () => getApiExtra('google', 'cx'),
  ))

  log.info(`Initialized with provider: ${settings.providerId}`)
}

export function dispose(): void {
  for (const p of providers.values()) {
    p.dispose?.()
  }
  providers.clear()
}
