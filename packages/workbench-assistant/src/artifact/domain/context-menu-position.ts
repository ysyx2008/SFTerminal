export type ContextMenuBox = {
  left: number
  top: number
  right: number
  bottom: number
}

/** 锚点弹出时，左右/上下哪边空间更大就按那边收；给菜单定上限，避免伸出可视范围被裁 */
export function availableMenuExtent(opts: {
  anchor: ContextMenuBox
  viewport: ContextMenuBox
  gap?: number
  pad?: number
}): { maxWidth: number; maxHeight: number } {
  const gap = opts.gap ?? 6
  const pad = opts.pad ?? 8
  const minX = opts.viewport.left + pad
  const maxX = opts.viewport.right - pad
  const minY = opts.viewport.top + pad
  const maxY = opts.viewport.bottom - pad
  return {
    maxWidth: Math.max(0, maxX - minX),
    maxHeight: Math.max(0, maxY - (opts.anchor.bottom + gap), opts.anchor.top - gap - minY)
  }
}

/** 右键菜单落在可视范围内：下方不够就翻到指针上方 */
export function clampContextMenuPosition(opts: {
  x: number
  y: number
  menuWidth: number
  menuHeight: number
  viewport: ContextMenuBox
  pad?: number
}): { left: number; top: number } {
  const pad = opts.pad ?? 8
  const minX = opts.viewport.left + pad
  const minY = opts.viewport.top + pad
  const maxX = opts.viewport.right - pad
  const maxY = opts.viewport.bottom - pad
  let left = opts.x
  let top = opts.y
  if (left + opts.menuWidth > maxX) left = maxX - opts.menuWidth
  if (left < minX) left = minX
  if (top + opts.menuHeight > maxY) top = opts.y - opts.menuHeight
  if (top < minY) top = minY
  if (top + opts.menuHeight > maxY) top = Math.max(minY, maxY - opts.menuHeight)
  return { left, top }
}

/** 选区提示：贴在选区上沿，上面放不下就落到下沿；左右居中于选区并收进可视范围 */
export function placeSelectionHint(opts: {
  anchor: ContextMenuBox
  hintWidth: number
  hintHeight: number
  viewport: ContextMenuBox
  gap?: number
  pad?: number
}): { left: number; top: number } {
  const gap = opts.gap ?? 6
  const pad = opts.pad ?? 8
  const minX = opts.viewport.left + pad
  const minY = opts.viewport.top + pad
  const maxX = opts.viewport.right - pad
  const maxY = opts.viewport.bottom - pad
  let left = (opts.anchor.left + opts.anchor.right) / 2 - opts.hintWidth / 2
  if (left + opts.hintWidth > maxX) left = maxX - opts.hintWidth
  if (left < minX) left = minX
  let top = opts.anchor.top - gap - opts.hintHeight
  if (top < minY) top = opts.anchor.bottom + gap
  if (top + opts.hintHeight > maxY) top = Math.max(minY, maxY - opts.hintHeight)
  return { left, top }
}

export function boxFromRect(r: DOMRect): ContextMenuBox {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** 当前选区的外框；选区为空、或两端不在 root 内时返回 null */
export function selectionAnchorBox(root: Node | null): ContextMenuBox | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  if (root) {
    const { anchorNode, focusNode } = sel
    if (!anchorNode || !focusNode) return null
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return null
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (rect.width <= 0 && rect.height <= 0) return null
  return boxFromRect(rect)
}

export function viewportBox(): ContextMenuBox {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight
  }
}

/** 预览窗与视口的交集，避免菜单画在被裁掉的区域 */
export function intersectViewport(clip: DOMRect | undefined | null): ContextMenuBox {
  const view = viewportBox()
  if (!clip) return view
  return {
    left: Math.max(view.left, clip.left),
    top: Math.max(view.top, clip.top),
    right: Math.min(view.right, clip.right),
    bottom: Math.min(view.bottom, clip.bottom)
  }
}
