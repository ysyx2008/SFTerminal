/**
 * 页面正文提取（content script）
 * 启发式定位 article/main 等区域，过滤导航/页脚噪声
 */
(function () {
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

  function elementText(el) {
    return (el.innerText || el.textContent || '').trim()
  }

  function scoreElement(el) {
    const text = elementText(el)
    if (text.length < 40) return 0
    const linkCount = el.querySelectorAll('a').length
    const mediaCount = el.querySelectorAll('video, iframe, [class*="video-player"], [class*="VideoPlayer"], [class*="txp_"]').length
    // 视频播放器控件文字短但 media 多，应降权
    return text.length - linkCount * 40 - mediaCount * 300
  }

  function extractJsonLdArticleBody(doc) {
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

  function extractFromParagraphs(doc) {
    const parts = []
    doc.querySelectorAll('p').forEach((p) => {
      if (!(p instanceof HTMLElement)) return
      const t = elementText(p)
      if (t.length >= 30) parts.push(t)
    })
    return normalizeText(parts.join('\n\n'))
  }

  function findArticleRoot(doc) {
    let best = null
    let bestScore = 0

    for (const sel of ARTICLE_SELECTORS) {
      doc.querySelectorAll(sel).forEach((el) => {
        if (!(el instanceof HTMLElement)) return
        const score = scoreElement(el)
        if (score > bestScore) {
          bestScore = score
          best = el
        }
      })
    }

    if (best) return best

    doc.querySelectorAll('div, section').forEach((el) => {
      if (!(el instanceof HTMLElement)) return
      const score = scoreElement(el)
      if (score > bestScore) {
        bestScore = score
        best = el
      }
    })

    return best || doc.body
  }

  function cloneAndStrip(el) {
    const clone = el.cloneNode(true)
    for (const sel of NOISE_SELECTORS) {
      clone.querySelectorAll(sel).forEach((node) => node.remove())
    }
    return clone
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function extractText(doc, mode) {
    if (mode === 'full') {
      return normalizeText(doc.body?.innerText || doc.body?.textContent || '')
    }
    const root = findArticleRoot(doc)
    let text = ''
    if (root) {
      text = normalizeText(cloneAndStrip(root).innerText || cloneAndStrip(root).textContent)
    }
    // 视频新闻页 DOM 正文过短时，尝试 JSON-LD / 段落聚合
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

  function extractHtml(doc, mode) {
    if (mode === 'full') {
      return doc.documentElement?.outerHTML || ''
    }
    const root = findArticleRoot(doc)
    if (!root) return ''
    return cloneAndStrip(root).innerHTML || ''
  }

  globalThis.__sailfishArticleExtract = {
    findArticleRoot,
    extractText,
    extractHtml,
  }
})()
