/**
 * 页面正文启发式提取（jsdom，与 web_fetch / browser_get_content 共用）
 * 原 browser-bridge article-extract.js 逻辑，已迁至桌面端以便扩展长期稳定。
 */

import { createRequire } from 'node:module'

const nodeRequire = createRequire(__filename)

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'video',
  'audio',
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '[class*="video-player"]',
  '[class*="VideoPlayer"]',
  '[class*="txp_"]',
  '[class*="player-container"]',
]

const ARTICLE_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '#ArticleContent',
  '.content-article',
  '.article-content',
  '.detail-content',
  '.main-content',
  '.article',
  '.post-content',
  '.entry-content',
  '.markdown-body',
  '.RichText',
  '.rich-text',
  '[class*="ArticleContent"]',
  '[class*="article-content"]',
]

export type HtmlArticleExtractMode = 'article' | 'full'

function getJSDOM() {
  return nodeRequire('jsdom').JSDOM as typeof import('jsdom').JSDOM
}

function elementText(el: Element): string {
  return (el.textContent || '').trim()
}

function scoreElement(el: Element): number {
  const text = elementText(el)
  if (text.length < 40) return 0
  const linkCount = el.querySelectorAll('a').length
  const mediaCount = el.querySelectorAll(
    'video, iframe, [class*="video-player"], [class*="VideoPlayer"], [class*="txp_"]',
  ).length
  return text.length - linkCount * 40 - mediaCount * 300
}

function normalizeText(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractJsonLdArticleBody(doc: Document): string {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const raw = JSON.parse(script.textContent || '')
      const items = Array.isArray(raw) ? raw : [raw]
      for (const item of items) {
        const nodes = item?.['@graph'] ? item['@graph'] : [item]
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue
          const body = node.articleBody
          if (typeof body === 'string' && body.trim().length > 100) {
            return normalizeText(body)
          }
        }
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return ''
}

function extractFromParagraphs(doc: Document): string {
  const parts: string[] = []
  doc.querySelectorAll('p').forEach((p) => {
    const t = elementText(p)
    if (t.length >= 30) parts.push(t)
  })
  return normalizeText(parts.join('\n\n'))
}

function findArticleRoot(doc: Document): Element | null {
  let best: Element | null = null
  let bestScore = 0

  for (const sel of ARTICLE_SELECTORS) {
    doc.querySelectorAll(sel).forEach((el) => {
      const score = scoreElement(el)
      if (score > bestScore) {
        bestScore = score
        best = el
      }
    })
  }

  if (best) return best

  doc.querySelectorAll('div, section').forEach((el) => {
    const score = scoreElement(el)
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  })

  return best || doc.body
}

function cloneAndStrip(doc: Document, el: Element): Element {
  const clone = el.cloneNode(true) as Element
  for (const sel of NOISE_SELECTORS) {
    clone.querySelectorAll(sel).forEach((node) => node.remove())
  }
  return clone
}

function parseDocument(html: string, baseUrl: string): Document {
  const JSDOM = getJSDOM()
  return new JSDOM(html, { url: baseUrl }).window.document
}

export function extractArticleTextFromHtml(
  html: string,
  baseUrl: string,
  mode: HtmlArticleExtractMode = 'article',
): string {
  const doc = parseDocument(html, baseUrl)
  if (mode === 'full') {
    return normalizeText(doc.body?.textContent || '')
  }

  const root = findArticleRoot(doc)
  let text = ''
  if (root) {
    const stripped = cloneAndStrip(doc, root)
    text = normalizeText(stripped.textContent || '')
  }
  if (text.length < 200) {
    const ld = extractJsonLdArticleBody(doc)
    if (ld.length > text.length) text = ld
  }
  if (text.length < 200) {
    const paras = extractFromParagraphs(doc)
    if (paras.length > text.length) text = paras
  }
  return text
}

export function extractArticleHtmlFromHtml(
  html: string,
  baseUrl: string,
  mode: HtmlArticleExtractMode = 'article',
): string {
  const doc = parseDocument(html, baseUrl)
  if (mode === 'full') {
    return doc.documentElement?.outerHTML || ''
  }
  const root = findArticleRoot(doc)
  if (!root) return ''
  return cloneAndStrip(doc, root).innerHTML || ''
}
