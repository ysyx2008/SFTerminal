/**
 * HTML 预览选区：从根节点内的原生 Selection 取出 Range，
 * 焦点离开后用 mark 钉住高亮（不依赖 CSS Highlight，避免点输入框不重绘）。
 */

export const STICKY_MARK_CLASS = 'sf-doc-sticky-mark'

/** 选区两端都在 root 内且有可见文字时，返回克隆 Range；否则 null */
export function rangeInsideRoot(root: Node | null, sel: Selection | null): Range | null {
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const anchor = sel.anchorNode
  const focus = sel.focusNode
  if (!anchor || !focus) return null
  if (!root.contains(anchor) || !root.contains(focus)) return null
  const range = sel.getRangeAt(0)
  if (!excerptFromRange(range)) return null
  return range.cloneRange()
}

export function excerptFromRange(range: Range): string {
  return range.toString().replace(/\u00a0/g, ' ').trim()
}

export type SelectionOverlayRect = {
  left: number
  top: number
  width: number
  height: number
}

/** 与原生 ::selection 同一套行盒，相对 host 定位 */
export function overlayRectsForRange(range: Range, host: Element): SelectionOverlayRect[] {
  const origin = host.getBoundingClientRect()
  return [...range.getClientRects()]
    .filter(r => r.width > 0 && r.height > 0)
    .map(r => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      width: r.width,
      height: r.height
    }))
}

export function textSlicesInRange(range: Range): { node: Text; start: number; end: number }[] {
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

/** 用选中原文在 root 里找回 Range（Range 失效时的退路；只匹配整段落在同一文本节点内的摘录） */
export function rangeFromExcerpt(root: Node | null, excerpt: string): Range | null {
  if (!root) return null
  const needle = excerpt.replace(/\u00a0/g, ' ').trim()
  if (!needle) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
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

export function applyStickyMarks(root: ParentNode | null, range: Range | null): void {
  if (!root || !range || range.collapsed) return
  clearStickyMarks(root)
  let slices: { node: Text; start: number; end: number }[]
  try {
    slices = textSlicesInRange(range)
  } catch {
    return
  }
  for (let i = slices.length - 1; i >= 0; i--) {
    const { node, start, end } = slices[i]
    if (end < node.data.length) node.splitText(end)
    const mid = start > 0 ? node.splitText(start) : node
    const mark = document.createElement('span')
    mark.className = STICKY_MARK_CLASS
    mid.parentNode?.insertBefore(mark, mid)
    mark.appendChild(mid)
  }
}

export function clearStickyMarks(root: ParentNode | null): void {
  if (!root || !('querySelectorAll' in root)) return
  const marks = [...root.querySelectorAll(`.${STICKY_MARK_CLASS}`)]
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  }
}
