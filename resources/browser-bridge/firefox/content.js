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
    if (mode === 'html') return { content: document.documentElement.outerHTML }
    return { content: document.body?.innerText || '' }
  }

  function evaluateScript(payload) {
    let code = String(payload.expression || '').trim()
    if (!code) return { result: null }
    if (code.startsWith('return ')) {
      code = code.slice(7)
    }
    try {
      // eslint-disable-next-line no-eval
      return { result: eval(code) }
    } catch {
      return { result: new Function(code)() }
    }
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
})()
