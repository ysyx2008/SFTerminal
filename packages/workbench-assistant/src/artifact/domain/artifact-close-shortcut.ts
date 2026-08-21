/**
 * 产出物有焦点时 Cmd/Ctrl+W 关当前页签。
 * 面板注册「有焦点就关」；壳层关闭快捷键先问这里，避免菜单加速键与页面按键各关一次。
 */

export function isCloseArtifactShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey?: boolean
}): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return event.key.toLowerCase() === 'w'
}

type CloseFocusedFn = () => boolean

let closer: CloseFocusedFn | null = null
let handledThisTick = false

export function registerFocusedArtifactCloser(fn: CloseFocusedFn | null): void {
  closer = fn
}

/** 焦点在产出物上则关掉当前页签并返回 true；同一次按键再进来也返回 true，避免连关两份。 */
export function closeFocusedArtifact(): boolean {
  if (handledThisTick) return true
  const closed = closer?.() ?? false
  if (closed) {
    handledThisTick = true
    queueMicrotask(() => {
      handledThisTick = false
    })
  }
  return closed
}
