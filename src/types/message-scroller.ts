import type { CacheSnapshot } from 'vue-virtual-scroller'

/** vue-virtual-scroller 组件实例在运行时的最小可用面（库自带类型与 ref 推断不一致） */
export interface MessageScrollerHandle {
  scrollToItem?: (index: number, options?: ScrollToOptions) => void
  scrollToPosition?: (position: number, options?: ScrollToOptions) => void
  scrollToBottom?: () => void
  forceUpdate?: (clear?: boolean) => void
  restoreCache?: (snapshot: CacheSnapshot) => boolean
  cacheSnapshot?: CacheSnapshot | { value: CacheSnapshot }
  $el?: HTMLElement
}

export function readMessageScrollerCache(
  scroller: MessageScrollerHandle | null | undefined
): CacheSnapshot | undefined {
  if (!scroller?.cacheSnapshot) return undefined
  const snap = scroller.cacheSnapshot
  return typeof snap === 'object' && snap !== null && 'value' in snap
    ? (snap as { value: CacheSnapshot }).value
    : snap as CacheSnapshot
}
