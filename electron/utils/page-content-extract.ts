/** 从已渲染页面 HTML 提取正文：Readability → DOM 启发式 → 纯文本兜底 */

import { extractArticleTextFromHtml } from './html-article-extract'
import {
  extractArticleFromHtml,
  isReadabilityUsable,
  MIN_READABILITY_CHARS,
} from './readability-extract'

export interface PageContentExtractResult {
  title: string | null
  text: string
  html: string | null
}

/**
 * 桌面端统一正文提取（attach browser_get_content 主路径）
 */
export async function extractPageContentFromHtml(
  html: string,
  baseUrl: string,
  plainFallback = '',
): Promise<PageContentExtractResult> {
  const readability = await extractArticleFromHtml(html, baseUrl)
  if (isReadabilityUsable(readability)) {
    return {
      title: readability!.title,
      text: readability!.textContent,
      html: readability!.content,
    }
  }

  const heuristic = extractArticleTextFromHtml(html, baseUrl, 'article')
  if (heuristic.length >= MIN_READABILITY_CHARS) {
    return { title: null, text: heuristic, html: null }
  }

  const plain = plainFallback.trim() || heuristic
  if (plain.length >= MIN_READABILITY_CHARS) {
    return { title: null, text: plain, html: null }
  }

  const fullBody = extractArticleTextFromHtml(html, baseUrl, 'full')
  return { title: null, text: fullBody || plain, html: null }
}
