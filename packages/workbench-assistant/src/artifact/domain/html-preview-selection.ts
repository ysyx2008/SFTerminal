/**
 * HTML 文件预览选区：客页报告 ↔ 宿主坐标 / 作用域。
 * 客页逻辑必须自包含（toString 注入 webview），不能闭包外部 import。
 */

export const HTML_PREVIEW_SELECTION_CHANNEL = 'sf-html-selection'
export const HTML_PREVIEW_SELECTION_CMD_CHANNEL = 'sf-html-selection-cmd'

export type HtmlPreviewSelectionBox = {
  left: number
  top: number
  right: number
  bottom: number
}

export type HtmlPreviewSelectionReport = {
  kind: 'mouseup' | 'selectionchange' | 'scroll'
  excerpt: string
  box: HtmlPreviewSelectionBox | null
}

export type HtmlPreviewSelectionCmd = { op: 'pin' } | { op: 'clear' }

export function isHtmlFilePreviewSelectionEnabled(opts: {
  isPptPreview: boolean
}): boolean {
  return !opts.isPptPreview
}

export function parseHtmlPreviewSelectionReport(value: unknown): HtmlPreviewSelectionReport | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (o.kind !== 'mouseup' && o.kind !== 'selectionchange' && o.kind !== 'scroll') return null
  const excerpt = typeof o.excerpt === 'string' ? o.excerpt.replace(/\u00a0/g, ' ').trim() : ''
  return { kind: o.kind, excerpt, box: parseBox(o.box) }
}

function parseBox(value: unknown): HtmlPreviewSelectionBox | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (
    typeof o.left !== 'number' ||
    typeof o.top !== 'number' ||
    typeof o.right !== 'number' ||
    typeof o.bottom !== 'number'
  ) {
    return null
  }
  if (o.right <= o.left && o.bottom <= o.top) return null
  return { left: o.left, top: o.top, right: o.right, bottom: o.bottom }
}

/** 客页 CSS 盒 × 缩放 + webview 在宿主里的位置 → 视口坐标 */
export function hostBoxFromGuest(
  guest: HtmlPreviewSelectionBox,
  webview: { left: number; top: number },
  zoom: number
): HtmlPreviewSelectionBox {
  const z = zoom > 0 ? zoom : 1
  return {
    left: webview.left + guest.left * z,
    top: webview.top + guest.top * z,
    right: webview.left + guest.right * z,
    bottom: webview.top + guest.bottom * z
  }
}

export function htmlPreviewSelectionGuestScript(): string {
  return `(${installHtmlPreviewSelectionGuest.toString()})()`
}

/**
 * 跑在预览页主世界。toString 后注入，禁止引用外部绑定。
 */
