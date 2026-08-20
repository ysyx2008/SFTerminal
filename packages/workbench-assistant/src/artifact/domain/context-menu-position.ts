export type ContextMenuBox = {
  left: number
  top: number
  right: number
  bottom: number
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
