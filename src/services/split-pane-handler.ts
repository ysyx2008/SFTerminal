/**
 * 分屏反向 IPC 处理器（渲染进程侧）
 *
 * 监听主进程 Agent 工具发起的分屏操作请求，调用 terminalStore 中相应方法，
 * 把执行结果回报给主进程 bridge。
 *
 * 注：所有操作都基于"当前激活 tab"。Agent 在 system prompt 中已被告知"分屏作用于当前 tab"。
 */
import { useTerminalStore, type SplitPane } from '../stores/terminal'
import { createLogger } from '../utils/logger'

const log = createLogger('SplitPaneHandler')

type Op =
  | { type: 'split'; direction: 'horizontal' | 'vertical' }
  | { type: 'close'; paneId: string }
  | { type: 'focus'; paneId: string }
  | { type: 'list' }

let unsubscribe: (() => void) | null = null

export function initSplitPaneHandler(): void {
  if (unsubscribe) return
  if (!window.electronAPI?.splitPane?.onExec) {
    log.warn('electronAPI.splitPane unavailable, skip init')
    return
  }

  log.info('split-pane handler initialized')
  unsubscribe = window.electronAPI.splitPane.onExec(async (id, op) => {
    log.info(`recv op id=${id} type=${op.type}`)
    let result: { ok: boolean; data?: unknown; error?: string }
    try {
      // 每次都重新拿最新 store 实例，避免 HMR 后闭包持有旧 store
      const store = useTerminalStore()
      result = await dispatch(store, op as Op)
      log.info(`dispatch done id=${id} ok=${result.ok} err=${result.error || ''}`)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
      log.warn(`dispatch threw id=${id}`, e)
    }
    window.electronAPI.splitPane.sendResult(id, result)
    log.info(`sendResult id=${id}`)
  })
}

// Vite HMR：模块热替换时清理旧 listener，避免重复注册
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    log.info('HMR dispose split-pane handler')
    disposeSplitPaneHandler()
  })
}

export function disposeSplitPaneHandler(): void {
  unsubscribe?.()
  unsubscribe = null
}

async function dispatch(
  store: ReturnType<typeof useTerminalStore>,
  op: Op
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const tab = store.activeTab
  if (!tab) {
    log.warn(`dispatch ${op.type}: no active tab`)
    return { ok: false, error: 'No active tab' }
  }
  if (tab.type === 'assistant') {
    log.warn(`dispatch ${op.type}: active tab is assistant`)
    return { ok: false, error: 'Cannot operate split panes on assistant tab' }
  }
  log.info(`dispatch ${op.type} tab=${tab.id} type=${tab.type}`)

  switch (op.type) {
    case 'split': {
      const t0 = Date.now()
      log.info(`split start direction=${op.direction}`)
      const newPaneId = await store.splitTerminal(op.direction)
      const t1 = Date.now()
      log.info(`split done newPaneId=${newPaneId || 'null'} elapsed=${t1 - t0}ms`)
      if (!newPaneId) {
        return { ok: false, error: 'Split failed (no active tab or terminal creation failed)' }
      }
      return {
        ok: true,
        data: {
          tabId: tab.id,
          newPaneId,
          panes: collectPanes(tab.splitLayout)
        }
      }
    }
    case 'close': {
      log.info(`close start paneId=${op.paneId}`)
      const removed = await store.closePane(tab.id, op.paneId)
      log.info(`close done paneId=${op.paneId} removed=${removed}`)
      if (!removed) {
        return {
          ok: false,
          error: `Pane not found: "${op.paneId}". Use list_panes to get current pane_id (布局可能在上次操作后已经变化).`
        }
      }
      return {
        ok: true,
        data: {
          tabId: tab.id,
          closedPaneId: op.paneId,
          panes: collectPanes(tab.splitLayout),
          mode: tab.splitLayout ? 'split' : 'single'
        }
      }
    }
    case 'focus': {
      if (!tab.splitLayout) {
        return { ok: false, error: 'Tab is not in split mode' }
      }
      const ok = store.setActivePaneInTab(tab.id, op.paneId)
      if (!ok) {
        return {
          ok: false,
          error: `Pane not found: "${op.paneId}". Use list_panes to get current pane_id.`
        }
      }
      return {
        ok: true,
        data: { tabId: tab.id, activePaneId: op.paneId }
      }
    }
    case 'list': {
      if (tab.splitLayout) {
        return {
          ok: true,
          data: {
            tabId: tab.id,
            mode: 'split' as const,
            panes: collectPanes(tab.splitLayout)
          }
        }
      }
      return {
        ok: true,
        data: {
          tabId: tab.id,
          mode: 'single' as const,
          panes: tab.ptyId
            ? [{
                paneId: 'main',
                ptyId: tab.ptyId,
                label: 'Main',
                isActive: true,
                terminalType: tab.type as 'local' | 'ssh'
              }]
            : []
        }
      }
    }
    default:
      return { ok: false, error: `Unknown split-pane op` }
  }
}

function collectPanes(
  layout: SplitPane | undefined
): Array<{ paneId: string; ptyId: string; label: string; isActive: boolean; terminalType: string }> {
  if (!layout) return []
  const out: Array<{ paneId: string; ptyId: string; label: string; isActive: boolean; terminalType: string }> = []
  const walk = (node: SplitPane) => {
    if (node.type === 'terminal') {
      if (!node.ptyId) return
      out.push({
        paneId: node.id,
        ptyId: node.ptyId,
        label: node.label || '',
        isActive: Boolean(node.isActive),
        terminalType: node.terminalType || 'local'
      })
      return
    }
    for (const c of node.children || []) walk(c)
  }
  walk(layout)
  return out
}

