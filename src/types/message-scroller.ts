import type { VirtualizerHandle } from 'virtua/vue'

/**
 * 消息虚拟滚动组件实例的最小可用面。
 *
 * 基于 virtua 的 VirtualizerHandle，对外保留项目需要的命令式滚动 API。
 * 迁移自 vue-virtual-scroller 的 MessageScrollerHandle，适配 virtua 的方法名：
 * - scrollToItem -> scrollToIndex
 * - scrollToPosition -> scrollTo
 * - scrollToBottom -> scrollTo(scrollSize)（封装在 AiPanel 挂载时注入）
 * - forceUpdate -> 移除（virtua 响应式更新无需手动触发）
 * - restoreCache / cacheSnapshot -> 移除（virtua CacheSnapshot 不保证跨版本，改用 aiScrollAnchor）
 * - findItemIndex / getItemOffset -> 同名保留
 */
export interface MessageScrollerHandle extends VirtualizerHandle {
  /** 滚到底部。virtua 无原生 scrollToBottom，由 AiPanel 注入为 scrollTo(scrollSize) */
  scrollToBottom?: () => void
}
