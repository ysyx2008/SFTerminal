/** Mozilla Readability 正文提取（与 web_fetch / browser_get_content 共用） */

import { createRequire } from 'node:module'

export const MIN_READABILITY_CHARS = 50

export interface ReadabilityArticle {
  title: string | null
  textContent: string
  content: string
}

// 懒加载：避免拖慢 main 进程启动；配合 vite external，运行时从 node_modules 加载
const nodeRequire = createRequire(__filename)

/**
 * 对已渲染页面的 HTML 运行 Readability（Firefox 阅读模式 / 印象笔记剪藏同类算法）
 */
export async function extractArticleFromHtml(
  html: string,
  baseUrl: string,
): Promise<ReadabilityArticle | null> {
  const { JSDOM } = nodeRequire('jsdom') as typeof import('jsdom')
  const { Readability } = nodeRequire('@mozilla/readability') as typeof import('@mozilla/readability')

  const dom = new JSDOM(html, { url: baseUrl })
  const reader = new Readability(dom.window.document)
  const article = reader.parse()
  if (!article) return null
  return {
    title: article.title ?? null,
    textContent: article.textContent ?? '',
    content: article.content ?? '',
  }
}

export function isReadabilityUsable(article: ReadabilityArticle | null): boolean {
  return Boolean(article && article.textContent.trim().length >= MIN_READABILITY_CHARS)
}
