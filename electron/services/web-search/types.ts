/**
 * Web Search Provider 类型定义
 *
 * 可插拔的搜索接口，内置 DuckDuckGo / Bocha / Bing / Jina / Tavily，
 * 插件可通过 registerProvider 注册自定义 provider。
 */

export interface WebSearchProvider {
  id: string
  name: string
  /** 执行搜索 */
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>
  /** 释放资源 */
  dispose?(): void
}

export interface WebSearchOptions {
  /** 最大结果数，默认 5 */
  maxResults?: number
  /** 语言偏好，如 'zh-CN' | 'en' */
  language?: string
  signal?: AbortSignal
}

export interface WebSearchResult {
  title: string
  url: string
  /** 摘要 */
  snippet: string
  /** 提取的正文（部分 Provider 支持） */
  content?: string
}
