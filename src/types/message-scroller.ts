import type { CacheSnapshot } from 'vue-virtual-scroller'

/** vue-virtual-scroller scrollToItem/scrollToPosition 的 options（库的 ScrollToOptions 形状） */
export interface ScrollerScrollToOptions {
  align?: 'start' | 'center' | 'end' | 'nearest'
  smooth?: boolean
  offset?: number
}

/** vue-virtual-scroller 组件实例在运行时的最小可用面（库自带类型与 ref 推断不一致） */
export interface MessageScrollerHandle {
  scrollToItem?: (index: number, options?: ScrollerScrollToOptions) => void
  scrollToPosition?: (position: number, options?: ScrollerScrollToOptions) => void
  scrollToBottom?: () => void
  forceUpdate?: (clear?: boolean) => void
  restoreCache?: (snapshot: CacheSnapshot) => boolean
  cacheSnapshot?: CacheSnapshot | { value: CacheSnapshot }
  /** 给定 wrapper 坐标，返回该位置所在 item 的 index（动态高度走尺寸表二分） */
  findItemIndex?: (position: number) => number
  /** 返回该 item 的 accumulator（item 顶距 wrapper 顶的距离） */
  getItemOffset?: (index: number) => number
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
