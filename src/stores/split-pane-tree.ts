/**
 * SplitPane 树形结构纯函数操作集
 *
 * 抽离自 stores/terminal.ts，让递归树操作既可在 store 内复用，
 * 也能在不依赖 vue / Pinia / window 的环境下被单元测试。
 *
 * 这里不出现任何带副作用的逻辑（IPC / store 状态变更 / i18n）；
 * i18n 化的标签函数留在 store 内（updatePaneLabels）。
 */
import type { SplitPane } from './terminal'

/**
 * 在布局中查找标记为激活的终端窗格（仅返回第一个命中的；正常情况下应只有一个）
 */
export function findActivePaneInLayout(layout: SplitPane): SplitPane | null {
  if (layout.type === 'terminal') {
    return layout.isActive ? layout : null
  }
  for (const child of layout.children || []) {
    const found = findActivePaneInLayout(child)
    if (found) return found
  }
  return null
}

/**
 * 用 `newPane` 替换布局中 id 等于 `paneId` 的节点
 * 返回是否成功替换
 */
export function replacePaneInLayout(layout: SplitPane, paneId: string, newPane: SplitPane): boolean {
  if (!layout.children) return false
  for (let i = 0; i < layout.children.length; i++) {
    if (layout.children[i].id === paneId) {
      layout.children[i] = newPane
      return true
    }
    if (replacePaneInLayout(layout.children[i], paneId, newPane)) {
      return true
    }
  }
  return false
}

/**
 * 按 id 查找节点（可能是 split 容器，也可能是 terminal 窗格）
 */
export function findPaneById(layout: SplitPane, paneId: string): SplitPane | null {
  if (layout.id === paneId) {
    return layout
  }
  for (const child of layout.children || []) {
    const found = findPaneById(child, paneId)
    if (found) return found
  }
  return null
}

/**
 * 收集布局中所有"终端窗格"叶节点
 */
export function getAllTerminalPanes(layout: SplitPane): SplitPane[] {
  if (layout.type === 'terminal') {
    return [layout]
  }
  const panes: SplitPane[] = []
  for (const child of layout.children || []) {
    panes.push(...getAllTerminalPanes(child))
  }
  return panes
}

/**
 * 把子节点的所有字段提升到父节点本身（原地修改父节点）。
 *
 * 用于 split 容器移除其中一个子节点后只剩一个孩子时的"层级压缩"。
 * 不能简单 Object.assign：父节点上的 children/direction 等字段，子节点没有，
 * Object.assign 不会清掉它们，会导致脏状态（terminal 节点残留 direction 字段）。
 *
 * 保留 parent.id 不变，确保 vue 渲染层 :key 引用稳定不重挂。
 */
export function liftChildIntoParent(parent: SplitPane, child: SplitPane): void {
  const parentRecord = parent as unknown as Record<string, unknown>
  const childRecord = child as unknown as Record<string, unknown>
  for (const key of Object.keys(parentRecord)) {
    if (key === 'id') continue
    delete parentRecord[key]
  }
  for (const [key, value] of Object.entries(childRecord)) {
    if (key === 'id') continue
    parentRecord[key] = value
  }
}

/**
 * 从布局中移除 id 为 paneId 的节点。如果它的父节点移除后只剩一个子节点，
 * 该子节点会被原地提升为父节点本身（liftChildIntoParent）。
 *
 * 返回是否成功移除。
 */
export function removePaneFromLayout(layout: SplitPane, paneId: string): boolean {
  if (!layout.children) return false

  for (let i = 0; i < layout.children.length; i++) {
    if (layout.children[i].id === paneId) {
      layout.children.splice(i, 1)
      if (layout.children.length === 1) {
        liftChildIntoParent(layout, layout.children[0])
      }
      return true
    }
    if (removePaneFromLayout(layout.children[i], paneId)) {
      return true
    }
  }
  return false
}
