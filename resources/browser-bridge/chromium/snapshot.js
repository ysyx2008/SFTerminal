/**
 * 无障碍树快照（content script）
 * 简化版 ref 映射，与 Playwright snapshot 语义对齐
 */
(function () {
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'tab', 'menuitem', 'option', 'slider', 'spinbutton',
  ])

  function getRole(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    const map = {
      a: el.href ? 'link' : 'generic',
      button: 'button',
      input: inputRole(el),
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      img: 'img',
      p: 'paragraph',
    }
    return map[tag] || 'generic'
  }

  function inputRole(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'button' || type === 'submit') return 'button'
    if (type === 'search') return 'searchbox'
    return 'textbox'
  }

  function getAccessibleName(el) {
    return (
      el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('placeholder')
      || el.getAttribute('alt')
      || (el.labels && el.labels[0] && el.labels[0].textContent.trim())
      || textContentShort(el)
    )
  }

  function textContentShort(el) {
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
    return text.length > 80 ? `${text.slice(0, 77)}…` : text
  }

  function isHidden(el) {
    if (!(el instanceof HTMLElement)) return true
    const style = window.getComputedStyle(el)
    return style.display === 'none' || style.visibility === 'hidden' || el.hidden
  }

  function buildSnapshot(root, options = {}) {
    const interactiveOnly = options.interactive === true
    const maxDepth = options.maxDepth ?? 15
    const refs = {}
    let refCounter = 0

    function nextRef() {
      refCounter += 1
      return `e${refCounter}`
    }

    function walk(el, depth) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || depth > maxDepth) return ''
      if (isHidden(el)) return ''

      const role = getRole(el)
      const name = getAccessibleName(el)
      const isInteractive = INTERACTIVE_ROLES.has(role) || el.matches('a[href], button, input, select, textarea')
      if (interactiveOnly && !isInteractive && role !== 'heading') {
        let childLines = ''
        for (const child of el.children) {
          childLines += walk(child, depth + 1)
        }
        return childLines
      }

      let line = `- ${role}`
      if (name) line += ` "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      let refId = null
      if (isInteractive || role === 'heading' || role === 'textbox' || role === 'link') {
        refId = nextRef()
        refs[refId] = {
          role,
          name: name || undefined,
          selector: `[data-sf-ref="${refId}"]`,
        }
        el.setAttribute('data-sf-ref', refId)
        line += ` [ref=${refId}]`
      }
      if (el.required || el.getAttribute('aria-required') === 'true') {
        line += ' [必填]'
      }
      if (role === 'heading') {
        const level = el.tagName.match(/^H(\d)$/i)
        if (level) line += ` [level=${level[1]}]`
      }
      line += '\n'

      for (const child of el.children) {
        line += walk(child, depth + 1)
      }
      return line
    }

    const tree = walk(root, 0)
    return { tree: tree.trim(), refs }
  }

  window.__sailfishSnapshot = buildSnapshot
})()
