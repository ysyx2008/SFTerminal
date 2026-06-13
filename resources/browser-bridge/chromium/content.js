/**
 * Content script — 在页面内执行 DOM 操作
 */
(function () {
  function byRef(refId) {
    return document.querySelector(`[data-sf-ref="${CSS.escape(refId)}"]`)
      || document.querySelector(`[data-sf-ref="${refId}"]`)
  }

  function clickTarget(payload) {
    const ref = payload.ref
    const selector = payload.selector
    let el = null
    if (ref) el = byRef(String(ref).replace(/^@/, ''))
    if (!el && selector) el = document.querySelector(String(selector))
    if (!el) throw new Error(`Element not found: ${ref || selector}`)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.click()
    return { clicked: true }
  }

  function typeTarget(payload) {
    const ref = payload.ref
    const text = String(payload.text ?? '')
    const clear = payload.clear !== false
    let el = ref ? byRef(String(ref).replace(/^@/, '')) : null
    if (!el && payload.selector) el = document.querySelector(String(payload.selector))
    if (!el) throw new Error(`Element not found: ${ref || payload.selector}`)
    el.focus()
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (clear) el.value = ''
      el.value += text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (el.isContentEditable) {
      if (clear) el.textContent = ''
      el.textContent += text
    } else {
      throw new Error('Element is not typable')
    }
    return { typed: text.length }
  }

  function scrollPage(payload) {
    const y = Number(payload.y ?? 0)
    window.scrollBy({ top: y, behavior: 'instant' in window ? 'instant' : 'auto' })
    return { scrolled: y }
  }

  function getContent(payload) {
    const mode = payload.mode || 'text'
    const selector = payload.selector ? String(payload.selector) : ''
    const extract = payload.extract || 'auto'
    const meta = { title: document.title, url: location.href }

    if (mode === 'page_html') {
      const article = globalThis.__sailfishArticleExtract
      return {
        ...meta,
        html: document.documentElement.outerHTML,
        fallbackText: article?.extractText?.(document, 'article') || '',
      }
    }

    if (selector) {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`Element not found: ${selector}`)
      if (mode === 'html') {
        return { ...meta, content: el.innerHTML || '' }
      }
      return { ...meta, content: (el.innerText || el.textContent || '').trim() }
    }

    const article = globalThis.__sailfishArticleExtract
    const extractMode = extract === 'full' ? 'full' : 'article'

    if (mode === 'html') {
      const content = extract === 'full'
        ? document.documentElement.outerHTML
        : (article?.extractHtml?.(document, extractMode) || document.body?.innerHTML || '')
      return { ...meta, content }
    }

    const content = extract === 'full'
      ? (document.body?.innerText || '')
      : (article?.extractText?.(document, extractMode) || document.body?.innerText || '')
    return { ...meta, content: String(content).trim() }
  }

  function evaluateScript(payload) {
    const fn = globalThis.__sailfishSafeEval
    if (typeof fn !== 'function') {
      throw new Error('Safe eval engine not loaded')
    }
    return { result: fn(payload.expression) }
  }

  window.__sailfishContentHandler = {
    snapshot(payload) {
      if (typeof window.__sailfishSnapshot !== 'function') {
        throw new Error('Snapshot engine not loaded')
      }
      const { tree, refs } = window.__sailfishSnapshot(document.body, {
        interactive: payload?.interactive !== false,
        maxDepth: payload?.maxDepth ?? 15,
      })
      return {
        tree,
        refs,
        title: document.title,
        url: location.href,
      }
    },
    click: clickTarget,
    type: typeTarget,
    scroll: scrollPage,
    get_content: getContent,
    evaluate: evaluateScript,
  }

  const runtime = globalThis.chrome?.runtime || globalThis.browser?.runtime
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'sailfish-evaluate') return undefined
      try {
        const result = evaluateScript({ expression: message.expression })
        sendResponse({ success: true, data: result })
      } catch (error) {
        sendResponse({ success: false, error: error?.message || String(error) })
      }
      return true
    })
  }
})()
