/**
 * 占位 div 注册中心契约
 *
 * TerminalTabView provide('paneSlotRegistry', { register, unregister })
 * SplitPaneView inject 后在 terminal 节点的 mount/update 时上报占位 div 引用。
 * Teleport 用 element 引用作 :to——element 变化时 Vue 自动 patch DOM 到新位置。
 *
 * 提到独立文件是为了避免 TerminalTabView ↔ SplitPaneView 之间的循环 import。
 */
export const PANE_SLOT_REGISTRY_KEY = 'paneSlotRegistry' as const

export interface PaneSlotRegistry {
  register: (ptyId: string, el: HTMLElement) => void
  unregister: (ptyId: string, el: HTMLElement) => void
}