export function installHtmlPreviewSelectionGuest(): void {
  const w = window as Window & {
    __sfArtifactHost?: { post: (data: unknown) => void }
    __sfArtifactGuest?: { handle: (cmd: unknown) => void }
  }
  if (w.__sfArtifactGuest) return

  const MARK = 'sf-doc-sticky-mark'
  let lastExcerpt = ''
  let pinSticky = false

  function ensureStyle(): void {
    if (document.getElementById('sf-html-sel-style')) return
    const style = document.createElement('style')
    style.id = 'sf-html-sel-style'
    style.textContent = `.${MARK}{background:rgba(77,158,255,0.35);color:inherit}`
    document.documentElement.appendChild(style)
  }

  function excerptOf(range: Range): string {
    return range.toString().replace(/\u00a0/g, ' ').trim()
  }

  function liveRange(): Range | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!excerptOf(range)) return null
    return range
  }

  function boxOf(range: Range): { left: number; top: number; right: number; bottom: number } | null {
    try {
      const r = range.getBoundingClientRect()
      if (r.width <= 0 && r.height <= 0) return null
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    } catch {
      return null
    }
  }

  function report(kind: 'mouseup' | 'selectionchange' | 'scroll'): void {
    const range = liveRange()
    const excerpt = range ? excerptOf(range) : lastExcerpt
    w.__sfArtifactHost?.post({
      kind,
      excerpt: kind === 'scroll' ? excerpt : (range ? excerpt : ''),
      box: range ? boxOf(range) : null
    })
  }

  function textSlices(range: Range): { node: Text; start: number; end: number }[] {
    if (range.collapsed) return []
    const start = range.startContainer
    const end = range.endContainer
    if (start === end && start.nodeType === Node.TEXT_NODE) {
      const a = Math.min(range.startOffset, range.endOffset)
      const b = Math.max(range.startOffset, range.endOffset)
      return b > a ? [{ node: start as Text, start: a, end: b }] : []
    }
    const ancestor = range.commonAncestorContainer
    const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor
    if (!root) return []
    const out: { node: Text; start: number; end: number }[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const text = node as Text
      if (range.intersectsNode(text) && text.data.length > 0) {
        const from = text === start ? range.startOffset : 0
        const to = text === end ? range.endOffset : text.data.length
        if (to > from) out.push({ node: text, start: from, end: to })
      }
      node = walker.nextNode()
    }
    return out
  }

  function rangeFromExcerpt(excerpt: string): Range | null {
    const needle = excerpt.replace(/\u00a0/g, ' ').trim()
    if (!needle) return null
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const text = node as Text
      const idx = text.data.replace(/\u00a0/g, ' ').indexOf(needle)
      if (idx >= 0) {
        const range = document.createRange()
        range.setStart(text, idx)
        range.setEnd(text, idx + needle.length)
        return range
      }
      node = walker.nextNode()
    }
    return null
  }

  function clearMarks(): void {
    const marks = [...document.querySelectorAll(`.${MARK}`)]
    for (const mark of marks) {
      const parent = mark.parentNode
      if (!parent) continue
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
      parent.removeChild(mark)
      parent.normalize()
    }
  }

  function applyMarks(range: Range): void {
    ensureStyle()
    clearMarks()
    let slices: { node: Text; start: number; end: number }[]
    try {
      slices = textSlices(range)
    } catch {
      return
    }
    for (let i = slices.length - 1; i >= 0; i--) {
      const { node, start, end } = slices[i]
      if (end < node.data.length) node.splitText(end)
      const mid = start > 0 ? node.splitText(start) : node
      const mark = document.createElement('span')
      mark.className = MARK
      mid.parentNode?.insertBefore(mark, mid)
      mark.appendChild(mid)
    }
  }

  function pin(): void {
    pinSticky = true
    if (document.querySelector(`.${MARK}`)) {
      window.getSelection()?.removeAllRanges()
      return
    }
    const range = liveRange() ?? rangeFromExcerpt(lastExcerpt)
    if (range) {
      lastExcerpt = excerptOf(range)
      applyMarks(range)
    }
    window.getSelection()?.removeAllRanges()
  }

  function clear(): void {
    pinSticky = false
    lastExcerpt = ''
    clearMarks()
  }

  function onMouseUp(e: MouseEvent): void {
    if (e.button === 2) return
    const range = liveRange()
    if (range) {
      pinSticky = false
      lastExcerpt = excerptOf(range)
      clearMarks()
      report('mouseup')
      return
    }
    if (!pinSticky) {
      lastExcerpt = ''
      report('mouseup')
    }
  }

  function onSelectionChange(): void {
    if (pinSticky) return
    const range = liveRange()
    if (range) lastExcerpt = excerptOf(range)
    report('selectionchange')
  }

  function onScroll(): void {
    if (pinSticky) return
    w.__sfArtifactHost?.post({ kind: 'scroll', excerpt: lastExcerpt, box: null })
  }

  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('selectionchange', onSelectionChange)
  window.addEventListener('scroll', onScroll, true)

  w.__sfArtifactGuest = {
    handle(cmd: unknown) {
      const op = cmd && typeof cmd === 'object' && 'op' in cmd ? (cmd as { op: unknown }).op : ''
      if (op === 'pin') pin()
      if (op === 'clear') clear()
    }
  }
}
